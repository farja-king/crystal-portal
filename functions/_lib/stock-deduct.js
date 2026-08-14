// Best-effort stock deduction when a quote becomes an invoice (or an
// invoice is created directly) - see functions/api/stock.js for the
// ledger-over-raw-value pattern this reuses. A garment line's real
// per-unit colour/size/qty lives in item.breakdown[] (see orders.js's
// priceItems); each breakdown row is matched against stock_items by
// supplier_code + colour + size. No match (no stock item set up for
// that exact code/colour/size, or a customer-supplied line with no
// catalog code at all) is silently skipped - stock tracking here is
// opt-in, not every garment on every order has a shelf count kept for
// it. Called from orders.js; never throws, since a failure here must
// never block the invoice action it's attached to.
//
// env/originUrl are passed straight through to recomputeStockAndAlert so
// an invoice that drops an item to/below its reorder threshold sends the
// exact same low-stock email a manual +/- adjustment would - see
// _lib/stock-alerts.js for the shared crossing-detection logic.
import { recomputeStockAndAlert } from "./stock-alerts.js";

export async function deductStockForOrder(db, items, reason, env, originUrl, orderId) {
  const deducted = [];
  try {
    // stock_items/stock_movements are created lazily by stock.js - guard
    // here too in case this runs before that endpoint has ever been hit
    // (a fresh DB, or an order converted before Stock was ever opened).
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS stock_items (
        id TEXT PRIMARY KEY, item TEXT NOT NULL, supplier_code TEXT, brand TEXT,
        colour TEXT, size TEXT, quantity REAL DEFAULT 0, cost_price REAL DEFAULT 0,
        sale_price REAL DEFAULT 0, reorder_threshold REAL, notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY, stock_item_id TEXT NOT NULL, delta REAL NOT NULL,
        reason TEXT, order_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    // order_id was added after this table already existed on live D1 - see
    // functions/api/stock.js's own guard for the same column (either file
    // could be the first to touch this table on a given deploy).
    try {
      await db.prepare("ALTER TABLE stock_movements ADD COLUMN order_id TEXT").run();
    } catch {
      // already exists
    }

    for (const item of Array.isArray(items) ? items : []) {
      // Only real catalog garment lines carry a supplier_code that can be
      // matched against Stock - customer-supplied lines and services never
      // have one, so they're skipped rather than matched on blank strings.
      if (item.source !== "catalog" || !item.supplier_code) continue;

      const rows = Array.isArray(item.breakdown) && item.breakdown.length
        ? item.breakdown
        : [{ colour: item.colour, size: item.size, qty: item.qty }];

      for (const row of rows) {
        const qty = Number(row.qty) || 0;
        const colour = String(row.colour || "").trim();
        const size = String(row.size || "").trim();
        if (!qty || !colour || !size) continue;

        const stockItem = await db.prepare(
          "SELECT id, item, quantity FROM stock_items WHERE supplier_code = ? AND colour = ? AND size = ?"
        ).bind(item.supplier_code, colour, size).first();
        if (!stockItem) continue;

        await db.prepare(
          "INSERT INTO stock_movements (id, stock_item_id, delta, reason, order_id) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), stockItem.id, -qty, reason, orderId || null).run();

        const newQty = await recomputeStockAndAlert(db, env, stockItem.id, originUrl);

        deducted.push({ item: stockItem.item, colour, size, qty, newQty });
      }
    }
  } catch (e) {
    // Never let stock deduction break the invoice action it's attached to.
  }
  return deducted;
}
