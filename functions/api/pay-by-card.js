// Customer-facing "Pay by card" link on an unpaid invoice email. Bank
// transfer stays the default everywhere (it's free and it's what the
// invoice asks for first) - this exists purely so "if someone insists on a
// card" doesn't mean falling back to Square's own invoicing/checkout
// products, which is the whole ecosystem Martin is otherwise moving away
// from. Square is kept for exactly one job here: processing the card
// transaction itself, via its Payment Links (Online Checkout) API.
//
// No login, same unguessable-token pattern as accept-quote.js/design-proofs.js:
// orders.pay_token, generated lazily by send-email.js the first time an
// unpaid invoice goes out. Unlike those two, this is a plain GET that
// redirects straight to Square's hosted checkout page - there's no decision
// to record here (POSTing money isn't something we do; Square's own page
// handles the actual card entry), so there's no reason to insist on a POST
// the way accept-quote/design-proofs do for their decisions.
//
// The actual payment gets recorded back into this portal's ledger by
// functions/api/square-webhook.js once Square confirms it - never by this
// file, which only ever creates the checkout link and hands the customer
// off to Square.
const SQUARE_VERSION = "2026-07-15"; // matches the API version on Martin's Square app/webhook subscription - keep both in step

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);

  // A plain HTML page rather than JSON - this is always hit directly by a
  // browser following a link in an email, never fetched by JS.
  const page = (bodyHtml, status = 200) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crystal Custom Embroidery</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;padding:24px;}
  .card{max-width:420px;width:100%;background:#fff;border-radius:16px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center;color:#0f172a;}
  h1{font-size:18px;margin:0 0 12px;}
  p{font-size:14px;color:#334155;line-height:1.6;}
</style></head>
<body><div class="card">${bodyHtml}</div></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });

  if (request.method !== "GET") {
    return page("<h1>Method not allowed</h1>", 405);
  }

  try {
    // Guard against a cold deploy hitting this file before orders.js/
    // send-email.js has - same "already exists" tolerance as everywhere else.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN pay_token TEXT`).run();
    } catch {
      // already exists
    }

    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) return page("<h1>This link is missing its reference.</h1><p>Please use the link exactly as sent in the email.</p>", 400);

    const o = await db.prepare("SELECT * FROM orders WHERE pay_token = ?").bind(token).first();
    if (!o) return page("<h1>This link isn't valid.</h1>", 404);
    if (o.doc_type !== "invoice") {
      return page("<h1>Nothing to pay here.</h1><p>This isn't an invoice yet.</p>", 409);
    }

    const balance = Number(o.total) - Number(o.amount_paid || 0);
    if (o.paid_status === "paid" || balance <= 0.004) {
      return page(`<h1>✓ Already paid in full</h1><p>Invoice ${escapeHtml(o.invoice_number)} shows no balance outstanding - nothing to pay here.</p>`);
    }

    if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) {
      // Shouldn't normally be reachable - send-email.js only includes this
      // link when both are configured - but the link could be re-used from
      // an old email after Square was disconnected, so handle it gracefully
      // rather than a raw 500.
      return page("<h1>Card payment isn't available right now.</h1><p>Please pay by bank transfer instead, or get in touch and we'll sort another way.</p>", 503);
    }

    const squareBase = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const amountPence = Math.round(balance * 100);

    const res = await fetch(`${squareBase}/v2/online-checkout/payment-links`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
      },
      body: JSON.stringify({
        // A fresh idempotency key every click, deliberately - each visit
        // should create its own live checkout for the current balance
        // (which may have shrunk since a bank-transfer part-payment landed
        // between two clicks), not silently reuse whatever it was before.
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: env.SQUARE_LOCATION_ID,
          // reference_id round-trips back to us on the payment.updated
          // webhook (via Square's own Retrieve Order call) - this is the
          // only thing that lets square-webhook.js know which of our
          // invoices a given Square payment belongs to.
          reference_id: o.id,
          line_items: [{
            name: `Invoice ${o.invoice_number}`.slice(0, 500),
            quantity: "1",
            base_price_money: { amount: amountPence, currency: "GBP" },
          }],
        },
        checkout_options: {
          redirect_url: `${url.origin}/pay-thank-you.html`,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return page(`<h1>Couldn't start checkout.</h1><p>Something went wrong on our end - please try again shortly, or pay by bank transfer instead.</p>`, 502);
    }

    const data = await res.json();
    const checkoutUrl = data && data.payment_link && data.payment_link.url;
    if (!checkoutUrl) {
      return page("<h1>Couldn't start checkout.</h1><p>Please try again shortly, or pay by bank transfer instead.</p>", 502);
    }

    return Response.redirect(checkoutUrl, 302);
  } catch (err) {
    return page(`<h1>Something went wrong.</h1><p>${escapeHtml(err.message)}</p>`, 500);
  }
}
