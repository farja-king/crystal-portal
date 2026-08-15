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
    for (const col of ["available_colours TEXT DEFAULT '[]'", "available_sizes TEXT DEFAULT '[]'"]) {
      try { await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run(); } catch { /* already exists */ }
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

    const stmt = db.prepare(`
      INSERT INTO products (
        id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
        category, cost_price, surcharge_category, vat_rate, sell_price, profit, active, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, '', ?, NULL, NULL, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        supplier = excluded.supplier,
        supplier_code = excluded.supplier_code,
        brand = excluded.brand,
        title = excluded.title,
        colour = excluded.colour,
        size = excluded.size,
        category = excluded.category,
        cost_price = excluded.cost_price,
        vat_rate = excluded.vat_rate,
        active = excluded.active,
        profit = CASE WHEN products.sell_price IS NULL THEN NULL ELSE ROUND(products.sell_price - excluded.cost_price, 2) END,
        updated_at = CURRENT_TIMESTAMP
    `);

    const batch = productRows.map((r) => stmt.bind(
      r.id, r.supplier, r.supplier_code, r.brand, r.title, r.colour, r.size, r.category, r.cost_price, r.vat_rate
    ));

    const CHUNK_SIZE = 50;
    let imported = 0;
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      await db.batch(batch.slice(i, i + CHUNK_SIZE));
      imported += Math.min(CHUNK_SIZE, batch.length - i);
    }

    // Fill available_colours/available_sizes the same way import-colours-sizes.js does.
    const colourStmt = db.prepare(`
      UPDATE products SET available_colours = ?, available_sizes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE UPPER(supplier_code) = UPPER(?)
    `);
    const codes = [...new Set([...Object.keys(colourByCode), ...Object.keys(sizeByCode)])];
    for (let i = 0; i < codes.length; i += CHUNK_SIZE) {
      const chunk = codes.slice(i, i + CHUNK_SIZE);
      await db.batch(chunk.map((code) => colourStmt.bind(
        JSON.stringify([...(colourByCode[code] || [])]),
        JSON.stringify([...(sizeByCode[code] || [])]),
        code
      )));
    }

    return json({
      success: true,
      imported,
      codes: codes.length,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
