// Emails a quote/invoice to its customer via Resend. Kept as its own
// function (rather than folded into orders.js) since it's a different kind
// of thing - a side effect against a third-party API, not a CRUD op against
// D1 - and needs its own two secrets that orders.js has no reason to touch:
// RESEND_API_KEY and RESEND_FROM_EMAIL (e.g. "Crystal Custom Embroidery
// <quotes@embroidery.click>" - must be on a domain verified in Resend).
import { buildOrderPdf } from "../_lib/document-pdf.js";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  const METHOD_LABELS = { embroidery: "Embroidery", dtf: "DTF", sublimation: "Sublimation", other: "Other" };
  const PLACEMENT_LABELS = { left_chest: "Left chest", right_chest: "Right chest", sleeve: "Sleeve", back: "Back", name: "Name", other: "Other" };
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);

  try {
    // Same "already exists" tolerance as every other API here - these
    // columns were added after orders already went live, so an ALTER on a
    // fresh table (which already has them from CREATE) just no-ops.
    for (const col of ["email_sent_at TEXT", "email_sent_to TEXT", "email_sent_count INTEGER DEFAULT 0", "accept_token TEXT", "pay_token TEXT"]) {
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

    // GET ?order_id=X - the full send history for one quote/invoice, for
    // the View Quote panel's "Communication History" section.
    if (request.method === "GET") {
      const orderId = new URL(request.url).searchParams.get("order_id");
      if (!orderId) return json({ error: "order_id is required" }, 400);
      const { results } = await db.prepare(
        "SELECT sent_to, subject, sent_at FROM email_log WHERE order_id = ? ORDER BY sent_at DESC"
      ).bind(orderId).all();
      return json(results);
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

    const items = JSON.parse(o.items || "[]");
    const docLabel = o.doc_type === "invoice" ? "Invoice" : "Quote";
    const docNumber = o.doc_type === "invoice" ? o.invoice_number : o.quote_number;
    // The very first time an invoice goes out is the moment to actually ask
    // for the deposit Martin set on it - every send after that is more of a
    // running statement (what's been paid, what's still owed), since the
    // deposit ask itself only makes sense once. email_sent_count is what
    // this same file already increments below on every successful send, so
    // it's "0/null" only for a send that hasn't happened yet.
    const isFirstSend = !o.email_sent_count;

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
            <div style="font-size:14px;">Status: ${o.paid_status === "paid" ? "Paid" : "Unpaid"}</div>
            ${o.due_date ? `<div style="font-size:14px;">Due by: ${ukDate(o.due_date)}</div>` : ""}
            <div style="font-size:20px;font-weight:700;margin-top:6px;">Total: ${money(o.total)}</div>
            ${(() => {
              if (o.paid_status === "paid") return "";
              const amountPaid = Number(o.amount_paid || 0);
              if (isFirstSend) {
                // The deposit ask only belongs on the invoice's first-ever
                // send - once it's gone out once, every later send is a
                // running statement instead (see amount_paid branch below).
                const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
                return depositDue > 0
                  ? `<div style="font-size:14px;font-weight:600;color:#b45309;margin-top:4px;">Deposit due: ${money(depositDue)}</div>`
                  : "";
              }
              return `${amountPaid > 0 ? `<div style="font-size:13px;color:#64748b;margin-top:4px;">Paid to date: ${money(amountPaid)}</div>` : ""}
                <div style="font-size:14px;font-weight:600;color:#b45309;">Balance due: ${money(o.total - amountPaid)}</div>`;
            })()}
          </div>
          ${o.paid_status !== "paid" ? `
          <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-top:16px;font-size:14px;line-height:1.6;">
            <div style="font-weight:600;">We appreciate your business. Please pay via Bank Transfer</div>
            <div>Banking Details: Crystal Custom Embroidery,</div>
            <div>Sort Code: 04-03-33, Account Number: 55185130</div>
            ${payByCardBlock}
          </div>` : ""}
          ${o.notes ? `<p style="margin-top:24px;color:#64748b;"><strong>Notes:</strong> ${escapeHtml(o.notes)}</p>` : ""}
          ${myOrdersUrl ? `<p style="margin-top:20px;font-size:13px;"><a href="${myOrdersUrl}" style="color:#4f46e5;">View all your orders</a></p>` : ""}
          <p style="margin-top:32px;color:#64748b;font-size:13px;">Thanks,<br>Crystal Custom Embroidery</p>
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

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromAddress, to: [to], reply_to: replyToAddress, subject, html,
          ...(pdfAttachment ? { attachments: [pdfAttachment] } : {}),
        }),
      });
      if (!resendRes.ok) {
        const errBody = await resendRes.text();
        return json({ error: "Resend rejected the email: " + errBody }, 502);
      }
      await db.prepare(
        "UPDATE orders SET email_sent_at = CURRENT_TIMESTAMP, email_sent_to = ?, email_sent_count = email_sent_count + 1 WHERE id = ?"
      ).bind(to, o.id).run();
      await db.prepare(
        "INSERT INTO email_log (id, order_id, sent_to, subject) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), o.id, to, subject).run();
      return json({ success: true, sent_to: to });
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
      // Each breakdown row's decorations are shown right underneath that
      // row (not lumped together under the whole line) - a real garment
      // sent to the customer this way now clearly shows e.g. "Black / M"
      // followed by "Embroidery - Left chest - Highlanders Logo" directly
      // below it, rather than every logo on the line appearing as one
      // undifferentiated block a customer can't match back to a size. Falls
      // back to the old flat display for a quote saved before decorations
      // moved onto individual rows (see admin.html's itemDetailLines, the
      // same logic for the internal View/Print).
      const decLine = (d) => {
        const dQty = Number(d.qty) || 1;
        const priceLabel = d.price
          ? `${money(d.price)} each${dQty > 1 ? ` × ${dQty} = ${money(d.price * dQty)}` : ""}`
          : "included";
        return `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(METHOD_LABELS[d.method] || d.method)} - ${escapeHtml(PLACEMENT_LABELS[d.placement] || d.placement)} (${priceLabel})${d.notes ? " - " + escapeHtml(d.notes) : ""}</div>`;
      };
      let detailLines;
      if (!item.breakdown || !item.breakdown.length || item.customer_item) {
        detailLines = (item.decorations || []).map(decLine).join("");
      } else {
        const hasRowDecorations = item.breakdown.some((b) => (b.decorations || []).length);
        detailLines = item.breakdown.map((b) => {
          const rowLine = `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(b.colour || "-")} / ${escapeHtml(b.size || "-")} × ${b.qty}</div>`;
          return rowLine + (hasRowDecorations ? (b.decorations || []).map(decLine).join("") : "");
        }).join("") + (!hasRowDecorations ? (item.decorations || []).map(decLine).join("") : "");
      }
      return `<tr>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${baseLabel}${detailLines}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${item.qty}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${money(item.unit_price)}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${money(item.line_total)}</td>
      </tr>`;
    }).join("");

    const discountLine = o.discount_amount ? `Discount: -${money(o.discount_amount)}` : "";

    const isUnpaidInvoice = o.doc_type === "invoice" && o.paid_status !== "paid";
    // A quote always shows what deposit it'll need if accepted - the
    // customer should know that before they agree to it. An invoice only
    // asks on its first-ever send; every send after that is a running
    // statement instead - see isFirstSend above and the matching comment in
    // document-pdf.js/buildOrderPdf.
    let depositBalanceLine = "";
    if (o.doc_type === "quote") {
      const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
      if (depositDue > 0) {
        depositBalanceLine = `<div style="font-size:14px;font-weight:600;color:#b45309;margin-top:4px;">Deposit due on acceptance: ${money(depositDue)}</div>`;
      }
    } else if (isUnpaidInvoice) {
      const amountPaid = Number(o.amount_paid || 0);
      if (isFirstSend) {
        const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
        if (depositDue > 0) {
          depositBalanceLine = `<div style="font-size:14px;font-weight:600;color:#b45309;margin-top:4px;">Deposit due: ${money(depositDue)}</div>`;
        }
      } else {
        depositBalanceLine = `${amountPaid > 0 ? `<div style="font-size:13px;color:#64748b;margin-top:4px;">Paid to date: ${money(amountPaid)}</div>` : ""}
          <div style="font-size:14px;font-weight:600;color:#b45309;">Balance due: ${money(o.total - amountPaid)}</div>`;
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
            ${o.doc_type === "invoice" ? `<div style="font-size:14px;">Status: ${o.paid_status === "paid" ? "Paid" : "Unpaid"}</div>` : ""}
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
        ${o.notes ? `<p style="margin-top:24px;color:#64748b;"><strong>Notes:</strong> ${escapeHtml(o.notes)}</p>` : ""}
        ${myOrdersUrl ? `<p style="margin-top:20px;font-size:13px;"><a href="${myOrdersUrl}" style="color:#4f46e5;">View all your orders</a></p>` : ""}
        <p style="margin-top:32px;color:#64748b;font-size:13px;">Thanks,<br>Crystal Custom Embroidery</p>
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
        ...(pdfAttachment ? { attachments: [pdfAttachment] } : {}),
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      return json({ error: "Resend rejected the email: " + errBody }, 502);
    }

    await db.prepare(
      "UPDATE orders SET email_sent_at = CURRENT_TIMESTAMP, email_sent_to = ?, email_sent_count = email_sent_count + 1 WHERE id = ?"
    ).bind(to, o.id).run();
    await db.prepare(
      "INSERT INTO email_log (id, order_id, sent_to, subject) VALUES (?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), o.id, to, subject).run();

    return json({ success: true, sent_to: to });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
