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

// Real Adobe AFM advance widths (1/1000 em) for the exact characters a
// money()/qty string can ever contain - digits 0-9, £, ., - and space are
// all the same width in both Helvetica and Helvetica-Bold, so this is
// enough to right-align a numeric column precisely in the document's own
// font, without needing a full per-glyph metrics table (or falling back
// to Courier, which looks nothing like the rest of the page).
const NUMERIC_CHAR_WIDTH = { "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556, "8": 556, "9": 556, ".": 278, "£": 556, "-": 333, " ": 278, ",": 278 };
function numericRightX(str, size, rightEdge) {
  const width = String(str).split("").reduce((sum, ch) => sum + (NUMERIC_CHAR_WIDTH[ch] ?? 556), 0) * size / 1000;
  return rightEdge - width;
}

// Plain descriptive text only (colour/size breakdown) - no pricing, since
// that's already fully covered by the garment's own Qty/Unit/Total row.
function itemBreakdownLines(item) {
  const lines = [];
  if (item.breakdown && item.breakdown.length && !item.customer_item) {
    item.breakdown.forEach((b) => lines.push((b.colour || "-") + " / " + (b.size || "-") + " x " + b.qty));
  }
  return lines;
}

// Every decoration on an item, collapsed into one priced row per distinct
// method+placement+price+notes combination (so 5 colours all getting the
// same "Embroidery - Left chest" print as one row with qty 5, not five
// identical rows) - each becomes its own Qty/Unit/Total table row rather
// than grey descriptive text, so decoration cost is visible as a real
// number instead of only being folded silently into the garment row's
// Total. See buildOrderPdf's item loop below for why: previously the
// garment row showed Unit=garment-price but Total=garment+decoration
// combined, so "2 x £18" not lining up with the row's own Total looked
// like a maths error even though the underlying total was correct - the
// decoration cost just wasn't shown anywhere as a number.
function decorationEntries(item) {
  const raw = [];
  if (!item.breakdown || !item.breakdown.length || item.customer_item) {
    (item.decorations || []).forEach((d) => raw.push(d));
  } else {
    const hasRowDecorations = item.breakdown.some((b) => (b.decorations || []).length);
    if (hasRowDecorations) {
      item.breakdown.forEach((b) => (b.decorations || []).forEach((d) => raw.push(d)));
    } else {
      (item.decorations || []).forEach((d) => raw.push(d));
    }
  }
  const byKey = new Map();
  for (const d of raw) {
    const label = (METHOD_LABELS[d.method] || d.method || "") + " - " + (PLACEMENT_LABELS[d.placement] || d.placement || "") + (d.notes ? " (" + d.notes + ")" : "");
    const unitPrice = Number(d.price) || 0;
    const qty = Number(d.qty) || 1;
    const key = label + "|" + unitPrice;
    if (byKey.has(key)) byKey.get(key).qty += qty;
    else byKey.set(key, { label, unitPrice, qty });
  }
  return [...byKey.values()];
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
    const statusLabel = o.paid_status === "paid" ? "Paid" : o.paid_status === "partial" ? "Partially paid" : "Unpaid";
    doc.line("Status: " + statusLabel, { size: 10, gap: 13 });
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
      { x: numericRightX("Qty", 9, QTY_RIGHT), text: "Qty", font: "F2", size: 9 },
      { x: numericRightX("Unit", 9, UNIT_RIGHT), text: "Unit", font: "F2", size: 9 },
      { x: numericRightX("Total", 9, RIGHT_EDGE), text: "Total", font: "F2", size: 9 },
    ],
    { gap: 14 }
  );
  doc.hr();

  items.forEach((item) => {
    const baseLabel = item.source === "catalog"
      ? [item.supplier_code, item.title].filter(Boolean).join(" ")
      : ([item.description, item.title].filter(Boolean).join(" - ") || "Customer's own garment");
    const qty = Number(item.qty) || 0;
    const qtyStr = String(item.qty);
    const unitStr = money(item.unit_price);
    // Garment-only total (qty x garment unit price) - NOT item.line_total,
    // which includes decoration cost. Decoration gets its own priced
    // row(s) below so Qty x Unit = Total holds on every row, and the
    // customer can see exactly what they're paying for garments vs
    // decoration instead of one combined figure.
    const garmentTotalStr = money(qty * (Number(item.unit_price) || 0));

    doc.row(
      [
        { x: COL_ITEM_X, text: truncate(baseLabel, 48), size: 9 },
        { x: numericRightX(qtyStr, 9, QTY_RIGHT), text: qtyStr, font: "F2", size: 9, gray: 0 },
        { x: numericRightX(unitStr, 9, UNIT_RIGHT), text: unitStr, font: "F2", size: 9, gray: 0 },
        { x: numericRightX(garmentTotalStr, 9, RIGHT_EDGE), text: garmentTotalStr, font: "F2", size: 9, gray: 0 },
      ],
      { gap: 13 }
    );
    itemBreakdownLines(item).forEach((l) => {
      doc.line(truncate(l, 60), { x: COL_ITEM_X + 8, size: 8, gray: 0.45, gap: 11 });
    });
    decorationEntries(item).forEach((d) => {
      const dQtyStr = String(d.qty);
      const dUnitStr = money(d.unitPrice);
      const dTotalStr = money(d.unitPrice * d.qty);
      doc.row(
        [
          { x: COL_ITEM_X + 8, text: truncate("+ " + d.label, 44), size: 8.5, gray: 0.35 },
          { x: numericRightX(dQtyStr, 8.5, QTY_RIGHT), text: dQtyStr, size: 8.5, gray: 0.35 },
          { x: numericRightX(dUnitStr, 8.5, UNIT_RIGHT), text: dUnitStr, size: 8.5, gray: 0.35 },
          { x: numericRightX(dTotalStr, 8.5, RIGHT_EDGE), text: dTotalStr, size: 8.5, gray: 0.35 },
        ],
        { gap: 11 }
      );
    });
    doc.gap(3);
  });

  doc.hr();
  doc.gap(10);

  // Totals card - a boxed summary on the right rather than a loose stack of
  // left-aligned lines, with every figure right-aligned against the same
  // edge (see numericRightX above) so Subtotal/Total/Deposit/Balance all
  // actually line up under each other.
  const totalsRows = [{ label: "Subtotal", value: money(o.subtotal) }];
  if (o.discount_amount) totalsRows.push({ label: "Discount", value: "-" + money(o.discount_amount) });
  totalsRows.push({ label: "Total", value: money(o.total), bold: true });
  // A quote always shows what deposit it'll need if accepted - the customer
  // should know that before they agree to it, not find out only once it's
  // already been converted to an invoice. An invoice shows a running
  // paid-to-date/balance-due statement as soon as anything's actually been
  // paid (regardless of whether it's been emailed yet - was previously
  // gated on email_sent_count, so a payment recorded manually before the
  // first send stayed invisible on this PDF until it was emailed, even
  // though orders.amount_paid was already correct in the database), and
  // otherwise falls back to showing the deposit ask.
  if (o.doc_type === "quote") {
    const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
    if (depositDue > 0) totalsRows.push({ label: "Deposit due on acceptance", value: money(depositDue), bold: true });
  } else if (o.doc_type === "invoice" && o.paid_status !== "paid") {
    const amountPaid = Number(o.amount_paid || 0);
    if (amountPaid > 0) {
      totalsRows.push({ label: "Paid to date", value: money(amountPaid) });
      totalsRows.push({ label: "Balance due", value: money(o.total - amountPaid), bold: true });
    } else {
      const depositDue = Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0));
      if (depositDue > 0) totalsRows.push({ label: "Deposit due", value: money(depositDue), bold: true });
    }
  }

  // Wide enough that even the longest label here ("Deposit due on
  // acceptance") can't run into the value column - label text (letters)
  // still isn't measured (no full AFM table), only the numeric value
  // column is, so this width keeps real margin rather than being exact.
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
    // Every value is bold black regardless of row - only the label weight/
    // size marks Total/Deposit/Balance as more important than Subtotal/
    // Discount, matching the document's regular body text rather than
    // switching font family or fading to grey.
    doc.text(cardX + 16, doc.y, r.label, { font: r.bold ? "F2" : "F1", size, gray: r.bold ? 0 : 0.25 });
    doc.text(numericRightX(r.value, size, cardRight - 16), doc.y, r.value, { font: "F2", size, gray: 0 });
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
