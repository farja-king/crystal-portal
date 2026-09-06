// Turns a DTF-Prep customer's already-uploaded, still-pending gang sheets
// into a real Crystal Portal invoice and a Square Payment Link to pay it -
// the step that runs when the customer clicks "Checkout" in DTF-Prep's cart.
//
// Deliberately reuses the existing order-creation machinery in orders.js
// (internal POST/PUT calls, same server-to-server X-API-Key pattern already
// used by design-proofs.js's auto-convert-on-approval flow) rather than
// hand-rolling another INSERT INTO orders - invoice numbering, totals, and
// pay_token minting all come from there for free, and stay correct if that
// logic ever changes. square-webhook.js needs no changes at all: it already
// resolves a completed payment back to an orders row via reference_id, and
// this produces a perfectly normal invoice-shaped row.
import { verifyCustomerToken } from "../_lib/customer-token.js";
import { ensureDtfCustomerColumns } from "../_lib/dtf-schema.js";

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
      SELECT id, filename, width_mm, height_mm, price FROM gang_sheet_uploads
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

    const total = uploads.reduce((sum, u) => sum + Number(u.price || 0), 0);
    if (total <= 0) return json({ error: "Nothing to charge" }, 400);

    const authHeaders = { "Content-Type": "application/json" };
    if (authCfg.api_key) authHeaders["X-API-Key"] = authCfg.api_key;
    const origin = new URL(request.url).origin;

    const orderItems = uploads.map((u) => ({
      source: "customer_supplied",
      title: `DTF gang sheet - ${u.filename} (${Math.round(u.width_mm || 0)}×${Math.round(u.height_mm || 0)}mm)`,
      unit_price: Number(u.price || 0),
      qty: 1,
    }));

    const createRes = await fetch(`${origin}/api/orders`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        doc_type: "invoice",
        customer_id: customer.id,
        customer_name: customer.name,
        customer_email: customer.email || "",
        items: orderItems,
        notes: "Created automatically from a DTF-Prep checkout.",
        source: "dtf-prep",
      }),
    });
    const created = await createRes.json();
    if (!createRes.ok || !created.success) {
      return json({ error: "Couldn't create your order - please try again shortly." }, 502);
    }
    const orderId = created.id;

    await db.prepare(`
      UPDATE gang_sheet_uploads SET order_id = ?, status = 'attached', attached_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).bind(orderId, ...uploadIds).run();

    // Approved credit accounts skip Square entirely and go straight on
    // account, as long as this order plus whatever they already owe stays
    // within their limit - re-checked here server-side, never trusted from
    // the client, same reasoning as every other price/entitlement check in
    // this endpoint's sibling files. Outside the limit (or no credit at
    // all) falls straight through to the existing Square flow below,
    // unchanged - this is the only new branch.
    if (customer.dtf_credit_status === "approved" && customer.dtf_credit_limit != null) {
      const outstandingRow = await db.prepare(`
        SELECT COALESCE(SUM(total - amount_paid), 0) AS outstanding FROM orders
        WHERE customer_id = ? AND doc_type = 'invoice' AND paid_status != 'paid' AND id != ?
      `).bind(customerId, orderId).first();
      const outstanding = (outstandingRow && outstandingRow.outstanding) || 0;

      if (outstanding + total <= Number(customer.dtf_credit_limit)) {
        return json({ success: true, invoiced_on_credit: true, order_id: orderId });
      }
    }

    const tokenRes = await fetch(`${origin}/api/orders`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ id: orderId, action: "ensure_pay_token" }),
    });
    const shared = await tokenRes.json();
    const payToken = shared && shared.pay_token;
    if (!tokenRes.ok || !payToken) {
      return json({ error: "Couldn't prepare payment for your order - please try again shortly." }, 502);
    }

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
          reference_id: orderId,
          line_items: uploads.map((u) => ({
            name: `DTF gang sheet (${Math.round(u.width_mm || 0)}×${Math.round(u.height_mm || 0)}mm)`.slice(0, 500),
            quantity: "1",
            base_price_money: { amount: Math.round(Number(u.price || 0) * 100), currency: "GBP" },
          })),
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

    return json({ success: true, checkout_url: checkoutUrl, order_id: orderId, pay_token: payToken });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
