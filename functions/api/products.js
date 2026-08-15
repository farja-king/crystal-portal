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
    // Without this, a GET to the same URL (e.g. ?customer_id=X, always
    // identical between one visit and the next) is fair game for the
    // browser to serve straight from its HTTP cache instead of hitting the
    // Worker - so an import/edit made in one tab could stay invisible in
    // another that already has that same URL cached, no matter how many
    // times the code re-fetches it.
    "Cache-Control": "no-store",
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
        on_website INTEGER DEFAULT 0,
        customer_id TEXT,
        item_type TEXT DEFAULT 'garment',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // The products table already existed on live D1 before these columns were
    // added to the CREATE TABLE above - "IF NOT EXISTS" is a no-op against an
    // existing table, so they need adding here instead. ALTER TABLE ADD COLUMN
    // throws if the column's already there, so each attempt is swallowed
    // individually - once they all exist this block is a harmless no-op. This
    // must run before the index creation below - CREATE INDEX on a column
    // that doesn't exist yet throws "no such column", which would otherwise
    // break every request against a table that predates customer_id.
    // deleted_at - soft-delete, same universal-Trash pattern as
    // customers.js/orders.js/stock.js (see admin.html's unified Trash tab).
    // DELETE sets this by default now; permanent:true does the real
    // removal. The bulk supplier-wipe/reset_prices tools below are
    // deliberately NOT routed through this - they're import-correction
    // tools that can touch thousands of rows at once, not a "delete this
    // one item" action, and flooding the Trash with a whole supplier's
    // worth of rows would make it useless for its actual purpose.
    for (const col of ["available_colours TEXT DEFAULT '[]'", "available_sizes TEXT DEFAULT '[]'", "on_website INTEGER DEFAULT 0", "customer_id TEXT", "item_type TEXT DEFAULT 'garment'", "deleted_at TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }
    // One-time backfill: a shared-catalog row that's never had a supplier
    // code (a flat fee/service like "Design Setup Fee", nothing to give it
    // a garment code) predates the Garments/Services split and would
    // otherwise sit tagged 'garment' by the column default above. Only
    // touches shared-catalog rows (customer_id IS NULL) - a customer's own
    // one-off Custom Price List items are a separate concern (see
    // functions/api/inbox.js's customer_id scoping) and were never shown on
    // either the Garment Catalog or Services tab anyway. Idempotent - a
    // second run finds nothing left to update.
    await db.prepare(`
      UPDATE products SET item_type = 'service'
      WHERE (supplier_code IS NULL OR supplier_code = '')
        AND (customer_id IS NULL OR customer_id = '')
        AND item_type = 'garment'
    `).run();

    // 6k+ rows, so every list view is filtered/paged - these carry that load.
    await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_code ON products (supplier_code)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_supplier ON products (supplier)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_title ON products (title)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_customer ON products (customer_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_deleted ON products (deleted_at)"),
    ]);

    // ------------------------------------------------------------------ GET --
    if (request.method === "GET") {
      const url = new URL(request.url);
      const p = url.searchParams;

      // ?trash=1 -> only soft-deleted products, for the universal Trash tab.
      if (p.get("trash")) {
        const { results } = await db.prepare(
          "SELECT * FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500"
        ).all();
        return json({ results });
      }

      // ?facets=1 -> the dropdown values the catalog UI filters by. Customer-
      // specific items (see customer_id below) are excluded - they're a
      // per-customer price list, not part of the general catalog Martin
      // browses/bulk-prices here.
      if (p.get("facets")) {
        const facetItemType = (p.get("item_type") || "").trim();
        const globalOnly = "deleted_at IS NULL AND (customer_id IS NULL OR customer_id = '')"
          + (facetItemType === "garment" || facetItemType === "service" ? ` AND item_type = '${facetItemType}'` : "");
        const [suppliers, brands, categories, totals] = await db.batch([
          db.prepare(`SELECT supplier AS value, COUNT(*) AS n FROM products WHERE ${globalOnly} GROUP BY supplier ORDER BY supplier`),
          db.prepare(`SELECT brand AS value, COUNT(*) AS n FROM products WHERE brand <> '' AND ${globalOnly} GROUP BY brand ORDER BY brand`),
          db.prepare(`SELECT category AS value, COUNT(*) AS n FROM products WHERE category <> '' AND ${globalOnly} GROUP BY category ORDER BY category`),
          db.prepare(`SELECT COUNT(*) AS total,
                             SUM(CASE WHEN sell_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
                             SUM(CASE WHEN vat_rate = 0 THEN 1 ELSE 0 END) AS zero_rated
                      FROM products WHERE ${globalOnly}`),
        ]);
        return json({
          suppliers: suppliers.results,
          brands: brands.results,
          categories: categories.results,
          totals: totals.results[0] || { total: 0, unpriced: 0, zero_rated: 0 },
        });
      }

      // ?other_customers_for=<id>&q=... - searches every OTHER customer's
      // own bespoke price-list items (never the shared catalog, never this
      // same customer's own list) for the Customer View's "Search other
      // customers' items" picker - lets the same garment/service already
      // set up for one customer get reused for another instead of
      // re-entering it from scratch. Includes which customer each match
      // belongs to, purely for display context.
      const otherCustomersFor = (p.get("other_customers_for") || "").trim();
      if (otherCustomersFor) {
        const query = (p.get("q") || "").trim();
        if (!query) return json({ results: [] });
        const { results } = await db.prepare(`
          SELECT pr.*, c.name AS owner_customer_name
          FROM products pr JOIN customers c ON c.id = pr.customer_id
          WHERE pr.deleted_at IS NULL AND pr.customer_id IS NOT NULL AND pr.customer_id <> '' AND pr.customer_id <> ?1
            AND (pr.title LIKE ?2 OR pr.supplier_code LIKE ?2 OR pr.colour LIKE ?2 OR pr.category LIKE ?2)
          ORDER BY pr.title LIMIT 25
        `).bind(otherCustomersFor, `%${query}%`).all();
        return json({ results });
      }

      const where = ["deleted_at IS NULL"];
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
      // item_type narrows to just 'garment' or just 'service' rows - used by
      // the Garments and Services tabs to keep the two apart. Left
      // unfiltered (both types together) when omitted, so every caller that
      // predates this split (the quote builder's catalog search, a
      // customer's price-list picker, etc) keeps seeing exactly what it did
      // before - nothing is hidden from them by default.
      const itemType = (p.get("item_type") || "").trim();
      if (itemType === "garment" || itemType === "service") {
        where.push(`item_type = ?${binds.length + 1}`);
        binds.push(itemType);
      }
      // customer_id scopes to one customer's own price list (e.g. imported
      // from their Square export) - without it, customer-tagged rows are
      // hidden from the general catalog entirely, so one customer's bespoke
      // items never surface in another customer's quote or in the shared
      // Garment Catalog tab.
      const customerId = (p.get("customer_id") || "").trim();
      if (customerId) {
        where.push(`customer_id = ?${binds.length + 1}`);
        binds.push(customerId);
      } else {
        where.push("(customer_id IS NULL OR customer_id = '')");
      }
      if (p.get("unpriced")) where.push("sell_price IS NULL");
      // "priced" = "On my website" in the UI - this is on_website, not just
      // "has a sell_price", because a product can now be priced for quoting
      // (manually, or from the quote builder) without actually being live on
      // embroidery.click. on_website is only ever set by the sync job, which
      // is the one thing that actually confirms a product is live on site.
      if (p.get("priced")) where.push("on_website = 1");
      if (p.get("active")) where.push("active = 1");

      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      // A customer_id-scoped request means "everything on this customer's
      // price list", not a paginated browse of the shared catalog - capping
      // it at the general 500 max silently truncated Karl Sports (434 rows)
      // down to whatever ?limit the caller happened to send (200 from the
      // quote builder), and since results are sorted by supplier_code text
      // rather than grouped by product, a multi-variation product's rows
      // are scattered across the full set - some past the cutoff, some not
      // - so it looked like "only some of this product's variations exist"
      // rather than what it actually was: a chunk of the list never sent.
      const limit = customerId
        ? Math.max(parseInt(p.get("limit") || "0", 10) || 0, 2000)
        : Math.min(Math.max(parseInt(p.get("limit") || "50", 10) || 50, 1), 500);
      const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);

      // Size needs a garment-aware sort (XS..8XL, not alphabetical - see
      // sizeRank), which SQL can't express, so the matching rows are pulled
      // in full, sorted in JS, then paginated by slicing.
      const { results: allMatches } = await db.prepare(
        `SELECT * FROM products ${clause} ORDER BY supplier, supplier_code, colour`
      ).bind(...binds).all();

      allMatches.sort(compareProducts);

      // ?group_by_code=1 -> collapse variant rows into one entry per product
      // code, so 6k+ rows can browse as a few hundred collapsible groups in
      // the Garment Catalog UI instead of one long flat list. Pagination
      // then counts codes, not variant rows - total_variants carries the row
      // count separately, since bulk-pricing scope messages still need it.
      if (p.get("group_by_code")) {
        const groups = [];
        const indexByCode = new Map();
        for (const row of allMatches) {
          const key = row.supplier_code;
          let idx = indexByCode.get(key);
          if (idx === undefined) {
            idx = groups.length;
            indexByCode.set(key, idx);
            groups.push({
              supplier_code: row.supplier_code,
              supplier: row.supplier,
              brand: row.brand,
              title: row.title,
              category: row.category,
              variants: [],
            });
          }
          groups[idx].variants.push(row);
        }

        const pagedGroups = groups.slice(offset, offset + limit);
        return json({ total: groups.length, total_variants: allMatches.length, limit, offset, results: pagedGroups });
      }

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
        // on conflict and profit is recomputed against the new cost. A row can
        // optionally carry its own sell_price (e.g. a customer's Square export,
        // where the exported "Price" *is* what's charged) - that only fills the
        // price in on first import, same protection as above, and customer_id
        // tags the row as belonging to one customer's own price list rather
        // than the shared catalog (see the GET handler's customer_id filter).
        const stmt = db.prepare(`
          INSERT INTO products (
            id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
            category, cost_price, surcharge_category, vat_rate, sell_price, profit, active, customer_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            supplier = excluded.supplier,
            supplier_code = excluded.supplier_code,
            supplier_ref = excluded.supplier_ref,
            brand = excluded.brand,
            title = excluded.title,
            colour = excluded.colour,
            size = excluded.size,
            category = excluded.category,
            cost_price = excluded.cost_price,
            surcharge_category = excluded.surcharge_category,
            vat_rate = excluded.vat_rate,
            active = excluded.active,
            sell_price = CASE WHEN products.sell_price IS NULL THEN excluded.sell_price ELSE products.sell_price END,
            profit = CASE WHEN products.sell_price IS NULL
                          THEN CASE WHEN excluded.sell_price IS NULL THEN NULL ELSE ROUND(excluded.sell_price - excluded.cost_price, 2) END
                          ELSE ROUND(products.sell_price - excluded.cost_price, 2) END,
            customer_id = excluded.customer_id,
            updated_at = CURRENT_TIMESTAMP
        `);

        const batch = data.rows.map((r) => {
          const cost = Number(r.cost_price) || 0;
          const vatRate = r.vat_rate === undefined || r.vat_rate === null || r.vat_rate === "" ? 0.2 : Number(r.vat_rate);
          const sell = r.sell_price === undefined || r.sell_price === null || r.sell_price === "" ? null : Number(r.sell_price);
          return stmt.bind(
            r.id,
            r.supplier || "",
            r.supplier_code || "",
            r.supplier_ref || "",
            r.brand || "",
            r.title || "",
            r.colour || "",
            r.size || "",
            r.category || "",
            cost,
            r.surcharge_category || "",
            vatRate,
            sell,
            profitOf(sell, cost, vatRate),
            r.customer_id || null
          );
        });

        // D1 batches can silently misbehave (or hit undocumented size limits)
        // when handed hundreds of statements at once - a 400+ row customer
        // export (see products.customer_id) was losing rows this way with no
        // error surfaced. Chunking keeps every batch call comfortably small;
        // if one chunk does fail, everything before it is already committed
        // and the whole import is safe to just re-run (upsert by id).
        const CHUNK_SIZE = 50;
        let imported = 0;
        for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
          await db.batch(batch.slice(i, i + CHUNK_SIZE));
          imported += Math.min(CHUNK_SIZE, batch.length - i);
        }
        return json({ success: true, imported });
      }

      const id = data.id || crypto.randomUUID();
      const cost = Number(data.cost_price) || 0;
      await db.prepare(`
        INSERT INTO products (
          id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
          category, cost_price, surcharge_category, vat_rate, sell_price, profit, active, customer_id, item_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        data.active === 0 ? 0 : 1,
        data.customer_id || null,
        data.item_type === "service" ? "service" : "garment"
      ).run();

      return json({ success: true, id });
    }

    // ------------------------------------------------------------------ PUT --
    if (request.method === "PUT") {
      const data = await request.json();

      // Restore from the Trash - see DELETE below, and GET's ?trash=1.
      if (data.restore) {
        await db.prepare("UPDATE products SET deleted_at = NULL WHERE id = ?").bind(data.id).run();
        return json({ success: true });
      }

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
        // Bulk pricing is a Garment Catalog tool for the shared catalog - a
        // customer's own imported price list is edited from their customer
        // record instead, never swept up in a markup/margin pass here. Added
        // after the confirm_all check so it never counts as a user-supplied
        // filter for that safety gate.
        where.push("(customer_id IS NULL OR customer_id = '')");
        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

        let expr;
        if (a.mode === "fixed") {
          const price = Number(a.price);
          if (!isFinite(price) || price < 0) return json({ error: "price must be a non-negative number" }, 400);
          // Bare "?" auto-numbers independently of the where clause's explicit
          // ?1/?2/etc, so mixing the two styles left D1 expecting a different
          // number of bindings than were passed - use the same explicit
          // numbering here, continuing on from wherever the filters left off.
          // expr appears twice in the SQL below (sell_price and profit), but
          // it's the same numbered placeholder both times, so it only needs
          // binding once, not twice.
          const priceParam = binds.length + 1;
          binds.push(price);
          expr = `ROUND(?${priceParam}, 2)`;
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
          vat_rate = ?, sell_price = ?, profit = ?, active = ?, customer_id = ?, on_website = ?, updated_at = CURRENT_TIMESTAMP
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
        data.customer_id ?? existing.customer_id,
        data.on_website ?? existing.on_website,
        data.id
      ).run();

      return json({ success: true });
    }

    // --------------------------------------------------------------- DELETE --
    if (request.method === "DELETE") {
      const data = await request.json();
      if (Array.isArray(data.ids) && data.ids.length) {
        const placeholders = data.ids.map(() => "?").join(",");
        if (data.permanent) {
          await db.prepare(`DELETE FROM products WHERE id IN (${placeholders})`).bind(...data.ids).run();
        } else {
          await db.prepare(`UPDATE products SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).bind(...data.ids).run();
        }
        return json({ success: true, count: data.ids.length });
      }
      if (data.id) {
        if (data.permanent) {
          await db.prepare("DELETE FROM products WHERE id = ?").bind(data.id).run();
        } else {
          await db.prepare("UPDATE products SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").bind(data.id).run();
        }
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
