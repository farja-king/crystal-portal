// Emails a quote/invoice to its customer via Resend. Kept as its own
// function (rather than folded into orders.js) since it's a different kind
// of thing - a side effect against a third-party API, not a CRUD op against
// D1 - and needs its own two secrets that orders.js has no reason to touch:
// RESEND_API_KEY and RESEND_FROM_EMAIL (e.g. "Crystal Custom Embroidery
// <quotes@embroidery.click>" - must be on a domain verified in Resend).
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
  const PLACEMENT_LABELS = { left_chest: "Left chest", sleeve: "Sleeve", back: "Back", other: "Other" };
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);

  try {
    // Same "already exists" tolerance as every other API here - these
    // columns were added after orders already went live, so an ALTER on a
    // fresh table (which already has them from CREATE) just no-ops.
    for (const col of ["email_sent_at TEXT", "email_sent_to TEXT", "email_sent_count INTEGER DEFAULT 0"]) {
      try {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
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
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_email_log_order ON email_log (order_id)").run();

    // GET ?order_id=X - the full send history for one quote/invoice, for
    // the View Quote panel's "Communication History" section.
    if (request.method === "GET") {
      const orderId = new URL(request.url).searchParams.get("order_id");
      if (!orderId) return json({ error: "order_id is required" }, 400);
      const { results } = await db.prepare(
        "SELECT sent_to, sent_at FROM email_log WHERE order_id = ? ORDER BY sent_at DESC"
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

    const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.order_id).first();
    if (!o) return json({ error: "Quote/invoice not found" }, 404);

    const to = (data.to || o.customer_email || "").trim();
    if (!to) return json({ error: "No email address on file for this customer" }, 400);

    const items = JSON.parse(o.items || "[]");
    const docLabel = o.doc_type === "invoice" ? "Invoice" : "Quote";
    const docNumber = o.doc_type === "invoice" ? o.invoice_number : o.quote_number;

    const rows = items.map((item) => {
      const baseLabel = item.source === "catalog"
        ? `${escapeHtml(item.supplier_code)} ${escapeHtml(item.title)}`
        : (escapeHtml([item.description, item.title].filter(Boolean).join(" - ")) || "Customer's own garment");
      const breakdownLines = (item.breakdown && item.breakdown.length && !item.customer_item)
        ? item.breakdown.map((b) => `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(b.colour || "-")} / ${escapeHtml(b.size || "-")} × ${b.qty}</div>`).join("")
        : "";
      const decLines = (item.decorations || []).map((d) => {
        const dQty = Number(d.qty) || 1;
        const priceLabel = d.price
          ? `${money(d.price)} each${dQty > 1 ? ` × ${dQty} = ${money(d.price * dQty)}` : ""}`
          : "included";
        return `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(METHOD_LABELS[d.method] || d.method)} - ${escapeHtml(PLACEMENT_LABELS[d.placement] || d.placement)} (${priceLabel})${d.notes ? " - " + escapeHtml(d.notes) : ""}</div>`;
      }).join("");
      return `<tr>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${baseLabel}${breakdownLines}${decLines}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${item.qty}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${money(item.unit_price)}</td>
        <td style="padding:10px 4px;border-bottom:1px solid #e2e8f0;">${money(item.line_total)}</td>
      </tr>`;
    }).join("");

    const discountLine = o.discount_amount
      ? `<div>Discount: -${money(o.discount_amount)}</div>`
      : "";

    const html = `
      <div style="font-family:Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
        <h1 style="margin:0 0 4px;font-size:22px;">Crystal Custom Embroidery</h1>
        <div style="color:#64748b;margin-bottom:20px;">${docLabel} - ${escapeHtml(docNumber)}${o.doc_type === "invoice" ? " (from " + escapeHtml(o.quote_number) + ")" : ""}</div>
        <p>Hi ${escapeHtml(o.customer_name)},</p>
        <p>Please find your ${docLabel.toLowerCase()} below${o.doc_type === "quote" ? " - let us know if you'd like to go ahead" : ""}.</p>
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
          ${discountLine}
          <div style="font-size:20px;font-weight:700;">Total: ${money(o.total)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">VAT not applicable - not VAT registered.</div>
        </div>
        ${o.notes ? `<p style="margin-top:24px;color:#64748b;"><strong>Notes:</strong> ${escapeHtml(o.notes)}</p>` : ""}
        <p style="margin-top:32px;color:#64748b;font-size:13px;">Thanks,<br>Crystal Custom Embroidery</p>
      </div>`;

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
        subject: `${docLabel} ${docNumber} from Crystal Custom Embroidery`,
        html,
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
      "INSERT INTO email_log (id, order_id, sent_to) VALUES (?, ?, ?)"
    ).bind(crypto.randomUUID(), o.id, to).run();

    return json({ success: true, sent_to: to });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
