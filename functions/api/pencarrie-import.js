// Full PenCarrie catalog import - genuine new-item + cost-price import, not
// just the colour/size backfill import-colours-sizes.js does. Source is
// PenCarrie's own trade-pricing export (one row per real SKU: style code +
// colourway + size, with Single/Pack/Carton List Price tiers and a VAT Rate)
// - a completely different, richer file than the Shopify-style product
// export used for colour/size only. Carton List Price is used as cost_price
// (confirmed against a real invoice: PenCarrie account pays the Carton tier).
//
// Upserts by matching (supplier_code, colour, size) against the existing
// shared catalog, NOT by a generated id - the original catalog seed used an
// unknown id scheme (done outside this app, before this import existed), so
// generating a fresh id per row and upserting on THAT would silently create
// duplicate rows for every product already in the catalog instead of
// updating them. Matching on the natural key finds the real existing row
// (if any) and updates it in place; only genuinely new (code, colour, size)
// combinations get a freshly generated id.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  const profitOf = (sell, cost, vatRate = 0.2) => {
    if (sell === null || sell === undefined || sell === "") return null;
    const totalCost = Number(cost || 0) * (1 + (Number(vatRate) || 0));
    return Math.round((Number(sell) - totalCost + Number.EPSILON) * 100) / 100;
  };

  try {
    for (const col of ["image_url TEXT", "colour_code TEXT"]) {
      try { await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run(); } catch { /* already exists */ }
    }

    const body = await request.json().catch(() => ({}));
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json({ error: "No rows in payload" }, 400);

    // 1. Bulk-lookup existing rows for every code in this chunk, so each row
    // below can tell "update this real existing row" from "this is genuinely
    // new" without a per-row round trip.
    const codes = [...new Set(rows.map((r) => String(r.code || "").trim().toUpperCase()).filter(Boolean))];
    const existingMap = new Map(); // `${code}|${colour}|${size}` -> id
    const IN_CHUNK = 50;
    for (let i = 0; i < codes.length; i += IN_CHUNK) {
      const chunkCodes = codes.slice(i, i + IN_CHUNK);
      const placeholders = chunkCodes.map(() => "?").join(",");
      const { results } = await db.prepare(
        `SELECT id, supplier_code, colour, size FROM products WHERE UPPER(supplier_code) IN (${placeholders}) AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL`
      ).bind(...chunkCodes).all();
      for (const r of results) {
        existingMap.set(`${r.supplier_code.toUpperCase()}|${r.colour}|${r.size}`, r.id);
      }
    }

    // 2. Upsert - existing rows keep their real id (and their sell_price -
    // same protection products.js's own bulk import uses), new combinations
    // get a freshly generated one.
    const stmt = db.prepare(`
      INSERT INTO products (
        id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
        category, cost_price, surcharge_category, vat_rate, sell_price, profit, active,
        image_url, colour_code, updated_at
      ) VALUES (?, 'PenCarrie', ?, '', ?, ?, ?, ?, ?, ?, '', ?, NULL, NULL, 1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        supplier = 'PenCarrie',
        supplier_code = excluded.supplier_code,
        brand = excluded.brand,
        title = excluded.title,
        colour = excluded.colour,
        size = excluded.size,
        category = excluded.category,
        cost_price = excluded.cost_price,
        vat_rate = excluded.vat_rate,
        active = excluded.active,
        image_url = excluded.image_url,
        colour_code = excluded.colour_code,
        profit = CASE WHEN products.sell_price IS NULL THEN NULL ELSE ROUND(products.sell_price - excluded.cost_price, 2) END,
        updated_at = CURRENT_TIMESTAMP
    `);

    const batch = [];
    let newItems = 0;
    let updatedItems = 0;

    for (const r of rows) {
      const code = String(r.code || "").trim().toUpperCase();
      const colour = String(r.colour || "").trim();
      const size = String(r.size || "").trim();
      if (!code) continue;
      const cost = Number(r.cost_price);
      if (!isFinite(cost)) continue;

      const key = `${code}|${colour}|${size}`;
      let id = existingMap.get(key);
      if (id) { updatedItems++; } else { id = "pencarrie-" + slugify(code) + "-" + slugify(colour) + "-" + slugify(size); newItems++; }

      const vatRate = r.vat_rate === undefined || r.vat_rate === null || r.vat_rate === "" ? 0.2 : Number(r.vat_rate);

      batch.push(stmt.bind(
        id, code, r.brand || "", r.title || "", colour, size,
        r.category || "", cost, vatRate, r.image_url || "", r.colour_code || ""
      ));
    }

    const CHUNK_SIZE = 50;
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      await db.batch(batch.slice(i, i + CHUNK_SIZE));
    }

    return json({ success: true, processed: batch.length, new_items: newItems, updated_items: updatedItems });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
