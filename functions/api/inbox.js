// The portal side of the built-in email inbox. Incoming mail is written
// into this same D1 table (inbox_emails) by a separate Cloudflare Email
// Worker (see email-worker/worker.js in this repo - deployed on its own,
// not part of this Pages project, since Email Routing can only target a
// standalone Worker, not a Pages Function). This file only ever reads and
// manages what's already there, plus sends new outbound mail via Resend.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  try {
    // Same table the Email Worker writes into - defined here too since
    // whichever of the two runs first is the one that actually creates it.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS inbox_emails (
        id TEXT PRIMARY KEY,
        direction TEXT DEFAULT 'inbound',
        from_address TEXT,
        from_name TEXT,
        to_address TEXT,
        subject TEXT,
        body_text TEXT,
        customer_id TEXT,
        is_read INTEGER DEFAULT 0,
        raw_r2_key TEXT,
        deleted_at TEXT,
        received_at TEXT DEFAULT CURRENT_TIMESTAMP,
        saved_to_customer INTEGER DEFAULT 0
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_inbox_customer ON inbox_emails (customer_id)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox_emails (received_at)").run();
    // The table already existed on live D1 before saved_to_customer was
    // added to the CREATE TABLE above - same "already exists" tolerance as
    // every other API here.
    try {
      await db.prepare("ALTER TABLE inbox_emails ADD COLUMN saved_to_customer INTEGER DEFAULT 0").run();
    } catch {
      // already exists
    }

    const url = new URL(request.url);

    // Downloads the original raw .eml straight from R2 - a safety net, since
    // the body_text shown in the list is only a best-effort plain-text
    // extraction (see email-worker/worker.js), not a full MIME parse.
    if (request.method === "GET" && url.searchParams.get("raw")) {
      const id = url.searchParams.get("raw");
      const row = await db.prepare("SELECT raw_r2_key, subject FROM inbox_emails WHERE id = ?").bind(id).first();
      if (!row || !row.raw_r2_key) return json({ error: "Original message not found" }, 404);
      const obj = bucket ? await bucket.get(row.raw_r2_key) : null;
      if (!obj) return json({ error: "Original message missing from storage" }, 404);
      return new Response(obj.body, {
        headers: {
          "Content-Type": "message/rfc822",
          "Content-Disposition": `attachment; filename="${(row.subject || "email").replace(/["/\\]/g, "")}.eml"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (request.method === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        const row = await db.prepare("SELECT * FROM inbox_emails WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Not found" }, 404);
        return json(row);
      }

      // ?customer_id=X is specifically "this customer's saved record" (the
      // Customer View's Email Conversation card) - only emails explicitly
      // marked saved_to_customer, not every auto-matched one, so a
      // customer's record doesn't fill up with every single message that
      // happened to come from their address. The main Inbox tab (no
      // customer_id param) always shows everything regardless of that flag.
      const customerId = url.searchParams.get("customer_id");
      const where = ["deleted_at IS NULL"];
      const binds = [];
      if (customerId) { where.push("customer_id = ?", "saved_to_customer = 1"); binds.push(customerId); }
      const { results } = await db.prepare(
        `SELECT id, direction, from_address, from_name, to_address, subject, customer_id, is_read, received_at, saved_to_customer,
                substr(body_text, 1, 160) AS preview
         FROM inbox_emails WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT 300`
      ).bind(...binds).all();
      return json(results);
    }

    if (request.method === "PUT") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      if (data.is_read !== undefined) {
        await db.prepare("UPDATE inbox_emails SET is_read = ? WHERE id = ?").bind(data.is_read ? 1 : 0, data.id).run();
      }
      // "Add to customer account" - explicitly saves this one email into a
      // customer's record (see the ?customer_id filter above). Also sets
      // customer_id itself, since an email from someone not auto-matched at
      // receive time (a brand-new enquiry that's since become a customer,
      // or a matching miss) can be attached by hand here too.
      if (data.saved_to_customer !== undefined) {
        await db.prepare("UPDATE inbox_emails SET saved_to_customer = ?, customer_id = COALESCE(?, customer_id) WHERE id = ?")
          .bind(data.saved_to_customer ? 1 : 0, data.customer_id || null, data.id).run();
      }
      return json({ success: true });
    }

    if (request.method === "DELETE") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      await db.prepare("UPDATE inbox_emails SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").bind(data.id).run();
      return json({ success: true });
    }

    // POST - compose and send a brand-new outbound email (not tied to a
    // quote/invoice - see functions/api/send-email.js for that flow). Logs
    // itself into the same table on success so it shows in the thread.
    if (request.method === "POST") {
      if (!env.RESEND_API_KEY) {
        return json({ error: "Email isn't set up yet - the RESEND_API_KEY secret is missing from this Pages project." }, 500);
      }
      const data = await request.json();
      const to = (data.to || "").trim();
      const subject = (data.subject || "").trim();
      const bodyText = data.body || "";
      if (!to) return json({ error: "A recipient email address is required" }, 400);
      if (!subject) return json({ error: "A subject is required" }, 400);

      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
      const html = `<div style="font-family:Arial,sans-serif;color:#0f172a;white-space:pre-wrap;">${escapeHtml(bodyText)}</div>`;

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
      });
      if (!resendRes.ok) {
        const errBody = await resendRes.text();
        return json({ error: "Resend rejected the email: " + errBody }, 502);
      }

      // A reply/compose explicitly tied to a customer (via the customer
      // picker or replying to an already-saved email) is itself a
      // deliberate action worth keeping on their record - unlike inbound
      // mail, which only gets auto-matched, not auto-saved.
      const id = crypto.randomUUID();
      await db.prepare(`
        INSERT INTO inbox_emails (id, direction, from_address, to_address, subject, body_text, customer_id, is_read, saved_to_customer)
        VALUES (?, 'outbound', ?, ?, ?, ?, ?, 1, ?)
      `).bind(id, fromAddress, to, subject, bodyText, data.customer_id || null, data.customer_id ? 1 : 0).run();

      return json({ success: true, id });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
