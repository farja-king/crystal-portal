// Emails a customer a statement for one invoice - every payment recorded
// against it plus the current balance due, not tied to a single payment
// (see functions/api/receipt.js for the per-payment version, sent
// automatically/optionally right after recording one). A statement is a
// deliberate "send me a fresh copy of everything on this invoice" action,
// callable at any time - e.g. when a customer says they lost a receipt, or
// just wants a running summary rather than the last-one-sent receipt.
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

  // email_log already exists (created by send-email.js) - guarded here too,
  // same defensive pattern as receipt.js/payment-reminders.js.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      sent_to TEXT NOT NULL,
      subject TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const { order_id, preview } = await request.json();
  if (!order_id) return json({ error: "order_id required" }, 400);

  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(order_id).first();
  if (!order) return json({ error: "Order not found" }, 404);

  const to = (order.customer_email || "").trim();
  if (!to) return json({ success: true, sent: false, reason: "No email address on file for this customer" });

  const { results: payments } = await db.prepare(
    "SELECT * FROM payments WHERE order_id = ? ORDER BY received_at ASC, created_at ASC"
  ).bind(order_id).all();

  const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
  const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
  const subject = `Statement: ${order.invoice_number}`;

  // A per-invoice statement is about this specific invoice, so it should
  // remind the customer what it was actually for - unlike the customer-
  // wide statement (customer-statement.js), which stays a summary across
  // every invoice and deliberately doesn't list line items. Manual
  // invoices (functions/api/manual-invoice.js) have no items to parse -
  // items.length is simply 0 there, so this section just doesn't render.
  const items = JSON.parse(order.items || "[]");
  const itemsSection = items.length ? `
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:12px 0;font-size:14px;border-collapse:collapse;">
        <tr style="color:#94a3b8;font-size:12px;text-transform:uppercase;">
          <td style="padding:0 12px 4px 0;">Item</td>
          <td style="padding:0 12px 4px 0;">Qty</td>
          <td style="padding:0 12px 4px 0;">Unit</td>
          <td style="padding:0 0 4px;text-align:right;">Total</td>
        </tr>
        ${items.map((item) => {
          const baseLabel = item.source === "catalog"
            ? `${escapeHtml(item.supplier_code || "")} ${escapeHtml(item.title || "")}`.trim()
            : (escapeHtml([item.description, item.title].filter(Boolean).join(" - ")) || "Customer's own garment");
          return `
            <tr>
              <td style="padding:4px 12px 4px 0;">${baseLabel}</td>
              <td style="padding:4px 12px 4px 0;color:#64748b;">${escapeHtml(String(item.qty))}</td>
              <td style="padding:4px 12px 4px 0;color:#64748b;">${money(item.unit_price)}</td>
              <td style="padding:4px 0;text-align:right;">${money(item.line_total)}</td>
            </tr>`;
        }).join("")}
      </table>` : "";

  const balance = Number(order.total) - Number(order.amount_paid || 0);
  const balanceLine = order.paid_status === "paid"
    ? `<p style="font-weight:600;color:#16a34a;">This invoice is paid in full - thank you!</p>`
    : `<p>Balance due: <strong>${money(balance)}</strong> of ${money(order.total)}.</p>`;

  const paymentsRows = payments.length
    ? payments.map((p) => `
        <tr>
          <td style="padding:4px 12px 4px 0;color:#64748b;">${escapeHtml(ukDate(p.received_at))}</td>
          <td style="padding:4px 12px 4px 0;">${p.method ? escapeHtml(p.method) : "-"}</td>
          <td style="padding:4px 0;font-weight:600;text-align:right;">${money(p.amount)}</td>
        </tr>`).join("")
    : `<tr><td colspan="3" style="padding:4px 0;color:#94a3b8;">No payments recorded yet.</td></tr>`;

  const html = emailShell({
    heading: "Statement",
    bodyHtml: `<p>Hi ${escapeHtml(order.customer_name)},</p>
      <p>Here's a summary of invoice <strong>${escapeHtml(order.invoice_number)}</strong> (total ${money(order.total)}):</p>
      ${itemsSection ? `<p style="font-size:12px;color:#94a3b8;text-transform:uppercase;margin:16px 0 0;">Items</p>${itemsSection}` : ""}
      <p style="font-size:12px;color:#94a3b8;text-transform:uppercase;margin:16px 0 0;">Payments</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 12px;font-size:14px;border-collapse:collapse;">
        <tr style="color:#94a3b8;font-size:12px;text-transform:uppercase;">
          <td style="padding:0 12px 4px 0;">Date</td>
          <td style="padding:0 12px 4px 0;">Method</td>
          <td style="padding:0 0 4px;text-align:right;">Amount</td>
        </tr>
        ${paymentsRows}
      </table>
      ${balanceLine}`,
    ctaColor: "#4f46e5",
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

    await db.prepare(
      "INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), order_id, to, subject, resendEmailId).run();

    return json({ success: true, sent: true });
  } catch (e) {
    return json({ success: true, sent: false, reason: e.message || "Failed to send" });
  }
}
