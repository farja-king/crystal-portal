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
        body_html TEXT,
        customer_id TEXT,
        is_read INTEGER DEFAULT 0,
        raw_r2_key TEXT,
        deleted_at TEXT,
        received_at TEXT DEFAULT CURRENT_TIMESTAMP,
        saved_to_customer INTEGER DEFAULT 0,
        message_id TEXT,
        in_reply_to TEXT,
        thread_id TEXT
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_inbox_customer ON inbox_emails (customer_id)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox_emails (received_at)").run();
    // The table already existed on live D1 before these were added to the
    // CREATE TABLE above - same "already exists" tolerance as every other
    // API here. Must run before the thread_id index below, or that index
    // creation fails outright on a table that doesn't have the column yet.
    for (const col of ["saved_to_customer INTEGER DEFAULT 0", "message_id TEXT", "in_reply_to TEXT", "thread_id TEXT", "body_html TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE inbox_emails ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_inbox_thread ON inbox_emails (thread_id)").run();
    // Every message from before thread_id existed has it NULL, not "equal
    // to its own id" - the frontend's grouping already falls back to
    // treating a NULL thread_id as a singleton thread keyed by the
    // message's own id, but a ?thread_id= lookup for that id would find
    // nothing (the stored value is genuinely NULL, not that id), making
    // the message effectively unclickable/undeletable. Backfilling once
    // makes the actual column match what the frontend already assumes.
    // Idempotent and a no-op once every row has a thread_id.
    await db.prepare("UPDATE inbox_emails SET thread_id = id WHERE thread_id IS NULL").run();

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

      // ?thread_id=X - every message in one conversation, full body_text,
      // oldest first (see the Inbox tab's threaded view). Not filtered by
      // saved_to_customer - that flag only governs what shows on a
      // *customer's* record, not what's part of a thread.
      if (url.searchParams.get("thread_id")) {
        const { results } = await db.prepare(
          "SELECT * FROM inbox_emails WHERE deleted_at IS NULL AND thread_id = ? ORDER BY received_at ASC"
        ).bind(url.searchParams.get("thread_id")).all();
        return json(results);
      }

      // ?customer_id=X&count_all=1 - how many inbox_emails rows actually
      // match this customer_id, ignoring saved_to_customer/deleted_at
      // entirely - the real scope purge_customer_history (DELETE below)
      // would remove, used to show an accurate count before that
      // permanent action is confirmed (see admin.html's
      // clearCustomerInboxHistory()). Deliberately broader than the
      // ?customer_id=X view below.
      if (url.searchParams.get("customer_id") && url.searchParams.get("count_all")) {
        const row = await db.prepare(
          "SELECT COUNT(*) AS cnt FROM inbox_emails WHERE customer_id = ?"
        ).bind(url.searchParams.get("customer_id")).first();
        return json({ count: row ? row.cnt : 0 });
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
        `SELECT id, direction, from_address, from_name, to_address, subject, customer_id, is_read, received_at, saved_to_customer, thread_id,
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

      // Genuinely permanent, unlike every other delete below (those are all
      // soft - deleted_at, recoverable, keeps the raw R2 file). This is for
      // deliberately clearing a customer's message history for good - e.g.
      // a test customer's inbox after testing is done - not day-to-day
      // Inbox tidying, so it's scoped by customer_id rather than exposed as
      // a normal message action, and always confirmed client-side first
      // (see admin.html's clearCustomerInboxHistory()).
      if (data.action === "purge_customer_history") {
        if (!data.customer_id) return json({ error: "customer_id required" }, 400);
        const { results: rows } = await db.prepare(
          "SELECT id, raw_r2_key FROM inbox_emails WHERE customer_id = ?"
        ).bind(data.customer_id).all();
        if (!rows.length) return json({ success: true, purged: 0 });
        if (bucket) {
          await Promise.all(rows.filter((r) => r.raw_r2_key).map((r) => bucket.delete(r.raw_r2_key).catch(() => {})));
        }
        await db.prepare("DELETE FROM inbox_emails WHERE customer_id = ?").bind(data.customer_id).run();
        return json({ success: true, purged: rows.length });
      }

      // Bulk: either a list of individual email ids, or a list of thread
      // ids (deletes every message in each thread) - the Inbox tab's
      // checkbox UI uses whichever matches what was selected.
      if (Array.isArray(data.ids) && data.ids.length) {
        const placeholders = data.ids.map(() => "?").join(",");
        await db.prepare(`UPDATE inbox_emails SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).bind(...data.ids).run();
        return json({ success: true, count: data.ids.length });
      }
      if (Array.isArray(data.thread_ids) && data.thread_ids.length) {
        const placeholders = data.thread_ids.map(() => "?").join(",");
        await db.prepare(`UPDATE inbox_emails SET deleted_at = CURRENT_TIMESTAMP WHERE thread_id IN (${placeholders})`).bind(...data.thread_ids).run();
        return json({ success: true, count: data.thread_ids.length });
      }
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

      // Real conversation threading: if this is a reply, look up the parent
      // message's own Message-ID and thread_id so this reply (a) sets
      // proper In-Reply-To/References headers on the outgoing email - the
      // standard mechanism every email client uses to thread a
      // conversation, including the customer's own inbox - and (b) joins
      // the same thread_id here, so it groups with the rest of the
      // conversation in the Inbox tab. We generate our own Message-ID
      // explicitly (rather than trusting whatever Resend assigns) so we
      // know for certain what a future reply's In-Reply-To will reference.
      const id = crypto.randomUUID();
      const messageId = `<${id}@embroidery.click>`;
      let threadId = id;
      let parentMessageId = null;
      if (data.in_reply_to_id) {
        const parent = await db.prepare("SELECT id, message_id, thread_id FROM inbox_emails WHERE id = ?").bind(data.in_reply_to_id).first();
        if (parent) {
          threadId = parent.thread_id || parent.id;
          parentMessageId = parent.message_id || null;
        }
      }

      const resendHeaders = { "Message-ID": messageId };
      if (parentMessageId) {
        resendHeaders["In-Reply-To"] = parentMessageId;
        resendHeaders["References"] = parentMessageId;
      }

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html, headers: resendHeaders }),
      });
      if (!resendRes.ok) {
        const errBody = await resendRes.text();
        return json({ error: "Resend rejected the email: " + errBody }, 502);
      }

      // A reply/compose explicitly tied to a customer (via the customer
      // picker or replying to an already-saved email) is itself a
      // deliberate action worth keeping on their record - unlike inbound
      // mail, which only gets auto-matched, not auto-saved.
      await db.prepare(`
        INSERT INTO inbox_emails (id, direction, from_address, to_address, subject, body_text, customer_id, is_read, saved_to_customer, message_id, in_reply_to, thread_id)
        VALUES (?, 'outbound', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).bind(id, fromAddress, to, subject, bodyText, data.customer_id || null, data.customer_id ? 1 : 0, messageId, parentMessageId, threadId).run();

      return json({ success: true, id });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
