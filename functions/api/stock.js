// Manual stock/inventory tracking - deliberately its own item list, not
// linked to the Garments/Services catalog (products.js) or any supplier
// sync. A stock item is "a specific colour/size of something physical
// sitting on a shelf" (brand PenCarrie, Uneek, or a manually-added one-off),
// not a pricing-tier catalog row - the two things happen to share fields
// like colour/size but are conceptually different, and conflating them
// would mean a catalog price change accidentally touching stock counts or
// vice versa.
//
// Quantity is never edited directly - every change (add or subtract) goes
// through the "adjust" action below and is logged to stock_movements, same
// ledger-over-raw-number philosophy as payments.js: quantity on the item
// row is a denormalized running total, always recomputed from the
// movements that actually happened, never trusted as a value handed in
// from the client.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS stock_items (
        id TEXT PRIMARY KEY,
        item TEXT NOT NULL,
        supplier_code TEXT,
        brand TEXT,
        colour TEXT,
        size TEXT,
        quantity REAL DEFAULT 0,
        cost_price REAL DEFAULT 0,
        sale_price REAL DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    // supplier_code (the garment catalog's reference code, e.g. RX101) was
    // added after this table already existed on live D1 - IF NOT EXISTS
    // above is a no-op against an existing table, so it needs adding here
    // too, same pattern as products.js. Purely informational: never used to
    // link back to the catalog row it was copied from (see
    // pickStockGarmentResult/applyStockGarmentVariant in admin.html).
    try {
      await db.prepare("ALTER TABLE stock_items ADD COLUMN supplier_code TEXT").run();
    } catch {
      // already exists
    }

    // The actual ledger - every add/subtract, with why. reason is free text
    // (e.g. "Delivery from PenCarrie", "Used on INV-0042", "Damaged/written
    // off") rather than a fixed enum - stock gets adjusted for enough
    // different real-world reasons that a closed list would just get a
    // "other" bucket everyone uses anyway.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        stock_item_id TEXT NOT NULL,
        delta REAL NOT NULL,
        reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements (stock_item_id)").run();

    async function recomputeQuantity(itemId) {
      const row = await db.prepare("SELECT COALESCE(SUM(delta), 0) AS total FROM stock_movements WHERE stock_item_id = ?").bind(itemId).first();
      const qty = row ? row.total : 0;
      await db.prepare("UPDATE stock_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(qty, itemId).run();
      return qty;
    }

    const url = new URL(request.url);

    // GET ?movements_for=X - the adjustment history for one item, newest
    // first, for the "Recent activity" panel on that item's row.
    if (request.method === "GET" && url.searchParams.get("movements_for")) {
      const { results } = await db.prepare(
        "SELECT * FROM stock_movements WHERE stock_item_id = ? ORDER BY created_at DESC"
      ).bind(url.searchParams.get("movements_for")).all();
      return json(results);
    }

    if (request.method === "GET") {
      const { results } = await db.prepare("SELECT * FROM stock_items ORDER BY item ASC, colour ASC, size ASC").all();
      return json(results);
    }

    // Shared by a single POST body and each row of a { rows: [...] } bulk
    // POST (see Bulk Add Stock in admin.html) - one insert, one optional
    // "Initial stock" movement, same as before.
    async function insertStockItem(data) {
      const item = String(data.item || "").trim();
      if (!item) return { error: "Item name is required" };

      const id = crypto.randomUUID();
      await db.prepare(`
        INSERT INTO stock_items (id, item, supplier_code, brand, colour, size, cost_price, sale_price, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, item,
        String(data.supplier_code || "").trim(),
        String(data.brand || "").trim(),
        String(data.colour || "").trim(),
        String(data.size || "").trim(),
        Number(data.cost_price) || 0,
        Number(data.sale_price) || 0,
        String(data.notes || "").trim()
      ).run();

      // An initial quantity is just the first movement, not a special
      // "starting balance" field - keeps the ledger the single source of
      // truth from the very first row, no separate concept to reconcile
      // against later.
      const initialQty = Number(data.quantity) || 0;
      if (initialQty) {
        await db.prepare(
          "INSERT INTO stock_movements (id, stock_item_id, delta, reason) VALUES (?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), id, initialQty, "Initial stock").run();
        await recomputeQuantity(id);
      }

      return { id };
    }

    if (request.method === "POST") {
      const data = await request.json();

      // Bulk Add Stock: several lines queued client-side (search a code,
      // pick colour/size, repeat), all saved together in one request rather
      // than one round-trip per line. A line with no item name is skipped
      // rather than failing the whole batch - shouldn't happen from the UI,
      // but a partial batch (everything valid still saved) beats losing
      // everything typed so far over one bad row.
      if (Array.isArray(data.rows)) {
        let imported = 0;
        for (const row of data.rows) {
          const result = await insertStockItem(row);
          if (!result.error) imported++;
        }
        return json({ success: true, imported });
      }

      const result = await insertStockItem(data);
      if (result.error) return json({ error: result.error }, 400);
      return json({ success: true, id: result.id });
    }

    if (request.method === "PUT") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      const existing = await db.prepare("SELECT * FROM stock_items WHERE id = ?").bind(data.id).first();
      if (!existing) return json({ error: "Stock item not found" }, 404);

      // The only way quantity ever changes - a plain field edit (below)
      // deliberately can't touch it, so there's exactly one path in and
      // out of the ledger.
      if (data.action === "adjust") {
        const delta = Number(data.delta);
        if (!delta) return json({ error: "delta must be a non-zero number" }, 400);
        await db.prepare(
          "INSERT INTO stock_movements (id, stock_item_id, delta, reason) VALUES (?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), data.id, delta, String(data.reason || "").trim()).run();
        const quantity = await recomputeQuantity(data.id);
        return json({ success: true, quantity });
      }

      await db.prepare(`
        UPDATE stock_items SET item = ?, supplier_code = ?, brand = ?, colour = ?, size = ?, cost_price = ?, sale_price = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        String(data.item || existing.item).trim(),
        data.supplier_code !== undefined ? String(data.supplier_code).trim() : existing.supplier_code,
        data.brand !== undefined ? String(data.brand).trim() : existing.brand,
        data.colour !== undefined ? String(data.colour).trim() : existing.colour,
        data.size !== undefined ? String(data.size).trim() : existing.size,
        data.cost_price !== undefined ? Number(data.cost_price) || 0 : existing.cost_price,
        data.sale_price !== undefined ? Number(data.sale_price) || 0 : existing.sale_price,
        data.notes !== undefined ? String(data.notes).trim() : existing.notes,
        data.id
      ).run();
      return json({ success: true });
    }

    if (request.method === "DELETE") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      await db.prepare("DELETE FROM stock_movements WHERE stock_item_id = ?").bind(data.id).run();
      await db.prepare("DELETE FROM stock_items WHERE id = ?").bind(data.id).run();
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
