// Lays out a quote/invoice as a PDF using the minimal writer in ./pdf.js -
// the same content as the printed/emailed version (functions/api/orders.js'
// print template, functions/api/send-email.js), just as an actual
// downloadable/attachable file, which is what HMRC record-keeping needs
// (a customer's own printed copy, not just something that only exists as a
// web page or an HTML email).
import { PdfDoc, MARGIN, PAGE_WIDTH } from "./pdf.js";

const METHOD_LABELS = { embroidery: "Embroidery", dtf: "DTF", sublimation: "Sublimation", other: "Other" };
const PLACEMENT_LABELS = { left_chest: "Left chest", right_chest: "Right chest", sleeve: "Sleeve", back: "Back", name: "Name", other: "Other" };

const money = (n) => "£" + Number(n || 0).toFixed(2);

function ukDate(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d)) return "";
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}

// No AFM width table here (see pdf.js) so long labels are hard-truncated
// rather than measured/wrapped - good enough for a garment/product name,
// keeps it from running into the Qty/Unit/Total columns.
function truncate(str, max) {
  str = String(str || "");
  return str.length > max ? str.slice(0, max - 1) + "..." : str;
}

const COL_ITEM_X = MARGIN;
const COL_QTY_X = 350;
const COL_UNIT_X = 400;
const COL_TOTAL_X = 470;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;

function itemDetailLines(item) {
  const lines = [];
  const decLine = (d) => {
    const dQty = Number(d.qty) || 1;
    const priceLabel = d.price
      ? money(d.price) + " each" + (dQty > 1 ? " x " + dQty + " = " + money(d.price * dQty) : "")
      : "included";
    lines.push(
      (METHOD_LABELS[d.method] || d.method || "") + " - " + (PLACEMENT_LABELS[d.placement] || d.placement || "") +
      " (" + priceLabel + ")" + (d.notes ? " - " + d.notes : "")
    );
  };
  if (!item.breakdown || !item.breakdown.length || item.customer_item) {
    (item.decorations || []).forEach(decLine);
  } else {
    const hasRowDecorations = item.breakdown.some((b) => (b.decorations || []).length);
    item.breakdown.forEach((b) => {
      lines.push((b.colour || "-") + " / " + (b.size || "-") + " x " + b.qty);
      if (hasRowDecorations) (b.decorations || []).forEach(decLine);
    });
    if (!hasRowDecorations) (item.decorations || []).forEach(decLine);
  }
  return lines;
}

// customerAddr: { address_1, address_2, city, county, postcode } or null.
export function buildOrderPdf(o, customerAddr) {
  const doc = new PdfDoc();
  const items = JSON.parse(o.items || "[]");
  const docLabel = o.doc_type === "invoice" ? "Invoice" : "Quote";
  const docNumber = o.doc_type === "invoice" ? o.invoice_number : o.quote_number;
  const isUnpaidInvoice = o.doc_type === "invoice" && o.paid_status !== "paid";

  doc.text(MARGIN, doc.y, "Crystal Custom Embroidery", { font: "F2", size: 18 });
  doc.y -= 22;
  doc.line("26 Grove Street, Raunds, NN9 6DS", { size: 9, gray: 0.4, gap: 12 });
  doc.line("hello@embroidery.click | 07530 576197", { size: 9, gray: 0.4, gap: 16 });
  doc.line(
    docLabel + " - " + docNumber + (o.doc_type === "invoice" && o.quote_number ? " (from " + o.quote_number + ")" : ""),
    { size: 10, gray: 0.4, gap: 20 }
  );

  doc.line("Customer", { font: "F2", size: 11, gap: 14 });
  doc.line(o.customer_name || "", { size: 10, gap: 13 });
  if (o.customer_email) doc.line(o.customer_email, { size: 10, gray: 0.35, gap: 13 });
  if (customerAddr) {
    [customerAddr.address_1, customerAddr.address_2, customerAddr.city, customerAddr.county, customerAddr.postcode]
      .filter(Boolean)
      .forEach((l) => doc.line(l, { size: 10, gray: 0.35, gap: 13 }));
  }
  doc.gap(6);

  doc.line("Details", { font: "F2", size: 11, gap: 14 });
  doc.line("Date: " + ukDate(o.created_at), { size: 10, gap: 13 });
  if (o.doc_type === "invoice") {
    doc.line("Status: " + (o.paid_status === "paid" ? "Paid" : "Unpaid"), { size: 10, gap: 13 });
    if (o.due_date) doc.line("Due by: " + ukDate(o.due_date), { size: 10, gap: 13 });
  }
  doc.gap(6);

  if (isUnpaidInvoice) {
    doc.line("We appreciate your business. Please pay via Bank Transfer", { font: "F2", size: 10, gap: 13 });
    doc.line("Banking Details: Crystal Custom Embroidery,", { size: 10, gap: 13 });
    doc.line("Sort Code: 04-03-33, Account Number: 55185130", { size: 10, gap: 13 });
    doc.gap(6);
  }

  doc.hr();
  doc.row(
    [
      { x: COL_ITEM_X, text: "Item", font: "F2", size: 9 },
      { x: COL_QTY_X, text: "Qty", font: "F2", size: 9 },
      { x: COL_UNIT_X, text: "Unit", font: "F2", size: 9 },
      { x: COL_TOTAL_X, text: "Total", font: "F2", size: 9 },
    ],
    { gap: 14 }
  );
  doc.hr();

  items.forEach((item) => {
    const baseLabel = item.source === "catalog"
      ? [item.supplier_code, item.title].filter(Boolean).join(" ")
      : ([item.description, item.title].filter(Boolean).join(" - ") || "Customer's own garment");

    doc.row(
      [
        { x: COL_ITEM_X, text: truncate(baseLabel, 48), size: 9 },
        { x: COL_QTY_X, text: String(item.qty), size: 9 },
        { x: COL_UNIT_X, text: money(item.unit_price), size: 9 },
        { x: COL_TOTAL_X, text: money(item.line_total), size: 9 },
      ],
      { gap: 13 }
    );
    itemDetailLines(item).forEach((l) => {
      doc.line(truncate(l, 60), { x: COL_ITEM_X + 8, size: 8, gray: 0.45, gap: 11 });
    });
    doc.gap(3);
  });

  doc.hr();
  doc.gap(4);
  doc.line("Subtotal: " + money(o.subtotal), { x: 400, size: 10, gap: 13 });
  if (o.discount_amount) doc.line("Discount: -" + money(o.discount_amount), { x: 400, size: 10, gap: 13 });
  doc.gap(6);
  doc.line("Total: " + money(o.total), { x: 400, font: "F2", size: 14, gap: 18 });
  // A quote always shows what deposit it'll need if accepted - the customer
  // should know that before they agree to it, not find out only once it's
  // already been converted to an invoice. An invoice shows the deposit ask
  // only on its first-ever send (email_sent_count is 0/null before that) -
  // the ask only makes sense once, every send after that shows a running
  // paid-to-date/balance-due statement instead.
  if (o.doc_type === "quote") {
    const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
    if (depositDue > 0) doc.line("Deposit due on acceptance: " + money(depositDue), { x: 400, font: "F2", size: 11, gap: 15 });
  } else if (o.doc_type === "invoice" && o.paid_status !== "paid") {
    const amountPaid = Number(o.amount_paid || 0);
    if (!o.email_sent_count) {
      const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
      if (depositDue > 0) doc.line("Deposit due: " + money(depositDue), { x: 400, font: "F2", size: 11, gap: 15 });
    } else {
      if (amountPaid > 0) doc.line("Paid to date: " + money(amountPaid), { x: 400, size: 10, gap: 13 });
      doc.line("Balance due: " + money(o.total - amountPaid), { x: 400, font: "F2", size: 11, gap: 15 });
    }
  }
  doc.line("VAT not applicable - not VAT registered.", { x: 400, size: 8, gray: 0.5, gap: 13 });

  if (o.notes) {
    doc.gap(10);
    doc.line("Notes:", { font: "F2", size: 10, gap: 13 });
    String(o.notes).split("\n").forEach((l) => doc.line(truncate(l, 90), { size: 9, gray: 0.4, gap: 12 }));
  }

  doc.gap(16);
  doc.line("Thanks, Crystal Custom Embroidery", { size: 9, gray: 0.5, gap: 12 });

  return doc.toBytes();
}
