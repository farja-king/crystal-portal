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

  // Actually sends the proof email for one already-attached (but not yet
  // sent) version - called from the "send_pending" action below, which is
  // itself triggered from three places in the portal: the Email button on
  // a quote, saving/updating a quote in the builder, and a manual "Send
  // now" on the proof itself. Whichever fires first for a given order wins
  // (sent_at gets set immediately after), so attaching several times before
  // ever sending just replaces which version goes out, never sends more
  // than one proof email per attach.
  async function sendProofEmail(env, db, bucket, origin, order, proof) {
    if (!env.RESEND_API_KEY) return { sent: false, reason: "Email isn't set up yet - the RESEND_API_KEY secret is missing." };
    const to = (order.customer_email || "").trim();
    if (!to) return { sent: false, reason: "No email address on file for this customer" };

    const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
    const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
    const docLabel = order.doc_type === "invoice" ? "Invoice" : "Quote";
    const docNumber = order.doc_type === "invoice" ? order.invoice_number : order.quote_number;
    const proofUrl = `${origin}/proof.html?token=${proof.token}`;
    const isImage = /^image\//.test(proof.content_type || "");

    // Embedded as an inline attachment (Content-ID, referenced via cid: in
    // the html) rather than a remote <img src> pointing back at this
    // portal - a remote image is exactly what most email clients block by
    // default until the user explicitly clicks "show images", which is why
    // it was showing as a placeholder icon instead of the actual logo.
    // Embedding the bytes directly means the image always renders
    // immediately, with nothing to fetch or block.
    let attachments;
    if (isImage) {
      const obj = await bucket.get(proof.r2_key);
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        let binary = "";
        const CHUNK = 8192; // avoid blowing the call stack on String.fromCharCode(...bigArray)
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        attachments = [{ filename: proof.filename, content: btoa(binary), content_id: "proof-image" }];
      }
    }
    const imageTag = attachments ? `<img src="cid:proof-image" alt="${escapeHtml(proof.filename)}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0;" />` : null;

    const html = `
      <div style="font-family:Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
        <h1 style="margin:0 0 4px;font-size:22px;">Crystal Custom Embroidery</h1>
        <div style="color:#64748b;margin-bottom:20px;">Design proof for ${escapeHtml(docLabel)} ${escapeHtml(docNumber)}${proof.version > 1 ? ` (version ${proof.version})` : ""}</div>
        <p>Hi ${escapeHtml(order.customer_name)},</p>
        <p>Here's the design proof for your order - please take a look and let us know if it's good to go.</p>
        <div style="margin:20px 0;">
          <a href="${proofUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Review &amp; Respond</a>
        </div>
        <p style="color:#64748b;font-size:13px;">Clicking through lets you approve it as-is, or let us know what needs changing.</p>
        ${imageTag || `<p><a href="${proofUrl}" style="color:#4f46e5;">View the attached file</a></p>`}
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
          ...(attachments ? { attachments } : {}),
        }),
      });
      if (!resendRes.ok) return { sent: false, reason: "Resend rejected the email" };
      await db.prepare("UPDATE design_proofs SET sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(proof.id).run();
      return { sent: true };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
  }

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

    // image_consent - whether the customer agreed to let their design/order
    // images be used on the website, social media or Google advertising,
    // answered alongside their approve/decline decision on proof.html.
    // 'yes' / 'no' / NULL (never answered) - the table already existed on
    // live D1 before this was added, so it needs an ALTER here too (same
    // pattern as orders.js).
    try {
      await db.prepare(`ALTER TABLE design_proofs ADD COLUMN image_consent TEXT`).run();
    } catch {
      // already exists
    }

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
      if (!row.r2_key) return json({ error: "This image was removed to free up storage - the record (filename, version, decision) is still kept." }, 404);

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
        SELECT p.id, p.version, p.filename, p.content_type, p.status, p.decision_notes, p.token, p.image_consent,
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
        image_consent: row.image_consent,
      });
    }

    // GET ?orphaned=1 - design proof rows whose order was deleted before
    // this file's DELETE handler learned to clean them up too (see
    // functions/api/orders.js). Those rows/files are otherwise invisible
    // forever - every other lookup here requires a valid order_id,
    // customer_id, or token, none of which still resolve to anything once
    // the order itself is gone. A one-off maintenance list/purge for
    // exactly that backlog, not something normal day-to-day use ever needs.
    if (request.method === "GET" && url.searchParams.get("orphaned")) {
      const { results } = await db.prepare(`
        SELECT p.id, p.filename, p.version, p.size_bytes, p.created_at, (p.r2_key <> '') AS has_file
        FROM design_proofs p LEFT JOIN orders o ON o.id = p.order_id
        WHERE o.id IS NULL ORDER BY p.created_at DESC
      `).all();
      return json(results);
    }

    // GET ?all=1 - every proof across every customer, latest version per
    // order only (older superseded versions would just be noise here),
    // newest-sent-or-created first. Backs the master Design Proofs
    // dashboard - the one place to see everything currently awaiting a
    // customer's response, or find a specific version to resend, without
    // having to already know which quote it's on.
    if (request.method === "GET" && url.searchParams.get("all")) {
      const { results } = await db.prepare(`
        SELECT p.id, p.order_id, p.customer_id, p.version, p.filename, p.content_type, p.status,
               p.decision_notes, p.created_at, p.sent_at, p.decided_at, (p.r2_key <> '') AS has_file,
               o.quote_number, o.invoice_number, o.doc_type, o.customer_name
        FROM design_proofs p
        JOIN orders o ON o.id = p.order_id
        WHERE p.version = (SELECT MAX(version) FROM design_proofs WHERE order_id = p.order_id)
        ORDER BY COALESCE(p.sent_at, p.created_at) DESC
      `).all();
      return json(results);
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
               p.created_at, p.sent_at, p.decided_at, p.image_consent, o.quote_number, o.invoice_number, o.doc_type,
               (p.r2_key <> '') AS has_file
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

        // Sends whichever version is attached-but-not-yet-sent for this
        // order, if any - a no-op if everything's already gone out (or
        // nothing's been attached at all). Called automatically whenever
        // the portal actually sends something to this customer (the Email
        // button on a quote, or Save/Update in the builder - see
        // admin.html's emailOrder/saveOrder), plus a manual "Send now" on
        // the proof itself for sending it on its own without touching the
        // rest of the quote.
        if (data.action === "send_pending") {
          if (!data.order_id) return json({ error: "order_id is required" }, 400);
          const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.order_id).first();
          if (!order) return json({ error: "Quote/invoice not found" }, 404);
          const proof = await db.prepare(
            "SELECT * FROM design_proofs WHERE order_id = ? AND sent_at IS NULL ORDER BY version DESC LIMIT 1"
          ).bind(data.order_id).first();
          if (!proof) return json({ success: true, sent: false, reason: "Nothing pending to send" });

          const result = await sendProofEmail(env, db, bucket, url.origin, order, proof);
          return json({ success: true, ...result, id: proof.id, version: proof.version });
        }

        // Sends one specific version regardless of order - the "Send now"
        // button on a particular proof row.
        if (data.action === "send") {
          if (!data.id) return json({ error: "id is required" }, 400);
          const proof = await db.prepare("SELECT * FROM design_proofs WHERE id = ?").bind(data.id).first();
          if (!proof) return json({ error: "Proof not found" }, 404);
          if (proof.sent_at) return json({ success: true, sent: false, reason: "Already sent" });
          const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(proof.order_id).first();
          if (!order) return json({ error: "Quote/invoice not found" }, 404);

          const result = await sendProofEmail(env, db, bucket, url.origin, order, proof);
          return json({ success: true, ...result, id: proof.id, version: proof.version });
        }

        // Resends a specific version regardless of its status or whether
        // it's gone out before - the "Resend" button offered on every
        // version, not just unsent drafts. Covers a customer who never got
        // (or lost) the original email, wants another copy of something
        // already decided, or an email client that clipped the approve/
        // decline link out of the message before they could use it.
        // sendProofEmail bumps sent_at to now either way, same as a first
        // send, so the proof list always shows "when was this last emailed".
        if (data.action === "resend") {
          if (!data.id) return json({ error: "id is required" }, 400);
          const proof = await db.prepare("SELECT * FROM design_proofs WHERE id = ?").bind(data.id).first();
          if (!proof) return json({ error: "Proof not found" }, 404);
          const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(proof.order_id).first();
          if (!order) return json({ error: "Quote/invoice not found" }, 404);

          const result = await sendProofEmail(env, db, bucket, url.origin, order, proof);
          return json({ success: true, ...result, id: proof.id, version: proof.version });
        }

        // Manual "Remove image from database" (offered on an Archived
        // quote) - frees the actual file bytes in R2 for every proof
        // version on this order, but keeps the design_proofs rows exactly
        // as they are (filename, version, status, decision notes,
        // decided_at) forever. Deliberately separate from Delete's
        // automatic cleanup - an archived quote is being kept on purpose,
        // so nothing about it is ever removed unless explicitly asked for
        // here.
        if (data.action === "remove_storage") {
          if (!data.order_id) return json({ error: "order_id is required" }, 400);
          const { results: proofs } = await db.prepare(
            "SELECT id, r2_key FROM design_proofs WHERE order_id = ? AND r2_key <> ''"
          ).bind(data.order_id).all();
          if (!proofs.length) return json({ success: true, removed: 0 });
          await Promise.all(proofs.map((p) => bucket.delete(p.r2_key).catch(() => {})));
          await db.prepare("UPDATE design_proofs SET r2_key = '' WHERE order_id = ?").bind(data.order_id).run();
          return json({ success: true, removed: proofs.length });
        }

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
        const imageConsent = data.image_consent === "yes" || data.image_consent === "no" ? data.image_consent : null;
        await db.prepare(
          "UPDATE design_proofs SET status = ?, decision_notes = ?, image_consent = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(data.decision, notes, imageConsent, proof.id).run();

        // The quote's own Status field (Draft/Sent/Approved/Declined - see
        // the ord-status dropdown in admin.html) mirrors the customer's
        // decision automatically, so it's visible on the main Quotes &
        // Invoices list the moment they respond, without Martin having to
        // set it by hand. "approved" is short-lived here if this also goes
        // on to auto-convert to an invoice below (paid_status takes over
        // once it's an invoice), but still correct in the moment, and is
        // the lasting record if the auto-conversion below doesn't happen
        // (e.g. this was already an invoice, or it fails).
        await db.prepare("UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(data.decision, proof.order_id).run();

        // Approving a proof on a quote (not already an invoice) converts it
        // straight to an invoice and emails that invoice out - the same
        // "convert" and "email" actions Martin would otherwise click by
        // hand, just triggered by the customer's own approval instead of
        // him having to come back and do it. Reuses the exact same
        // endpoints (internal same-origin calls) rather than duplicating
        // their logic, so this can never drift from what a manual
        // conversion/send actually does. Wrapped so a failure here never
        // undoes the approval itself, which is already safely recorded.
        let invoiceNumber = null;
        let invoiced = false;
        let invoiceEmailed = false;
        if (data.decision === "approved" && proof.doc_type === "quote") {
          try {
            const convertRes = await fetch(`${url.origin}/api/orders`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: proof.order_id, action: "convert_to_invoice" }),
            });
            const convertData = await convertRes.json();
            if (convertRes.ok && convertData.success) {
              invoiced = true;
              invoiceNumber = convertData.invoice_number;
              const emailRes = await fetch(`${url.origin}/api/send-email`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ order_id: proof.order_id }),
              });
              invoiceEmailed = emailRes.ok;
            }
          } catch (e) {
            // Approval is still recorded either way - Martin can convert/
            // send by hand from the portal if this automation failed.
          }
        }

        // Notify the portal - same pattern as the Inbox's new-mail
        // notification (a plain email via Resend, since a phone's Mail app
        // already pushes new-mail notifications natively).
        if (env.RESEND_API_KEY) {
          const notifyTo = env.NOTIFY_EMAIL_TO || env.RESEND_REPLY_TO || "hello@embroidery.click";
          const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
          const docNumber = proof.doc_type === "invoice" ? proof.invoice_number : proof.quote_number;
          const verb = data.decision === "approved" ? "Approved" : "Declined";
          const invoiceNote = invoiced
            ? `<p><strong>${escapeHtml(invoiceNumber)}</strong> was created automatically and ${invoiceEmailed ? "emailed to the customer" : "could not be emailed - send it from the portal"}.</p>`
            : "";
          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: fromAddress,
                to: [notifyTo],
                subject: `Design proof ${verb}: ${proof.filename} - ${proof.customer_name} (${docNumber})${invoiced ? " - now " + invoiceNumber : ""}`,
                html: `<p><strong>${escapeHtml(proof.customer_name)}</strong> has <strong>${verb.toLowerCase()}</strong> version ${proof.version} of the design proof "${escapeHtml(proof.filename)}" on ${escapeHtml(docNumber)}.</p>` +
                  (notes ? `<p><strong>Their note:</strong> ${escapeHtml(notes)}</p>` : "") + invoiceNote,
              }),
            });
          } catch (e) {
            // Notification failing shouldn't fail the customer's decision -
            // it's already recorded in D1 either way.
          }
        }

        return json({ success: true, status: data.decision, invoiced, invoice_number: invoiceNumber, invoice_emailed: invoiceEmailed });
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

      // Deliberately NOT emailed yet - attaching is just staging it on the
      // quote so Martin can check everything's right first. It goes out
      // the next time he actually sends something to this customer (the
      // Email button, or Save/Update on the quote - see the sendPendingProof
      // action below, called from all three), or via the "Send now" button
      // if he wants it to go immediately without touching the rest of the
      // quote.
      return json({ success: true, id, version });
    }

    if (request.method === "DELETE") {
      const data = await request.json();

      // One-off cleanup for the backlog of proofs whose order was deleted
      // before orders.js learned to clean these up too - see the
      // ?orphaned=1 GET above. Removes every orphaned row's file from R2
      // and the row itself, in one go.
      if (data.action === "purge_orphaned") {
        const { results: orphaned } = await db.prepare(`
          SELECT p.id, p.r2_key FROM design_proofs p LEFT JOIN orders o ON o.id = p.order_id WHERE o.id IS NULL
        `).all();
        if (!orphaned.length) return json({ success: true, purged: 0 });
        await Promise.all(orphaned.filter((p) => p.r2_key).map((p) => bucket.delete(p.r2_key).catch(() => {})));
        const ids = orphaned.map((p) => p.id);
        const placeholders = ids.map(() => "?").join(",");
        await db.prepare(`DELETE FROM design_proofs WHERE id IN (${placeholders})`).bind(...ids).run();
        return json({ success: true, purged: orphaned.length });
      }

      if (!data.id) return json({ error: "id is required" }, 400);
      const row = await db.prepare("SELECT r2_key FROM design_proofs WHERE id = ?").bind(data.id).first();
      if (row) {
        if (row.r2_key) await bucket.delete(row.r2_key);
        await db.prepare("DELETE FROM design_proofs WHERE id = ?").bind(data.id).run();
      }
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
