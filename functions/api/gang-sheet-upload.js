// Upload endpoint for a customer's finished DTF-Prep gang sheet, plus their
// own upload history. Reachable only with a valid gang-sheet-session bearer
// token minted by functions/api/gang-sheet-auth.js's verify action -
// checked here in the file itself (see functions/_middleware.js's public
// exemption for this path, added alongside gang-sheet-auth's). There's no
// staff-facing path here at all; that's functions/api/gang-sheet-queue.js.
import { verifyCustomerToken } from "../_lib/customer-token.js";

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
      // Always scoped to the token's own customer_id - never a
      // caller-supplied one, so one customer can't page through another's
      // upload history by guessing/passing a different id.
      const { results } = await db.prepare(`
        SELECT id, filename, width_mm, height_mm, price, status, uploaded_at, attached_at
        FROM gang_sheet_uploads WHERE customer_id = ? ORDER BY uploaded_at DESC
      `).bind(customerId).all();
      return json(results);
    }

    if (request.method === "POST") {
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
      const customerRow = await db.prepare("SELECT dtf_flat_sheet_price FROM customers WHERE id = ?").bind(customerId).first();
      const flatPrice = customerRow && customerRow.dtf_flat_sheet_price != null ? Number(customerRow.dtf_flat_sheet_price) : null;
      const price = round2(
        (flatPrice != null ? flatPrice : Math.max(heightMm * RATE_PER_MM, MIN_CHARGE_GBP)) + upscaleCount * UPSCALE_CHARGE_GBP
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
