// Garment quotes and invoices built in the back office - separate from the
// DTF length-based quotes in quotes.js, which stays untouched. A single row
// covers both a quote and the invoice it becomes: doc_type flips from
// 'quote' to 'invoice' on conversion rather than duplicating the row, so the
// original quote_number is never lost.
//
// Martin isn't VAT registered, so there is deliberately no VAT anywhere in
// this file - total is subtotal minus discount, full stop. Don't add a VAT
// column here by analogy with products.js; that VAT is what Martin pays
// suppliers (a cost), not something charged to his customers.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  // Recomputed from the submitted items every time, never trusted verbatim
  // from the client - this is the thing that becomes an invoice, so the
  // stored total has to be right.
  function priceItems(items, discountPct) {
    const priced = (Array.isArray(items) ? items : []).map((item) => {
      const source = item.source === "customer_supplied" ? "customer_supplied" : "catalog";

      // Catalog rows are often a pricing tier ("All Colours" / "XS - XXL"),
      // not one physical garment, so the real per-unit colour/size/qty is
      // itemized in breakdown - qty for the line is the sum of those, not a
      // single number the client could otherwise send disconnected from it.
      const breakdown = (Array.isArray(item.breakdown) ? item.breakdown : []).map((b) => ({
        colour: String(b.colour || "").slice(0, 60),
        size: String(b.size || "").slice(0, 60),
        qty: Math.max(1, parseInt(b.qty, 10) || 1),
      }));
      const qty = source === "catalog" && breakdown.length
        ? breakdown.reduce((sum, b) => sum + b.qty, 0)
        : Math.max(1, parseInt(item.qty, 10) || 1);

      const unitPrice = Number(item.unit_price) || 0;
      const decorations = (Array.isArray(item.decorations) ? item.decorations : []).map((d) => ({
        method: String(d.method || "").slice(0, 40),
        placement: String(d.placement || "").slice(0, 40),
        price: Number(d.price) || 0,
        qty: Math.max(1, parseInt(d.qty, 10) || 1),
        notes: String(d.notes || "").slice(0, 200),
      }));
      const decorationTotal = decorations.reduce((sum, d) => sum + d.price * d.qty, 0);
      const lineTotal = round2(qty * (unitPrice + decorationTotal));
      return {
        source,
        product_id: item.product_id || null,
        supplier_code: item.supplier_code || "",
        title: item.title || "",
        colour: item.colour || "",
        size: item.size || "",
        description: item.description || "",
        qty,
        unit_price: unitPrice,
        breakdown,
        decorations,
        line_total: lineTotal,
      };
    });

    const subtotal = round2(priced.reduce((sum, i) => sum + i.line_total, 0));
    const discount_pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
    const discount_amount = round2(subtotal * (discount_pct / 100));
    const total = round2(subtotal - discount_amount);

    return { items: priced, subtotal, discount_pct, discount_amount, total };
  }

  async function nextNumber(kind) {
    // kind is 'quote' or 'invoice'. Single upsert+RETURNING statement so the
    // increment is atomic - this is exactly what replaces the old
    // client-side "Q-" + quotes.length numbering, which could collide.
    const row = await db.prepare(`
      INSERT INTO counters (name, value) VALUES (?, 1)
      ON CONFLICT(name) DO UPDATE SET value = value + 1
      RETURNING value
    `).bind(kind).first();
    const n = row ? row.value : 1;
    const prefix = kind === "invoice" ? "INV" : "Q";
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER DEFAULT 0
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        doc_type TEXT DEFAULT 'quote',
        quote_number TEXT,
        invoice_number TEXT,
        customer_id TEXT,
        customer_name TEXT,
        customer_email TEXT,
        items TEXT NOT NULL DEFAULT '[]',
        subtotal REAL DEFAULT 0,
        discount_pct REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        total REAL DEFAULT 0,
        status TEXT DEFAULT 'draft',
        paid_status TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        invoiced_at TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // ------------------------------------------------------------------ GET --
    if (request.method === "GET") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      if (id) {
        const row = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Not found" }, 404);
        return json({ ...row, items: JSON.parse(row.items || "[]") });
      }

      const docType = url.searchParams.get("doc_type");
      const where = docType ? "WHERE doc_type = ?" : "";
      const binds = docType ? [docType] : [];
      const { results } = await db.prepare(
        `SELECT * FROM orders ${where} ORDER BY created_at DESC`
      ).bind(...binds).all();

      return json(results.map((r) => ({ ...r, items: JSON.parse(r.items || "[]") })));
    }

    // ----------------------------------------------------------------- POST --
    // Always creates a new quote (invoices are only ever produced by
    // converting one - see the "convert_to_invoice" PUT action below).
    if (request.method === "POST") {
      const data = await request.json();
      const id = crypto.randomUUID();
      const priced = priceItems(data.items, data.discount_pct);
      const quote_number = await nextNumber("quote");

      await db.prepare(`
        INSERT INTO orders (
          id, doc_type, quote_number, customer_id, customer_name, customer_email,
          items, subtotal, discount_pct, discount_amount, total, status, notes
        ) VALUES (?, 'quote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        quote_number,
        data.customer_id || "",
        data.customer_name || "",
        data.customer_email || "",
        JSON.stringify(priced.items),
        priced.subtotal,
        priced.discount_pct,
        priced.discount_amount,
        priced.total,
        data.status || "draft",
        data.notes || ""
      ).run();

      return json({ success: true, id, quote_number, ...priced });
    }

    // ------------------------------------------------------------------ PUT --
    if (request.method === "PUT") {
      const data = await request.json();
      const existing = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.id).first();
      if (!existing) return json({ error: "Order not found" }, 404);

      if (data.action === "convert_to_invoice") {
        if (existing.doc_type === "invoice") return json({ error: "Already an invoice" }, 409);
        const invoice_number = await nextNumber("invoice");
        await db.prepare(`
          UPDATE orders SET doc_type = 'invoice', invoice_number = ?, paid_status = 'unpaid',
            invoiced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(invoice_number, data.id).run();
        return json({ success: true, invoice_number });
      }

      if (data.action === "set_paid_status") {
        if (existing.doc_type !== "invoice") return json({ error: "Only invoices have a paid status" }, 400);
        const status = data.paid_status === "paid" ? "paid" : "unpaid";
        await db.prepare(
          "UPDATE orders SET paid_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(status, data.id).run();
        return json({ success: true });
      }

      if (data.action === "set_status") {
        await db.prepare(
          "UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(String(data.status || "draft").slice(0, 30), data.id).run();
        return json({ success: true });
      }

      // Full edit: re-price from the submitted items, same as create.
      const priced = priceItems(
        data.items !== undefined ? data.items : JSON.parse(existing.items || "[]"),
        data.discount_pct !== undefined ? data.discount_pct : existing.discount_pct
      );

      await db.prepare(`
        UPDATE orders SET
          customer_id = ?, customer_name = ?, customer_email = ?,
          items = ?, subtotal = ?, discount_pct = ?, discount_amount = ?, total = ?,
          notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        data.customer_id ?? existing.customer_id,
        data.customer_name ?? existing.customer_name,
        data.customer_email ?? existing.customer_email,
        JSON.stringify(priced.items),
        priced.subtotal,
        priced.discount_pct,
        priced.discount_amount,
        priced.total,
        data.notes ?? existing.notes,
        data.status !== undefined ? String(data.status).slice(0, 30) : existing.status,
        data.id
      ).run();

      return json({ success: true, ...priced });
    }

    // --------------------------------------------------------------- DELETE --
    if (request.method === "DELETE") {
      const { id } = await request.json();
      await db.prepare("DELETE FROM orders WHERE id = ?").bind(id).run();
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
