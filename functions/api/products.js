// Garment catalog: cost price (from the supplier price lists), Martin's sell
// price, and the profit between them. Follows the same lazy-schema + snake_case
// -on-the-wire pattern as quotes.js / customers.js / settings.js.
//
// STORAGE MODEL (as of the catalog consolidation): one physical row per
// product CODE, not per exact colour+size combination - a garment code that
// used to be 200 rows (one per colour x size, since PenCarrie/Uneek charge
// different costs per colour and per size) is now one row whose `variant_data`
// column holds a JSON array of { id, colour, size, cost_price, sell_price,
// vat_rate, colour_code, image_url } - one entry per what used to be a
// separate physical row, reusing that row's own id as the tier's id.
//
// Every GET response still expands each consolidated row back into the exact
// same flat per-tier shape every consumer (admin.html, the order builder, the
// Stock/Customer-View pickers, the import jobs) already expects - see
// expandRow() below. This is deliberate: it means none of those consumers
// needed to change at all, only this file and the import jobs that write to
// it. A row with an empty/missing variant_data is treated as its own single
// tier (parseVariants()'s fallback) - this is what makes it safe to deploy
// this file before the one-time migration (see the products_consolidate_*
// migration script, run separately via the D1 console/MCP) has actually run:
// nothing breaks in between, un-migrated codes just look like single-tier
// codes until they're consolidated.
//
// Writes by a tier `id` (PUT single edit, DELETE) resolve which consolidated
// row owns that id via the small `product_variant_index` lookup table, then
// read-modify-write just that one entry inside `variant_data`.
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

  // Every tier inside variant_data, or - for a row that hasn't been
  // consolidated yet (empty/missing variant_data) - a single synthetic tier
  // built from the row's own colour/size/cost/sell columns. This fallback is
  // the entire reason this file is safe to deploy before the one-time
  // migration runs: an un-migrated code just behaves as a one-tier code.
  function parseVariants(row) {
    let tiers = null;
    try {
      tiers = JSON.parse(row.variant_data || "[]");
    } catch {
      tiers = null;
    }
    if (!Array.isArray(tiers) || !tiers.length) {
      return [{
        id: row.id,
        colour: row.colour || "",
        size: row.size || "",
        cost_price: row.cost_price,
        sell_price: row.sell_price,
        vat_rate: row.vat_rate,
        colour_code: row.colour_code || "",
        image_url: row.image_url || "",
      }];
    }
    return tiers;
  }

  // Expands one consolidated (code-level) row into the flat per-tier objects
  // every existing consumer already expects - same field shape a physical
  // per-variant row used to have, just sourced from variant_data instead of
  // being its own row. product_id is added so a caller can always find the
  // parent row without a second lookup.
  function expandRow(row) {
    return parseVariants(row).map((t) => ({
      id: t.id,
      product_id: row.id,
      supplier: row.supplier,
      supplier_code: row.supplier_code,
      supplier_ref: row.supplier_ref,
      brand: row.brand,
      title: row.title,
      colour: t.colour ?? "",
      size: t.size ?? "",
      category: row.category,
      cost_price: t.cost_price ?? 0,
      surcharge_category: row.surcharge_category,
      vat_rate: t.vat_rate ?? row.vat_rate ?? 0.2,
      sell_price: t.sell_price === undefined ? null : t.sell_price,
      profit: profitOf(t.sell_price, t.cost_price, t.vat_rate ?? row.vat_rate ?? 0.2),
      active: row.active,
      available_colours: row.available_colours,
      available_sizes: row.available_sizes,
      on_website: row.on_website,
      customer_id: row.customer_id,
      item_type: row.item_type,
      colour_code: t.colour_code || "",
      image_url: t.image_url || "",
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    }));
  }

  function expandRows(rows) {
    return rows.flatMap(expandRow);
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
    // variant_data - the catalog consolidation (see file header): a
    // consolidated code-level row's colour/size/cost/sell tiers, as JSON.
    for (const col of ["available_colours TEXT DEFAULT '[]'", "available_sizes TEXT DEFAULT '[]'", "on_website INTEGER DEFAULT 0", "customer_id TEXT", "item_type TEXT DEFAULT 'garment'", "deleted_at TEXT", "variant_data TEXT DEFAULT '[]'", "variant_data_trash TEXT DEFAULT '[]'"]) {
      try {
        await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }
    // Maps a tier's own id to whichever consolidated row currently holds it
    // in its variant_data - lets PUT/DELETE-by-id resolve the parent row in
    // one indexed lookup instead of scanning variant_data with a JSON
    // function. Populated by the migration script for existing data, and
    // kept up to date by every write path below (addTierToIndex/
    // removeTierFromIndex).
    await db.prepare(`CREATE TABLE IF NOT EXISTS product_variant_index (variant_id TEXT PRIMARY KEY, product_id TEXT NOT NULL)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_variant_index_product ON product_variant_index (product_id)`).run();

    async function addTierToIndex(variantId, productId) {
      await db.prepare(
        `INSERT INTO product_variant_index (variant_id, product_id) VALUES (?, ?)
         ON CONFLICT(variant_id) DO UPDATE SET product_id = excluded.product_id`
      ).bind(variantId, productId).run();
    }
    async function removeTierFromIndex(variantId) {
      await db.prepare(`DELETE FROM product_variant_index WHERE variant_id = ?`).bind(variantId).run();
    }
    // Finds which consolidated row currently owns a tier id. Falls back to
    // treating the id as a still-un-migrated row's own id (SELECT * FROM
    // products WHERE id = ?) if it's not in the index yet - same
    // deploy-before-migration safety net as parseVariants()'s fallback.
    async function findRowForTier(variantId) {
      const indexed = await db.prepare(`SELECT product_id FROM product_variant_index WHERE variant_id = ?`).bind(variantId).first();
      const rowId = indexed ? indexed.product_id : variantId;
      const row = await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(rowId).first();
      return row || null;
    }

    // One-time backfill: a shared-catalog row that's never had a supplier
    // code (a flat fee/service like "Design Setup Fee", nothing to give it
    // a garment code) predates the Garments/Services split and would
    // otherwise sit tagged 'garment' by the column default above. Only
    // touches shared-catalog rows (customer_id IS NULL) - a customer's own
    // one-off Custom Price List items are a separate concern (see
    // functions/api/inbox.js's customer_id scoping) and were never shown on
    // either the Garment Catalog or Services tab anyway.
    //
    // Genuinely gated to run once now (schema_migrations marker below) -
    // it used to just be a plain UPDATE with no guard, so despite being
    // labelled "one-time" it silently ran on every single request forever,
    // reclassifying any *newly added* code-less garment as a service too.
    // Found live: Martin added a garment with no ref code (name/category/
    // cost/sell filled in) and it vanished from the Garments tab - it had
    // saved fine, just got flipped to a service by this on the very next
    // page load.
    await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    const backfillDone = await db.prepare(
      `SELECT 1 FROM schema_migrations WHERE id = 'products_backfill_service_item_type'`
    ).first();
    if (!backfillDone) {
      await db.prepare(`
        UPDATE products SET item_type = 'service'
        WHERE (supplier_code IS NULL OR supplier_code = '')
          AND (customer_id IS NULL OR customer_id = '')
          AND item_type = 'garment'
      `).run();
      await db.prepare(`INSERT INTO schema_migrations (id) VALUES ('products_backfill_service_item_type')`).run();
    }

    // Indexes - cheap now that the garment catalog is (post-consolidation)
    // one row per product code rather than one per colour+size combo, but
    // kept for the same query shapes that mattered when it was 98k+ rows:
    // idx_products_code_browse specifically backs the Garment Catalog's main
    // browse (SELECT DISTINCT supplier_code ... ORDER BY supplier_code LIMIT
    // ? OFFSET ?) as a plain index walk with no temp b-tree - see that
    // query's own comment below for the full story (an earlier version of
    // this index/query measured *worse* than an unbounded scan; this one,
    // checked the same way, didn't).
    await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_code ON products (supplier_code)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_supplier ON products (supplier)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_title ON products (title)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_customer ON products (customer_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_deleted ON products (deleted_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_browse ON products (deleted_at, item_type, supplier, supplier_code)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_products_code_browse ON products (deleted_at, item_type, supplier_code)"),
    ]);

    // Audit trail for sell_price, added after a sync-job bug silently
    // overwrote several customers' negotiated prices with no way to tell
    // what they'd been before (see the removed sync-prices.js, and the
    // customer_id fix in this file's PUT handler and in push-prices-live.js).
    // Every path that can change sell_price now logs the before/after here
    // first - restoring from a bad change becomes a query against this
    // table instead of digging through old invoices and PDFs by hand.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS product_price_history (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        supplier_code TEXT,
        customer_id TEXT,
        old_sell_price REAL,
        new_sell_price REAL,
        source TEXT,
        changed_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_price_history_product ON product_price_history (product_id)").run();

    // source: 'manual_edit' (Garment Catalog inline edit / edit form),
    // 'bulk_pricing' (the markup/margin/fixed-price sweep), 'import' (a
    // price filled in on first import - never fires on an overwrite, since
    // import already refuses to touch a row that already has a price).
    // old_sell_price of null just means "first price ever set" - still
    // logged, since that's real provenance even though there's nothing to
    // restore to. Only a genuine no-op (old === new) is skipped.
    async function logPriceChange(productId, supplierCode, customerId, oldPrice, newPrice, source) {
      if (oldPrice === newPrice) return;
      await db.prepare(`
        INSERT INTO product_price_history (id, product_id, supplier_code, customer_id, old_sell_price, new_sell_price, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), productId, supplierCode || "", customerId || null, oldPrice, newPrice, source).run();
    }

    // ------------------------------------------------------------------ GET --
    if (request.method === "GET") {
      const url = new URL(request.url);
      const p = url.searchParams;

      // ?trash=1 -> only soft-deleted products, for the universal Trash tab.
      // Trash still operates on whole rows (whole codes, post-consolidation) -
      // see the file header and the PUT/DELETE handlers below.
      if (p.get("trash")) {
        // ?trash=1&q=<term> - finds a specific trashed item by code/title/
        // colour/brand. Needed once trash holds tens of thousands of rows
        // (see the bulk unpriced-garment trim this was added for) - without
        // it, the plain most-recent-500 view below has no way to surface
        // one specific item a customer's asked for again, buried among
        // everything else that's been trashed.
        const trashQ = (p.get("q") || "").trim();
        if (trashQ) {
          const { results } = await db.prepare(
            "SELECT * FROM products WHERE deleted_at IS NOT NULL AND (supplier_code LIKE ?1 OR title LIKE ?1 OR colour LIKE ?1 OR brand LIKE ?1) ORDER BY deleted_at DESC LIMIT 100"
          ).bind(`%${trashQ}%`).all();
          return json({ results: expandRows(results) });
        }
        const { results } = await db.prepare(
          "SELECT * FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500"
        ).all();
        return json({ results: expandRows(results) });
      }

      // ?facets=1 -> the dropdown values the catalog UI filters by. Customer-
      // specific items (see customer_id below) are excluded - they're a
      // per-customer price list, not part of the general catalog Martin
      // browses/bulk-prices here. Counts are now CODE counts (one row per
      // code post-consolidation), same as everywhere else in this file -
      // cheap regardless of how many tiers a code has, since COUNT(*) here
      // is over physical rows, not variant_data entries.
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

      // ?price_history=<tier_id> - the audit trail for one tier, newest
      // first. See logPriceChange above for what writes to this - still
      // keyed by the tier's own id (product_price_history.product_id holds
      // whatever id was passed to logPriceChange, i.e. a tier id, not
      // necessarily today's consolidated row id - unaffected by the
      // consolidation since this table was never restructured).
      const priceHistoryFor = (p.get("price_history") || "").trim();
      if (priceHistoryFor) {
        const { results } = await db.prepare(
          "SELECT * FROM product_price_history WHERE product_id = ? ORDER BY changed_at DESC"
        ).bind(priceHistoryFor).all();
        return json({ results });
      }

      // ?other_customers_for=<id>&q=... - searches every OTHER customer's
      // own bespoke price-list items (never the shared catalog, never this
      // same customer's own list) for the Customer View's "Search other
      // customers' items" picker - lets the same garment/service already
      // set up for one customer get reused for another instead of
      // re-entering it from scratch. Includes which customer each match
      // belongs to, purely for display context. A customer's own price-list
      // rows were never part of the shared-catalog consolidation (each one
      // is already its own single-tier row, copied at the moment it was
      // added - see addCvCatalogPickerVariants in admin.html), so no
      // expandRow() needed here.
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
      // (for the breakdown dropdowns). Post-consolidation this fetches (at
      // most) one physical row, expanded into however many tiers it holds.
      const code = (p.get("code") || "").trim();
      if (code) { where.push(`supplier_code = ?${binds.length + 1}`); binds.push(code); }
      // Exact id match - a flat fee/service (e.g. "Design Setup Fee") has no
      // supplier_code to look up by, so this is the only way to re-fetch its
      // current cost_price by product_id (see admin.html's
      // attachCostDataToOrderLines, used by reorder/edit-quote to refresh
      // the internal margin box). id here means a TIER id - resolved via
      // findRowForTier the same way PUT/DELETE resolve it, then that one
      // matching tier (not the whole row's other tiers) is returned.
      const idParam = (p.get("id") || "").trim();
      if (idParam) {
        const row = await findRowForTier(idParam);
        if (!row || row.deleted_at) return json({ total: 0, limit: 1, offset: 0, results: [] });
        const results = expandRow(row).filter((t) => t.id === idParam);
        return json({ total: results.length, limit: 1, offset: 0, results });
      }
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
      // quote builder). A customer's price list was never part of the
      // shared-catalog consolidation (each row there is already its own
      // single-tier row), so this limit is still a row/tier-count limit.
      const limit = customerId
        ? Math.max(parseInt(p.get("limit") || "0", 10) || 0, 2000)
        : Math.min(Math.max(parseInt(p.get("limit") || "50", 10) || 50, 1), 500);
      const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);

      // A code/customer_id-scoped lookup is already narrow (bounded by that
      // exact filter, never the whole shared catalog), so the original
      // fetch-everything-then-sort-in-JS approach stays as-is here - needed
      // anyway for the garment-aware size sort (see sizeRank) that SQL can't
      // express, and at this scale (one row per code) it's cheap regardless.
      //
      // The general catalog browse (no code/customer_id - the Garment
      // Catalog tab's main view) pages in SQL instead (LIMIT/OFFSET, backed
      // by idx_products_code_browse) so a page only ever reads the codes it
      // actually needs, not the whole table - this is what mattered when the
      // table was 98k+ rows and is kept because it's still the right shape
      // even now that a "row" means a whole code.
      if (!code && !customerId) {
        if (p.get("group_by_code")) {
          // Page of *codes* first (cheap - an index walk that stops after
          // `limit`), then the full rows for just those codes.
          //
          // Ordered by supplier_code alone, NOT supplier-then-code - verified
          // directly against production via EXPLAIN QUERY PLAN that `GROUP
          // BY supplier_code ORDER BY MIN(supplier), supplier_code` (an
          // earlier version of this fix) forces two separate temp b-trees
          // and measured at 200k+ rows_read - worse than an unbounded scan.
          // `SELECT DISTINCT supplier_code ... ORDER BY supplier_code`
          // against idx_products_code_browse needs no temp b-tree at all.
          // Trade-off: codes from different suppliers interleave
          // alphabetically instead of clustering by supplier - filtering by
          // a specific supplier (already an available facet) still browses
          // that supplier's own range together.
          const codeRows = await db.prepare(
            `SELECT DISTINCT supplier_code FROM products ${clause} ORDER BY supplier_code LIMIT ? OFFSET ?`
          ).bind(...binds, limit, offset).all();
          const pageCodes = codeRows.results.map((r) => r.supplier_code);

          let pagedGroups = [];
          if (pageCodes.length) {
            const codePlaceholders = pageCodes.map(() => "?").join(",");
            const { results: pageRows } = await db.prepare(
              `SELECT * FROM products ${clause} AND supplier_code IN (${codePlaceholders}) ORDER BY supplier, supplier_code`
            ).bind(...binds, ...pageCodes).all();

            const indexByCode = new Map();
            for (const row of pageRows) {
              const key = row.supplier_code;
              let idx = indexByCode.get(key);
              if (idx === undefined) {
                idx = pagedGroups.length;
                indexByCode.set(key, idx);
                pagedGroups.push({
                  supplier_code: row.supplier_code,
                  supplier: row.supplier,
                  brand: row.brand,
                  title: row.title,
                  category: row.category,
                  variants: [],
                });
              }
              const tiers = expandRow(row);
              tiers.sort((a, b) => {
                if (a.colour !== b.colour) return a.colour < b.colour ? -1 : 1;
                const rankDiff = sizeRank(a.size) - sizeRank(b.size);
                if (rankDiff !== 0) return rankDiff;
                return a.size < b.size ? -1 : a.size > b.size ? 1 : 0;
              });
              pagedGroups[idx].variants.push(...tiers);
            }
            // A code could (rarely) span more than one physical row if the
            // migration/import left duplicates - group rows already merge by
            // supplier_code above, so this just keeps the *groups* in the
            // paginated code order (pageRows itself isn't guaranteed to come
            // back in that order from the IN (...) query).
            pagedGroups.sort((a, b) => pageCodes.indexOf(a.supplier_code) - pageCodes.indexOf(b.supplier_code));
          }

          // The exact total (codes + variant tiers) only gets recomputed on
          // the first page of a given filter - it can't change mid-browse,
          // and a COUNT still has to examine every matching row regardless
          // of indexing. Cheap now regardless (COUNT(*) is over ~506 rows,
          // not 98k), kept as-is since admin.html already only asks on
          // page 1 and reuses the answer afterward.
          let total = null, total_variants = null;
          if (offset === 0) {
            const totals = await db.prepare(
              `SELECT COUNT(DISTINCT supplier_code) AS codes FROM products ${clause}`
            ).bind(...binds).first();
            total = totals ? totals.codes : 0;
            // total_variants (tier count) needs the actual rows, not just a
            // SQL COUNT, since tiers live inside variant_data - fine at this
            // scale (whole filtered set, but that's ~500 rows max now).
            const { results: allForCount } = await db.prepare(`SELECT variant_data, colour, size, cost_price, sell_price, vat_rate FROM products ${clause}`).bind(...binds).all();
            total_variants = allForCount.reduce((sum, r) => sum + parseVariants(r).length, 0);
          }

          return json({ total, total_variants, limit, offset, results: pagedGroups });
        }
        // Ungrouped broad browse (group_by_code not requested) - one row per
        // code, so this is already cheap; kept as a plain fetch+sort+slice
        // for the same size-aware-sort reasoning as the code/customer_id
        // paths above, expanded to tiers before returning.
        const { results: allMatches } = await db.prepare(
          `SELECT * FROM products ${clause} ORDER BY supplier, supplier_code`
        ).bind(...binds).all();
        const expanded = expandRows(allMatches);
        expanded.sort(compareProducts);
        const results = expanded.slice(offset, offset + limit);
        return json({ total: expanded.length, limit, offset, results });
      }

      const { results: allMatches } = await db.prepare(
        `SELECT * FROM products ${clause} ORDER BY supplier, supplier_code`
      ).bind(...binds).all();

      const expanded = expandRows(allMatches);
      expanded.sort(compareProducts);

      // ?group_by_code=1 -> collapse tiers into one entry per product code -
      // used by the code/customer_id-scoped callers too (e.g. re-fetching
      // one code's full tier set for the order builder's colour/size
      // dropdowns). total_variants carries the tier count separately, since
      // bulk-pricing scope messages still need it.
      if (p.get("group_by_code")) {
        const groups = [];
        const indexByCode = new Map();
        for (const t of expanded) {
          const key = t.supplier_code;
          let idx = indexByCode.get(key);
          if (idx === undefined) {
            idx = groups.length;
            indexByCode.set(key, idx);
            groups.push({
              supplier_code: t.supplier_code,
              supplier: t.supplier,
              brand: t.brand,
              title: t.title,
              category: t.category,
              variants: [],
            });
          }
          groups[idx].variants.push(t);
        }

        const pagedGroups = groups.slice(offset, offset + limit);
        return json({ total: groups.length, total_variants: expanded.length, limit, offset, results: pagedGroups });
      }

      const results = expanded.slice(offset, offset + limit);

      return json({ total: expanded.length, limit, offset, results });
    }

    // ----------------------------------------------------------------- POST --
    // Either one product (one tier of a code), or { rows: [...] } for a chunk
    // of the price-list import. Both upsert into the consolidated code-level
    // row rather than creating a new physical row per tier - see
    // upsertTier() below, shared by both paths.
    if (request.method === "POST") {
      const data = await request.json();

      // Finds (or creates) the consolidated row for supplierCode+customerId,
      // then inserts-or-updates one tier (matched by the tier's own id if
      // given, else by exact colour+size) inside its variant_data. Used by
      // both the single-product POST and the bulk-import upsert below, and
      // by pencarrie-import.js/uneek-sync.js (which call this same file's
      // POST endpoint, not this function directly - they send one row per
      // tier just like before, this is what actually consolidates them).
      async function upsertTier(r, { preserveSellPrice }) {
        const tierId = r.id || crypto.randomUUID();
        const supplierCode = r.supplier_code || "";
        const customerId = r.customer_id || null;
        const cost = Number(r.cost_price) || 0;
        const vatRate = r.vat_rate === undefined || r.vat_rate === null || r.vat_rate === "" ? 0.2 : Number(r.vat_rate);
        const sell = r.sell_price === undefined || r.sell_price === null || r.sell_price === "" ? null : Number(r.sell_price);
        const colour = r.colour || "";
        const size = r.size || "";

        // A flat fee/service or a customer's own price-list item has no
        // meaningful "code" to consolidate under (supplier_code is often
        // blank, and customer_id-scoped rows were never part of the bloat
        // problem) - those stay exactly as one physical row per item, same
        // as before the consolidation.
        const consolidatable = !!supplierCode && !customerId;

        let row = consolidatable
          ? await db.prepare(`SELECT * FROM products WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL AND item_type = 'garment' LIMIT 1`).bind(supplierCode).first()
          : await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(tierId).first();

        const newTier = {
          id: tierId, colour, size, cost_price: cost,
          vat_rate: vatRate, colour_code: r.colour_code || "", image_url: r.image_url || "",
        };

        if (!row) {
          // Brand-new code (or a non-consolidatable single item) - one row,
          // one tier to start.
          newTier.sell_price = sell;
          await db.prepare(`
            INSERT INTO products (
              id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
              category, cost_price, surcharge_category, vat_rate, sell_price, profit, active,
              customer_id, item_type, variant_data, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
          `).bind(
            tierId, r.supplier || "", supplierCode, r.supplier_ref || "", r.brand || "", r.title || "",
            colour, size, r.category || "", cost, r.surcharge_category || "", vatRate, sell,
            profitOf(sell, cost, vatRate), customerId, r.item_type === "service" ? "service" : "garment",
            JSON.stringify([newTier])
          ).run();
          await addTierToIndex(tierId, tierId);
          return { productId: tierId, tierId, oldSell: null, newSell: sell };
        }

        const tiers = parseVariants(row);
        // Match by exact tier id first (an edit/re-import of a known tier),
        // else by exact colour+size (a fresh import re-upserting the same
        // physical variant under a new synthetic id, same as before).
        let existingIdx = tiers.findIndex((t) => t.id === tierId);
        if (existingIdx === -1) existingIdx = tiers.findIndex((t) => (t.colour || "") === colour && (t.size || "") === size);

        const oldSell = existingIdx >= 0 ? (tiers[existingIdx].sell_price ?? null) : null;
        // "Never overwrite a price Martin already set" - same rule the old
        // per-row upsert used, just applied per-tier now instead of per-row.
        newTier.sell_price = existingIdx >= 0 && preserveSellPrice && oldSell !== null && oldSell !== undefined ? oldSell : sell;
        const finalTierId = existingIdx >= 0 ? tiers[existingIdx].id : tierId;
        newTier.id = finalTierId;

        if (existingIdx >= 0) tiers[existingIdx] = newTier;
        else tiers.push(newTier);

        // Row-level columns (supplier/brand/title/category/etc) always take
        // the latest import's values - only per-tier cost/sell/vat/colour
        // data is tier-scoped. Row-level cost_price/sell_price mirror the
        // first tier, purely so code that still reads those columns
        // directly (facets, push-prices-live.js) keeps working.
        const defaultTier = tiers[0];
        await db.prepare(`
          UPDATE products SET
            supplier = ?, supplier_ref = ?, brand = ?, title = ?, category = ?,
            surcharge_category = ?, active = 1, variant_data = ?,
            colour = ?, size = ?, cost_price = ?, vat_rate = ?, sell_price = ?, profit = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          r.supplier || row.supplier, r.supplier_ref || row.supplier_ref, r.brand || row.brand,
          r.title || row.title, r.category || row.category, r.surcharge_category || row.surcharge_category,
          JSON.stringify(tiers),
          defaultTier.colour, defaultTier.size, defaultTier.cost_price, defaultTier.vat_rate,
          defaultTier.sell_price, profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate),
          row.id
        ).run();
        await addTierToIndex(finalTierId, row.id);
        return { productId: row.id, tierId: finalTierId, oldSell, newSell: newTier.sell_price };
      }

      if (Array.isArray(data.rows)) {
        // Re-running the import must refresh cost prices without ever wiping
        // the sell prices Martin has already set (preserveSellPrice: true).
        // Sequential (not db.batch chunks like before the consolidation) -
        // each row needs to read-modify-write its code's row, which a plain
        // batch of independent INSERTs can't express safely (two tiers of
        // the same new code in one chunk would race on creating the row).
        // Import jobs already chunk their own calls into this endpoint (see
        // pencarrie-import.js/uneek-sync.js), so a chunk here is at most a
        // few hundred rows - fine sequentially within one Worker request.
        let imported = 0;
        for (const r of data.rows) {
          await upsertTier(r, { preserveSellPrice: true });
          imported++;
        }
        return json({ success: true, imported });
      }

      // Single product/tier add (Garment Catalog "+ Add Product" form, or
      // the Customer View catalog picker copying one colour/size into a
      // customer's own price list). preserveSellPrice: false - an explicit
      // single add always uses whatever price was typed, even if (somehow)
      // a tier with that exact id/colour+size already existed.
      const result = await upsertTier(data, { preserveSellPrice: false });
      return json({ success: true, id: result.tierId });
    }

    // ------------------------------------------------------------------ PUT --
    if (request.method === "PUT") {
      const data = await request.json();

      // Restore from the Trash - operates on the whole row (whole code),
      // same as before. See DELETE below, and GET's ?trash=1. Restoring a
      // pre-consolidation trashed tier (one that isn't itself a full
      // consolidated row) uses restore_variant_into_code below instead -
      // admin.html routes 'product' trash entries there specifically.
      if (data.restore) {
        await db.prepare("UPDATE products SET deleted_at = NULL WHERE id = ?").bind(data.id).run();
        return json({ success: true });
      }

      // Folds an old, pre-consolidation trashed row (one physical row = one
      // colour+size, from before this file's rewrite) back in as a tier on
      // its code's active consolidated row - creating that row if the whole
      // code was never migrated/re-imported since. This is the "fully
      // automatic, no need to ask" restore behaviour - admin.html's
      // restoreFromTrash/bulkRestoreFromTrash call this for every 'product'
      // trash entry instead of the generic {restore:true} above, so it
      // works identically whether the trashed item is old-format or already
      // consolidated (a whole-code restore falls through to the same
      // {restore:true} path it always used, since findRowForTier resolves a
      // consolidated row's own id straight back to itself).
      if (data.action === "restore_variant_into_code") {
        const trashedRow = await db.prepare("SELECT * FROM products WHERE id = ?").bind(data.id).first();
        if (!trashedRow) return json({ error: "Trashed item not found" }, 404);

        // Already a (deleted) consolidated row for a code with more than one
        // tier, or has no supplier_code to consolidate under (a service/fee) -
        // just restore it as-is, same as the plain restore above.
        const tiers = parseVariants(trashedRow);
        if (!trashedRow.supplier_code || tiers.length > 1) {
          await db.prepare("UPDATE products SET deleted_at = NULL WHERE id = ?").bind(data.id).run();
          return json({ success: true, merged: false });
        }

        const activeRow = await db.prepare(
          `SELECT * FROM products WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL AND item_type = 'garment' LIMIT 1`
        ).bind(trashedRow.supplier_code).first();

        if (!activeRow) {
          // No active row for this code at all - the trashed row just
          // becomes the active one again.
          await db.prepare("UPDATE products SET deleted_at = NULL WHERE id = ?").bind(data.id).run();
          await addTierToIndex(tiers[0].id, data.id);
          return json({ success: true, merged: false });
        }

        // Merge this tier into the active row's variant_data (skip if a
        // tier with the same colour+size is somehow already there - the
        // active one wins, nothing lost since the trashed copy is only ever
        // a duplicate in that case) and hard-delete the now-redundant
        // standalone trashed row.
        const activeTiers = parseVariants(activeRow);
        const tier = tiers[0];
        const already = activeTiers.some((t) => (t.colour || "") === (tier.colour || "") && (t.size || "") === (tier.size || ""));
        if (!already) {
          activeTiers.push(tier);
          await db.prepare("UPDATE products SET variant_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(JSON.stringify(activeTiers), activeRow.id).run();
          await addTierToIndex(tier.id, activeRow.id);
        }
        await db.prepare("DELETE FROM products WHERE id = ?").bind(data.id).run();
        return json({ success: true, merged: true, product_id: activeRow.id });
      }

      // Category rename/delete - added for the Quick App tab's category
      // management (admin.html) so a category is one thing everywhere
      // (Garments catalog and the Crystal Quick app both read the same
      // products.category column) rather than a separate list to keep in
      // sync. Shared-catalog rows only, same reasoning as apply_pricing
      // below - a customer's own Custom Price List category is theirs.
      if (data.rename_category) {
        const { from, to } = data.rename_category;
        if (!from || !to) return json({ error: "from and to are required" }, 400);
        const res = await db.prepare(`
          UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP
          WHERE category = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL
        `).bind(to, from).run();
        return json({ success: true, updated: res.meta ? res.meta.changes : null });
      }
      // Doesn't delete the products themselves - just clears their category
      // back to uncategorised, same as removing a category should mean
      // "stop grouping these together", not "delete the garments".
      if (data.delete_category) {
        const name = data.delete_category;
        const res = await db.prepare(`
          UPDATE products SET category = '', updated_at = CURRENT_TIMESTAMP
          WHERE category = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL
        `).bind(name).run();
        return json({ success: true, updated: res.meta ? res.meta.changes : null });
      }

      // Bulk pricing: setting sell prices by hand for every code is not
      // realistic, so a markup/margin can be applied across a filtered
      // slice, or a fixed price can be set on all filtered items. Now
      // matches at most ~506 rows (whole codes) even unfiltered, so this
      // fetches matching rows into the Worker and recomputes each tier's
      // price in JS rather than a single SQL UPDATE - a plain UPDATE can't
      // reach inside variant_data, and at this scale (never more than the
      // active garment catalog) doing it in JS is both simpler and cheap.
      if (data.apply_pricing) {
        const a = data.apply_pricing;

        const where = [];
        const binds = [];
        // supplier_code is an EXACT match (unlike q's LIKE) - the "set this
        // one code's price" field on the Garment Catalog's group header
        // uses this, since a LIKE match on the code (e.g. "RX1") would also
        // catch RX101/RX151/RX100 and any other code sharing that
        // substring, not just the single code the header row is for.
        if (a.supplier_code) { where.push(`supplier_code = ?${binds.length + 1}`); binds.push(a.supplier_code); }
        if (a.q) {
          where.push(`(supplier_code LIKE ?${binds.length + 1} OR title LIKE ?${binds.length + 1} OR colour LIKE ?${binds.length + 1} OR brand LIKE ?${binds.length + 1})`);
          binds.push(`%${a.q}%`);
        }
        for (const [k, col] of [["supplier", "supplier"], ["brand", "brand"], ["category", "category"]]) {
          if (a[k]) { where.push(`${col} = ?${binds.length + 1}`); binds.push(a[k]); }
        }
        if (!where.length && !a.confirm_all) {
          return json({ error: "Refusing to reprice the entire catalog without confirm_all" }, 400);
        }
        // Bulk pricing is a Garment Catalog tool for the shared catalog - a
        // customer's own imported price list is edited from their customer
        // record instead, never swept up in a markup/margin pass here.
        where.push("(customer_id IS NULL OR customer_id = '')");
        where.push("deleted_at IS NULL");
        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

        let priceFor;
        if (a.mode === "fixed") {
          const price = Number(a.price);
          if (!isFinite(price) || price < 0) return json({ error: "price must be a non-negative number" }, 400);
          priceFor = () => round2(price);
        } else {
          const pct = Number(a.percent);
          if (!isFinite(pct)) return json({ error: "percent must be a number" }, 400);
          if (a.mode === "margin" && pct >= 100) {
            return json({ error: "A margin of 100% or more is not achievable" }, 400);
          }
          // markup is on cost (cost x 1.5), margin is on the sell price (cost / 0.5)
          priceFor = (cost) => a.mode === "margin" ? round2(cost / (1 - pct / 100)) : round2(cost * (1 + pct / 100));
        }

        const { results: matching } = await db.prepare(`SELECT * FROM products ${clause}`).bind(...binds).all();

        let updated = 0;
        const historyRows = [];
        const BATCH_SIZE = 50;
        let pendingUpdates = [];
        for (const row of matching) {
          const tiers = parseVariants(row);
          let rowChanged = false;
          for (const t of tiers) {
            if (a.only_unpriced && t.sell_price !== null && t.sell_price !== undefined) continue;
            const oldSell = t.sell_price ?? null;
            const newSell = priceFor(Number(t.cost_price) || 0);
            if (oldSell === newSell) continue;
            t.sell_price = newSell;
            rowChanged = true;
            historyRows.push({ id: crypto.randomUUID(), product_id: t.id, supplier_code: row.supplier_code || "", customer_id: null, old_sell_price: oldSell, new_sell_price: newSell });
          }
          if (!rowChanged) continue;
          updated += tiers.length;
          const defaultTier = tiers[0];
          pendingUpdates.push(
            db.prepare(`UPDATE products SET variant_data = ?, colour = ?, size = ?, cost_price = ?, sell_price = ?, profit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .bind(JSON.stringify(tiers), defaultTier.colour, defaultTier.size, defaultTier.cost_price, defaultTier.sell_price, profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate), row.id)
          );
          if (pendingUpdates.length >= BATCH_SIZE) {
            await db.batch(pendingUpdates);
            pendingUpdates = [];
          }
        }
        if (pendingUpdates.length) await db.batch(pendingUpdates);

        for (let i = 0; i < historyRows.length; i += BATCH_SIZE) {
          await db.batch(historyRows.slice(i, i + BATCH_SIZE).map((h) =>
            db.prepare(`INSERT INTO product_price_history (id, product_id, supplier_code, customer_id, old_sell_price, new_sell_price, source) VALUES (?, ?, ?, ?, ?, ?, 'bulk_pricing')`)
              .bind(h.id, h.product_id, h.supplier_code, h.customer_id, h.old_sell_price, h.new_sell_price)
          ));
        }

        return json({ success: true, updated });
      }

      // Single-tier edit (Garment Catalog inline edit, "+ Add Product" form's
      // price entry, saveSellPrice) - resolves which consolidated row owns
      // this tier id, then read-modify-writes just that one entry.
      const row = await findRowForTier(data.id);
      if (!row) return json({ error: "Product not found" }, 404);

      const tiers = parseVariants(row);
      const idx = tiers.findIndex((t) => t.id === data.id);
      if (idx === -1) return json({ error: "Product not found" }, 404);
      const existingTier = tiers[idx];

      const cost = data.cost_price ?? existingTier.cost_price;
      const sell = data.sell_price === undefined ? existingTier.sell_price : data.sell_price;
      const vatRate = data.vat_rate ?? existingTier.vat_rate ?? row.vat_rate;

      tiers[idx] = {
        ...existingTier,
        colour: data.colour ?? existingTier.colour,
        size: data.size ?? existingTier.size,
        cost_price: cost,
        vat_rate: vatRate,
        sell_price: sell === "" ? null : sell,
        colour_code: data.colour_code ?? existingTier.colour_code,
        image_url: data.image_url ?? existingTier.image_url,
      };

      const defaultTier = tiers[0];
      await db.prepare(`
        UPDATE products SET
          supplier = ?, supplier_code = ?, supplier_ref = ?, brand = ?, title = ?, category = ?,
          surcharge_category = ?, active = ?, customer_id = ?, on_website = ?, variant_data = ?,
          colour = ?, size = ?, cost_price = ?, vat_rate = ?, sell_price = ?, profit = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        data.supplier ?? row.supplier,
        data.supplier_code ?? row.supplier_code,
        data.supplier_ref ?? row.supplier_ref,
        data.brand ?? row.brand,
        data.title ?? row.title,
        data.category ?? row.category,
        data.surcharge_category ?? row.surcharge_category,
        data.active ?? row.active,
        data.customer_id ?? row.customer_id,
        data.on_website ?? row.on_website,
        JSON.stringify(tiers),
        defaultTier.colour, defaultTier.size, defaultTier.cost_price, defaultTier.vat_rate,
        defaultTier.sell_price, profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate),
        row.id
      ).run();

      const newSell = tiers[idx].sell_price;
      await logPriceChange(data.id, row.supplier_code, row.customer_id, existingTier.sell_price ?? null, newSell, "manual_edit");

      return json({ success: true });
    }

    // --------------------------------------------------------------- DELETE --
    if (request.method === "DELETE") {
      const data = await request.json();

      // Removes one tier from its code's row (not the whole row, unless it
      // was the last tier). Soft-delete moves the *tier* into a small
      // "removed tiers" holding area on the same row (variant_data_trash) so
      // it stays recoverable without needing a whole standalone trashed row
      // per tier - permanent:true drops it for good. Deleting the last
      // remaining tier trashes/deletes the whole row instead, same as
      // before consolidation.
      async function deleteTier(tierId, permanent) {
        const row = await findRowForTier(tierId);
        if (!row) return false;
        const tiers = parseVariants(row);
        const idx = tiers.findIndex((t) => t.id === tierId);
        if (idx === -1) return false;

        if (tiers.length <= 1) {
          if (permanent) await db.prepare("DELETE FROM products WHERE id = ?").bind(row.id).run();
          else await db.prepare("UPDATE products SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id).run();
          if (permanent) await removeTierFromIndex(tierId);
          return true;
        }

        const [removed] = tiers.splice(idx, 1);
        const defaultTier = tiers[0];
        if (!permanent) {
          let trashedTiers = [];
          try { trashedTiers = JSON.parse(row.variant_data_trash || "[]"); } catch { trashedTiers = []; }
          trashedTiers.push(removed);
          await db.prepare(`
            UPDATE products SET variant_data = ?, variant_data_trash = ?,
              colour = ?, size = ?, cost_price = ?, vat_rate = ?, sell_price = ?, profit = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            JSON.stringify(tiers), JSON.stringify(trashedTiers),
            defaultTier.colour, defaultTier.size, defaultTier.cost_price, defaultTier.vat_rate,
            defaultTier.sell_price, profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate),
            row.id
          ).run();
        } else {
          await db.prepare(`
            UPDATE products SET variant_data = ?,
              colour = ?, size = ?, cost_price = ?, vat_rate = ?, sell_price = ?, profit = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            JSON.stringify(tiers),
            defaultTier.colour, defaultTier.size, defaultTier.cost_price, defaultTier.vat_rate,
            defaultTier.sell_price, profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate),
            row.id
          ).run();
          await removeTierFromIndex(tierId);
        }
        return true;
      }

      if (Array.isArray(data.ids) && data.ids.length) {
        for (const id of data.ids) await deleteTier(id, !!data.permanent);
        return json({ success: true, count: data.ids.length });
      }
      if (data.id) {
        await deleteTier(data.id, !!data.permanent);
        return json({ success: true });
      }
      // "Empty Trash" - a real bulk-import rollback (see the comment on
      // `?trash=1 ... LIMIT 500` above) can leave thousands of trashed rows
      // behind. The Trash tab's per-row bulk delete only ever handles what's
      // currently selected/loaded (max 500 at a time, one DELETE request per
      // row from the browser) - useless at that scale. This wipes every
      // trashed product row in a single query instead, same confirm-flag
      // pattern as the supplier/reset_prices wipes below. Only touches
      // whole trashed rows - a tier soft-deleted into variant_data_trash
      // (see deleteTier above) isn't affected by this; permanently deleting
      // one of those is a normal permanent:true single-tier delete.
      if (data.purge_all_trash && data.confirm) {
        const res = await db.prepare("DELETE FROM products WHERE deleted_at IS NOT NULL").run();
        return json({ success: true, purged: res.meta ? res.meta.changes : null });
      }
      // Clearing a supplier is how a bad import gets rolled back.
      if (data.supplier && data.confirm) {
        const res = await db.prepare("DELETE FROM products WHERE supplier = ?").bind(data.supplier).run();
        return json({ success: true, deleted: res.meta ? res.meta.changes : null });
      }
      // Reset all sell prices to NULL (for wiping bad bulk imports) - clears
      // every tier's sell_price too, not just the row-level default.
      if (data.reset_prices && data.confirm) {
        const { results: allRows } = await db.prepare("SELECT id, variant_data FROM products").all();
        let reset = 0;
        let pending = [];
        for (const row of allRows) {
          const tiers = parseVariants(row);
          let changed = false;
          for (const t of tiers) {
            if (t.sell_price !== null && t.sell_price !== undefined) { t.sell_price = null; changed = true; reset++; }
          }
          if (!changed) continue;
          pending.push(db.prepare("UPDATE products SET variant_data = ?, sell_price = NULL, profit = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(JSON.stringify(tiers), row.id));
          if (pending.length >= 50) { await db.batch(pending); pending = []; }
        }
        if (pending.length) await db.batch(pending);
        return json({ success: true, reset });
      }
      return json({ error: "Provide an id, or a supplier with confirm:true, or reset_prices with confirm:true" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
