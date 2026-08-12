// Refunds a card payment taken via Square, straight from the portal's
// existing payment history (see the "Refund" button in admin.html's
// loadOrderPayments, shown only next to a payment with method 'Card
// (Square)' and a square_payment_id - a manually-recorded payment has
// neither, and is voided instead via the existing delete_payment action,
// since there's no live card transaction behind it to reverse).
//
// Unlike pay-by-card.js/square-webhook.js, this is a normal authenticated
// /api/* route - Martin clicking a button in the logged-in portal, not a
// customer-facing link - so it goes through the ordinary portal-login gate
// in functions/_middleware.js like everything else here, no exemption
// needed.
//
// Full refund only, deliberately - the exact amount of the original
// payment, never a partial figure typed in by hand. Keeps this a clean
// mirror-image of the payment it's reversing rather than opening up a
// second place amounts can drift from what was actually charged.
const SQUARE_VERSION = "2026-07-15"; // keep in step with pay-by-card.js/square-webhook.js

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // Guard against a cold deploy hitting this file before orders.js has -
    // same "already exists" tolerance as everywhere else.
    try {
      await db.prepare(`ALTER TABLE payments ADD COLUMN refunded_at TEXT`).run();
    } catch {
      // already exists
    }

    const data = await request.json();
    if (!data.payment_id) return json({ error: "payment_id is required" }, 400);

    const payment = await db.prepare("SELECT * FROM payments WHERE id = ?").bind(data.payment_id).first();
    if (!payment) return json({ error: "Payment not found" }, 404);
    if (!payment.square_payment_id) {
      return json({ error: "This wasn't a card payment taken via Square - void it instead if it needs reversing." }, 400);
    }
    if (payment.refunded_at) {
      return json({ error: "This payment has already been refunded." }, 409);
    }
    if (Number(payment.amount) <= 0) {
      return json({ error: "Nothing to refund - this row is already a refund, not a payment." }, 400);
    }

    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(payment.order_id).first();
    if (!order) return json({ error: "The order this payment belongs to no longer exists." }, 404);

    const squareAccessToken = (env.SQUARE_ACCESS_TOKEN || "").trim();
    if (!squareAccessToken) return json({ error: "Square isn't configured - SQUARE_ACCESS_TOKEN is missing." }, 503);

    const squareBase = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const amountPence = Math.round(Number(payment.amount) * 100);

    const refundRes = await fetch(`${squareBase}/v2/refunds`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${squareAccessToken}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        payment_id: payment.square_payment_id,
        amount_money: { amount: amountPence, currency: "GBP" },
        reason: `Refund for ${order.invoice_number || order.quote_number || order.id}`.slice(0, 190),
      }),
    });

    if (!refundRes.ok) {
      const errBody = await refundRes.text().catch(() => "");
      return json({ error: "Square rejected the refund", detail: errBody }, 502);
    }
    const refundData = await refundRes.json();
    const refundId = refundData && refundData.refund && refundData.refund.id;

    await db.prepare("UPDATE payments SET refunded_at = CURRENT_TIMESTAMP WHERE id = ?").bind(payment.id).run();

    // A negative row in the same ledger, not a delete of the original - the
    // original payment stays as the true record of what was charged, and
    // this is the true record of what came back. recomputePaymentSummary's
    // equivalent below (orders.js's own version, duplicated here per this
    // codebase's usual per-file pattern) sums both correctly regardless of
    // sign.
    const refundRowId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO payments (id, order_id, amount, method, type, notes, received_at)
      VALUES (?, ?, ?, 'Card (Square) refund', 'refund', ?, CURRENT_TIMESTAMP)
    `).bind(
      refundRowId, payment.order_id, -Number(payment.amount),
      `Refund of ${payment.id.slice(0, 8)} via Square${refundId ? " (refund " + refundId + ")" : ""}`
    ).run();

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

    return json({ success: true, refund_id: refundId, amount_paid: amountPaid, paid_status: status });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
