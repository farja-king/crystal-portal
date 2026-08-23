// Staff-facing lookup for DTF-Prep gang sheets - the per-order thumbnail on
// an invoice's detail view, and the "DTF Gang Sheets" dashboard (a sub-tab
// of Design Proofs) showing every upload across every customer at a glance.
// Normal portal-password gate (no public exemption needed here, unlike
// gang-sheet-upload.js/gang-sheet-checkout.js, which are the customer-facing
// side of this same data).
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!db) return json({ error: "Database isn't set up yet" }, 500);

  // keep_file - the "Keep file" toggle on the DTF Gang Sheets dashboard.
  // Exempts an upload from the 30-day cleanup sweep (gang-sheet-cleanup.js)
  // and, if its order is ever deleted, from being removed along with it
  // (see deleteOrphanedGangSheetUploads in orders.js) - it's just detached
  // instead. Guarded here too, not just in gang-sheet-upload.js, since this
  // file is just as likely to be the first one hit on a cold deploy.
  try {
    await db.prepare(`ALTER TABLE gang_sheet_uploads ADD COLUMN keep_file INTEGER DEFAULT 0`).run();
  } catch {
    // already exists
  }

  // The dashboard's "new orders" popup (mark_seen) and the Keep file
  // toggle (set_keep) don't need R2 at all, so they're handled before the
  // bucket guard below - no reason to block them just because file storage
  // happens to be misconfigured.
  if (request.method === "POST" || request.method === "PUT") {
    try {
      const data = await request.json();
      if (data.action === "mark_seen") {
        await db.prepare(
          "UPDATE gang_sheet_uploads SET seen_by_staff = 1 WHERE status = 'attached' AND seen_by_staff = 0"
        ).run();
        return json({ success: true });
      }
      if (data.action === "set_keep") {
        if (!data.id) return json({ error: "id is required" }, 400);
        await db.prepare("UPDATE gang_sheet_uploads SET keep_file = ? WHERE id = ?").bind(data.keep ? 1 : 0, data.id).run();
        return json({ success: true });
      }
      return json({ error: "Unknown action" }, 400);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!bucket) {
    return json({ error: "File storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  try {
    const url = new URL(request.url);

    // Cheap COUNT for the dashboard's "you have N new orders" popup - counts
    // distinct orders, not upload rows, since a checkout can attach more
    // than one gang sheet to the same order (one popup per order, not one
    // per sheet).
    if (url.searchParams.get("count_new")) {
      const row = await db.prepare(
        "SELECT COUNT(DISTINCT order_id) AS n FROM gang_sheet_uploads WHERE status = 'attached' AND seen_by_staff = 0 AND order_id IS NOT NULL"
      ).first();
      return json({ count: (row && row.n) || 0 });
    }

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

    // ?all=1 - the DTF Gang Sheets dashboard: every upload across every
    // customer, newest first, joined to customer/order info for display.
    // LEFT JOINs since a kept-but-detached upload (its order was deleted)
    // or a not-yet-attached one still needs to show up here.
    if (url.searchParams.get("all")) {
      const { results } = await db.prepare(`
        SELECT u.id, u.filename, u.width_mm, u.height_mm, u.price, u.status, u.keep_file, u.uploaded_at, u.order_id,
               c.name AS customer_name, o.doc_type, o.invoice_number, o.quote_number
        FROM gang_sheet_uploads u
        LEFT JOIN customers c ON c.id = u.customer_id
        LEFT JOIN orders o ON o.id = u.order_id
        ORDER BY u.uploaded_at DESC
      `).all();
      return json(results);
    }

    const orderId = url.searchParams.get("order_id");
    if (!orderId) return json({ error: "order_id is required" }, 400);
    const { results } = await db.prepare(`
      SELECT id, filename, width_mm, height_mm, price, status, keep_file, uploaded_at
      FROM gang_sheet_uploads WHERE order_id = ? ORDER BY uploaded_at DESC
    `).bind(orderId).all();
    return json(results);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
