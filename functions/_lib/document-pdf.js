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
const QTY_RIGHT = 380;
const UNIT_RIGHT = 462;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;

// Courier is genuinely fixed-width (0.6em per glyph), unlike Helvetica -
// this writer has no AFM table to measure Helvetica's real per-character
// widths (see pdf.js), so Courier is the only font it can right-align a
// numeric column against precisely. Every Qty/Unit/Total/Subtotal-style
// figure below is drawn in Courier for exactly this reason - it's what
// makes the numbers actually line up instead of drifting per row.
function courierRightX(str, size, rightEdge) {
  return rightEdge - String(str).length * size * 0.6;
}

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
      { x: courierRightX("Qty", 9, QTY_RIGHT), text: "Qty", font: "F3", size: 9 },
      { x: courierRightX("Unit", 9, UNIT_RIGHT), text: "Unit", font: "F3", size: 9 },
      { x: courierRightX("Total", 9, RIGHT_EDGE), text: "Total", font: "F3", size: 9 },
    ],
    { gap: 14 }
  );
  doc.hr();

  items.forEach((item) => {
    const baseLabel = item.source === "catalog"
      ? [item.supplier_code, item.title].filter(Boolean).join(" ")
      : ([item.description, item.title].filter(Boolean).join(" - ") || "Customer's own garment");
    const qtyStr = String(item.qty);
    const unitStr = money(item.unit_price);
    const totalStr = money(item.line_total);

    doc.row(
      [
        { x: COL_ITEM_X, text: truncate(baseLabel, 48), size: 9 },
        { x: courierRightX(qtyStr, 9, QTY_RIGHT), text: qtyStr, font: "F3", size: 9 },
        { x: courierRightX(unitStr, 9, UNIT_RIGHT), text: unitStr, font: "F3", size: 9 },
        { x: courierRightX(totalStr, 9, RIGHT_EDGE), text: totalStr, font: "F3", size: 9 },
      ],
      { gap: 13 }
    );
    itemDetailLines(item).forEach((l) => {
      doc.line(truncate(l, 60), { x: COL_ITEM_X + 8, size: 8, gray: 0.45, gap: 11 });
    });
    doc.gap(3);
  });

  doc.hr();
  doc.gap(10);

  // Totals card - a boxed summary on the right rather than a loose stack of
  // left-aligned lines, with every figure right-aligned against the same
  // edge (see courierRightX above) so Subtotal/Total/Deposit/Balance all
  // actually line up under each other.
  const totalsRows = [{ label: "Subtotal", value: money(o.subtotal) }];
  if (o.discount_amount) totalsRows.push({ label: "Discount", value: "-" + money(o.discount_amount) });
  totalsRows.push({ label: "Total", value: money(o.total), bold: true });
  // A quote always shows what deposit it'll need if accepted - the customer
  // should know that before they agree to it, not find out only once it's
  // already been converted to an invoice. An invoice shows the deposit ask
  // only on its first-ever send (email_sent_count is 0/null before that) -
  // the ask only makes sense once, every send after that shows a running
  // paid-to-date/balance-due statement instead.
  if (o.doc_type === "quote") {
    const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
    if (depositDue > 0) totalsRows.push({ label: "Deposit due on acceptance", value: money(depositDue), bold: true });
  } else if (o.doc_type === "invoice" && o.paid_status !== "paid") {
    const amountPaid = Number(o.amount_paid || 0);
    if (!o.email_sent_count) {
      const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
      if (depositDue > 0) totalsRows.push({ label: "Deposit due", value: money(depositDue), bold: true });
    } else {
      if (amountPaid > 0) totalsRows.push({ label: "Paid to date", value: money(amountPaid) });
      totalsRows.push({ label: "Balance due", value: money(o.total - amountPaid), bold: true });
    }
  }

  // Wide enough that even the longest label here ("Deposit due on
  // acceptance") can't run into the value column - Helvetica-Bold isn't
  // measured (no AFM table), so this width was chosen with real margin
  // rather than computed exactly.
  const cardX = 270;
  const cardRight = RIGHT_EDGE;
  const rowH = 20;
  const topPad = 16;
  // Constructed so the cursor lands exactly 8pt below the box's own bottom
  // edge once the row loop finishes - no separate "now skip past the box"
  // step needed afterward.
  const cardH = topPad + totalsRows.length * rowH - 8;
  doc.ensureSpace(totalsRows.length + 2, rowH);
  doc.rect(cardX, doc.y - cardH, cardRight - cardX, cardH, { gray: 0.8, weight: 0.75 });
  doc.y -= topPad;
  totalsRows.forEach((r) => {
    const size = r.bold ? 11 : 10;
    doc.text(cardX + 16, doc.y, r.label, { font: r.bold ? "F2" : "F1", size, gray: r.bold ? 0 : 0.4 });
    doc.text(courierRightX(r.value, size, cardRight - 16), doc.y, r.value, { font: "F3", size, gray: 0 });
    doc.y -= rowH;
  });
  doc.gap(6);
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
