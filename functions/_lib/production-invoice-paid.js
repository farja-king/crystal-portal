// Auto-ticks the Production Tracker's "Invoice paid" step the moment an
// invoice is genuinely paid in full - a real payment (Record Payment,
// Square card checkout, or a webhook landing with nobody watching) used to
// only ever update paid_status/amount_paid; the tracker itself stayed
// exactly where it was until someone separately remembered to go tick the
// step by hand. On INV-0034, paid via Square, nobody had - the invoice was
// genuinely paid but the tracker still showed "Invoice paid" as the
// current, not-done step days later. Called from every place that can move
// an order to paid_status = 'paid': orders.js's recomputePaymentSummary
// (Record Payment), square-webhook.js (a card payment via Square Payment
// Links), same "duplicated per file, not imported" pattern those already
// use for the payment-summary arithmetic itself - only this one small piece
// (finding/completing the step) is shared, since it's genuine logic rather
// than a one-line sum.
import { logOrderEvent } from "./order-events.js";

export async function markInvoicePaidStepDone(db, orderId) {
  try {
    // Exact title match, case-insensitive - a tracker with no step by this
    // name (custom-renamed, or deleted) is left alone rather than guessed
    // at, same restraint the bulk "mark step done" action uses. Already
    // 'done' is a silent no-op, not re-logged/re-dated.
    const step = await db.prepare(
      "SELECT id FROM production_steps WHERE order_id = ? AND title = 'Invoice paid' COLLATE NOCASE AND status != 'done' LIMIT 1"
    ).bind(orderId).first();
    if (!step) return;
    await db.prepare(
      "UPDATE production_steps SET status = 'done', completed_at = CURRENT_TIMESTAMP, notified_at = NULL WHERE id = ?"
    ).bind(step.id).run();
    await logOrderEvent(db, orderId, "production_step", "Production: Invoice paid");
  } catch (e) {
    // Never let this break the payment that triggered it - the payment
    // itself is already safely recorded either way, this is just the
    // tracker catching up to reflect it.
  }
}
