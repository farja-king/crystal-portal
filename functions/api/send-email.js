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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (!env.RESEND_API_KEY) {
    return json({ error: "Email isn't set up yet - the RESEND_API_KEY secret is missing from this Pages project." }, 500);
  }
  const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";

  const METHOD_LABELS = { embroidery: "Embroidery", dtf: "DTF", sublimation: "Sublimation", other: "Other" };
  const PLACEMENT_LABELS = { left_chest: "Left chest", sleeve: "Sleeve", back: "Back", other: "Other" };
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => "£" + Number(n || 0).toFixed(2);
  const ukDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-GB");
  };

  try {
    // Same "already exists" tolerance as every other API here - these
    // columns were added after orders already went live, so an ALTER on a
    // fresh table (which already has them from CREATE) just no-ops.
    for (const col of ["email_sent_at TEXT", "email_sent_to TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

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
        subject: `${docLabel} ${docNumber} from Crystal Custom Embroidery`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      return json({ error: "Resend rejected the email: " + errBody }, 502);
    }

    await db.prepare(
      "UPDATE orders SET email_sent_at = CURRENT_TIMESTAMP, email_sent_to = ? WHERE id = ?"
    ).bind(to, o.id).run();

    return json({ success: true, sent_to: to });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
