// Seeds Stock rows from Garment Catalog rows - shared by the Stock tab's
// "Sync Garment Catalog" button (functions/api/stock.js) and the automatic
// re-seed that runs when a garment is restored from the Trash
// (functions/api/products.js). Both do exactly the same thing to a catalog
// row; they only differ in which rows they hand over, so the expansion and
// insert logic lives here once rather than in two places that would
// otherwise drift apart.
//
// A catalog row is ONE row per product code since the consolidation (see
// products.js's file header) - its colour/size tiers live inside
// `variant_data` JSON. Stock is the opposite shape: one row per exact
// colour+size sitting on a shelf. So one catalog row fans out into as many
// stock rows as it has tiers.
//
// Insert-only, never update: an existing stock row is left completely
// alone (its quantity, prices, threshold and notes are Martin's, not the
// catalog's - a stock row is deliberately not linked back to the catalog
// row it came from, see stock.js's file header). New rows land at quantity
// 0 with no movement, which keeps the ledger honest - a zero balance from
// zero movements needs no "starting balance" row to reconcile against.
const CHUNK_SIZE = 50;

// stock_items is created lazily by stock.js - guard here too, since the
// restore-from-Trash path in products.js can be the first thing to touch
// it on a fresh DB (same reasoning as _lib/stock-deduct.js's own guard).
async function ensureStockTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id TEXT PRIMARY KEY, item TEXT NOT NULL, supplier_code TEXT, brand TEXT,
      colour TEXT, size TEXT, quantity REAL DEFAULT 0, cost_price REAL DEFAULT 0,
      sale_price REAL DEFAULT 0, reorder_threshold REAL, notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  // Predates the CREATE above on live D1, and every match below is made on
  // it - so it has to exist before the first SELECT, not just before the
  // first insert.
  try {
    await db.prepare("ALTER TABLE stock_items ADD COLUMN supplier_code TEXT").run();
  } catch {
    // already exists
  }
}

// Same fallback as products.js's parseVariants - a row with empty/missing
// variant_data is its own single tier, so this works on un-consolidated
// rows too.
function tiersOf(row) {
  let tiers = null;
  try {
    tiers = JSON.parse(row.variant_data || "[]");
  } catch {
    tiers = null;
  }
  if (!Array.isArray(tiers) || !tiers.length) {
    return [{ colour: row.colour || "", size: row.size || "", cost_price: row.cost_price, sell_price: row.sell_price }];
  }
  return tiers;
}

const keyOf = (code, colour, size) =>
  `${String(code || "").trim().toLowerCase()}|${String(colour || "").trim().toLowerCase()}|${String(size || "").trim().toLowerCase()}`;

// rows: raw `products` rows (already filtered by the caller to the ones it
// wants seeded). Returns what it did, so both callers can report a count.
export async function seedStockFromCatalogRows(db, rows) {
  await ensureStockTable(db);

  const codes = [...new Set(
    (rows || []).map((r) => String(r.supplier_code || "").trim()).filter(Boolean)
  )];
  if (!codes.length) return { created: 0, existing: 0, codes: 0 };

  // What's already on the shelf for these codes. Deliberately NOT filtered
  // by deleted_at: a stock row sitting in the Trash still counts as
  // existing, so seeding can't quietly create a second copy of something
  // Martin deleted and may yet restore.
  const existingKeys = new Set();
  for (let i = 0; i < codes.length; i += CHUNK_SIZE) {
    const slice = codes.slice(i, i + CHUNK_SIZE);
    const { results } = await db.prepare(
      `SELECT supplier_code, colour, size FROM stock_items WHERE supplier_code IN (${slice.map(() => "?").join(",")})`
    ).bind(...slice).all();
    for (const r of results || []) existingKeys.add(keyOf(r.supplier_code, r.colour, r.size));
  }

  const pending = [];
  let created = 0;
  let existing = 0;
  for (const row of rows || []) {
    const code = String(row.supplier_code || "").trim();
    if (!code) continue;
    for (const tier of tiersOf(row)) {
      const colour = String(tier.colour || "").trim();
      const size = String(tier.size || "").trim();
      const key = keyOf(code, colour, size);
      // existingKeys grows as we go, so two catalog rows sharing a code (or
      // a duplicated tier inside one row) can't queue the same stock row twice.
      if (existingKeys.has(key)) { existing++; continue; }
      existingKeys.add(key);
      pending.push(db.prepare(`
        INSERT INTO stock_items (id, item, supplier_code, brand, colour, size, cost_price, sale_price, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
      `).bind(
        crypto.randomUUID(),
        String(row.title || code).trim(),
        code,
        String(row.brand || "").trim(),
        colour,
        size,
        Number(tier.cost_price) || 0,
        Number(tier.sell_price) || 0
      ));
      created++;
    }
  }

  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    await db.batch(pending.slice(i, i + CHUNK_SIZE));
  }

  return { created, existing, codes: codes.length };
}
