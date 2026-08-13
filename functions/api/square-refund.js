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
import { emailShell } from "../_lib/email-template.js";
import { logOrderEvent } from "../_lib/order-events.js";

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
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);

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
    await logOrderEvent(db, order.id, "refunded", `Refunded £${Number(payment.amount).toFixed(2)} via Square`);

    // Customer-facing confirmation - the mirror image of receipt.js's
    // "payment received" email, sent automatically the same way rather than
    // left for Martin to explain by hand. A refund with no customer email on
    // file still succeeds (the money's already moved either way); it just
    // has nothing to send to.
    let customerEmailed = false;
    const customerTo = (order.customer_email || "").trim();
    if (env.RESEND_API_KEY && customerTo) {
      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
      const docNumber = order.invoice_number || order.quote_number;
      const html = emailShell({
        heading: "Refund processed",
        bodyHtml: `<p>Hi ${escapeHtml(order.customer_name)},</p>
          <p>We've refunded <strong>${money(payment.amount)}</strong> back to the card used on <strong>${escapeHtml(docNumber)}</strong> - it should appear on your statement within a few business days, depending on your bank.</p>
          <p>Get in touch if you have any questions about this.</p>`,
        ctaColor: "#d97706",
      });
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromAddress, to: [customerTo], reply_to: replyToAddress,
            subject: `Refund processed: ${docNumber}`, html,
          }),
        });
        customerEmailed = res.ok;
        if (res.ok) {
          try {
            await db.prepare(
              "INSERT INTO email_log (id, order_id, sent_to, subject) VALUES (?, ?, ?, ?)"
            ).bind(crypto.randomUUID(), order.id, customerTo, `Refund processed: ${docNumber}`).run();
          } catch (e) {
            // email_log table doesn't exist yet - the email still sent, just not logged this time
          }
        }
      } catch (e) {
        // The refund itself already succeeded either way - Martin can see
        // customerEmailed: false in the response and follow up by hand.
      }
    }

    // Martin's own confirmation - same "notify the portal" pattern as
    // accept-quote.js/design-proofs.js/square-webhook.js, so refunding
    // (which he might do from his phone, away from the portal) still gets
    // an explicit "yes, that went through" rather than just trusting the
    // button didn't error.
    if (env.RESEND_API_KEY) {
      const notifyTo = env.NOTIFY_EMAIL_TO || env.RESEND_REPLY_TO || "hello@embroidery.click";
      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const docNumber = order.invoice_number || order.quote_number;
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromAddress,
            to: [notifyTo],
            subject: `Refund processed: ${docNumber} - ${money(payment.amount)}`,
            html: `<p>Refunded <strong>${money(payment.amount)}</strong> to <strong>${escapeHtml(order.customer_name)}</strong> against <strong>${escapeHtml(docNumber)}</strong> via Square.</p>` +
              `<p>Balance is now ${money(Number(order.total) - amountPaid)} (${status}).${customerEmailed ? " The customer was emailed a confirmation." : customerTo ? " Their confirmation email failed to send." : " No email on file for them to notify."}</p>`,
          }),
        });
      } catch (e) {
        // Notification failing shouldn't fail the refund - it already went through.
      }
    }

    return json({ success: true, refund_id: refundId, amount_paid: amountPaid, paid_status: status, customer_emailed: customerEmailed });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
