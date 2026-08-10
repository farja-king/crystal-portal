// Minimal, dependency-free PDF 1.4 writer.
//
// Cloudflare Pages Functions here have no package.json/build step - there's
// nowhere for a real PDF library (which would need npm install) to come
// from - so this hand-writes just enough of the PDF file format (objects, a
// content stream per page, an xref table) to lay out a simple business
// document: text, straight lines, plain rectangles. No image embedding, no
// custom fonts - just the standard PDF fonts (Helvetica/-Bold/Courier)
// every PDF reader already ships with, which is all a text invoice needs.
//
// Deliberately NOT a general-purpose PDF engine - see functions/_lib/
// document-pdf.js for the actual quote/invoice layout built on top of this.

export const PAGE_WIDTH = 595.28; // A4 in points
export const PAGE_HEIGHT = 841.89;
export const MARGIN = 50;
const TOP_Y = PAGE_HEIGHT - MARGIN;
const BOTTOM_Y = MARGIN + 20;

// PDF string literals only support single-byte WinAnsi-ish text - anything
// outside Latin-1 (emoji, CJK, etc, which a UK customer address/name is
// vanishingly unlikely to contain) is replaced rather than corrupting the
// file. Backslash/parens are the two characters PDF string syntax itself
// needs escaped.
function esc(str) {
  return String(str ?? "")
    .split("")
    .map((ch) => (ch.charCodeAt(0) > 255 ? "?" : ch))
    .join("")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

// The whole file is built as one JS string where every character is
// deliberately kept in the 0-255 range (see esc() above and every literal
// used below) - that makes JS string .length exactly equal to byte count
// throughout, so byte offsets for the xref table can just be out.length as
// we go, and this final pass turns it into real bytes.
function latin1Bytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

export class PdfDoc {
  constructor() {
    this.pages = [];
    this._newPage();
  }

  _newPage() {
    this.page = [];
    this.pages.push(this.page);
    this.y = TOP_Y;
  }

  // Forces a new page if the next `lines` rows (each `lineHeight` tall)
  // wouldn't fit above the bottom margin - called before anything that
  // draws, so a table/section never gets silently cut off mid-row.
  ensureSpace(lines = 1, lineHeight = 14) {
    if (this.y - lines * lineHeight < BOTTOM_Y) this._newPage();
  }

  text(x, y, str, { font = "F1", size = 10, gray = 0 } = {}) {
    this.page.push(
      `${gray} g BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(str)}) Tj ET`
    );
  }

  // One line of body text at the left margin (or a given x), advancing the
  // cursor down by `gap` afterward - the normal way content gets added.
  line(str, { font = "F1", size = 10, gray = 0, x = MARGIN, gap = 14 } = {}) {
    this.ensureSpace(1, gap);
    this.text(x, this.y, str, { font, size, gray });
    this.y -= gap;
  }

  // Several fixed-x columns on the same output row (a table row) - same y
  // for all of them, one shared advance afterward.
  row(cols, { gap = 14 } = {}) {
    this.ensureSpace(1, gap);
    for (const c of cols) this.text(c.x, this.y, c.text, { font: c.font, size: c.size, gray: c.gray });
    this.y -= gap;
  }

  hr({ gray = 0.75, weight = 0.5 } = {}) {
    this.ensureSpace(1, 10);
    this.page.push(
      `${weight} w ${gray} G ${MARGIN.toFixed(2)} ${this.y.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l S`
    );
    this.y -= 10;
  }

  // A plain stroked rectangle - x/y is the bottom-left corner (PDF's
  // coordinate origin), same as everywhere else in this file. Used to box
  // off a section (e.g. the totals summary) so it reads as one grouped
  // card instead of a loose stack of lines.
  rect(x, y, w, h, { gray = 0.75, weight = 0.75 } = {}) {
    this.page.push(
      `${weight} w ${gray} G ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`
    );
  }

  gap(px = 8) {
    this.y -= px;
  }

  toBytes() {
    const numPages = this.pages.length;
    const firstPageObjNum = 6; // 1=Catalog 2=Pages 3=Helvetica 4=Helvetica-Bold 5=Courier
    const pageObjNums = [];
    const contentObjNums = [];
    for (let i = 0; i < numPages; i++) {
      pageObjNums.push(firstPageObjNum + i * 2);
      contentObjNums.push(firstPageObjNum + i * 2 + 1);
    }
    const totalObjs = 5 + numPages * 2;

    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets = {};
    const addObj = (num, body) => {
      offsets[num] = out.length;
      out += `${num} 0 obj\n${body}\nendobj\n`;
    };

    addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    addObj(
      2,
      `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${numPages} >>`
    );
    // /Encoding /WinAnsiEncoding is what makes byte 0xA3 render as "£" and
    // 0xE9 as "é" - without it a viewer falls back to the font's built-in
    // StandardEncoding, which doesn't have £ at all and maps 0xE9 to a
    // different glyph entirely (that's why "Piqué" was coming out as
    // "PiquØ" and £ as a blank/wrong character before this).
    addObj(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
    addObj(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
    addObj(5, `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`);

    for (let i = 0; i < numPages; i++) {
      addObj(
        pageObjNums[i],
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjNums[i]} 0 R >>`
      );
      const streamBody = this.pages[i].join("\n");
      addObj(contentObjNums[i], `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`);
    }

    const xrefStart = out.length;
    out += `xref\n0 ${totalObjs + 1}\n`;
    out += `0000000000 65535 f\r\n`;
    for (let n = 1; n <= totalObjs; n++) {
      out += `${String(offsets[n]).padStart(10, "0")} 00000 n\r\n`;
    }
    out += `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    return latin1Bytes(out);
  }
}
