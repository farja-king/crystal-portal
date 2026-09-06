// Turns a DTF-Prep customer's already-uploaded, still-pending gang sheets
// into a real Crystal Portal invoice and (usually) a Square Payment Link to
// pay it - the step that runs when the customer clicks "Checkout" in
// DTF-Prep's cart.
//
// Order creation is deliberately NOT unconditional here anymore. It used to
// create the real `orders` invoice up front, before Square was even
// involved - if the customer abandoned the Square payment page, that unpaid
// invoice sat in the back office forever with nothing to clean it up. Now:
//  - An approved credit account (no external payment step - the credit
//    approval itself is the confirmation) still creates the order
//    immediately, via the shared createDtfOrder() helper.
//  - Everyone else creates a lightweight `gang_sheet_pending_checkouts` row
//    instead, and Square's Payment Link `reference_id` points at THAT
//    row's id, not an order id. The real order only gets created by
//    square-webhook.js, the moment payment is actually confirmed - see that
//    file for the other half of this. Abandoned checkouts leave nothing in
//    the back office at all; gang-sheet-cleanup.js sweeps the stray
//    gang_sheet_pending_checkouts row after a few hours.
import { verifyCustomerToken } from "../_lib/customer-token.js";
import { ensureDtfCustomerColumns } from "../_lib/dtf-schema.js";
import { buildDtfOrderItems, createDtfOrder } from "../_lib/gang-sheet-order.js";

const SQUARE_VERSION = "2026-07-15"; // keep in step with pay-by-card.js's own constant

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!db) return json({ error: "Database isn't set up yet" }, 500);
  if (!env.DTF_PREP_ORIGIN) return json({ error: "DTF-Prep isn't configured yet - DTF_PREP_ORIGIN is missing" }, 500);

  try {
    await ensureDtfCustomerColumns(db);
    // See gang-sheet-uploads.js for why this exists - guarded here too
    // since this file can just as easily be the first hit on a cold deploy.
    try {
      await db.prepare(`ALTER TABLE gang_sheet_uploads ADD COLUMN production_ready_at TEXT`).run();
    } catch {
      // already exists
    }
    // qty - see gang-sheet-upload.js, the canonical guard for this column
    // (this file just needs to read it back, but re-guards independently
    // per this codebase's established convention rather than assuming
    // upload.js already ran first on a cold deploy).
    try {
      await db.prepare(`ALTER TABLE gang_sheet_uploads ADD COLUMN qty INTEGER DEFAULT 1`).run();
    } catch {
      // already exists
    }
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS gang_sheet_pending_checkouts (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        upload_ids TEXT NOT NULL,
        total REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Customer session auth - identical check to gang-sheet-upload.js.
    const auth = request.headers.get("Authorization") || "";
    const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    if (!bearerToken) return json({ error: "Not authenticated" }, 401);

    const authCfg = await db.prepare("SELECT customer_token_secret, api_key FROM auth_config WHERE id = 'default'").first();
    if (!authCfg || !authCfg.customer_token_secret) return json({ error: "Not authenticated" }, 401);

    const payload = await verifyCustomerToken(bearerToken, authCfg.customer_token_secret);
    if (!payload || payload.purpose !== "gang-sheet-session" || !payload.customer_id) {
      return json({ error: "Your session has expired - please sign in again." }, 401);
    }
    const customerId = payload.customer_id;

    const data = await request.json();
    const uploadIds = Array.isArray(data.upload_ids) ? data.upload_ids.filter((id) => typeof id === "string" && id) : [];
    if (!uploadIds.length) return json({ error: "No gang sheets to check out" }, 400);

    const placeholders = uploadIds.map(() => "?").join(",");
    const { results: uploads } = await db.prepare(`
      SELECT id, filename, width_mm, height_mm, price, qty FROM gang_sheet_uploads
      WHERE customer_id = ? AND status = 'pending' AND id IN (${placeholders})
    `).bind(customerId, ...uploadIds).all();

    // Every requested id must exist, belong to this customer, and still be
    // pending - if any don't match (already checked out elsewhere, expired,
    // someone else's id), refuse the whole checkout rather than silently
    // charging for fewer sheets than the customer's cart showed them.
    if (uploads.length !== uploadIds.length) {
      return json({ error: "Some items in your cart are no longer available - please refresh and try again." }, 409);
    }

    const customer = await db.prepare(
      "SELECT id, name, email, dtf_credit_status, dtf_credit_limit FROM customers WHERE id = ? AND deleted_at IS NULL"
    ).bind(customerId).first();
    if (!customer) return json({ error: "That account no longer exists." }, 404);

    const total = uploads.reduce((sum, u) => sum + Number(u.price || 0) * Math.max(1, parseInt(u.qty, 10) || 1), 0);
    if (total < 0) return json({ error: "Nothing to charge" }, 400);

    const authHeaders = { "Content-Type": "application/json" };
    if (authCfg.api_key) authHeaders["X-API-Key"] = authCfg.api_key;
    const origin = new URL(request.url).origin;

    // A £0.00 dtf_flat_sheet_price (see customers.js) - a deliberate
    // "make this free for this customer" override, not "no override" (that
    // stays null - see gang-sheet-upload.js's own flatPrice != null check).
    // Nothing to charge and no external payment step makes sense here, so
    // create the order already marked paid, same as a genuine £0-owed
    // invoice would be - previously this just refused checkout outright
    // ("Nothing to charge"), which meant a £0 price was actually unusable.
    if (total === 0) {
      const orderItems = buildDtfOrderItems(uploads);
      const orderId = await createDtfOrder({ origin, authHeaders, customer }, orderItems);

      await db.prepare(
        "UPDATE orders SET paid_status = 'paid', amount_paid = 0, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(orderId).run();

      await db.prepare(`
        UPDATE gang_sheet_uploads SET order_id = ?, status = 'attached', attached_at = CURRENT_TIMESTAMP, production_ready_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `).bind(orderId, ...uploadIds).run();

      return json({ success: true, free: true, order_id: orderId });
    }

    // Approved credit accounts skip Square entirely and go straight on
    // account, as long as this order plus whatever they already owe stays
    // within their limit - re-checked here server-side, never trusted from
    // the client, same reasoning as every other price/entitlement check in
    // this endpoint's sibling files. No existing order to exclude from
    // "outstanding" here (nothing's been created yet either way), unlike
    // the old flow.
    if (customer.dtf_credit_status === "approved" && customer.dtf_credit_limit != null) {
      const outstandingRow = await db.prepare(`
        SELECT COALESCE(SUM(total - amount_paid), 0) AS outstanding FROM orders
        WHERE customer_id = ? AND doc_type = 'invoice' AND paid_status != 'paid'
      `).bind(customerId).first();
      const outstanding = (outstandingRow && outstandingRow.outstanding) || 0;

      if (outstanding + total <= Number(customer.dtf_credit_limit)) {
        const orderItems = buildDtfOrderItems(uploads);
        const orderId = await createDtfOrder({ origin, authHeaders, customer }, orderItems);

        await db.prepare(`
          UPDATE gang_sheet_uploads SET order_id = ?, status = 'attached', attached_at = CURRENT_TIMESTAMP, production_ready_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders})
        `).bind(orderId, ...uploadIds).run();

        return json({ success: true, invoiced_on_credit: true, order_id: orderId });
      }
    }

    // Everyone else: no order yet - just a lightweight placeholder so
    // Square's Payment Link has something to reference. gang_sheet_uploads
    // stays exactly 'pending' (not touched at all) until square-webhook.js
    // creates the real order and attaches them, once payment is confirmed.
    const pendingId = crypto.randomUUID();
    await db.prepare(
      "INSERT INTO gang_sheet_pending_checkouts (id, customer_id, upload_ids, total) VALUES (?, ?, ?, ?)"
    ).bind(pendingId, customerId, JSON.stringify(uploadIds), total).run();

    const squareAccessToken = (env.SQUARE_ACCESS_TOKEN || "").trim();
    const squareLocationId = (env.SQUARE_LOCATION_ID || "").trim();
    if (!squareAccessToken || !squareLocationId) {
      return json({ error: "Card payment isn't available right now - please get in touch." }, 503);
    }
    const squareBase = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";

    const squareRes = await fetch(`${squareBase}/v2/online-checkout/payment-links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${squareAccessToken}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: squareLocationId,
          reference_id: pendingId,
          line_items: uploads.map((u) => {
            const qty = Math.max(1, parseInt(u.qty, 10) || 1);
            return {
              name: `DTF gang sheet (${Math.round(u.width_mm || 0)}×${Math.round(u.height_mm || 0)}mm)`.slice(0, 500),
              quantity: String(qty),
              base_price_money: { amount: Math.round(Number(u.price || 0) * 100), currency: "GBP" },
            };
          }),
        },
        checkout_options: {
          redirect_url: `${env.DTF_PREP_ORIGIN}/thank-you.html`,
        },
      }),
    });

    if (!squareRes.ok) {
      return json({ error: "Couldn't start payment - please try again shortly." }, 502);
    }
    const squareData = await squareRes.json();
    const checkoutUrl = squareData && squareData.payment_link && squareData.payment_link.url;
    if (!checkoutUrl) {
      return json({ error: "Couldn't start payment - please try again shortly." }, 502);
    }

    return json({ success: true, checkout_url: checkoutUrl });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
