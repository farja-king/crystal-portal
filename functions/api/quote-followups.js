// Stale quote follow-up - a quote that was actually emailed but never
// approved/declined after N days gets one gentle "still interested?" nudge,
// instead of just sitting there silently forever. Same shape as
// payment-reminders.js (settings GET/PUT, action:'run_one' for the manual
// button, action:'run' for the daily cron sweep), deliberately a separate
// file rather than folded into that one - a stale quote and an overdue
// invoice are different situations with different audiences (doc_type
// 'quote' vs 'invoice'), and keeping them apart means either can change
// cadence/wording independently.
//
// Unlike payment reminders, this is a ONE-OFF nudge, not a repeating chase -
// see followup_sent_at below. Repeatedly emailed "still interested?" would
// read as pushy for something that was never a firm commitment the way an
// unpaid invoice is.
import { emailShell } from "../_lib/email-template.js";
import { logOrderEvent } from "../_lib/order-events.js";

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
      CREATE TABLE IF NOT EXISTS quote_followup_settings (
        id TEXT PRIMARY KEY,
        days_after_sent INTEGER DEFAULT 5,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // followup_sent_at - when the one-off nudge went out, if it ever has.
    // Doubles as both "don't send it twice" and the flag the Quotes list
    // uses to show a "Stale" badge.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN followup_sent_at TEXT`).run();
    } catch {
      // already exists
    }
    // email_sent_at/accept_token/followup_interval_days - normally added by
    // send-email.js/orders.js, guarded here too in case a cold deploy's cron
    // sweep hits this file before either of those has ever run.
    for (const col of ["email_sent_at TEXT", "accept_token TEXT", "followup_interval_days INTEGER"]) {
      try {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS email_log (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        sent_to TEXT NOT NULL,
        subject TEXT,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    async function getDaysAfterSent() {
      const row = await db.prepare("SELECT days_after_sent FROM quote_followup_settings WHERE id = 'default'").first();
      return row ? Number(row.days_after_sent) : 5;
    }

    if (request.method === "GET") {
      // ?stale=1 - every quote currently eligible/flagged as stale, for the
      // Quotes & Invoices list to badge without duplicating the eligibility
      // logic client-side.
      if (new URL(request.url).searchParams.get("stale")) {
        const defaultDays = await getDaysAfterSent();
        const now = Date.now();
        const { results } = await db.prepare(`
          SELECT id, email_sent_at, followup_interval_days FROM orders
          WHERE doc_type = 'quote' AND archived_at IS NULL
            AND status NOT IN ('approved', 'declined')
            AND email_sent_at IS NOT NULL AND email_sent_at <> ''
        `).all();
        const staleIds = results
          .filter((r) => {
            const ms = parseSqlTimestamp(r.email_sent_at);
            if (!Number.isFinite(ms)) return false;
            const days = Number(r.followup_interval_days) || defaultDays;
            return ms < now - days * 86400000;
          })
          .map((r) => r.id);
        return json({ days_after_sent: defaultDays, stale_ids: staleIds });
      }
      return json({ days_after_sent: await getDaysAfterSent() });
    }

    if (request.method === "PUT") {
      const data = await request.json();
      const days = Math.max(1, Math.min(90, Number(data.days_after_sent) || 5));
      await db.prepare(`
        INSERT INTO quote_followup_settings (id, days_after_sent, updated_at) VALUES ('default', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET days_after_sent = excluded.days_after_sent, updated_at = CURRENT_TIMESTAMP
      `).bind(days).run();
      return json({ success: true, days_after_sent: days });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    if (!env.RESEND_API_KEY) {
      return json({ error: "Email isn't set up yet - the RESEND_API_KEY secret is missing." }, 500);
    }

    async function sendFollowup(order) {
      const to = (order.customer_email || "").trim();
      if (!to) return { sent: false, reason: "No email address on file for this customer" };

      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
      const subject = `Still interested? Quote ${order.quote_number}`;
      const acceptUrl = order.accept_token ? `${new URL(request.url).origin}/accept-quote.html?token=${order.accept_token}` : null;

      const html = emailShell({
        heading: "Just checking in",
        bodyHtml: `<p>Hi ${escapeHtml(order.customer_name)},</p>
          <p>We sent over quote <strong>${escapeHtml(order.quote_number)}</strong> (${money(order.total)}) a little while ago and wanted to check you're still interested.</p>
          <p>No pressure at all - just let us know if you'd like to go ahead, need any changes, or the timing's just not right anymore.</p>
          ${acceptUrl ? `<div style="margin:20px 0;"><a href="${acceptUrl}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Accept &amp; Confirm</a></div>` : ""}
          <p style="font-size:13px;"><a href="https://wa.me/447530576197?text=Hi%2C%20about%20quote%20${encodeURIComponent(order.quote_number || "")}." style="color:#4f46e5;">Or message us on WhatsApp</a></p>`,
        ctaColor: "#4f46e5",
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
          "INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), order.id, to, subject, resendEmailId).run();
        await db.prepare(
          "UPDATE orders SET followup_sent_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(order.id).run();
        await logOrderEvent(db, order.id, "followup_sent", "Stale-quote follow-up emailed");
        return { sent: true };
      } catch (e) {
        return { sent: false, reason: e.message };
      }
    }

    const data = await request.json();

    // Manual "Send follow-up now" - re-sends even if one already went out,
    // same override behaviour as payment-reminders.js's run_one.
    if (data.action === "run_one") {
      if (!data.id) return json({ error: "id is required" }, 400);
      const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.id).first();
      if (!order) return json({ error: "Order not found" }, 404);
      if (order.doc_type !== "quote") return json({ error: "Only quotes can get a stale follow-up" }, 400);
      const result = await sendFollowup(order);
      return json({ success: true, ...result });
    }

    // The daily batch, called by the Worker's cron.
    if (data.action === "run") {
      const defaultDays = await getDaysAfterSent();
      const now = Date.now();

      // Only quotes that were actually emailed (email_sent_at set) and still
      // sit undecided, never archived (an archived quote was deliberately
      // parked, not forgotten), and haven't already had their one nudge.
      // Each quote can override the portal-wide day count via its own
      // followup_interval_days (set in the builder), same as invoices can
      // override payment-reminder cadence - so the day-count check has to
      // happen per-row in JS, not as one shared SQL WHERE clause.
      // email_sent_at is compared in JS (parseSqlTimestamp), not SQL, since
      // D1's CURRENT_TIMESTAMP format doesn't sort/compare reliably against
      // an ISO string built here - same reasoning as payment-reminders.js.
      const { results: candidates } = await db.prepare(`
        SELECT * FROM orders
        WHERE doc_type = 'quote' AND archived_at IS NULL
          AND status NOT IN ('approved', 'declined')
          AND email_sent_at IS NOT NULL AND email_sent_at <> ''
          AND (followup_sent_at IS NULL OR followup_sent_at = '')
      `).all();

      let checked = 0;
      let sent = 0;
      for (const order of candidates) {
        const sentMs = parseSqlTimestamp(order.email_sent_at);
        const days = Number(order.followup_interval_days) || defaultDays;
        if (!Number.isFinite(sentMs) || sentMs > now - days * 86400000) continue; // not stale enough yet
        checked += 1;
        const result = await sendFollowup(order);
        if (result.sent) sent += 1;
      }
      return json({ success: true, checked, sent });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
