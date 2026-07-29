// Garment catalog: cost price (from the supplier price lists), Martin's sell
// price, and the profit between them. Follows the same lazy-schema + snake_case
// -on-the-wire pattern as quotes.js / customers.js / settings.js.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  // sell_price is what Martin charges; profit is stored, not derived in the UI,
  // so reports can aggregate on it directly. Profit = sell price minus (cost + VAT he pays).
  // Since he's not VAT registered, he pays VAT to suppliers but can't claim it back.
  const profitOf = (sell, cost, vatRate = 0.2) => {
    if (sell === null || sell === undefined || sell === "") return null;
    const totalCost = Number(cost || 0) * (1 + (Number(vatRate) || 0));
    return round2(Number(sell) - totalCost);
  };

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  // Sizes in the supplier data are a mix of letter sizes (XS..8XL, sometimes
  // as ranges like "S - XXL" or combos like "XXL/3XL"), numeric measurements
  // (waist/chest inches, ml, age-in-months ranges), and a handful of
  // non-garment tokens (CONE, COP, A4, One size). Plain alphabetical sort
  // puts "3XL" before "4XL" before "S - XXL", which is why the table looked
  // scrambled - this ranks the *smallest* size in the token first.
  const LETTER_SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "6XL", "7XL", "8XL"];
  function sizeRank(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return 9999;
    const base = s.split(" - ")[0].split("/")[0].trim();
    const idx = LETTER_SIZE_ORDER.indexOf(base);
    if (idx >= 0) return idx;
    const numMatch = base.match(/^(\d+(?:\.\d+)?)/);
    if (numMatch) return 1000 + parseFloat(numMatch[1]);
    return 9999;
  }
  function compareProducts(a, b) {
    if (a.supplier !== b.supplier) return a.supplier < b.supplier ? -1 : 1;
    if (a.supplier_code !== b.supplier_code) return a.supplier_code < b.supplier_code ? -1 : 1;
    if (a.colour !== b.colour) return a.colour < b.colour ? -1 : 1;
    const rankDiff = sizeRank(a.size) - sizeRank(b.size);
    if (rankDiff !== 0) return rankDiff;
    return a.size < b.size ? -1 : a.size > b.size ? 1 : 0;
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        supplier TEXT,
        supplier_code TEXT,
        supplier_ref TEXT,
        brand TEXT,
        title TEXT,
        colour TEXT,
        size TEXT,
        category TEXT,
        cost_price REAL DEFAULT 0,
        surcharge_category TEXT,
        vat_rate REAL DEFAULT 0.2,
        sell_price REAL,
        profit REAL,
        active INTEGER DEFAULT 1,
        available_colours TEXT DEFAULT '[]',
        available_sizes TEXT DEFAULT '[]',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // 6k+ rows, so every list view is filtered/paged - these carry that load.
    await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_code ON products (supplier_code)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_supplier ON products (supplier)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_title ON products (title)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand)"),
    ]);

    // ------------------------------------------------------------------ GET --
    if (request.method === "GET") {
      const url = new URL(request.url);
      const p = url.searchParams;

      // ?facets=1 -> the dropdown values the catalog UI filters by
      if (p.get("facets")) {
        const [suppliers, brands, categories, totals] = await db.batch([
          db.prepare("SELECT supplier AS value, COUNT(*) AS n FROM products GROUP BY supplier ORDER BY supplier"),
          db.prepare("SELECT brand AS value, COUNT(*) AS n FROM products WHERE brand <> '' GROUP BY brand ORDER BY brand"),
          db.prepare("SELECT category AS value, COUNT(*) AS n FROM products WHERE category <> '' GROUP BY category ORDER BY category"),
          db.prepare(`SELECT COUNT(*) AS total,
                             SUM(CASE WHEN sell_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
                             SUM(CASE WHEN vat_rate = 0 THEN 1 ELSE 0 END) AS zero_rated
                      FROM products`),
        ]);
        return json({
          suppliers: suppliers.results,
          brands: brands.results,
          categories: categories.results,
          totals: totals.results[0] || { total: 0, unpriced: 0, zero_rated: 0 },
        });
      }

      const where = [];
      const binds = [];

      const q = (p.get("q") || "").trim();
      if (q) {
        where.push("(supplier_code LIKE ?1 OR title LIKE ?1 OR colour LIKE ?1 OR brand LIKE ?1 OR supplier_ref LIKE ?1)");
        binds.push(`%${q}%`);
      }
      // Exact code match - used by the quote builder once a product's been
      // picked, to pull every colour/size variant that code actually has
      // (for the breakdown dropdowns), rather than a fuzzy LIKE search.
      const code = (p.get("code") || "").trim();
      if (code) { where.push(`supplier_code = ?${binds.length + 1}`); binds.push(code); }
      for (const [param, col] of [["supplier", "supplier"], ["brand", "brand"], ["category", "category"]]) {
        const v = p.get(param);
        if (v) { where.push(`${col} = ?${binds.length + 1}`); binds.push(v); }
      }
      if (p.get("unpriced")) where.push("sell_price IS NULL");
      // "priced" = items with a sell price set, i.e. what's actually live on
      // the web store today (the sync job only ever sets sell_price for
      // products it finds on the site).
      if (p.get("priced")) where.push("sell_price IS NOT NULL");
      if (p.get("active")) where.push("active = 1");

      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const limit = Math.min(Math.max(parseInt(p.get("limit") || "50", 10) || 50, 1), 500);
      const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);

      // Size needs a garment-aware sort (XS..8XL, not alphabetical - see
      // sizeRank), which SQL can't express, so the matching rows are pulled
      // in full, sorted in JS, then paginated by slicing.
      const { results: allMatches } = await db.prepare(
        `SELECT * FROM products ${clause} ORDER BY supplier, supplier_code, colour`
      ).bind(...binds).all();

      allMatches.sort(compareProducts);
      const results = allMatches.slice(offset, offset + limit);

      return json({ total: allMatches.length, limit, offset, results });
    }

    // ----------------------------------------------------------------- POST --
    // Either one product, or { rows: [...] } for a chunk of the price-list import.
    if (request.method === "POST") {
      const data = await request.json();

      if (Array.isArray(data.rows)) {
        // Re-running the import must refresh cost prices without ever wiping the
        // sell prices Martin has already set, so sell_price/profit are left alone
        // on conflict and profit is recomputed against the new cost.
        const stmt = db.prepare(`
          INSERT INTO products (
            id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
            category, cost_price, surcharge_category, vat_rate, sell_price, profit, active, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            supplier_ref = excluded.supplier_ref,
            brand = excluded.brand,
            title = excluded.title,
            category = excluded.category,
            cost_price = excluded.cost_price,
            surcharge_category = excluded.surcharge_category,
            vat_rate = excluded.vat_rate,
            profit = CASE WHEN products.sell_price IS NULL THEN NULL
                          ELSE ROUND(products.sell_price - excluded.cost_price, 2) END,
            updated_at = CURRENT_TIMESTAMP
        `);

        const batch = data.rows.map((r) => stmt.bind(
          r.id,
          r.supplier || "",
          r.supplier_code || "",
          r.supplier_ref || "",
          r.brand || "",
          r.title || "",
          r.colour || "",
          r.size || "",
          r.category || "",
          Number(r.cost_price) || 0,
          r.surcharge_category || "",
          r.vat_rate === undefined || r.vat_rate === null || r.vat_rate === "" ? 0.2 : Number(r.vat_rate)
        ));

        await db.batch(batch);
        return json({ success: true, imported: batch.length });
      }

      const id = data.id || crypto.randomUUID();
      const cost = Number(data.cost_price) || 0;
      await db.prepare(`
        INSERT INTO products (
          id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
          category, cost_price, surcharge_category, vat_rate, sell_price, profit, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        data.supplier || "",
        data.supplier_code || "",
        data.supplier_ref || "",
        data.brand || "",
        data.title || "",
        data.colour || "",
        data.size || "",
        data.category || "",
        cost,
        data.surcharge_category || "",
        data.vat_rate ?? 0.2,
        data.sell_price ?? null,
        profitOf(data.sell_price, cost, data.vat_rate ?? 0.2),
        data.active === 0 ? 0 : 1
      ).run();

      return json({ success: true, id });
    }

    // ------------------------------------------------------------------ PUT --
    if (request.method === "PUT") {
      const data = await request.json();

      // Bulk pricing: setting ~6.3k sell prices by hand is not realistic, so a
      // markup/margin can be applied across a filtered slice, or a fixed price
      // can be set on all filtered items (useful for "copy this price to all").
      if (data.apply_pricing) {
        const a = data.apply_pricing;

        const where = [];
        const binds = [];
        if (a.q) {
          where.push("(supplier_code LIKE ?1 OR title LIKE ?1 OR colour LIKE ?1 OR brand LIKE ?1)");
          binds.push(`%${a.q}%`);
        }
        for (const [k, col] of [["supplier", "supplier"], ["brand", "brand"], ["category", "category"]]) {
          if (a[k]) { where.push(`${col} = ?${binds.length + 1}`); binds.push(a[k]); }
        }
        if (a.only_unpriced) where.push("sell_price IS NULL");
        if (!where.length && !a.confirm_all) {
          return json({ error: "Refusing to reprice the entire catalog without confirm_all" }, 400);
        }
        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

        let expr;
        if (a.mode === "fixed") {
          const price = Number(a.price);
          if (!isFinite(price) || price < 0) return json({ error: "price must be a non-negative number" }, 400);
          expr = `ROUND(?, 2)`;
          binds.push(price);
          binds.push(price); // expr is used twice in the SQL (sell_price and profit)
        } else {
          const pct = Number(a.percent);
          if (!isFinite(pct)) return json({ error: "percent must be a number" }, 400);
          if (a.mode === "margin" && pct >= 100) {
            return json({ error: "A margin of 100% or more is not achievable" }, 400);
          }
          // markup is on cost (cost x 1.5), margin is on the sell price (cost / 0.5)
          expr = a.mode === "margin"
            ? `ROUND(cost_price / ${(1 - pct / 100).toFixed(6)}, 2)`
            : `ROUND(cost_price * ${(1 + pct / 100).toFixed(6)}, 2)`;
        }

        const res = await db.prepare(`
          UPDATE products
          SET sell_price = ${expr},
              profit = ROUND(${expr} - cost_price * (1 + vat_rate), 2),
              updated_at = CURRENT_TIMESTAMP
          ${clause}
        `).bind(...binds).run();

        return json({ success: true, updated: res.meta ? res.meta.changes : null });
      }

      const existing = await db.prepare("SELECT * FROM products WHERE id = ?").bind(data.id).first();
      if (!existing) return json({ error: "Product not found" }, 404);

      const cost = data.cost_price ?? existing.cost_price;
      const sell = data.sell_price === undefined ? existing.sell_price : data.sell_price;

      await db.prepare(`
        UPDATE products SET
          supplier = ?, supplier_code = ?, supplier_ref = ?, brand = ?, title = ?,
          colour = ?, size = ?, category = ?, cost_price = ?, surcharge_category = ?,
          vat_rate = ?, sell_price = ?, profit = ?, active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        data.supplier ?? existing.supplier,
        data.supplier_code ?? existing.supplier_code,
        data.supplier_ref ?? existing.supplier_ref,
        data.brand ?? existing.brand,
        data.title ?? existing.title,
        data.colour ?? existing.colour,
        data.size ?? existing.size,
        data.category ?? existing.category,
        cost,
        data.surcharge_category ?? existing.surcharge_category,
        data.vat_rate ?? existing.vat_rate,
        sell === "" ? null : sell,
        sell === "" ? null : profitOf(sell, cost, data.vat_rate ?? existing.vat_rate),
        data.active ?? existing.active,
        data.id
      ).run();

      return json({ success: true });
    }

    // --------------------------------------------------------------- DELETE --
    if (request.method === "DELETE") {
      const data = await request.json();
      if (data.id) {
        await db.prepare("DELETE FROM products WHERE id = ?").bind(data.id).run();
        return json({ success: true });
      }
      // Clearing a supplier is how a bad import gets rolled back.
      if (data.supplier && data.confirm) {
        const res = await db.prepare("DELETE FROM products WHERE supplier = ?").bind(data.supplier).run();
        return json({ success: true, deleted: res.meta ? res.meta.changes : null });
      }
      // Reset all sell prices to NULL (for wiping bad bulk imports).
      if (data.reset_prices && data.confirm) {
        const res = await db.prepare("UPDATE products SET sell_price = NULL, profit = NULL, updated_at = CURRENT_TIMESTAMP").run();
        return json({ success: true, reset: res.meta ? res.meta.changes : null });
      }
      return json({ error: "Provide an id, or a supplier with confirm:true, or reset_prices with confirm:true" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
