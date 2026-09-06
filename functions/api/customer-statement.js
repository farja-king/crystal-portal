// Emails a customer a statement covering every invoice they have, not just
// one - a per-invoice line (number, date, total, paid, balance) plus an
// overall total. Deliberately a separate endpoint from statement.js (which
// stays exactly as it was, scoped to a single order) rather than adding a
// customer_id branch there, so this new customer-wide feature can't affect
// the existing per-invoice Send Statement button in any way.
import { emailShell } from "../_lib/email-template.js";

const SQUARE_VERSION = "2026-07-15"; // keep in step with pay-by-card.js/gang-sheet-checkout.js's own constant

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);
  const ukDate = (raw) => {
    if (!raw) return "";
    const d = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
    if (isNaN(d)) return raw;
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  };

  if (!env.RESEND_API_KEY) {
    return json({ error: "Email isn't set up yet - the RESEND_API_KEY secret is missing." }, 500);
  }

  // email_log already exists (created by send-email.js) - guarded here too,
  // same defensive pattern as receipt.js/statement.js/payment-reminders.js.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      sent_to TEXT NOT NULL,
      subject TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  for (const col of ["resend_email_id TEXT", "delivery_status TEXT", "delivery_status_at TEXT", "delivery_detail TEXT", "body_html TEXT", "kind TEXT", "step_id TEXT"]) {
    try { await db.prepare(`ALTER TABLE email_log ADD COLUMN ${col}`).run(); } catch {}
  }

  const { customer_id, preview } = await request.json();
  if (!customer_id) return json({ error: "customer_id required" }, 400);

  const customer = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(customer_id).first();
  if (!customer) return json({ error: "Customer not found" }, 404);

  const to = (customer.email || "").trim();
  if (!to) return json({ success: true, sent: false, reason: "No email address on file for this customer" });

  // One row per invoice - a running summary, not every individual payment
  // across every invoice (that could get very long for a customer with a
  // lot of history) - but each invoice's own payments are still listed
  // underneath it, indented, since an invoice date and its actual payment
  // date(s) are often genuinely different (invoiced for a job on the 8th,
  // raised on the 11th, paid on the 12th) and that gap is exactly what a
  // statement needs to show. Archived invoices are included deliberately,
  // same reasoning as the Dashboard's ?all=1 - archiving tidies the working
  // list, it was never meant to erase a sale from a customer's own record
  // of what they've been billed.
  const { results: invoices } = await db.prepare(
    "SELECT * FROM orders WHERE customer_id = ? AND doc_type = 'invoice' ORDER BY created_at ASC"
  ).bind(customer_id).all();

  if (!invoices.length) {
    return json({ success: true, sent: false, reason: "This customer has no invoices yet" });
  }

  const paymentsByInvoice = {};
  if (invoices.length) {
    const placeholders = invoices.map(() => "?").join(",");
    const { results: payments } = await db.prepare(
      `SELECT * FROM payments WHERE order_id IN (${placeholders}) ORDER BY received_at ASC, created_at ASC`
    ).bind(...invoices.map((o) => o.id)).all();
    payments.forEach((p) => {
      if (!paymentsByInvoice[p.order_id]) paymentsByInvoice[p.order_id] = [];
      paymentsByInvoice[p.order_id].push(p);
    });
  }

  const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
  const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
  const subject = `Statement: ${customer.name || "your account"}`;

  const totalInvoiced = invoices.reduce((s, o) => s + Number(o.total || 0), 0);
  const totalPaid = invoices.reduce((s, o) => s + Number(o.amount_paid || 0), 0);
  const totalBalance = totalInvoiced - totalPaid;

  const invoiceRows = invoices.map((o) => {
    const balance = Number(o.total || 0) - Number(o.amount_paid || 0);
    const statusLabel = o.paid_status === "paid" ? "Paid" : o.paid_status === "partial" ? "Partial" : "Unpaid";
    const mainRow = `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#64748b;">${escapeHtml(o.invoice_number)}</td>
        <td style="padding:4px 12px 4px 0;color:#64748b;">${escapeHtml(ukDate(o.created_at))}</td>
        <td style="padding:4px 12px 4px 0;">${money(o.total)}</td>
        <td style="padding:4px 12px 4px 0;">${statusLabel}</td>
        <td style="padding:4px 0;font-weight:600;text-align:right;">${money(balance)}</td>
      </tr>`;
    const paymentRows = (paymentsByInvoice[o.id] || []).map((p) => `
      <tr>
        <td colspan="4" style="padding:1px 12px 1px 20px;color:#94a3b8;font-size:12px;">↳ Paid ${escapeHtml(ukDate(p.received_at))}${p.method ? " (" + escapeHtml(p.method) + ")" : ""}</td>
        <td style="padding:1px 0;text-align:right;color:#64748b;font-size:12px;">${money(p.amount)}</td>
      </tr>`).join("");
    return mainRow + paymentRows;
  }).join("");

  const overallLine = totalBalance <= 0
    ? `<p style="font-weight:600;color:#16a34a;">Everything on your account is paid in full - thank you!</p>`
    : `<p>Total balance due across all invoices: <strong>${money(totalBalance)}</strong> (of ${money(totalInvoiced)} invoiced, ${money(totalPaid)} paid to date).</p>`;

  // "Pay all outstanding" - one Square Payment Link for the whole balance,
  // covering every unpaid/partial invoice on this statement in a single
  // card payment, rather than the customer having to pay each individually.
  // square-webhook.js resolves it back via reference_id -> a
  // statement_payment_links row (order_ids, oldest first) and splits the
  // one payment across them - see that file and recordPaymentOnOrder() in
  // _lib/record-payment.js for the other half of this.
  //
  // Real send only (never during preview - each preview click would
  // otherwise mint a fresh, unused Square link every time staff just wants
  // to see the wording), and only when there's actually something to pay.
  let payCtaUrl = null;
  const unpaidOrderIds = invoices.filter((o) => o.paid_status !== "paid").map((o) => o.id);
  if (!preview && totalBalance > 0.001 && unpaidOrderIds.length) {
    const squareAccessToken = (env.SQUARE_ACCESS_TOKEN || "").trim();
    const squareLocationId = (env.SQUARE_LOCATION_ID || "").trim();
    if (squareAccessToken && squareLocationId) {
      try {
        await db.prepare(`
          CREATE TABLE IF NOT EXISTS statement_payment_links (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            order_ids TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `).run();
        const groupId = crypto.randomUUID();
        const squareBase = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
        const squareRes = await fetch(`${squareBase}/v2/online-checkout/payment-links`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${squareAccessToken}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_VERSION,
          },
          body: JSON.stringify({
            idempotency_key: crypto.randomUUID(),
            order: {
              location_id: squareLocationId,
              reference_id: groupId,
              line_items: [{
                name: `Account balance - ${unpaidOrderIds.length} invoice${unpaidOrderIds.length === 1 ? "" : "s"}`,
                quantity: "1",
                base_price_money: { amount: Math.round(totalBalance * 100), currency: "GBP" },
              }],
            },
          }),
        });
        if (squareRes.ok) {
          const squareData = await squareRes.json();
          const checkoutUrl = squareData && squareData.payment_link && squareData.payment_link.url;
          if (checkoutUrl) {
            await db.prepare(
              "INSERT INTO statement_payment_links (id, customer_id, order_ids) VALUES (?, ?, ?)"
            ).bind(groupId, customer_id, JSON.stringify(unpaidOrderIds)).run();
            payCtaUrl = checkoutUrl;
          }
        }
      } catch (e) {
        // A statement with no working pay link is still useful (it's the
        // whole point of the email otherwise) - never block the send over
        // this failing.
      }
    }
  }

  const html = emailShell({
    heading: "Account Statement",
    bodyHtml: `<p>Hi ${escapeHtml(customer.name)},</p>
      <p>Here's a summary of every invoice on your account:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:12px 0;font-size:14px;border-collapse:collapse;">
        <tr style="color:#94a3b8;font-size:12px;text-transform:uppercase;">
          <td style="padding:0 12px 4px 0;">Invoice</td>
          <td style="padding:0 12px 4px 0;">Date</td>
          <td style="padding:0 12px 4px 0;">Total</td>
          <td style="padding:0 12px 4px 0;">Status</td>
          <td style="padding:0 0 4px;text-align:right;">Balance</td>
        </tr>
        ${invoiceRows}
      </table>
      ${overallLine}
      ${(preview && totalBalance > 0.001) ? `<p style="color:#94a3b8;font-size:12px;">(A secure "Pay all outstanding" link will be included here when this statement is actually sent.)</p>` : ""}`,
    ctaText: payCtaUrl ? `Pay ${money(totalBalance)} now` : undefined,
    ctaUrl: payCtaUrl || undefined,
    ctaColor: "#16a34a",
  });

  // Preview mode - builds and returns the exact email (subject/to/html)
  // without sending or logging anything, so the admin UI can show it in a
  // "review before sending" popup. The real send below is untouched, and
  // only ever runs when this isn't set.
  if (preview) {
    return json({ success: true, preview: true, to, subject, html });
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
    });
    if (!res.ok) return json({ success: true, sent: false, reason: "Resend rejected the email" });
    const resendEmailId = await res.json().then((r) => r.id).catch(() => null);

    // Logged once per invoice included, so "statement sent" shows up in
    // each of that invoice's own Communication History panel too - there's
    // no single order_id this email is "about", and email_log requires one.
    await db.batch(invoices.map((o) =>
      db.prepare("INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id, body_html, kind) VALUES (?, ?, ?, ?, ?, ?, 'customer_statement')")
        .bind(crypto.randomUUID(), o.id, to, subject, resendEmailId, html)
    ));

    return json({ success: true, sent: true });
  } catch (e) {
    return json({ success: true, sent: false, reason: e.message || "Failed to send" });
  }
}
