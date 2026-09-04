// Live replacement for the manual "Import UNEEK" CSV upload (see
// importUneekCsv in admin.html) - pulls the same account-specific product
// data straight from Uneek's own API (GET /productdata/all, HTTP Basic
// Auth) instead of a hand-downloaded *ProdData.csv export. Same upsert
// shape/id scheme as the CSV path so either one can run and update the
// same catalog rows (id = 'uneek-' + code + '-' + colour + '-' + size).
//
// Credentials are never in this file - UNEEK_EMAIL / UNEEK_PASSWORD (and
// optionally UNEEK_CUSTOMER_NO) must be set as encrypted secrets on the
// Cloudflare Pages project (Settings > Environment variables > Production),
// same pattern as SQUARE_ACCESS_TOKEN etc in square-webhook.js.
import { fetchUneekRawText } from "../_lib/uneek.js";

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

  if (!env.UNEEK_EMAIL || !env.UNEEK_PASSWORD) {
    return json({ error: "UNEEK_EMAIL / UNEEK_PASSWORD not configured as Cloudflare secrets" }, 500);
  }

  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  const profitOf = (sell, cost, vatRate = 0.2) => {
    if (sell === null || sell === undefined || sell === "") return null;
    const totalCost = Number(cost || 0) * (1 + (Number(vatRate) || 0));
    return Math.round((Number(sell) - totalCost + Number.EPSILON) * 100) / 100;
  };

  try {
    for (const col of ["available_colours TEXT DEFAULT '[]'", "available_sizes TEXT DEFAULT '[]'", "variant_data TEXT DEFAULT '[]'"]) {
      try { await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run(); } catch { /* already exists */ }
    }
    // Guarded here too - same defensive duplication as pencarrie-import.js.
    await db.prepare(`CREATE TABLE IF NOT EXISTS product_variant_index (variant_id TEXT PRIMARY KEY, product_id TEXT NOT NULL)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_variant_index_product ON product_variant_index (product_id)`).run();

    function parseTiers(row) {
      let tiers = null;
      try { tiers = JSON.parse(row.variant_data || "[]"); } catch { tiers = null; }
      if (!Array.isArray(tiers) || !tiers.length) {
        return [{ id: row.id, colour: row.colour || "", size: row.size || "", sell_price: row.sell_price ?? null }];
      }
      return tiers;
    }

    // fetchUneekRawText() already unwraps Uneek's double-encoding (see
    // functions/_lib/uneek.js). This full-catalog parse (thousands of rows)
    // is exactly what blows Cloudflare's per-request CPU limit on anything
    // but a paid Workers plan - see uneek-product.js for the CPU-cheap
    // per-code alternative "Publish to website" uses instead.
    let text;
    try {
      text = await fetchUneekRawText(env);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      return json({ error: `Could not parse Uneek response: ${e.message}` }, 502);
    }
    const rawRows = Array.isArray(payload)
      ? payload
      : Object.values(payload || {}).find((v) => Array.isArray(v)) || [];

    if (!rawRows.length) return json({ error: "Uneek API returned no product rows" }, 502);

    const productRows = [];
    const colourByCode = {};
    const sizeByCode = {};

    for (const r of rawRows) {
      const code = String(r.ProductCode || "").trim();
      const price = Number(r.MyPrice);
      if (!code || !isFinite(price)) continue;

      const colour = String(r.Colour || "").trim();
      const size = String(r.Size || "").trim();
      const vatRate = String(r.TaxCode || "").trim().toUpperCase() === "ZERORATED" ? 0 : 0.2;

      if (colour) (colourByCode[code] || (colourByCode[code] = new Set())).add(colour);
      if (size) (sizeByCode[code] || (sizeByCode[code] = new Set())).add(size);

      productRows.push({
        id: "uneek-" + slugify(code) + "-" + slugify(colour) + "-" + slugify(size),
        supplier: "UNEEK",
        supplier_code: code,
        brand: "UNEEK",
        title: String(r.ProductName || "").trim(),
        colour,
        size,
        category: String(r.Category || "").trim(),
        cost_price: price,
        vat_rate: vatRate,
      });
    }

    if (!productRows.length) return json({ error: "No usable rows after parsing Uneek response" }, 502);

    // Consolidated write path (see products.js's file header) - one physical
    // row per code, tiers merged into its variant_data, instead of one
    // physical row per exact colour+size. Existing tiers keep whatever
    // sell_price is already on them (this sync only ever supplies cost, so
    // there's nothing to "preserve vs overwrite" for a brand-new tier -
    // it simply starts unpriced, same as before).
    const codes = [...new Set(productRows.map((r) => r.supplier_code))];
    const productIdByCode = new Map(); // code -> id of the code's active consolidated row (if any)
    const existingTierMap = new Map(); // tier id -> current tier object

    const IN_CHUNK = 50;
    for (let i = 0; i < codes.length; i += IN_CHUNK) {
      const chunkCodes = codes.slice(i, i + IN_CHUNK);
      const placeholders = chunkCodes.map(() => "?").join(",");
      const { results } = await db.prepare(
        `SELECT * FROM products WHERE UPPER(supplier_code) IN (${placeholders}) AND id LIKE 'uneek-%' AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL`
      ).bind(...chunkCodes.map((c) => c.toUpperCase())).all();
      for (const row of results) {
        productIdByCode.set(row.supplier_code, row.id);
        for (const t of parseTiers(row)) existingTierMap.set(t.id, t);
      }
    }

    const tiersByCode = new Map();
    for (const r of productRows) {
      const existing = existingTierMap.get(r.id);
      const tier = {
        id: r.id, colour: r.colour, size: r.size, cost_price: r.cost_price, vat_rate: r.vat_rate,
        sell_price: existing ? (existing.sell_price ?? null) : null,
        colour_code: existing ? (existing.colour_code || "") : "",
        image_url: existing ? (existing.image_url || "") : "",
      };
      if (!tiersByCode.has(r.supplier_code)) tiersByCode.set(r.supplier_code, { brand: r.brand, title: r.title, category: r.category, tiers: [] });
      tiersByCode.get(r.supplier_code).tiers.push(tier);
    }

    const pending = [];
    let imported = 0;
    for (const [code, group] of tiersByCode) {
      const existingProductId = productIdByCode.get(code);
      let mergedTiers, targetRowId;
      if (existingProductId) {
        const row = await db.prepare("SELECT * FROM products WHERE id = ?").bind(existingProductId).first();
        const byId = new Map(parseTiers(row).map((t) => [t.id, t]));
        for (const t of group.tiers) byId.set(t.id, t);
        mergedTiers = [...byId.values()];
        targetRowId = existingProductId;
      } else {
        mergedTiers = group.tiers;
        targetRowId = group.tiers[0].id;
      }
      imported += group.tiers.length;

      const defaultTier = mergedTiers[0];
      if (existingProductId) {
        pending.push(db.prepare(`
          UPDATE products SET supplier = 'UNEEK', brand = ?, title = ?, category = ?, variant_data = ?,
            colour = ?, size = ?, cost_price = ?, vat_rate = ?, sell_price = ?, profit = ?, active = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          group.brand, group.title, group.category, JSON.stringify(mergedTiers),
          defaultTier.colour, defaultTier.size, defaultTier.cost_price, defaultTier.vat_rate, defaultTier.sell_price,
          profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate), targetRowId
        ));
      } else {
        pending.push(db.prepare(`
          INSERT INTO products (
            id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
            category, cost_price, surcharge_category, vat_rate, sell_price, profit, active, variant_data, updated_at
          ) VALUES (?, 'UNEEK', ?, '', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
        `).bind(
          targetRowId, code, group.brand, group.title, defaultTier.colour, defaultTier.size,
          group.category, defaultTier.cost_price, defaultTier.vat_rate, defaultTier.sell_price,
          profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate), JSON.stringify(mergedTiers)
        ));
      }
      for (const t of group.tiers) {
        pending.push(db.prepare(
          `INSERT INTO product_variant_index (variant_id, product_id) VALUES (?, ?) ON CONFLICT(variant_id) DO UPDATE SET product_id = excluded.product_id`
        ).bind(t.id, targetRowId));
      }
    }

    const CHUNK_SIZE = 50;
    for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
      await db.batch(pending.slice(i, i + CHUNK_SIZE));
    }

    // Fill available_colours/available_sizes the same way import-colours-sizes.js does.
    const colourStmt = db.prepare(`
      UPDATE products SET available_colours = ?, available_sizes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE UPPER(supplier_code) = UPPER(?)
    `);
    const facetCodes = [...new Set([...Object.keys(colourByCode), ...Object.keys(sizeByCode)])];
    for (let i = 0; i < facetCodes.length; i += CHUNK_SIZE) {
      const chunk = facetCodes.slice(i, i + CHUNK_SIZE);
      await db.batch(chunk.map((code) => colourStmt.bind(
        JSON.stringify([...(colourByCode[code] || [])]),
        JSON.stringify([...(sizeByCode[code] || [])]),
        code
      )));
    }

    return json({
      success: true,
      imported,
      codes: facetCodes.length,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
