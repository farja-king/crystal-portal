// Visual per-order production tracker - a customer's payment/quote status
// (tracked in orders.js) is a different thing from where the physical job
// actually is on the shop floor. Each order gets its own ordered list of
// steps (seeded with a sensible default the first time it's opened, then
// freely editable - add/rename/reorder/delete), each with optional notes
// and photos.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const DEFAULT_STEPS = [
    "Artwork approved",
    "Garments ordered",
    "In production",
    "Quality check",
    "Ready for collection/dispatch",
  ];

  if (!bucket) {
    return json({ error: "File storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS production_steps (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        notes TEXT,
        position INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_production_steps_order ON production_steps (order_id)").run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS production_step_images (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER DEFAULT 0,
        r2_key TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_production_step_images_step ON production_step_images (step_id)").run();

    const url = new URL(request.url);

    // Streams a step photo's bytes - same trust level as every other
    // internal image endpoint here (design-proofs.js, design-files.js),
    // not auth-gated beyond the portal's own login.
    if (request.method === "GET" && url.searchParams.get("view")) {
      const row = await db.prepare("SELECT * FROM production_step_images WHERE id = ?").bind(url.searchParams.get("view")).first();
      if (!row) return json({ error: "Image not found" }, 404);
      const obj = await bucket.get(row.r2_key);
      if (!obj) return json({ error: "File missing from storage" }, 404);
      return new Response(obj.body, {
        headers: {
          "Content-Type": row.content_type || "application/octet-stream",
          "Content-Disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // GET ?order_id=X - the whole tracker for one order, seeding the
    // default pipeline the very first time it's ever opened.
    if (request.method === "GET") {
      const orderId = url.searchParams.get("order_id");
      if (!orderId) return json({ error: "order_id is required" }, 400);

      const { results: existing } = await db.prepare(
        "SELECT id FROM production_steps WHERE order_id = ? LIMIT 1"
      ).bind(orderId).all();

      if (!existing.length) {
        for (let i = 0; i < DEFAULT_STEPS.length; i++) {
          await db.prepare(
            "INSERT INTO production_steps (id, order_id, title, position) VALUES (?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), orderId, DEFAULT_STEPS[i], i).run();
        }
      }

      const { results: steps } = await db.prepare(
        "SELECT * FROM production_steps WHERE order_id = ? ORDER BY position ASC"
      ).bind(orderId).all();
      const { results: images } = await db.prepare(
        "SELECT id, step_id, filename, content_type, created_at FROM production_step_images WHERE order_id = ? ORDER BY created_at ASC"
      ).bind(orderId).all();

      const imagesByStep = {};
      for (const img of images) {
        (imagesByStep[img.step_id] = imagesByStep[img.step_id] || []).push(img);
      }
      return json(steps.map((s) => ({ ...s, images: imagesByStep[s.id] || [] })));
    }

    if (request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";

      // Multipart - attaching a photo to a step.
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const stepId = form.get("step_id");
        const orderId = form.get("order_id");
        if (!stepId || !orderId) return json({ error: "step_id and order_id are required" }, 400);
        const file = form.get("file");
        if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
          return json({ error: "No file provided" }, 400);
        }
        const id = crypto.randomUUID();
        const key = `production-steps/${orderId}/${stepId}/${id}-${file.name}`;
        await bucket.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
        });
        await db.prepare(`
          INSERT INTO production_step_images (id, step_id, order_id, filename, content_type, size_bytes, r2_key)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(id, stepId, orderId, file.name, file.type || "application/octet-stream", file.size || 0, key).run();
        return json({ success: true, id });
      }

      // JSON - adds a new step at the end of this order's list.
      const data = await request.json();
      if (!data.order_id || !data.title) return json({ error: "order_id and title are required" }, 400);
      const { results: existing } = await db.prepare(
        "SELECT MAX(position) AS maxPos FROM production_steps WHERE order_id = ?"
      ).bind(data.order_id).all();
      const nextPos = (existing[0] && Number.isFinite(existing[0].maxPos) ? existing[0].maxPos : -1) + 1;
      const id = crypto.randomUUID();
      await db.prepare(
        "INSERT INTO production_steps (id, order_id, title, position) VALUES (?, ?, ?, ?)"
      ).bind(id, data.order_id, String(data.title).slice(0, 200), nextPos).run();
      return json({ success: true, id });
    }

    if (request.method === "PUT") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      const existing = await db.prepare("SELECT * FROM production_steps WHERE id = ?").bind(data.id).first();
      if (!existing) return json({ error: "Step not found" }, 404);

      // Swaps this step's position with the one immediately before/after it
      // - simple move up/down rather than free drag-and-drop.
      if (data.action === "move") {
        const { results: siblings } = await db.prepare(
          "SELECT id, position FROM production_steps WHERE order_id = ? ORDER BY position ASC"
        ).bind(existing.order_id).all();
        const idx = siblings.findIndex((s) => s.id === data.id);
        const swapIdx = data.direction === "up" ? idx - 1 : idx + 1;
        if (idx === -1 || swapIdx < 0 || swapIdx >= siblings.length) return json({ success: true });
        const a = siblings[idx], b = siblings[swapIdx];
        await db.prepare("UPDATE production_steps SET position = ? WHERE id = ?").bind(b.position, a.id).run();
        await db.prepare("UPDATE production_steps SET position = ? WHERE id = ?").bind(a.position, b.id).run();
        return json({ success: true });
      }

      const title = data.title !== undefined ? String(data.title).slice(0, 200) : existing.title;
      const notes = data.notes !== undefined ? String(data.notes).slice(0, 2000) : existing.notes;
      const status = data.status === "done" ? "done" : data.status === "pending" ? "pending" : existing.status;
      const completedAt = status === "done"
        ? (existing.status === "done" ? existing.completed_at : new Date().toISOString())
        : null;

      await db.prepare(
        "UPDATE production_steps SET title = ?, notes = ?, status = ?, completed_at = ? WHERE id = ?"
      ).bind(title, notes, status, completedAt, data.id).run();
      return json({ success: true });
    }

    if (request.method === "DELETE") {
      const data = await request.json();

      if (data.image_id) {
        const row = await db.prepare("SELECT r2_key FROM production_step_images WHERE id = ?").bind(data.image_id).first();
        if (row) {
          if (row.r2_key) await bucket.delete(row.r2_key);
          await db.prepare("DELETE FROM production_step_images WHERE id = ?").bind(data.image_id).run();
        }
        return json({ success: true });
      }

      if (!data.id) return json({ error: "id is required" }, 400);
      const { results: images } = await db.prepare(
        "SELECT r2_key FROM production_step_images WHERE step_id = ?"
      ).bind(data.id).all();
      await Promise.all(images.filter((i) => i.r2_key).map((i) => bucket.delete(i.r2_key).catch(() => {})));
      await db.prepare("DELETE FROM production_step_images WHERE step_id = ?").bind(data.id).run();
      await db.prepare("DELETE FROM production_steps WHERE id = ?").bind(data.id).run();
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
