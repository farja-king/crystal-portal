// GET ?id=X -> a real downloadable PDF of one quote/invoice, built with the
// hand-rolled writer in functions/_lib/pdf.js (see that file for why - no
// build step here for a real PDF library). Same content as the printed/
// emailed version, but an actual file a customer can save/print for their
// own records (HMRC keeping requirements were the reason this got asked
// for - a web page or an HTML email isn't something people file away).
import { buildOrderPdf } from "../_lib/document-pdf.js";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return new Response(JSON.stringify({ error: "id is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!o) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Manual invoices (functions/api/manual-invoice.js) have no items to
  // build a PDF from - the "PDF" for these always is whatever file Martin
  // uploaded, streamed straight from R2 instead.
  if (o.is_manual) {
    if (!o.manual_pdf_r2_key || !env.DESIGN_FILES) {
      return new Response(JSON.stringify({ error: "No PDF on file for this invoice" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const obj = await env.DESIGN_FILES.get(o.manual_pdf_r2_key);
    if (!obj) {
      return new Response(JSON.stringify({ error: "File missing from storage" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${(o.manual_pdf_filename || o.invoice_number || "invoice").replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const customerAddr = o.customer_id
    ? await db.prepare("SELECT address_1, address_2, city, county, postcode FROM customers WHERE id = ?").bind(o.customer_id).first()
    : null;

  const bytes = buildOrderPdf(o, customerAddr);
  const docNumber = o.doc_type === "invoice" ? o.invoice_number : o.quote_number;

  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${(docNumber || "document").replace(/[^a-zA-Z0-9-_]/g, "")}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
