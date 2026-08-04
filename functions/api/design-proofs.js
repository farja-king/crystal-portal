// Design mockup/proof approval workflow. A quote can have several versions
// of a proof image attached over time (v1 rejected with notes, v2 attached
// to replace it, etc) - every version is kept forever in R2 at full
// quality, never overwritten, so "version 2 was approved" always resolves
// to the exact bytes that were actually shown, even years later if a
// dispute ever comes up. Only the LATEST version is ever the "live" one a
// customer's link points at; older versions just sit in the history.
//
// The customer never logs in - each version gets its own unguessable
// token, and the public proof.html page (served as a static file, not a
// Function) uses that token to look up and decide on exactly one proof.
// Decisions are POSTed here, never a plain GET link, so a link-prefetching
// scanner or email client can't accidentally "click" Approve on someone's
// behalf.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  if (!bucket) {
    return json({ error: "File storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS design_proofs (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        customer_id TEXT,
        version INTEGER NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER DEFAULT 0,
        r2_key TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        decision_notes TEXT,
        token TEXT UNIQUE NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sent_at TEXT,
        decided_at TEXT
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_design_proofs_order ON design_proofs (order_id)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_design_proofs_customer ON design_proofs (customer_id)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_design_proofs_token ON design_proofs (token)").run();

    const url = new URL(request.url);

    // Streams the actual image/PDF bytes from R2 - used both by the admin
    // portal (?view=<id>, id isn't secret - same trust level as every other
    // internal API here, none of which are auth-gated beyond the portal's
    // own login) and the public proof.html page (?view_token=<token>, only
    // the exact unguessable link the customer was sent can pull the image).
    if (request.method === "GET" && (url.searchParams.get("view") || url.searchParams.get("view_token"))) {
      const byId = url.searchParams.get("view");
      const byToken = url.searchParams.get("view_token");
      const row = byId
        ? await db.prepare("SELECT * FROM design_proofs WHERE id = ?").bind(byId).first()
        : await db.prepare("SELECT * FROM design_proofs WHERE token = ?").bind(byToken).first();
      if (!row) return json({ error: "Proof not found" }, 404);

      const obj = await bucket.get(row.r2_key);
      if (!obj) return json({ error: "File missing from storage" }, 404);

      return new Response(obj.body, {
        headers: {
          "Content-Type": row.content_type || "application/octet-stream",
          "Content-Disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // GET ?token=X - public, unauthenticated lookup for proof.html: just
    // enough detail to render the decision page, no other order/customer
    // data leaks through this one.
    if (request.method === "GET" && url.searchParams.get("token")) {
      const row = await db.prepare(`
        SELECT p.id, p.version, p.filename, p.content_type, p.status, p.decision_notes, p.token,
               o.quote_number, o.invoice_number, o.doc_type, o.customer_name
        FROM design_proofs p JOIN orders o ON o.id = p.order_id
        WHERE p.token = ?
      `).bind(url.searchParams.get("token")).first();
      if (!row) return json({ error: "This proof link isn't valid." }, 404);
      const docNumber = row.doc_type === "invoice" ? row.invoice_number : row.quote_number;
      return json({
        id: row.id, version: row.version, filename: row.filename, status: row.status,
        decision_notes: row.decision_notes, token: row.token, doc_number: docNumber,
        customer_name: row.customer_name, is_image: /^image\//.test(row.content_type || ""),
      });
    }

    // GET ?order_id=X or ?customer_id=X - version history, newest first, for
    // the internal Quote View panel and the Customer View modal.
    if (request.method === "GET") {
      const orderId = url.searchParams.get("order_id");
      const customerId = url.searchParams.get("customer_id");
      if (!orderId && !customerId) return json({ error: "order_id or customer_id is required" }, 400);

      const where = orderId ? "p.order_id = ?" : "p.customer_id = ?";
      const { results } = await db.prepare(`
        SELECT p.id, p.order_id, p.version, p.filename, p.content_type, p.status, p.decision_notes,
               p.created_at, p.sent_at, p.decided_at, o.quote_number, o.invoice_number, o.doc_type
        FROM design_proofs p JOIN orders o ON o.id = p.order_id
        WHERE ${where} ORDER BY p.order_id, p.version DESC
      `).bind(orderId || customerId).all();
      return json(results);
    }

    // POST - two shapes: multipart/form-data (Martin attaching a new
    // version) or JSON { token, decision, notes } (the customer's decision,
    // POSTed from proof.html - never a plain GET link, see the file header).
    if (request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        const data = await request.json();
        if (!data.token) return json({ error: "token is required" }, 400);
        if (data.decision !== "approved" && data.decision !== "declined") {
          return json({ error: "decision must be 'approved' or 'declined'" }, 400);
        }

        const proof = await db.prepare(`
          SELECT p.*, o.quote_number, o.invoice_number, o.doc_type, o.customer_name
          FROM design_proofs p JOIN orders o ON o.id = p.order_id
          WHERE p.token = ?
        `).bind(data.token).first();
        if (!proof) return json({ error: "This proof link isn't valid." }, 404);
        if (proof.status !== "pending") {
          return json({ error: `This proof was already marked ${proof.status} - no further action needed.` }, 409);
        }

        const notes = (data.notes || "").slice(0, 1000);
        await db.prepare(
          "UPDATE design_proofs SET status = ?, decision_notes = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(data.decision, notes, proof.id).run();

        // Notify the portal - same pattern as the Inbox's new-mail
        // notification (a plain email via Resend, since a phone's Mail app
        // already pushes new-mail notifications natively).
        if (env.RESEND_API_KEY) {
          const notifyTo = env.NOTIFY_EMAIL_TO || env.RESEND_REPLY_TO || "hello@embroidery.click";
          const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
          const docNumber = proof.doc_type === "invoice" ? proof.invoice_number : proof.quote_number;
          const verb = data.decision === "approved" ? "Approved" : "Declined";
          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: fromAddress,
                to: [notifyTo],
                subject: `Design proof ${verb}: ${proof.filename} - ${proof.customer_name} (${docNumber})`,
                html: `<p><strong>${escapeHtml(proof.customer_name)}</strong> has <strong>${verb.toLowerCase()}</strong> version ${proof.version} of the design proof "${escapeHtml(proof.filename)}" on ${escapeHtml(docNumber)}.</p>` +
                  (notes ? `<p><strong>Their note:</strong> ${escapeHtml(notes)}</p>` : ""),
              }),
            });
          } catch (e) {
            // Notification failing shouldn't fail the customer's decision -
            // it's already recorded in D1 either way.
          }
        }

        return json({ success: true, status: data.decision });
      }

      // Multipart upload - a new proof version on a quote.
      const form = await request.formData();
      const orderId = form.get("order_id");
      const customerId = form.get("customer_id") || null;
      if (!orderId) return json({ error: "order_id is required" }, 400);
      const file = form.get("file");
      if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
        return json({ error: "No file provided" }, 400);
      }

      const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
      if (!order) return json({ error: "Quote/invoice not found" }, 404);

      const { results: existing } = await db.prepare(
        "SELECT version FROM design_proofs WHERE order_id = ? ORDER BY version DESC LIMIT 1"
      ).bind(orderId).all();
      const version = (existing[0] ? existing[0].version : 0) + 1;

      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      const key = `design-proofs/${orderId}/${id}-${file.name}`;
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });

      await db.prepare(`
        INSERT INTO design_proofs (id, order_id, customer_id, version, filename, content_type, size_bytes, r2_key, token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, orderId, customerId, version, file.name, file.type || "application/octet-stream", file.size || 0, key, token).run();

      // Email the customer straight away - "attach a proof" and "send the
      // proof" are the same action from Martin's side, so there's no
      // separate draft state that could be forgotten about.
      let emailed = false;
      const to = (order.customer_email || "").trim();
      if (env.RESEND_API_KEY && to) {
        const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
        const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
        const docLabel = order.doc_type === "invoice" ? "Invoice" : "Quote";
        const docNumber = order.doc_type === "invoice" ? order.invoice_number : order.quote_number;
        const origin = url.origin;
        const proofUrl = `${origin}/proof.html?token=${token}`;
        const imageUrl = /^image\//.test(file.type || "") ? `${origin}/api/design-proofs?view_token=${token}` : null;

        const html = `
          <div style="font-family:Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
            <h1 style="margin:0 0 4px;font-size:22px;">Crystal Custom Embroidery</h1>
            <div style="color:#64748b;margin-bottom:20px;">Design proof for ${escapeHtml(docLabel)} ${escapeHtml(docNumber)}${version > 1 ? ` (version ${version})` : ""}</div>
            <p>Hi ${escapeHtml(order.customer_name)},</p>
            <p>Here's the design proof for your order - please take a look and let us know if it's good to go.</p>
            ${imageUrl ? `<img src="${imageUrl}" alt="${escapeHtml(file.name)}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0;" />` : `<p><a href="${proofUrl}" style="color:#4f46e5;">View the attached file</a></p>`}
            <div style="margin-top:20px;">
              <a href="${proofUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Review &amp; Respond</a>
            </div>
            <p style="margin-top:24px;color:#64748b;font-size:13px;">Clicking through lets you approve it as-is, or let us know what needs changing.</p>
            <p style="margin-top:32px;color:#64748b;font-size:13px;">Thanks,<br>Crystal Custom Embroidery</p>
          </div>`;

        try {
          const resendRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: fromAddress, to: [to], reply_to: replyToAddress,
              subject: `Design proof for your ${docLabel.toLowerCase()} ${docNumber} - please review`,
              html,
            }),
          });
          if (resendRes.ok) {
            emailed = true;
            await db.prepare("UPDATE design_proofs SET sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
          }
        } catch (e) {
          // Upload already succeeded and is saved regardless - Martin can
          // still see/resend it from the portal even if this send failed.
        }
      }

      return json({ success: true, id, version, emailed, reason: emailed ? null : (to ? "Resend rejected the email" : "No email address on file for this customer") });
    }

    if (request.method === "DELETE") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      const row = await db.prepare("SELECT r2_key FROM design_proofs WHERE id = ?").bind(data.id).first();
      if (row) {
        await bucket.delete(row.r2_key);
        await db.prepare("DELETE FROM design_proofs WHERE id = ?").bind(data.id).run();
      }
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
