// Upload endpoint for a customer's finished DTF-Prep gang sheet, plus their
// own upload history. Reachable only with a valid gang-sheet-session bearer
// token minted by functions/api/gang-sheet-auth.js's verify action -
// checked here in the file itself (see functions/_middleware.js's public
// exemption for this path, added alongside gang-sheet-auth's). There's no
// staff-facing path here at all; that's functions/api/gang-sheet-queue.js.
import { verifyCustomerToken } from "../_lib/customer-token.js";
import { ensureDtfCustomerColumns } from "../_lib/dtf-schema.js";

// Pricing is computed here, not trusted from the client, since this price is
// what gang-sheet-checkout.js later charges through Square. Must be kept in
// sync with DTF-Prep's own CONFIG in src/app.js if the rate ever changes -
// sheet width is fixed (the print bed), so only height/length feeds price.
const RATE_PER_MM = 10 / 600; // a full 600mm sheet prints at £10
const MIN_CHARGE_GBP = 5;
const UPSCALE_CHARGE_GBP = 0.5;

function round2(n) {
  return Math.round(n * 100) / 100;
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!db) return json({ error: "Database isn't set up yet" }, 500);
  if (!bucket) {
    return json({ error: "File storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  try {
    // gang-sheets/{customer_id}/{id}.png in the same DESIGN_FILES bucket
    // design-files.js already uses, under its own key prefix - reusing the
    // existing bucket rather than provisioning a new one.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS gang_sheet_uploads (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        width_mm REAL,
        height_mm REAL,
        price REAL,
        r2_key TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        order_id TEXT,
        seen_by_staff INTEGER DEFAULT 0,
        uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        attached_at TEXT
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_gsu_status ON gang_sheet_uploads (status)").run();
    await ensureDtfCustomerColumns(db);

    // Customer session auth - the only auth this endpoint accepts.
    const auth = request.headers.get("Authorization") || "";
    const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    if (!bearerToken) return json({ error: "Not authenticated" }, 401);

    const cfg = await db.prepare("SELECT customer_token_secret FROM auth_config WHERE id = 'default'").first();
    if (!cfg || !cfg.customer_token_secret) return json({ error: "Not authenticated" }, 401);

    const payload = await verifyCustomerToken(bearerToken, cfg.customer_token_secret);
    if (!payload || payload.purpose !== "gang-sheet-session" || !payload.customer_id) {
      return json({ error: "Your session has expired - please sign in again." }, 401);
    }
    const customerId = payload.customer_id;

    if (request.method === "GET") {
      const url = new URL(request.url);

      // ?view=<id> - streams the original file back, scoped to this
      // customer's own rows only. Used by the Account page's Reorder
      // button (pulls the original artwork back down to re-add to cart
      // unedited - see DTF-Prep's cart.js) - separate from admin's own
      // ?view= in gang-sheet-uploads.js, which is staff-only and unscoped.
      if (url.searchParams.get("view")) {
        const row = await db
          .prepare("SELECT * FROM gang_sheet_uploads WHERE id = ? AND customer_id = ?")
          .bind(url.searchParams.get("view"), customerId)
          .first();
        if (!row) return json({ error: "Not found" }, 404);
        const obj = await bucket.get(row.r2_key);
        if (!obj) return json({ error: "This file is no longer on our server - files are automatically removed 30 days after upload." }, 404);
        return new Response(obj.body, {
          headers: {
            "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png",
            "Cache-Control": "no-store",
          },
        });
      }

      // Always scoped to the token's own customer_id - never a
      // caller-supplied one, so one customer can't page through another's
      // upload history by guessing/passing a different id.
      //
      // dispatched_at - the most recent time this upload's order had a
      // "Ready for collection/dispatch" or "Order collected" production
      // step (see production-steps.js) marked done. Deleting your own file
      // is only allowed 15 days after that (see the "delete" action below)
      // - production isn't necessarily finished the moment an order is
      // paid, and deleting the artwork before it's actually been
      // printed/dispatched would leave nothing to produce it from.
      const { results } = await db.prepare(`
        SELECT u.id, u.filename, u.width_mm, u.height_mm, u.price, u.status, u.uploaded_at, u.attached_at, u.order_id,
               o.pay_token AS order_pay_token,
               (
                 SELECT MAX(completed_at) FROM production_steps ps
                 WHERE ps.order_id = u.order_id AND ps.status = 'done'
                   AND (ps.title LIKE '%dispatch%' OR ps.title LIKE '%collect%')
               ) AS dispatched_at
        FROM gang_sheet_uploads u
        LEFT JOIN orders o ON o.id = u.order_id
        WHERE u.customer_id = ? ORDER BY u.uploaded_at DESC
      `).bind(customerId).all();

      const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
      const rows = results.map((r) => ({
        ...r,
        can_delete: !!(r.dispatched_at && Date.now() - new Date(r.dispatched_at).getTime() >= FIFTEEN_DAYS_MS),
      }));
      return json(rows);
    }

    if (request.method === "POST") {
      const contentType = request.headers.get("Content-Type") || "";

      // JSON body -> an action on an existing row, not a new upload.
      if (contentType.includes("application/json")) {
        const data = await request.json();

        if (data.action === "delete") {
          if (!data.id) return json({ error: "id is required" }, 400);
          const row = await db
            .prepare("SELECT * FROM gang_sheet_uploads WHERE id = ? AND customer_id = ?")
            .bind(data.id, customerId)
            .first();
          if (!row) return json({ error: "Not found" }, 404);

          // Re-checked here, not trusted from the client - see the GET
          // listing's dispatched_at/can_delete comment above for why.
          const step = await db.prepare(`
            SELECT MAX(completed_at) AS dispatched_at FROM production_steps
            WHERE order_id = ? AND status = 'done' AND (title LIKE '%dispatch%' OR title LIKE '%collect%')
          `).bind(row.order_id).first();
          const dispatchedAt = step && step.dispatched_at;
          const canDelete = !!(dispatchedAt && Date.now() - new Date(dispatchedAt).getTime() >= 15 * 24 * 60 * 60 * 1000);
          if (!canDelete) {
            return json({ error: "This file can't be deleted yet - it becomes deletable 15 days after your order is marked dispatched/collected." }, 403);
          }

          if (row.r2_key) {
            try {
              await bucket.delete(row.r2_key);
            } catch {
              // R2 object already gone - fine, still remove the DB row below.
            }
          }
          await db.prepare("DELETE FROM gang_sheet_uploads WHERE id = ?").bind(data.id).run();
          return json({ success: true });
        }

        return json({ error: "Unknown action" }, 400);
      }

      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
        return json({ error: "No file provided" }, 400);
      }

      const id = crypto.randomUUID();
      const key = `gang-sheets/${customerId}/${id}.png`;
      const buffer = await file.arrayBuffer();
      await bucket.put(key, buffer, { httpMetadata: { contentType: file.type || "image/png" } });

      const widthMm = Number(form.get("width_mm")) || null;
      const heightMm = Number(form.get("height_mm")) || 0;
      const upscaleCount = Math.max(0, parseInt(form.get("upscale_count"), 10) || 0);

      // A trade/bespoke customer's own fixed sheet price (set on their
      // customer record - see customers.js) replaces the standard
      // length-based rate entirely, any length up to the max costs the same.
      // Looked up here, not trusted from the client, for the same reason
      // the standard price isn't: this is what actually gets charged.
      //
      // dtf_account_tier === 'registered' - a customer who's completed
      // their profile (see gang-sheet-account.js) waives the upscale charge
      // entirely; 'guest' (or NULL, shouldn't happen once auth is required
      // to reach this endpoint) still pays it. Also looked up here rather
      // than trusted from the client, same reasoning.
      const customerRow = await db.prepare("SELECT dtf_flat_sheet_price, dtf_account_tier FROM customers WHERE id = ?").bind(customerId).first();
      const flatPrice = customerRow && customerRow.dtf_flat_sheet_price != null ? Number(customerRow.dtf_flat_sheet_price) : null;
      const upscaleIsFree = customerRow && customerRow.dtf_account_tier === "registered";
      const price = round2(
        (flatPrice != null ? flatPrice : Math.max(heightMm * RATE_PER_MM, MIN_CHARGE_GBP)) + (upscaleIsFree ? 0 : upscaleCount * UPSCALE_CHARGE_GBP)
      );
      const filename = file.name || `gang-sheet-${id}.png`;

      await db.prepare(`
        INSERT INTO gang_sheet_uploads (id, customer_id, filename, width_mm, height_mm, price, r2_key, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, customerId, filename, widthMm, heightMm, price, key, buffer.byteLength).run();

      return json({ success: true, id });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
