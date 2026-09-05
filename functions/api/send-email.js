// Emails a quote/invoice to its customer via Resend. Kept as its own
// function (rather than folded into orders.js) since it's a different kind
// of thing - a side effect against a third-party API, not a CRUD op against
// D1 - and needs its own two secrets that orders.js has no reason to touch:
// RESEND_API_KEY and RESEND_FROM_EMAIL (e.g. "Crystal Custom Embroidery
// <quotes@embroidery.click>" - must be on a domain verified in Resend).
import { buildOrderPdf } from "../_lib/document-pdf.js";
import { logOrderEvent } from "../_lib/order-events.js";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Authorization needed here too (same gap fixed on customers.js/
    // payments.js for Crystal Quick) - without it, a cross-origin POST from
    // Crystal Quick fails preflight before ever reaching this handler, so
    // saving a quote/invoice there never actually emails the customer.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  const METHOD_LABELS = { embroidery: "Embroidery", dtf: "DTF", sublimation: "Sublimation", other: "Other" };
  const PLACEMENT_LABELS = { left_chest: "Left chest", right_chest: "Right chest", sleeve: "Sleeve", left_sleeve: "Left sleeve", right_sleeve: "Right sleeve", back: "Back", name: "Name", other: "Other" };
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);

  try {
    // Same "already exists" tolerance as every other API here - these
    // columns were added after orders already went live, so an ALTER on a
    // fresh table (which already has them from CREATE) just no-ops.
    for (const col of ["email_sent_at TEXT", "email_sent_to TEXT", "email_sent_count INTEGER DEFAULT 0", "accept_token TEXT", "pay_token TEXT", "last_email_status TEXT", "last_email_status_at TEXT", "last_email_status_detail TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }
    // customers.portal_token - this file is the one that actually writes it
    // (see the "My Orders" link generation below), so it needs its own
    // guard here too rather than relying on customers.js having already run
    // - each Function's D1 guards are independent, not shared just because
    // another file also touches the same table.
    try {
      await db.prepare(`ALTER TABLE customers ADD COLUMN portal_token TEXT`).run();
    } catch {
      // already exists
    }

    // Every send is logged as its own row here (order_id, recipient, when) -
    // separate from orders.email_sent_at/email_sent_to, which only ever hold
    // the *most recent* send and get overwritten on the next one. This is
    // the full history: "emailed again", who to, and when, kept internally
    // on the quote/invoice record and never shown to the customer.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS email_log (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        sent_to TEXT NOT NULL,
        subject TEXT,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_email_log_order ON email_log (order_id)").run();
    // The table already existed on live D1 before subject was added to the
    // CREATE TABLE above - same "already exists" tolerance as everywhere else.
    try {
      await db.prepare("ALTER TABLE email_log ADD COLUMN subject TEXT").run();
    } catch {
      // already exists
    }
    // resend_email_id is how functions/api/resend-webhook.js matches a
    // later delivered/bounced/complained event back to this exact send -
    // Resend returns it in the POST /emails response body. delivery_status
    // starts NULL ("sent, no confirmation yet") until a webhook event
    // updates it - never assume "sent" means "arrived".
    for (const col of ["resend_email_id TEXT", "delivery_status TEXT", "delivery_status_at TEXT", "delivery_detail TEXT", "body_html TEXT", "kind TEXT", "step_id TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE email_log ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    // GET ?order_id=X - the full send history for one quote/invoice, for
    // the View Quote panel's "Communication History" section. Each row
    // also carries its full event timeline (events[]) - see functions/api/
    // resend-webhook.js's email_events table, which keeps every delivered/
    // opened/clicked/bounced event separately rather than the single
    // latest-status columns on this row, so "opened 3 times" is answerable
    // (the "View activity" report in admin.html reads this). body_html is
    // a snapshot of exactly what was sent, saved at the moment it went out
    // (every kind of email this app sends now saves one - see the various
    // "INSERT INTO email_log" call sites) - it's what backs the "View
    // email" popup, and only ever missing for an email sent before that
    // was added.
    if (request.method === "GET") {
      const orderId = new URL(request.url).searchParams.get("order_id");
      if (!orderId) return json({ error: "order_id is required" }, 400);
      const { results } = await db.prepare(
        "SELECT id, sent_to, subject, sent_at, resend_email_id, delivery_status, delivery_status_at, delivery_detail, body_html FROM email_log WHERE order_id = ? ORDER BY sent_at DESC"
      ).bind(orderId).all();

      const emailIds = results.map((r) => r.resend_email_id).filter(Boolean);
      let eventsByEmail = {};
      if (emailIds.length) {
        try {
          const placeholders = emailIds.map(() => "?").join(",");
          const { results: events } = await db.prepare(
            `SELECT resend_email_id, event_type, occurred_at, detail FROM email_events WHERE resend_email_id IN (${placeholders}) ORDER BY occurred_at ASC`
          ).bind(...emailIds).all();
          for (const e of events) {
            (eventsByEmail[e.resend_email_id] = eventsByEmail[e.resend_email_id] || []).push(e);
          }
        } catch {
          // email_events table doesn't exist yet (no webhook event has ever
          // landed) - every row just gets an empty events list below.
        }
      }
      return json(results.map((r) => ({ ...r, events: eventsByEmail[r.resend_email_id] || [] })));
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!env.RESEND_API_KEY) {
      return json({ error: "Email isn't set up yet - the RESEND_API_KEY secret is missing from this Pages project." }, 500);
    }
    const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
    // The from address lives on a send-only subdomain (verified in Resend
    // separately from the main domain, to keep sending reputation isolated
    // from real inbound mail) - a customer hitting Reply needs to land
    // somewhere that's actually read, not that subdomain.
    const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";

    const data = await request.json();
    if (!data.order_id) return json({ error: "order_id is required" }, 400);

    let o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.order_id).first();
    if (!o) return json({ error: "Quote/invoice not found" }, 404);

    // Lazily generated the first time a quote is ever emailed - this is
    // the token behind the "Accept & Confirm" button below, and the only
    // thing functions/api/accept-quote.js looks up by. An invoice never
    // needs one (it's already agreed to and being paid for, not accepted).
    if (o.doc_type === "quote" && !o.accept_token) {
      const acceptToken = crypto.randomUUID();
      await db.prepare("UPDATE orders SET accept_token = ? WHERE id = ?").bind(acceptToken, o.id).run();
      o = { ...o, accept_token: acceptToken };
    }

    // Same lazy-generation pattern, for the "Pay by card" link on an unpaid
    // invoice - see functions/api/pay-by-card.js, the only thing that reads
    // this. A paid invoice never needs one; a quote doesn't either (nothing
    // to charge until it's an invoice).
    if (o.doc_type === "invoice" && o.paid_status !== "paid" && !o.pay_token) {
      const payToken = crypto.randomUUID();
      await db.prepare("UPDATE orders SET pay_token = ? WHERE id = ?").bind(payToken, o.id).run();
      o = { ...o, pay_token: payToken };
    }

    // Same lazy-generation pattern again, this time on the customer record
    // rather than the order - see functions/api/my-orders.js. One token per
    // customer, generated once ever (the first time anything's emailed to
    // them) and reused on every send after, so "View all your orders" is
    // the same working link across every email they're ever sent, not a
    // fresh one each time. Orders with no customer_id (shouldn't normally
    // happen, but manual/legacy rows exist) just don't get this link.
    let myOrdersUrl = null;
    if (o.customer_id) {
      const customer = await db.prepare("SELECT portal_token FROM customers WHERE id = ?").bind(o.customer_id).first();
      if (customer) {
        let portalToken = customer.portal_token;
        if (!portalToken) {
          portalToken = crypto.randomUUID();
          await db.prepare("UPDATE customers SET portal_token = ? WHERE id = ?").bind(portalToken, o.customer_id).run();
        }
        myOrdersUrl = `${new URL(request.url).origin}/my-orders.html?token=${portalToken}`;
      }
    }

    const to = (data.to || o.customer_email || "").trim();
    if (!to) return json({ error: "No email address on file for this customer" }, 400);

    // Optional personal note from the send dialog - shown at the very top
    // of the email, above the standard quote/invoice content, so it reads
    // like something Martin actually typed to this customer rather than a
    // generic template. Never touches the PDF attachment - that's always
    // the plain document.
    const personalMessage = (data.message || "").trim().slice(0, 2000);

    // If a design proof is attached but not yet sent, fold it into THIS
    // email instead of the customer getting a second one moments later
    // (functions/api/design-proofs.js's sendPendingDesignProof, called by
    // admin.html right after this endpoint returns, queries the same
    // "sent_at IS NULL" condition - marking it sent below makes that call
    // a no-op, so this is the only place the combined send actually
    // happens, not a duplicate path). Two emails landing back to back was
    // also making the second one more likely to be caught by spam
    // filters - one email with everything in it reads as a normal reply
    // in a thread instead.
    let pendingProof = null;
    let proofAttachment = null;
    let proofBlockHtml = "";
    try {
      pendingProof = await db.prepare(
        "SELECT * FROM design_proofs WHERE order_id = ? AND sent_at IS NULL ORDER BY version DESC LIMIT 1"
      ).bind(o.id).first();
    } catch {
      // design_proofs table doesn't exist yet on a fresh DB - it's created
      // lazily by design-proofs.js, so "no proof" is the correct read here.
    }
    if (pendingProof && env.DESIGN_FILES) {
      const proofUrl = `${new URL(request.url).origin}/proof.html?token=${pendingProof.token}`;
      const isImage = /^image\//.test(pendingProof.content_type || "");
      if (isImage) {
        const obj = await env.DESIGN_FILES.get(pendingProof.r2_key);
        if (obj) {
          const bytes = new Uint8Array(await obj.arrayBuffer());
          let binary = "";
          const CHUNK = 8192; // avoid blowing the call stack on String.fromCharCode(...bigArray)
          for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          proofAttachment = { filename: pendingProof.filename, content: btoa(binary), content_id: "proof-image" };
        }
      }
      const imageTag = proofAttachment
        ? `<img src="cid:proof-image" alt="${escapeHtml(pendingProof.filename)}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:10px 0;" />`
        : `<p style="margin:8px 0;"><a href="${proofUrl}" style="color:#4f46e5;">View the attached design file</a></p>`;
      proofBlockHtml = `
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-top:20px;background:#f8fafc;">
          <div style="font-weight:600;font-size:15px;margin-bottom:6px;">Design proof${pendingProof.version > 1 ? ` (version ${pendingProof.version})` : ""}</div>
          <p style="margin:0 0 4px;font-size:14px;color:#475569;">Here's the design for this order - please take a look and let us know if it's good to go.</p>
          ${imageTag}
          <div style="margin-top:10px;">
            <a href="${proofUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">Review &amp; Respond</a>
          </div>
        </div>`;
    }

    const items = JSON.parse(o.items || "[]");
    const docLabel = o.doc_type === "invoice" ? "Invoice" : "Quote";
    const docNumber = o.doc_type === "invoice" ? o.invoice_number : o.quote_number;
    // Whether to show "Deposit due" vs a running paid-to-date/balance-due
    // statement is now driven purely by whether anything's actually been
    // paid (amount_paid > 0) - it used to also depend on email_sent_count
    // (deposit ask only on the first-ever send), which meant a payment
    // recorded manually before that first send stayed invisible on both
    // this email and the matching PDF (document-pdf.js) even though
    // amount_paid was already correct in the database.

    // "Pay by card" - only offered when Square's actually configured (both
    // secrets present) and there's a genuine balance left to charge. Bank
    // transfer is still the only thing asked for up front (see the bank
    // details block below, in both branches); this is deliberately a quiet
    // fallback, not competing for attention with it - "if someone insists
    // on a card" per how this was actually asked for, not a primary payment
    // option pushed on every invoice.
    const payByCardBlock = (o.doc_type === "invoice" && o.paid_status !== "paid" && o.pay_token && env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID)
      ? `<p style="font-size:13px;color:#64748b;margin-top:10px;">Prefer to pay by card instead? <a href="${new URL(request.url).origin}/api/pay-by-card?token=${o.pay_token}" style="color:#4f46e5;">Pay by card</a></p>`
      : "";

    // Manual invoices (functions/api/manual-invoice.js) have no items/
    // discount to build the usual itemised email around, and their PDF is
    // whatever Martin uploaded, not one built from this order's data - both
    // get their own short branch below rather than threading is_manual
    // checks through the shared template used by every system-built order.
    if (o.is_manual) {
      // Defined locally rather than reusing the one further down this
      // function - that one isn't declared until after this early-return
      // branch, so referencing it here would hit its temporal dead zone.
      const ukDate = (raw) => {
        if (!raw) return "";
        const d = new Date(raw);
        return isNaN(d) ? "" : String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
      };
      const subject = `Invoice ${docNumber} from Crystal Custom Embroidery`;
      const html = `
        <div style="font-family:Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
          <h1 style="margin:0 0 4px;font-size:22px;">Crystal Custom Embroidery</h1>
          <div style="color:#64748b;font-size:13px;line-height:1.5;">26 Grove Street, Raunds, NN9 6DS<br>hello@embroidery.click | 07530 576197</div>
          <div style="color:#64748b;margin-top:8px;margin-bottom:20px;">Invoice - ${escapeHtml(docNumber)}</div>
          ${personalMessage ? `<div style="background:#f8fafc;border-left:3px solid #4f46e5;border-radius:6px;padding:12px 16px;margin-bottom:20px;white-space:pre-line;">${escapeHtml(personalMessage)}</div>` : ""}
          <p>Hi ${escapeHtml(o.customer_name)},</p>
          <p>Please find your invoice attached.</p>
          <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-top:16px;">
            <div style="font-size:14px;">Date: ${ukDate(o.created_at)}</div>
            <div style="font-size:14px;">Status: ${o.paid_status === "paid" ? "Paid" : o.paid_status === "partial" ? "Partially paid" : "Unpaid"}</div>
            ${o.due_date ? `<div style="font-size:14px;">Due by: ${ukDate(o.due_date)}</div>` : ""}
            <div style="font-size:20px;font-weight:700;margin-top:6px;">Total: ${money(o.total)}</div>
            ${(() => {
              if (o.paid_status === "paid") return "";
              const amountPaid = Number(o.amount_paid || 0);
              // Shows a running paid-to-date/balance-due statement as soon
              // as anything's actually been paid - regardless of whether
              // this is the first send, since a payment recorded manually
              // before the invoice was ever emailed is just as real as one
              // recorded after. Was previously gated on isFirstSend, which
              // is why a manually-recorded payment stayed invisible here
              // (and on the matching PDF, document-pdf.js) until the first
              // send flipped email_sent_count - amount_paid itself was
              // already correct in the database the whole time.
              if (amountPaid > 0) {
                return `<div style="font-size:13px;color:#64748b;margin-top:4px;">Paid to date: ${money(amountPaid)}</div>
                  <div style="font-size:14px;font-weight:600;color:#b45309;">Balance due: ${money(o.total - amountPaid)}</div>`;
              }
              const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
              return depositDue > 0
                ? `<div style="font-size:14px;font-weight:600;color:#b45309;margin-top:4px;">Deposit due: ${money(depositDue)}</div>`
                : "";
            })()}
          </div>
          ${o.paid_status !== "paid" ? `
          <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-top:16px;font-size:14px;line-height:1.6;">
            <div style="font-weight:600;">We appreciate your business. Please pay via Bank Transfer</div>
            <div>Banking Details: Crystal Custom Embroidery,</div>
            <div>Sort Code: 04-03-33, Account Number: 55185130</div>
            ${payByCardBlock}
          </div>` : ""}
          ${proofBlockHtml}
          ${o.notes ? `<p style="margin-top:24px;color:#64748b;"><strong>Notes:</strong> ${escapeHtml(o.notes)}</p>` : ""}
          ${myOrdersUrl ? `<p style="margin-top:20px;font-size:13px;"><a href="${myOrdersUrl}" style="color:#4f46e5;">View all your orders</a></p>` : ""}
          <p style="margin-top:32px;color:#64748b;font-size:13px;">Thanks,<br>Crystal Custom Embroidery<br>
            <a href="https://wa.me/447530576197?text=Hi%2C%20I%20have%20a%20question%20about%20${encodeURIComponent(docNumber || "")}." style="color:#4f46e5;">Message us on WhatsApp</a></p>
        </div>`;

      let pdfAttachment = null;
      if (o.manual_pdf_r2_key && env.DESIGN_FILES) {
        const obj = await env.DESIGN_FILES.get(o.manual_pdf_r2_key);
        if (obj) {
          const bytes = new Uint8Array(await obj.arrayBuffer());
          let binary = "";
          const CHUNK = 8192;
          for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          pdfAttachment = { filename: o.manual_pdf_filename || `${docNumber || "invoice"}.pdf`, content: btoa(binary) };
        }
      }
      const manualAttachments = [pdfAttachment, proofAttachment].filter(Boolean);

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromAddress, to: [to], reply_to: replyToAddress, subject, html,
          ...(manualAttachments.length ? { attachments: manualAttachments } : {}),
        }),
      });
      if (!resendRes.ok) {
        const errBody = await resendRes.text();
        return json({ error: "Resend rejected the email: " + errBody }, 502);
      }
      // Resend's own id for this send - functions/api/resend-webhook.js
      // matches a later delivered/bounced/complained event back to this
      // row by it. Best-effort: a malformed success response shouldn't
      // block the send that already went out.
      const resendEmailId = await resendRes.json().then((r) => r.id).catch(() => null);
      await db.prepare(
        "UPDATE orders SET email_sent_at = CURRENT_TIMESTAMP, email_sent_to = ?, email_sent_count = email_sent_count + 1 WHERE id = ?"
      ).bind(to, o.id).run();
      await db.prepare(
        "INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id, body_html) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), o.id, to, subject, resendEmailId, html).run();
      if (pendingProof) {
        await db.prepare("UPDATE design_proofs SET sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(pendingProof.id).run();
      }
      await logOrderEvent(db, o.id, "sent", `Emailed to ${to}`);
      return json({ success: true, sent_to: to, proof_included: !!pendingProof, proof_version: pendingProof ? pendingProof.version : null });
    }

    // Same live-from-the-customer-record address lookup as the printed
    // version (functions/api/orders.js) - this email is meant to read as
    // the actual invoice, not a stripped-down summary of it, so it needs
    // the same trading/billing address block, bank details and due date
    // that appear on the print/PDF version.
    const customerAddr = o.customer_id
      ? await db.prepare("SELECT address_1, address_2, city, county, postcode FROM customers WHERE id = ?").bind(o.customer_id).first()
      : null;
    const addressLines = (addr) => !addr ? "" : [addr.address_1, addr.address_2, addr.city, addr.county, addr.postcode]
      .filter(Boolean).map(escapeHtml).join("<br>");
    const ukDate = (raw) => {
      if (!raw) return "";
      const d = new Date(raw);
      return isNaN(d) ? "" : String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
    };

    const rows = items.map((item) => {
      const baseLabel = item.source === "catalog"
        ? `${escapeHtml(item.supplier_code)} ${escapeHtml(item.title)}`
        : (escapeHtml([item.description, item.title].filter(Boolean).join(" - ")) || "Customer's own garment");

      // Colour/size breakdown - plain description under the garment row,
      // no pricing (that's fully covered by the garment row's own
      // Qty/Unit/Total, same reasoning as document-pdf.js).
      let breakdownLines = "";
      if (item.breakdown && item.breakdown.length && !item.customer_item) {
        breakdownLines = item.breakdown.map((b) =>
          `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(b.colour || "-")} / ${escapeHtml(b.size || "-")} × ${b.qty}</div>`
        ).join("");
      }

      // Decoration - previously shown as descriptive text only, with its
      // cost folded silently into the garment row's Total (so "2 × £18"
      // not matching that row's own Total looked like a maths error, even
      // though the combined total was correct - the decoration cost just
      // wasn't shown as a number anywhere). Now its own priced row(s),
      // collapsed by method+placement+price+notes so the same print across
      // several colours becomes one row with the combined qty, not a
      // repeat per colour.
      // d.qty on a decoration is "instances per garment" (e.g. 2 for both
      // sleeves), not a count of garments - a row/line's decoration cost is
      // that × how many garments it actually applies to (the breakdown
      // row's own qty for a per-row decoration, or the item's total qty for
      // a line-level one - same multiplication lineTotal already does when
      // computing the real total this itemization has to reconcile with).
      // Pushing d.qty through unscaled here undercounted any decoration on
      // more than one garment - e.g. 2 shirts × DTF once each showed as a
      // single £5 instead of £10, even though the order's actual total
      // already correctly charged for both.
      const rawDecorations = [];
      if (!item.breakdown || !item.breakdown.length || item.customer_item) {
        const garmentQty = Number(item.qty) || 1;
        (item.decorations || []).forEach((d) => rawDecorations.push({ ...d, qty: (Number(d.qty) || 1) * garmentQty }));
      } else {
        const hasRowDecorations = item.breakdown.some((b) => (b.decorations || []).length);
        if (hasRowDecorations) {
          item.breakdown.forEach((b) => {
            const rowQty = Number(b.qty) || 1;
            (b.decorations || []).forEach((d) => rawDecorations.push({ ...d, qty: (Number(d.qty) || 1) * rowQty }));
          });
        } else {
          const totalQty = item.breakdown.reduce((sum, b) => sum + (Number(b.qty) || 0), 0) || 1;
          (item.decorations || []).forEach((d) => rawDecorations.push({ ...d, qty: (Number(d.qty) || 1) * totalQty }));
        }
      }
      const decByKey = new Map();
      for (const d of rawDecorations) {
        const label = `${METHOD_LABELS[d.method] || d.method} - ${PLACEMENT_LABELS[d.placement] || d.placement}${d.notes ? ` (${d.notes})` : ""}`;
        const unitPrice = Number(d.price) || 0;
        const qty = Number(d.qty) || 1;
        const key = label + "|" + unitPrice;
        if (decByKey.has(key)) decByKey.get(key).qty += qty;
        else decByKey.set(key, { label, unitPrice, qty });
      }

      const qty = Number(item.qty) || 0;
      const garmentTotal = qty * (Number(item.unit_price) || 0);

      // Per-line date - the running-tab case (a customer whose order stays
      // open while work gets added across several days before it's finally
      // sent/finalized) needs this shown per item, not just the single
      // Date: line for the document as a whole further up this email.
      const dateLine = item.date_added
        ? `<div style="font-size:12px;color:#94a3b8;margin-top:2px;">Added ${escapeHtml(ukDate(item.date_added))}</div>`
        : "";

      const garmentRow = `<tr>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${baseLabel}${dateLine}${breakdownLines}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${item.qty}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${money(item.unit_price)}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${money(garmentTotal)}</td>
      </tr>`;

      const decorationRows = [...decByKey.values()].map((d) => `<tr>
        <td style="padding:6px 4px 6px 16px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">+ ${escapeHtml(d.label)}</td>
        <td style="padding:6px 4px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${d.qty}</td>
        <td style="padding:6px 4px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${money(d.unitPrice)}</td>
        <td style="padding:6px 4px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">${money(d.unitPrice * d.qty)}</td>
      </tr>`).join("");

      // Per-line discount - separate from the order-level Discount line
      // further down. item.line_total (what rolls up into the order
      // subtotal) is already net of this, so it's purely a disclosure row.
      const lineDiscountRow = item.discount_amount > 0.001
        ? `<tr><td colspan="3" style="padding:6px 4px 6px 16px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">Discount</td>
             <td style="padding:6px 4px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;">-${money(item.discount_amount)}</td></tr>`
        : "";

      return garmentRow + decorationRows + lineDiscountRow;
    }).join("");

    const discountLine = o.discount_amount ? `Discount: -${money(o.discount_amount)}` : "";

    const isUnpaidInvoice = o.doc_type === "invoice" && o.paid_status !== "paid";
    // A quote always shows what deposit it'll need if accepted - the
    // customer should know that before they agree to it. An invoice shows
    // the deposit ask only until something's actually been paid, then
    // switches to a running paid-to-date/balance-due statement - see the
    // matching comment in document-pdf.js/buildOrderPdf.
    let depositBalanceLine = "";
    if (o.doc_type === "quote") {
      const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
      if (depositDue > 0) {
        depositBalanceLine = `<div style="font-size:14px;font-weight:600;color:#b45309;margin-top:4px;">Deposit due on acceptance: ${money(depositDue)}</div>`;
      }
    } else if (isUnpaidInvoice) {
      // Shows a running paid-to-date/balance-due statement as soon as
      // anything's actually been paid, not just from the invoice's second
      // send onward - see the matching comment in the is_manual branch
      // above and in document-pdf.js/buildOrderPdf for why this used to
      // stay wrong (showing "Deposit due" instead) for a payment recorded
      // manually before the invoice's first send.
      const amountPaid = Number(o.amount_paid || 0);
      if (amountPaid > 0) {
        depositBalanceLine = `<div style="font-size:13px;color:#64748b;margin-top:4px;">Paid to date: ${money(amountPaid)}</div>
          <div style="font-size:14px;font-weight:600;color:#b45309;">Balance due: ${money(o.total - amountPaid)}</div>`;
      } else {
        const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
        if (depositDue > 0) {
          depositBalanceLine = `<div style="font-size:14px;font-weight:600;color:#b45309;margin-top:4px;">Deposit due: ${money(depositDue)}</div>`;
        }
      }
    }
    // Lets the customer approve the quote themselves - no login, just the
    // unguessable accept_token above - instead of Martin having to come
    // back and convert/send it by hand. Only shown while there's still a
    // decision to make; once they've approved or declined it (via this
    // link or the design-proof approval flow, which sets the same status)
    // showing it again would be confusing.
    const acceptBlock = (o.doc_type === "quote" && o.status !== "approved" && o.status !== "declined" && o.accept_token) ? `
      <div style="margin:20px 0;text-align:center;">
        <a href="${new URL(request.url).origin}/accept-quote.html?token=${o.accept_token}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:16px;">Accept &amp; Confirm</a>
        <div style="color:#64748b;font-size:12px;margin-top:8px;">No account needed - one click to confirm you'd like to go ahead.</div>
      </div>` : "";
    const bankBlock = isUnpaidInvoice ? `
        <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-top:16px;font-size:14px;line-height:1.6;">
          <div style="font-weight:600;">We appreciate your business. Please pay via Bank Transfer</div>
          <div>Banking Details: Crystal Custom Embroidery,</div>
          <div>Sort Code: 04-03-33, Account Number: 55185130</div>
          ${payByCardBlock}
        </div>` : "";

    const html = `
      <div style="font-family:Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
        <h1 style="margin:0 0 4px;font-size:22px;">Crystal Custom Embroidery</h1>
        <div style="color:#64748b;font-size:13px;line-height:1.5;">26 Grove Street, Raunds, NN9 6DS<br>hello@embroidery.click | 07530 576197</div>
        <div style="color:#64748b;margin-top:8px;margin-bottom:20px;">${docLabel} - ${escapeHtml(docNumber)}${o.doc_type === "invoice" ? " (from " + escapeHtml(o.quote_number) + ")" : ""}</div>
        ${personalMessage ? `<div style="background:#f8fafc;border-left:3px solid #4f46e5;border-radius:6px;padding:12px 16px;margin-bottom:20px;white-space:pre-line;">${escapeHtml(personalMessage)}</div>` : ""}
        <p>Hi ${escapeHtml(o.customer_name)},</p>
        <p>Please find your ${docLabel.toLowerCase()} below${o.doc_type === "quote" ? " - let us know if you'd like to go ahead" : ""}.</p>
        ${acceptBlock}

        <div style="display:flex;gap:16px;margin-top:16px;">
          <div style="flex:1;border:1px solid #e2e8f0;border-radius:12px;padding:14px;">
            <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Customer</div>
            <div style="font-size:14px;">${escapeHtml(o.customer_name)}</div>
            ${o.customer_email ? `<div style="font-size:14px;color:#64748b;">${escapeHtml(o.customer_email)}</div>` : ""}
            ${addressLines(customerAddr) ? `<div style="font-size:14px;color:#64748b;margin-top:4px;">${addressLines(customerAddr)}</div>` : ""}
          </div>
          <div style="flex:1;border:1px solid #e2e8f0;border-radius:12px;padding:14px;">
            <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Details</div>
            <div style="font-size:14px;">Date: ${ukDate(o.created_at)}</div>
            ${o.doc_type === "invoice" ? `<div style="font-size:14px;">Status: ${o.paid_status === "paid" ? "Paid" : o.paid_status === "partial" ? "Partially paid" : "Unpaid"}</div>` : ""}
            ${o.doc_type === "invoice" && o.due_date ? `<div style="font-size:14px;">Due by: ${ukDate(o.due_date)}</div>` : ""}
          </div>
        </div>
        ${bankBlock}

        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <thead>
            <tr style="text-align:left;border-bottom:2px solid #0f172a;">
              <th style="padding:8px 4px;font-size:12px;text-transform:uppercase;">Item</th>
              <th style="padding:8px 4px;font-size:12px;text-transform:uppercase;">Qty</th>
              <th style="padding:8px 4px;font-size:12px;text-transform:uppercase;">Unit</th>
              <th style="padding:8px 4px;font-size:12px;text-transform:uppercase;">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:16px;text-align:right;">
          <div>Subtotal: ${money(o.subtotal)}</div>
          ${discountLine ? `<div style="margin-top:6px;">${discountLine}</div>` : ""}
          <div style="font-size:20px;font-weight:700;margin-top:6px;">Total: ${money(o.total)}</div>
          ${depositBalanceLine}
          <div style="font-size:12px;color:#64748b;margin-top:4px;">VAT not applicable - not VAT registered.</div>
        </div>
        ${proofBlockHtml}
        ${o.notes ? `<p style="margin-top:24px;color:#64748b;"><strong>Notes:</strong> ${escapeHtml(o.notes)}</p>` : ""}
        ${myOrdersUrl ? `<p style="margin-top:20px;font-size:13px;"><a href="${myOrdersUrl}" style="color:#4f46e5;">View all your orders</a></p>` : ""}
        <p style="margin-top:32px;color:#64748b;font-size:13px;">Thanks,<br>Crystal Custom Embroidery<br>
          <a href="https://wa.me/447530576197?text=Hi%2C%20I%20have%20a%20question%20about%20${encodeURIComponent(docNumber || "")}." style="color:#4f46e5;">Message us on WhatsApp</a></p>
      </div>`;

    const subject = `${docLabel} ${docNumber} from Crystal Custom Embroidery`;

    // A real PDF copy attached to every send - the HTML above is for
    // reading in an email client, this is what a customer actually saves/
    // prints for their own records (see functions/_lib/document-pdf.js and
    // functions/api/order-pdf.js, which serves the same file for direct
    // download from the portal).
    let pdfAttachment = null;
    try {
      const pdfBytes = buildOrderPdf(o, customerAddr);
      let binary = "";
      const CHUNK = 8192; // avoid blowing the call stack on String.fromCharCode(...bigArray)
      for (let i = 0; i < pdfBytes.length; i += CHUNK) {
        binary += String.fromCharCode(...pdfBytes.subarray(i, i + CHUNK));
      }
      pdfAttachment = { filename: `${docNumber || "document"}.pdf`, content: btoa(binary) };
    } catch (e) {
      // A broken PDF build shouldn't block the email itself going out -
      // the HTML body alone is still a complete, readable copy.
    }

    const attachments = [pdfAttachment, proofAttachment].filter(Boolean);

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [to],
        reply_to: replyToAddress,
        subject,
        html,
        ...(attachments.length ? { attachments } : {}),
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      return json({ error: "Resend rejected the email: " + errBody }, 502);
    }
    // Resend's own id for this send - functions/api/resend-webhook.js
    // matches a later delivered/bounced/complained event back to this row
    // by it. Best-effort: a malformed success response shouldn't block
    // the send that already went out.
    const resendEmailId = await resendRes.json().then((r) => r.id).catch(() => null);

    await db.prepare(
      "UPDATE orders SET email_sent_at = CURRENT_TIMESTAMP, email_sent_to = ?, email_sent_count = email_sent_count + 1 WHERE id = ?"
    ).bind(to, o.id).run();
    await db.prepare(
      "INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id, body_html) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), o.id, to, subject, resendEmailId, html).run();
    if (pendingProof) {
      await db.prepare("UPDATE design_proofs SET sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(pendingProof.id).run();
    }
    await logOrderEvent(db, o.id, "sent", `Emailed to ${to}`);

    return json({ success: true, sent_to: to, proof_included: !!pendingProof, proof_version: pendingProof ? pendingProof.version : null });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
