// Automated payment-chasing for overdue invoices.
//
// The portal itself (Cloudflare Pages Functions) has no cron/scheduler, so
// the actual daily trigger lives on the separate crystal-inbox-worker (see
// email-worker/worker.js's scheduled() handler) - it calls this file's
// action:'run' once a day via a plain fetch, authenticated with the same
// X-API-Key mechanism functions/_middleware.js already supports (see
// auth.js's action:'api_key'). The admin portal itself only ever calls the
// settings GET/PUT and action:'run_one' (the manual "Send reminder now"
// button), both of which go through the normal password gate like
// everything else here.
// D1's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" (UTC, space-separated) -
// not reliably parsed as UTC by `new Date(...)` across runtimes, so
// normalize to a real ISO string first.
import { emailShell } from "../_lib/email-template.js";

function parseSqlTimestamp(s) {
  if (!s) return NaN;
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS reminder_settings (
        id TEXT PRIMARY KEY,
        days_after_due INTEGER DEFAULT 7,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // last_reminder_sent_at - drives both "don't chase again today" and the
    // repeat cadence (next reminder is due days_after_due after this one).
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN last_reminder_sent_at TEXT`).run();
    } catch {
      // already exists
    }

    // email_log already exists (created by send-email.js) - reminders are
    // logged into the exact same table so they show up for free in a
    // quote/invoice's existing Communication History panel, no new UI
    // needed there. Guard the CREATE here too in case this endpoint is ever
    // hit before send-email.js has run once on a fresh database.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS email_log (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        sent_to TEXT NOT NULL,
        subject TEXT,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    async function getDaysAfterDue() {
      const row = await db.prepare("SELECT days_after_due FROM reminder_settings WHERE id = 'default'").first();
      return row ? Number(row.days_after_due) : 7;
    }

    if (request.method === "GET") {
      return json({ days_after_due: await getDaysAfterDue() });
    }

    if (request.method === "PUT") {
      const data = await request.json();
      const days = Math.max(1, Math.min(90, Number(data.days_after_due) || 7));
      await db.prepare(`
        INSERT INTO reminder_settings (id, days_after_due, updated_at) VALUES ('default', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET days_after_due = excluded.days_after_due, updated_at = CURRENT_TIMESTAMP
      `).bind(days).run();
      return json({ success: true, days_after_due: days });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    if (!env.RESEND_API_KEY) {
      return json({ error: "Email isn't set up yet - the RESEND_API_KEY secret is missing." }, 500);
    }

    async function sendReminder(order) {
      const to = (order.customer_email || "").trim();
      if (!to) return { sent: false, reason: "No email address on file for this customer" };

      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
      const subject = `Payment reminder: ${order.invoice_number}`;
      // The daily sweep (see the candidates query below) already excludes
      // anything with a payment recorded against it, so this branch should
      // rarely fire in practice - but "Send reminder now" is still offered
      // on a partial invoice for the admin to manually chase the remaining
      // balance, so the wording needs to be right for that case too.
      const amountPaid = Number(order.amount_paid || 0);
      const owedLine = amountPaid > 0
        ? `<strong>${money(order.total - amountPaid)}</strong> still owed (${money(amountPaid)} already paid, out of a total of ${money(order.total)})`
        : `<strong>${money(order.total)}</strong>`;
      const stillShowsLine = amountPaid > 0
        ? "still shows a balance outstanding on our records"
        : "still shows as unpaid on our records";
      const html = emailShell({
        heading: "Payment reminder",
        bodyHtml: `<p>Hi ${escapeHtml(order.customer_name)},</p>
          <p>Just a friendly reminder that invoice <strong>${escapeHtml(order.invoice_number)}</strong> - ${owedLine} -
             ${order.due_date ? `was due on ${escapeHtml(order.due_date)}` : "is now overdue"} and ${stillShowsLine}.</p>
          <p>If you've already paid this, please let us know so we can update it - otherwise we'd appreciate payment at your earliest convenience.</p>
          <p style="font-size:13px;"><a href="https://wa.me/447530576197?text=Hi%2C%20about%20invoice%20${encodeURIComponent(order.invoice_number || "")}." style="color:#4f46e5;">Or message us on WhatsApp</a></p>`,
        ctaColor: "#d97706",
      });

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
        });
        if (!res.ok) return { sent: false, reason: "Resend rejected the email" };

        await db.prepare(
          "INSERT INTO email_log (id, order_id, sent_to, subject) VALUES (?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), order.id, to, subject).run();
        await db.prepare(
          "UPDATE orders SET last_reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(order.id).run();
        return { sent: true };
      } catch (e) {
        return { sent: false, reason: e.message };
      }
    }

    const data = await request.json();

    // Sends exactly one invoice's reminder right now, regardless of the due
    // date/cadence check below - the admin's manual "Send reminder now"
    // button.
    if (data.action === "run_one") {
      if (!data.id) return json({ error: "id is required" }, 400);
      const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.id).first();
      if (!order) return json({ error: "Order not found" }, 404);
      if (order.doc_type !== "invoice") return json({ error: "Only invoices can be chased for payment" }, 400);
      const result = await sendReminder(order);
      return json({ success: true, ...result });
    }

    // The daily batch, called by the Worker's cron - not meant to be hit
    // from the admin UI. Each invoice can override the portal-wide day
    // count via orders.reminder_interval_days, so the day-count check has
    // to happen per-row in JS rather than as one shared SQL WHERE clause.
    if (data.action === "run") {
      const defaultDays = await getDaysAfterDue();
      const now = Date.now();

      // paid_status = 'unpaid' only (not != 'paid') - the moment any
      // payment lands, even a deposit as small as £1, the automatic chase
      // stops entirely rather than continuing to remind for the remaining
      // balance. A partial invoice can still be chased by hand via "Send
      // reminder now" if Martin wants to follow up on what's left.
      // reminder_paused = 0 (or unset) excludes anything explicitly paused
      // via the row actions' Pause Reminders toggle - a full opt-out,
      // regardless of due date or cadence.
      const { results: candidates } = await db.prepare(`
        SELECT * FROM orders
        WHERE doc_type = 'invoice' AND paid_status = 'unpaid'
          AND due_date IS NOT NULL AND due_date <> ''
          AND (reminder_paused IS NULL OR reminder_paused = 0)
      `).all();

      let checked = 0;
      let sent = 0;
      for (const order of candidates) {
        const days = Number(order.reminder_interval_days) || defaultDays;
        const cutoffMs = now - days * 86400000;

        const dueMs = new Date(order.due_date).getTime();
        if (!Number.isFinite(dueMs) || dueMs > cutoffMs) continue; // not overdue by enough days yet

        if (order.last_reminder_sent_at) {
          const lastMs = parseSqlTimestamp(order.last_reminder_sent_at);
          if (Number.isFinite(lastMs) && lastMs > cutoffMs) continue; // reminded too recently for this invoice's own cadence
        }

        checked += 1;
        const result = await sendReminder(order);
        if (result.sent) sent += 1;
      }
      return json({ success: true, checked, sent });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
