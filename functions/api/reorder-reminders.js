// Nudges past customers to reorder once it's been a while since their last
// portal invoice - most of Martin's garment work (club/team/school kit) is
// annual, so ~11 months after the last order is when a reorder becomes
// timely rather than premature. Same shape as quote-followups.js (a
// ONE-OFF nudge per order cycle, not a repeating chase like payment
// reminders): reorder_reminder_sent_at on the CUSTOMER (not the order -
// this is the first customer-level "already sent" field in the schema,
// everything else lives on orders) is reset to NULL by orders.js whenever
// a new invoice is created for that customer, so the next reminder times
// off THIS order, not the one that already got a nudge.
import { emailShell } from "../_lib/email-template.js";

// Fixed rather than a settings row like payment-reminders/quote-followups -
// kept simple since this is a coarse "about a year" nudge, not a cadence
// Martin needs to tune per-invoice. Easy to make configurable later if he
// wants that.
const MONTHS_AFTER = 11;

function parseSqlTimestamp(s) {
  if (!s) return NaN;
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  try {
    // See orders.js's resetReorderReminder for the write side of this column.
    try {
      await db.prepare("ALTER TABLE customers ADD COLUMN reorder_reminder_sent_at TEXT").run();
    } catch {
      // already exists
    }
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS email_log (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        sent_to TEXT NOT NULL,
        subject TEXT,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!env.RESEND_API_KEY) {
      return json({ error: "Email isn't set up yet - the RESEND_API_KEY secret is missing." }, 500);
    }

    async function sendReorderReminder(customer, lastOrderLabel) {
      const to = (customer.email || "").trim();
      if (!to) return { sent: false, reason: "No email address on file for this customer" };

      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
      const subject = "Time to reorder?";
      const name = escapeHtml(customer.name || "");

      const html = emailShell({
        heading: "Ready for a refill?",
        bodyHtml: `<p>Hi ${name},</p>
          <p>It's been about ${MONTHS_AFTER} months since your last order with us${lastOrderLabel ? ` (back in ${escapeHtml(lastOrderLabel)})` : ""} - if you're due a reorder for the new season, we'd love to help you sort it.</p>
          <p>No pressure at all - just reply to this email, or get in touch below, whenever suits.</p>
          <p style="font-size:13px;"><a href="https://wa.me/447530576197?text=Hi%2C%20I%27d%20like%20to%20reorder." style="color:#4f46e5;">Or message us on WhatsApp</a></p>`,
        ctaText: "Request a quote",
        ctaUrl: `${new URL(request.url).origin}/request-quote.html`,
      });

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
        });
        if (!res.ok) return { sent: false, reason: "Resend rejected the email" };
        const resendEmailId = await res.json().then((r) => r.id).catch(() => null);

        await db.prepare(
          "INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id) VALUES (?, NULL, ?, ?, ?)"
        ).bind(crypto.randomUUID(), to, subject, resendEmailId).run();
        await db.prepare(
          "UPDATE customers SET reorder_reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(customer.id).run();
        return { sent: true };
      } catch (e) {
        return { sent: false, reason: e.message };
      }
    }

    const data = await request.json();

    // Manual "Send now" from the customer record, re-sends even if one
    // already went out - same override behaviour as quote-followups.js's run_one.
    if (data.action === "run_one") {
      if (!data.id) return json({ error: "id is required" }, 400);
      const customer = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(data.id).first();
      if (!customer) return json({ error: "Customer not found" }, 404);
      const result = await sendReorderReminder(customer, null);
      return json({ success: true, ...result });
    }

    // The daily batch, called by the Worker's cron.
    if (data.action === "run") {
      const cutoffMs = Date.now() - MONTHS_AFTER * 30 * 86400000;

      // Only customers with an email, not deleted, who've had at least one
      // portal invoice, and haven't already had their one nudge since that
      // invoice. The days-stale check happens in JS (parseSqlTimestamp),
      // not SQL, same reasoning as quote-followups.js/payment-reminders.js -
      // D1's CURRENT_TIMESTAMP format doesn't sort/compare reliably against
      // an ISO string built here.
      const { results: candidates } = await db.prepare(`
        SELECT c.*, MAX(o.created_at) AS last_invoice_at
        FROM customers c
        JOIN orders o ON o.customer_id = c.id AND o.doc_type = 'invoice'
        WHERE c.deleted_at IS NULL AND c.email IS NOT NULL AND c.email <> ''
          AND (c.reorder_reminder_sent_at IS NULL OR c.reorder_reminder_sent_at = '')
        GROUP BY c.id
      `).all();

      let checked = 0;
      let sent = 0;
      for (const row of candidates) {
        const ms = parseSqlTimestamp(row.last_invoice_at);
        if (!Number.isFinite(ms) || ms > cutoffMs) continue; // not stale enough yet
        checked += 1;
        const label = new Date(ms).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
        const result = await sendReorderReminder(row, label);
        if (result.sent) sent += 1;
      }
      return json({ success: true, checked, sent });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
