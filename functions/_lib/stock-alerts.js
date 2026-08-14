// Shared "recompute quantity from the ledger, then check for a low-stock
// crossing" step - used everywhere a stock_movements row gets inserted
// (a manual +/- in stock.js, an invoice auto-deducting via stock-deduct.js,
// or a new item's starting quantity). Keeping this in one place means the
// alert logic can't drift out of sync between the two call sites.
//
// Only emails Martin on the CROSSING into low stock, not on every
// still-low movement afterward - low_stock_alerted_at on the row is the
// guard: set the moment it's emailed, cleared again once quantity goes
// back above threshold, so the next dip below threshold alerts again.
import { emailShell } from "./email-template.js";

// Keep in sync with admin.html's DEFAULT_REORDER_THRESHOLD - this is the
// portal-wide default for any item that hasn't had its own threshold set.
export const DEFAULT_REORDER_THRESHOLD = 3;

function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function ensureLowStockColumn(db) {
  try {
    await db.prepare("ALTER TABLE stock_items ADD COLUMN low_stock_alerted_at TEXT").run();
  } catch {
    // already exists
  }
}

async function sendLowStockAlert(env, item, qty, threshold, originUrl) {
  if (!env.RESEND_API_KEY) return;
  try {
    const notifyTo = env.NOTIFY_EMAIL_TO || env.RESEND_REPLY_TO || "hello@embroidery.click";
    const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
    const label = [item.item, item.colour, item.size].filter(Boolean).join(" - ");
    const html = emailShell({
      heading: "Low stock alert",
      bodyHtml: `<p><strong>${escapeHtml(label)}</strong>${item.supplier_code ? ` (${escapeHtml(item.supplier_code)})` : ""} is down to <strong>${qty}</strong> - at or below its reorder threshold of ${threshold}.</p>`,
      ctaText: "View Stock",
      ctaUrl: originUrl ? `${originUrl}/admin` : undefined,
    });
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress, to: [notifyTo], subject: `Low stock: ${label}`, html }),
    });
  } catch (e) {
    // Never let a failed notification break the stock movement it's attached to.
  }
}

// Call this instead of a bare "SELECT SUM(delta)... UPDATE quantity" after
// inserting a stock_movements row - db/env come from the calling Function's
// context, stockItemId is the row that just got a new movement, originUrl
// is request URL's origin (for the email's "View Stock" link, optional).
export async function recomputeStockAndAlert(db, env, stockItemId, originUrl) {
  await ensureLowStockColumn(db);

  const totalRow = await db.prepare(
    "SELECT COALESCE(SUM(delta), 0) AS total FROM stock_movements WHERE stock_item_id = ?"
  ).bind(stockItemId).first();
  const qty = totalRow ? totalRow.total : 0;
  await db.prepare(
    "UPDATE stock_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(qty, stockItemId).run();

  const item = await db.prepare("SELECT * FROM stock_items WHERE id = ?").bind(stockItemId).first();
  if (!item) return qty;

  const threshold = item.reorder_threshold === null || item.reorder_threshold === undefined
    ? DEFAULT_REORDER_THRESHOLD : Number(item.reorder_threshold);
  const isLow = qty <= threshold;

  try {
    if (isLow && !item.low_stock_alerted_at) {
      await db.prepare("UPDATE stock_items SET low_stock_alerted_at = CURRENT_TIMESTAMP WHERE id = ?").bind(stockItemId).run();
      await sendLowStockAlert(env, item, qty, threshold, originUrl);
    } else if (!isLow && item.low_stock_alerted_at) {
      await db.prepare("UPDATE stock_items SET low_stock_alerted_at = NULL WHERE id = ?").bind(stockItemId).run();
    }
  } catch (e) {
    // Never let the alert check break the stock movement it's attached to.
  }

  return qty;
}
