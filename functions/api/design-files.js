// Per-customer embroidery design file backup (DST/EMB/PDF/etc, whatever
// Hatch or the supplier hands over) - stored in R2 (env.DESIGN_FILES bucket
// binding), with D1 holding just the lightweight metadata row per file.
// D1 is a bad place for the actual bytes (bloats every query at scale); R2
// is built for exactly this and is effectively free at the sizes involved
// here. See the "CUSTOMERS DESIGNS" folder this is backing up - deliberately
// scoped to that one, not the separate Karl Sports design library.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!bucket) {
    return json({ error: "Design file storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS design_files (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER DEFAULT 0,
        r2_key TEXT NOT NULL,
        uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_design_files_customer ON design_files (customer_id)").run();

    const url = new URL(request.url);

    // Streams the actual file bytes back from R2 - a plain GET with
    // ?download=<file id> rather than its own route, so a simple <a href>
    // in the customer view can trigger it directly.
    if (request.method === "GET" && url.searchParams.get("download")) {
      const id = url.searchParams.get("download");
      const row = await db.prepare("SELECT * FROM design_files WHERE id = ?").bind(id).first();
      if (!row) return json({ error: "File not found" }, 404);

      const obj = await bucket.get(row.r2_key);
      if (!obj) return json({ error: "File missing from storage" }, 404);

      return new Response(obj.body, {
        headers: {
          "Content-Type": row.content_type || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // GET ?customer_id=X - list of files on file for one customer.
    if (request.method === "GET") {
      const customerId = url.searchParams.get("customer_id");
      if (!customerId) return json({ error: "customer_id is required" }, 400);
      const { results } = await db.prepare(
        "SELECT id, customer_id, filename, content_type, size_bytes, uploaded_at FROM design_files WHERE customer_id = ? ORDER BY uploaded_at DESC"
      ).bind(customerId).all();
      return json(results);
    }

    // POST multipart/form-data: fields "customer_id" and one or more "file".
    if (request.method === "POST") {
      const form = await request.formData();
      const customerId = form.get("customer_id");
      if (!customerId) return json({ error: "customer_id is required" }, 400);

      const files = form.getAll("file").filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
      if (!files.length) return json({ error: "No file(s) provided" }, 400);

      const saved = [];
      for (const file of files) {
        const id = crypto.randomUUID();
        const key = `customer-designs/${customerId}/${id}-${file.name}`;
        await bucket.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
        });
        await db.prepare(`
          INSERT INTO design_files (id, customer_id, filename, content_type, size_bytes, r2_key)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(id, customerId, file.name, file.type || "application/octet-stream", file.size || 0, key).run();
        saved.push({ id, filename: file.name, size_bytes: file.size || 0 });
      }

      return json({ success: true, saved });
    }

    if (request.method === "DELETE") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      const row = await db.prepare("SELECT r2_key FROM design_files WHERE id = ?").bind(data.id).first();
      if (row) {
        await bucket.delete(row.r2_key);
        await db.prepare("DELETE FROM design_files WHERE id = ?").bind(data.id).run();
      }
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
