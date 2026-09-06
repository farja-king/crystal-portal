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
import { buildDtfOrderItems, createDtfOrder } from "../_lib/gang-sheet-order.js";
import { recordPaymentOnOrder } from "../_lib/record-payment.js";
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
    // See gang-sheet-uploads.js for why this exists - guarded here too
    // since this is exactly where a DTF-Prep order's payment actually
    // completes, and this file can just as easily be first to touch it.
    try {
      await db.prepare(`ALTER TABLE gang_sheet_uploads ADD COLUMN production_ready_at TEXT`).run();
    } catch {
      // already exists
    }
    // Guarded independently here too, same convention - see gang-sheet-
    // checkout.js (where rows normally get created) and gang-sheet-
    // cleanup.js (which sweeps stale ones).
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS gang_sheet_pending_checkouts (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        upload_ids TEXT NOT NULL,
        total REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    // See customer-statement.js - the "Pay all outstanding" link on an
    // account statement covers several invoices with one Square payment,
    // so reference_id points at one of these rows (order_ids, oldest
    // first) instead of a single order id.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS statement_payment_links (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        order_ids TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

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

    let order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(ourOrderId).first();

    // Not a real order yet - reference_id might instead be a DTF-Prep
    // checkout that deliberately deferred creating one (see gang-sheet-
    // checkout.js's gang_sheet_pending_checkouts) until payment, which is
    // exactly what just happened. Create it now, for the first time.
    if (!order) {
      const pending = await db.prepare("SELECT * FROM gang_sheet_pending_checkouts WHERE id = ?").bind(ourOrderId).first();
      if (!pending) return json({ received: true, unmatched: true });

      try {
        await db.prepare(`ALTER TABLE gang_sheet_uploads ADD COLUMN qty INTEGER DEFAULT 1`).run();
      } catch {
        // already exists
      }

      const customer = await db.prepare("SELECT id, name, email FROM customers WHERE id = ?").bind(pending.customer_id).first();
      let uploadIds = [];
      try {
        uploadIds = JSON.parse(pending.upload_ids);
      } catch {
        uploadIds = [];
      }

      if (customer && Array.isArray(uploadIds) && uploadIds.length) {
        const placeholders = uploadIds.map(() => "?").join(",");
        const { results: uploads } = await db.prepare(`
          SELECT id, filename, width_mm, height_mm, price, qty FROM gang_sheet_uploads
          WHERE customer_id = ? AND status = 'pending' AND id IN (${placeholders})
        `).bind(pending.customer_id, ...uploadIds).all();

        if (uploads.length) {
          const authCfg = await db.prepare("SELECT api_key FROM auth_config WHERE id = 'default'").first();
          const authHeaders = { "Content-Type": "application/json" };
          if (authCfg && authCfg.api_key) authHeaders["X-API-Key"] = authCfg.api_key;
          const origin = new URL(request.url).origin;

          const orderItems = buildDtfOrderItems(uploads);
          const newOrderId = await createDtfOrder({ origin, authHeaders, customer }, orderItems);

          await db.prepare(`
            UPDATE gang_sheet_uploads SET order_id = ?, status = 'attached', attached_at = CURRENT_TIMESTAMP, production_ready_at = CURRENT_TIMESTAMP
            WHERE id IN (${placeholders})
          `).bind(newOrderId, ...uploadIds).run();

          order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(newOrderId).first();
        }
      }

      // Job done either way - a stray pending-checkout row past this point
      // costs nothing (gang-sheet-cleanup.js also sweeps these after a few
      // hours regardless), but removing it now means a redelivered webhook
      // for the same event won't try to create a second order.
      await db.prepare("DELETE FROM gang_sheet_pending_checkouts WHERE id = ?").bind(pending.id).run();
    }

    // Still nothing resolved from `orders` directly - reference_id might
    // instead be a combined statement payment (customer-statement.js's
    // "Pay all outstanding" link), which covers several invoices with one
    // Square payment. Split the single payment across those invoices,
    // oldest first, same amount-owed math a person doing this by hand over
    // several Record Payment entries would use, then finish the webhook
    // here rather than falling through to the single-order path below.
    if (!order) {
      const group = await db.prepare("SELECT * FROM statement_payment_links WHERE id = ?").bind(ourOrderId).first();
      if (group) {
        let orderIds = [];
        try {
          orderIds = JSON.parse(group.order_ids);
        } catch {
          orderIds = [];
        }
        let remaining = Number(payment.amount_money && payment.amount_money.amount) / 100;
        if (!remaining || remaining <= 0) return json({ received: true });

        const results = [];
        for (const oid of orderIds) {
          if (remaining <= 0.001) break;
          const invoice = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(oid).first();
          if (!invoice || invoice.paid_status === "paid") continue;
          const owed = Number(invoice.total) - Number(invoice.amount_paid || 0);
          if (owed <= 0.001) continue;
          const applied = Math.min(owed, remaining);
          remaining -= applied;
          const { paymentId, status } = await recordPaymentOnOrder(db, invoice, applied, {
            method: "Card (Square)",
            notes: `Paid by card via Square as part of a combined statement payment (payment ${payment.id})`,
            receivedAt: payment.updated_at,
            squarePaymentId: payment.id,
          });
          results.push({ order_id: invoice.id, invoice_number: invoice.invoice_number, amount: applied, status, paymentId });
        }

        await db.prepare("DELETE FROM statement_payment_links WHERE id = ?").bind(group.id).run();

        // Same best-effort receipt-per-invoice + portal notification as the
        // single-order path below, just once per invoice this payment
        // actually touched.
        const authCfg = await db.prepare("SELECT api_key FROM auth_config WHERE id = 'default'").first();
        const origin = new URL(request.url).origin;
        for (const r of results) {
          if (authCfg && authCfg.api_key) {
            try {
              await fetch(`${origin}/api/receipt`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-API-Key": authCfg.api_key },
                body: JSON.stringify({ order_id: r.order_id, payment_id: r.paymentId }),
              });
            } catch (e) {
              // Payment is already safely recorded either way.
            }
          }
        }
        if (env.RESEND_API_KEY && results.length) {
          const notifyTo = env.NOTIFY_EMAIL_TO || env.RESEND_REPLY_TO || "hello@embroidery.click";
          const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
          const lines = results.map((r) => `<li>${r.invoice_number}: £${r.amount.toFixed(2)} (now ${r.status})</li>`).join("");
          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: fromAddress,
                to: [notifyTo],
                subject: `Combined card payment received - £${(Number(payment.amount_money.amount) / 100).toFixed(2)}`,
                html: `<p>A combined statement payment was received and split across ${results.length} invoice${results.length === 1 ? "" : "s"}:</p><ul>${lines}</ul>`,
              }),
            });
          } catch (e) {
            // Notification failing shouldn't fail the webhook.
          }
        }

        return json({ received: true, recorded: true, combined: true, applied: results });
      }
    }

    if (!order) return json({ received: true, unmatched: true });

    const amount = Number(payment.amount_money && payment.amount_money.amount) / 100;
    if (!amount || amount <= 0) return json({ received: true });

    const { paymentId, status } = await recordPaymentOnOrder(db, order, amount, {
      method: "Card (Square)",
      notes: `Paid by card via Square (payment ${payment.id})`,
      receivedAt: payment.updated_at,
      squarePaymentId: payment.id,
    });

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
