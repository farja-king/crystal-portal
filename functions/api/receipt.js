// Emails a customer a receipt for one specific payment recorded against an
// invoice (see the payments ledger in functions/api/orders.js). Deliberately
// its own endpoint rather than folded into send-email.js - a receipt is
// about a single payments row, not the order as a whole, and reuses
// emailShell() (the same plain HTML-card style payment-reminders.js uses)
// rather than the bespoke full-invoice layout send-email.js builds.
import { emailShell } from "../_lib/email-template.js";

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

  // email_log already exists (created by send-email.js) - guarded here too
  // in case this endpoint is ever hit before that one has run once on a
  // fresh database, same defensive pattern as payment-reminders.js.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      sent_to TEXT NOT NULL,
      subject TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const { order_id, payment_id } = await request.json();
  if (!order_id || !payment_id) return json({ error: "order_id and payment_id required" }, 400);

  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(order_id).first();
  if (!order) return json({ error: "Order not found" }, 404);
  const payment = await db.prepare("SELECT * FROM payments WHERE id = ? AND order_id = ?").bind(payment_id, order_id).first();
  if (!payment) return json({ error: "Payment not found" }, 404);

  const to = (order.customer_email || "").trim();
  if (!to) return json({ success: true, sent: false, reason: "No email address on file for this customer" });

  const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
  const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
  const subject = `Payment receipt: ${order.invoice_number}`;

  const balance = Number(order.total) - Number(order.amount_paid || 0);
  const balanceLine = order.paid_status === "paid"
    ? `<p style="font-weight:600;color:#16a34a;">This invoice is now paid in full - thank you!</p>`
    : `<p>Balance due: <strong>${money(balance)}</strong> of ${money(order.total)}.</p>`;

  const html = emailShell({
    heading: "Payment received",
    bodyHtml: `<p>Hi ${escapeHtml(order.customer_name)},</p>
      <p>Thanks - we've recorded a payment against invoice <strong>${escapeHtml(order.invoice_number)}</strong>:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0;font-size:14px;">
        <tr><td style="padding:2px 12px 2px 0;color:#64748b;">Amount</td><td style="font-weight:600;">${money(payment.amount)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#64748b;">Date</td><td>${escapeHtml(ukDate(payment.received_at))}</td></tr>
        ${payment.method ? `<tr><td style="padding:2px 12px 2px 0;color:#64748b;">Method</td><td>${escapeHtml(payment.method)}</td></tr>` : ""}
      </table>
      ${balanceLine}`,
    ctaColor: "#16a34a",
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
    });
    if (!res.ok) return json({ success: true, sent: false, reason: "Resend rejected the email" });
    const resendEmailId = await res.json().then((r) => r.id).catch(() => null);

    await db.prepare(
      "INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), order_id, to, subject, resendEmailId).run();
    await db.prepare(
      "UPDATE payments SET receipt_sent_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(payment_id).run();

    return json({ success: true, sent: true });
  } catch (e) {
    return json({ success: true, sent: false, reason: e.message || "Failed to send" });
  }
}
