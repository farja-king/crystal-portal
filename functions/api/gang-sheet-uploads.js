// Staff-facing lookup for DTF-Prep gang sheets attached to an order - shows
// the actual artwork on an invoice's detail view in admin.html. Normal
// portal-password gate (no public exemption needed here, unlike
// gang-sheet-upload.js/gang-sheet-checkout.js, which are the customer-facing
// side of this same data).
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!db) return json({ error: "Database isn't set up yet" }, 500);
  if (!bucket) {
    return json({ error: "File storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  try {
    const url = new URL(request.url);

    // Streams the actual PNG - same pattern as design-files.js's ?view=.
    // gang_sheet_uploads has no content_type column (every upload is a PNG
    // by construction, see gang-sheet-upload.js), so fall back to the type
    // R2 itself stored at upload time, then to image/png.
    if (url.searchParams.get("view")) {
      const row = await db.prepare("SELECT * FROM gang_sheet_uploads WHERE id = ?").bind(url.searchParams.get("view")).first();
      if (!row) return json({ error: "Not found" }, 404);
      const obj = await bucket.get(row.r2_key);
      if (!obj) return json({ error: "File missing from storage" }, 404);
      return new Response(obj.body, {
        headers: {
          "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png",
          "Cache-Control": "no-store",
        },
      });
    }

    const orderId = url.searchParams.get("order_id");
    if (!orderId) return json({ error: "order_id is required" }, 400);
    const { results } = await db.prepare(`
      SELECT id, filename, width_mm, height_mm, price, status, uploaded_at
      FROM gang_sheet_uploads WHERE order_id = ? ORDER BY uploaded_at DESC
    `).bind(orderId).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
