// Records a card payment taken via Square (see pay-by-card.js for the other
// half - it only ever creates the checkout link and hands the customer off
// to Square; this file is what actually lands the money back in the
// portal's own payments ledger, exactly as if Martin had clicked Record
// Payment himself).
//
// Square calls this - there's no session, no X-API-Key, nothing this portal
// issued. The ONLY thing that proves a request genuinely came from Square is
// its HMAC-SHA256 signature over (this endpoint's exact URL + the exact raw
// request body), using the Webhook Signature Key from the Square dashboard's
// subscription for this URL. functions/_middleware.js exempts this path
// entirely from the portal-login gate for that reason - this file is its own
// gate, and a request that fails signature verification is rejected outright
// rather than silently trusted.
import { logOrderEvent } from "../_lib/order-events.js";
const SQUARE_VERSION = "2026-07-15"; // matches the API version on Martin's Square app/webhook subscription - keep in step with pay-by-card.js

async function verifySquareSignature(request, rawBody, signatureKey) {
  const signatureHeader = request.headers.get("x-square-hmacsha256-signature");
  if (!signatureHeader || !signatureKey) return false;

  // Must be the EXACT URL Square is configured to POST to (protocol+host+
  // path, no query string) - a mismatch here (e.g. http vs https, a trailing
  // slash) makes every signature fail even though the payload is genuine.
  const notificationUrl = new URL(request.url).origin + new URL(request.url).pathname;
  const payload = notificationUrl + rawBody;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(signatureKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  // Not a true constant-time compare (Workers has no crypto.timingSafeEqual
  // exposed) - acceptable here since this guards a single low-volume
  // endpoint, not a high-value auth token used across the app.
  return computed === signatureHeader;
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();

  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    // Not configured yet - reject rather than silently trust an
    // unverifiable request. Nothing to record if Square hasn't been wired
    // up this far.
    return json({ error: "Webhook not configured" }, 503);
  }
  const verified = await verifySquareSignature(request, rawBody, (env.SQUARE_WEBHOOK_SIGNATURE_KEY || "").trim());
  if (!verified) return json({ error: "Invalid signature" }, 401);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    // square_payment_id on payments - dedupe key, since Square can and does
    // redeliver the same webhook (and payment.updated fires more than once
    // per payment as its status moves toward COMPLETED, not just at the end).
    try {
      await db.prepare(`ALTER TABLE payments ADD COLUMN square_payment_id TEXT`).run();
    } catch {
      // already exists
    }

    if (event.type !== "payment.updated") return json({ received: true });

    const payment = event.data && event.data.object && event.data.object.payment;
    if (!payment || payment.status !== "COMPLETED") return json({ received: true });

    const existing = await db.prepare("SELECT id FROM payments WHERE square_payment_id = ?").bind(payment.id).first();
    if (existing) return json({ received: true, already_recorded: true });

    // .trim() defensively - see pay-by-card.js for why (a value pasted into
    // the Cloudflare dashboard can pick up a trailing space/newline).
    const squareAccessToken = (env.SQUARE_ACCESS_TOKEN || "").trim();
    if (!squareAccessToken) return json({ error: "Square not configured" }, 503);

    // payment.order_id is Square's own order id, not ours - reference_id on
    // that Square order is what pay-by-card.js set to our orders.id at
    // link-creation time, so a lookup round-trip is unavoidable here.
    const squareBase = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const orderRes = await fetch(`${squareBase}/v2/orders/${payment.order_id}`, {
      headers: { "Authorization": `Bearer ${squareAccessToken}`, "Square-Version": SQUARE_VERSION },
    });
    if (!orderRes.ok) return json({ error: "Could not resolve Square order" }, 502);
    const orderData = await orderRes.json();
    const ourOrderId = orderData && orderData.order && orderData.order.reference_id;
    if (!ourOrderId) return json({ received: true, unmatched: true });

    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(ourOrderId).first();
    if (!order) return json({ received: true, unmatched: true });

    const amount = Number(payment.amount_money && payment.amount_money.amount) / 100;
    if (!amount || amount <= 0) return json({ received: true });

    const paymentId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO payments (id, order_id, amount, method, type, notes, received_at, square_payment_id)
      VALUES (?, ?, ?, 'Card (Square)', 'payment', ?, ?, ?)
    `).bind(
      paymentId, order.id, amount,
      `Paid by card via Square (payment ${payment.id})`,
      payment.updated_at || new Date().toISOString(),
      payment.id
    ).run();

    // Same recompute orders.js's recomputePaymentSummary does - duplicated
    // rather than imported, same self-contained-file pattern every other
    // Function here follows.
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

    // Fire the same receipt email the Record Payment modal's "send receipt"
    // checkbox triggers - reusing /api/receipt.js rather than duplicating
    // its template. This is a server-to-server call, so it needs the same
    // X-API-Key auth as accept-quote.js/design-proofs.js's internal calls
    // (see functions/_middleware.js) - without it, it would 401 silently.
    let receiptSent = false;
    try {
      const authCfg = await db.prepare("SELECT api_key FROM auth_config WHERE id = 'default'").first();
      if (authCfg && authCfg.api_key) {
        const origin = new URL(request.url).origin;
        const receiptRes = await fetch(`${origin}/api/receipt`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": authCfg.api_key },
          body: JSON.stringify({ order_id: order.id, payment_id: paymentId }),
        });
        const receiptData = await receiptRes.json().catch(() => null);
        receiptSent = !!(receiptData && receiptData.sent);
      }
    } catch (e) {
      // Payment is already safely recorded either way - a receipt can be
      // resent by hand from the portal if this failed.
    }

    // Notify the portal, same pattern as accept-quote.js/design-proofs.js.
    if (env.RESEND_API_KEY) {
      const notifyTo = env.NOTIFY_EMAIL_TO || env.RESEND_REPLY_TO || "hello@embroidery.click";
      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromAddress,
            to: [notifyTo],
            subject: `Card payment received: ${order.invoice_number} - £${amount.toFixed(2)}`,
            html: `<p><strong>${order.customer_name}</strong> paid <strong>£${amount.toFixed(2)}</strong> by card (Square) against <strong>${order.invoice_number}</strong>.</p>` +
              `<p>Status is now <strong>${status}</strong>.${receiptSent ? " A receipt was emailed automatically." : ""}</p>`,
          }),
        });
      } catch (e) {
        // Notification failing shouldn't fail the webhook.
      }
    }

    return json({ received: true, recorded: true, payment_id: paymentId, status });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
