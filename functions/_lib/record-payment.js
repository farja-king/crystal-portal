// Shared "record one payment against one order" step - the same sequence
// square-webhook.js always needed to run for a single-invoice card payment
// (insert the payments row, recompute amount_paid/paid_status/paid_at,
// log the event, flip the invoice-paid production step, flip the DTF
// Builder "ready for production" flag), now also needed for a combined
// statement payment that gets split across SEVERAL invoices in one webhook
// call (see customer-statement.js's "Pay all outstanding" link and
// square-webhook.js's statement_payment_links handling). Kept here so both
// call sites can never drift apart on what "recording a payment" means.
import { logOrderEvent } from "./order-events.js";
import { markInvoicePaidStepDone } from "./production-invoice-paid.js";

export async function recordPaymentOnOrder(db, order, amount, { method, notes, receivedAt, squarePaymentId }) {
  const paymentId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO payments (id, order_id, amount, method, type, notes, received_at, square_payment_id)
    VALUES (?, ?, ?, ?, 'payment', ?, ?, ?)
  `).bind(paymentId, order.id, amount, method, notes, receivedAt || new Date().toISOString(), squarePaymentId || null).run();

  const sumRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = ?").bind(order.id).first();
  const amountPaid = sumRow ? sumRow.total : 0;
  let status;
  if (amountPaid <= 0) status = "unpaid";
  else if (amountPaid >= order.total) status = "paid";
  else status = "partial";
  const paidAt = status === "paid" ? new Date().toISOString() : null;
  await db.prepare(
    "UPDATE orders SET amount_paid = ?, paid_status = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(amountPaid, status, paidAt, order.id).run();
  await logOrderEvent(db, order.id, "payment_via_card", `Paid £${amount.toFixed(2)} by card via Square`);
  if (status === "paid") {
    await markInvoicePaidStepDone(db, order.id);
    await db.prepare(
      "UPDATE gang_sheet_uploads SET production_ready_at = CURRENT_TIMESTAMP WHERE order_id = ? AND production_ready_at IS NULL"
    ).bind(order.id).run();
  }
  return { paymentId, amountPaid, status };
}
