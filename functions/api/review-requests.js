// The "Confirmed Pickup?" checkbox on the main Quotes & Invoices list -
// separate from the Production Tracker's own "Order collected" step (that
// one's just internal tracking) - schedules a friendly "hope you enjoyed
// it, please leave a review" email for whenever the customer actually
// walked out the door with their order.
//
// Cloudflare Pages Functions have no cron of their own, and Workers Cron
// Triggers only run on a fixed recurring schedule (no one-off "send this
// exact email at 3pm today"), so the same crystal-inbox-worker that already
// runs the daily payment-reminder sweep also sweeps this table - see its
// scheduled() handler in email-worker/worker.js. That Worker's cron needs
// to run more often than once a day for "in a couple hours"/"tomorrow
// midday" to actually land close to the chosen time - see the comment on
// that handler for the recommended frequency.
import { emailShell } from "../_lib/email-template.js";

const GOOGLE_REVIEW_URL = "https://www.google.com/search?q=crystal+custom+embroidery+google+review&oq=crystal+custom+embroidery+google+review&gs_lcrp=EgZjaHJvbWUyBggAEEUYOTIHCAEQIRiPAtIBBzQwN2owajSoAgCwAgE&sourceid=chrome&source=chrome.ob&ie=UTF-8#lrd=0x4877a1edc8eae3d9:0x8f8bf17b0f059923,1,,,,";

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
    // pickup_confirmed_at - when the "Confirmed Pickup?" box was ticked.
    // review_email_scheduled_at - when the review-request email should go
    // out (may be in the past already, meaning "send on the next sweep" -
    // see action:'run' below). review_email_sent_at - once it's actually
    // gone, so it's never sent twice for the same confirmation.
    for (const col of ["pickup_confirmed_at TEXT", "review_email_scheduled_at TEXT", "review_email_sent_at TEXT"]) {
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

    async function sendReviewEmail(order) {
      if (!env.RESEND_API_KEY) return { sent: false, reason: "Email isn't set up yet - the RESEND_API_KEY secret is missing." };
      const to = (order.customer_email || "").trim();
      if (!to) return { sent: false, reason: "No email address on file for this customer" };

      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
      const docNumber = order.doc_type === "invoice" ? order.invoice_number : order.quote_number;
      const subject = `Hope you're loving your order! - ${docNumber}`;
      const html = emailShell({
        heading: "Hope you love it! 🧵",
        bodyHtml: `<p>Hi ${escapeHtml(order.customer_name)},</p>
          <p>Thanks so much for picking up order <strong>${escapeHtml(docNumber)}</strong> - we really hope you love it!</p>
          <p>If you have a couple of minutes, a quick Google review would mean a lot to us and helps other customers find us too.</p>`,
        ctaText: "Leave a Google Review",
        ctaUrl: GOOGLE_REVIEW_URL,
        ctaColor: "#f59e0b",
      });

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
        });
        if (!res.ok) return { sent: false, reason: "Resend rejected the email" };
        try {
          await db.prepare(
            "INSERT INTO email_log (id, order_id, sent_to, subject) VALUES (?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), order.id, to, subject).run();
        } catch (e) {
          // email_log couldn't be written to - the email still sent either way
        }
        return { sent: true };
      } catch (e) {
        return { sent: false, reason: e.message };
      }
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const data = await request.json();

    // Ticking "Confirmed Pickup?" - always records the confirmation, and
    // either sends right away (send_at is now-or-past) or leaves it for the
    // next sweep to pick up at the chosen time.
    if (data.action === "confirm_pickup") {
      if (!data.id) return json({ error: "id is required" }, 400);
      const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.id).first();
      if (!order) return json({ error: "Order not found" }, 404);

      const sendAt = data.send_at ? new Date(data.send_at) : new Date();
      if (isNaN(sendAt.getTime())) return json({ error: "Invalid send_at" }, 400);
      const sendAtIso = sendAt.toISOString();

      await db.prepare(
        "UPDATE orders SET pickup_confirmed_at = CURRENT_TIMESTAMP, review_email_scheduled_at = ?, review_email_sent_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(sendAtIso, data.id).run();

      if (sendAt.getTime() <= Date.now()) {
        const result = await sendReviewEmail(order);
        if (result.sent) {
          await db.prepare("UPDATE orders SET review_email_sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(data.id).run();
        }
        return json({ success: true, sent_now: true, email: result });
      }
      return json({ success: true, sent_now: false, scheduled_for: sendAtIso });
    }

    // Unticking - a correction (ticked by mistake), not "the review email
    // shouldn't have gone" - if it already sent, that's left in email_log
    // as history same as everything else here.
    if (data.action === "unconfirm_pickup") {
      if (!data.id) return json({ error: "id is required" }, 400);
      await db.prepare(
        "UPDATE orders SET pickup_confirmed_at = NULL, review_email_scheduled_at = NULL, review_email_sent_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(data.id).run();
      return json({ success: true });
    }

    // The sweep - called by the Worker's cron (see file header). Anything
    // whose scheduled time has arrived and hasn't sent yet goes out now.
    if (data.action === "run") {
      const nowIso = new Date().toISOString();
      const { results: due } = await db.prepare(
        "SELECT * FROM orders WHERE review_email_scheduled_at IS NOT NULL AND review_email_scheduled_at <= ? AND review_email_sent_at IS NULL"
      ).bind(nowIso).all();

      let sent = 0;
      for (const order of due) {
        const result = await sendReviewEmail(order);
        if (result.sent) {
          sent += 1;
          await db.prepare("UPDATE orders SET review_email_sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(order.id).run();
        }
      }
      return json({ success: true, checked: due.length, sent });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
