// Public "Request a Quote" form (see request-quote.html) - the front door
// for a brand new lead who isn't a customer yet, as opposed to every other
// public page in this codebase (accept-quote, pay-by-card, my-orders),
// which are all scoped to someone who already has a quote/invoice/customer
// record. Submitting here creates (or reuses, matched by email) a customer
// record and a row in this file's own quote_requests table - deliberately
// NOT a row in orders, since there's no priced garment lines yet, just "this
// person wants something" - Martin still builds the actual quote by hand
// from the normal New Quote builder, same as any other quote, just starting
// from a pre-filled customer and their message instead of a blank form.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS quote_requests (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        message TEXT,
        status TEXT DEFAULT 'new',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        actioned_at TEXT
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_quote_requests_status ON quote_requests (status)").run();

    // ------------------------------------------------------------------ GET --
    // Authenticated (no token/public path here, unlike this file's own
    // POST below) - the admin-only "Incoming Requests" panel in Quotes &
    // Invoices.
    if (request.method === "GET") {
      const url = new URL(request.url);
      // ?count=1 - just the number still 'new', for the nav badge, so
      // opening the tab doesn't need the full list just to show a count.
      if (url.searchParams.get("count")) {
        const row = await db.prepare("SELECT COUNT(*) AS n FROM quote_requests WHERE status = 'new'").first();
        return json({ count: row ? row.n : 0 });
      }
      const { results } = await db.prepare(
        "SELECT * FROM quote_requests WHERE status <> 'dismissed' ORDER BY created_at DESC"
      ).all();
      return json(results);
    }

    // ----------------------------------------------------------------- POST --
    // The public form submission - no auth, see functions/_middleware.js.
    if (request.method === "POST") {
      const data = await request.json();
      const name = String(data.name || "").trim().slice(0, 200);
      const email = String(data.email || "").trim().slice(0, 200);
      const phone = String(data.phone || "").trim().slice(0, 40);
      const company = String(data.company || "").trim().slice(0, 200);
      const message = String(data.message || "").trim().slice(0, 3000);

      if (!name) return json({ error: "Please enter your name." }, 400);
      if (!email && !phone) return json({ error: "Please leave an email or phone number so we can get back to you." }, 400);
      if (!message) return json({ error: "Please tell us a bit about what you need." }, 400);

      // Basic honeypot - a hidden field real visitors never see or fill in,
      // bots filling every field on the page do. Silently "succeeds" rather
      // than telling a bot it was caught, same as every other anti-spam
      // trick worth using here (this form has no CAPTCHA, so it's the one
      // line of defence against automated junk).
      if (data.website) return json({ success: true });

      // Reuse an existing customer by email if there is one, same matching
      // this codebase already uses elsewhere (email-worker/worker.js's
      // inbound-mail matching) - a returning customer using this form
      // shouldn't fork into a second, duplicate customer record.
      let customerId = null;
      if (email) {
        const existing = await db.prepare(
          "SELECT id FROM customers WHERE lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1"
        ).bind(email).first();
        if (existing) customerId = existing.id;
      }
      if (!customerId) {
        customerId = crypto.randomUUID();
        await db.prepare(`
          INSERT INTO customers (id, name, company, email, phone)
          VALUES (?, ?, ?, ?, ?)
        `).bind(customerId, name, company, email, phone).run();
      }

      const id = crypto.randomUUID();
      await db.prepare(`
        INSERT INTO quote_requests (id, customer_id, name, email, phone, company, message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, customerId, name, email, phone, company, message).run();

      if (env.RESEND_API_KEY) {
        const notifyTo = env.NOTIFY_EMAIL_TO || env.RESEND_REPLY_TO || "hello@embroidery.click";
        const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: fromAddress,
              to: [notifyTo],
              subject: `New quote request: ${name}${company ? " (" + company + ")" : ""}`,
              html: `<p>New quote request from <strong>${escapeHtml(name)}</strong>${company ? " at " + escapeHtml(company) : ""}.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0;font-size:14px;font-family:Arial,sans-serif;">
                  ${email ? `<tr><td style="padding:2px 12px 2px 0;color:#64748b;">Email</td><td>${escapeHtml(email)}</td></tr>` : ""}
                  ${phone ? `<tr><td style="padding:2px 12px 2px 0;color:#64748b;">Phone</td><td>${escapeHtml(phone)}</td></tr>` : ""}
                </table>
                <p style="white-space:pre-line;">${escapeHtml(message)}</p>`,
            }),
          });
        } catch (e) {
          // The request itself is already saved either way - Martin will
          // still see it in the portal even if this notification failed.
        }
      }

      return json({ success: true });
    }

    // ------------------------------------------------------------------ PUT --
    // Admin-only status updates - "Mark contacted" / "Dismiss" on the
    // Incoming Requests panel. Converting to an actual quote happens
    // entirely client-side (admin.html opens the normal New Quote builder
    // pre-filled with this request's customer/message) - there's no
    // separate "convert" action here, since building the real priced
    // garment lines is Martin's own manual work either way.
    if (request.method === "PUT") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      const status = ["new", "contacted", "dismissed"].includes(data.status) ? data.status : null;
      if (!status) return json({ error: "Invalid status" }, 400);
      await db.prepare(
        "UPDATE quote_requests SET status = ?, actioned_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(status, data.id).run();
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
