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

  function sanitizeDecoration(d) {
    return {
      method: String(d.method || "").slice(0, 40),
      placement: String(d.placement || "").slice(0, 40),
      price: Number(d.price) || 0,
      qty: Math.max(1, parseInt(d.qty, 10) || 1),
      notes: String(d.notes || "").slice(0, 200),
    };
  }

  // Recomputed from the submitted items every time, never trusted verbatim
  // from the client - this is the thing that becomes an invoice, so the
  // stored total has to be right.
  function priceItems(items, discountPct, discountFlat) {
    const priced = (Array.isArray(items) ? items : []).map((item) => {
      const source = item.source === "customer_supplied" ? "customer_supplied" : "catalog";
      const isGarmentLine = source === "catalog" && !item.customer_item;

      // Catalog rows are often a pricing tier ("All Colours" / "XS - XXL"),
      // not one physical garment, so the real per-unit colour/size/qty is
      // itemized in breakdown - qty for the line is the sum of those, not a
      // single number the client could otherwise send disconnected from it.
      // Each row also carries its own decorations (e.g. Black/M gets a
      // "Highlanders Logo", Black/XL gets a different logo) - added so a
      // decoration is priced against, and later printed alongside, the
      // specific colour/size it was actually put on, not shared across
      // every row in the line ambiguously.
      const breakdown = (Array.isArray(item.breakdown) ? item.breakdown : []).map((b) => ({
        colour: String(b.colour || "").slice(0, 60),
        size: String(b.size || "").slice(0, 60),
        qty: Math.max(1, parseInt(b.qty, 10) || 1),
        decorations: (Array.isArray(b.decorations) ? b.decorations : []).map(sanitizeDecoration),
      }));

      const unitPrice = Number(item.unit_price) || 0;
      // Line-level decorations - still how a customer-supplied line or a
      // customer's flat saved item (no colour/size breakdown to attach a
      // decoration to) carries decorations, and also how an OLDER quote
      // saved before per-row decorations existed still has them stored.
      const decorations = (Array.isArray(item.decorations) ? item.decorations : []).map(sanitizeDecoration);
      const hasRowDecorations = breakdown.some((b) => b.decorations.length);

      let qty, lineTotal;
      if (isGarmentLine && breakdown.length) {
        qty = breakdown.reduce((sum, b) => sum + b.qty, 0);
        if (hasRowDecorations || !decorations.length) {
          // New-style: each row's own decorations only cost against that
          // row's own qty.
          lineTotal = round2(breakdown.reduce((sum, b) => {
            const rowDecTotal = b.decorations.reduce((s, d) => s + d.price * d.qty, 0);
            return sum + b.qty * (unitPrice + rowDecTotal);
          }, 0));
        } else {
          // Old-style: this item still only has line-level decorations (a
          // quote saved before this feature existed, not yet re-opened in
          // the builder) - keep the original formula so its stored total
          // doesn't shift underneath it.
          const decorationTotal = decorations.reduce((sum, d) => sum + d.price * d.qty, 0);
          lineTotal = round2(qty * (unitPrice + decorationTotal));
        }
      } else {
        qty = Math.max(1, parseInt(item.qty, 10) || 1);
        const decorationTotal = decorations.reduce((sum, d) => sum + d.price * d.qty, 0);
        lineTotal = round2(qty * (unitPrice + decorationTotal));
      }

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
        // Marks a line picked from a customer's own saved price list (see
        // products.customer_id) rather than the shared garment catalog -
        // carried through so re-opening this quote in the builder renders
        // the simple qty-only line it started as, not a garment colour/size
        // grid that was never meaningful for it.
        customer_item: !!item.customer_item,
      };
    });

    const subtotal = round2(priced.reduce((sum, i) => sum + i.line_total, 0));
    const discount_pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
    const discount_flat = Math.max(0, Number(discountFlat) || 0);
    const discount_amount = round2(subtotal * (discount_pct / 100) + discount_flat);
    const total = Math.max(0, round2(subtotal - discount_amount));

    return { items: priced, subtotal, discount_pct, discount_flat, discount_amount, total };
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
        discount_flat REAL DEFAULT 0,
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

    // The table already existed on live D1 before discount_flat was added to
    // the CREATE TABLE above - "IF NOT EXISTS" is a no-op against an existing
    // table, so it needs adding here instead (same pattern as customers.js).
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN discount_flat REAL DEFAULT 0`).run();
    } catch {
      // already exists
    }
    // paid_at - when an invoice was actually marked paid, not just that it
    // currently is (paid_status alone has no timestamp) - needed so the
    // Dashboard can report revenue against the date it actually came in,
    // not the date the invoice happened to be created.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN paid_at TEXT`).run();
    } catch {
      // already exists
    }
    // archived_at - a quote nobody ever responded to, tucked out of the way
    // without deleting it (still fully retrievable, unlike Delete). Only
    // affects the main pipeline list (the default GET, no id/customer_id) -
    // a customer's own profile history and a direct ?id= lookup show an
    // archived order exactly as normal, since archiving is about
    // decluttering the working list, not hiding it from their record.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN archived_at TEXT`).run();
    } catch {
      // already exists
    }

    // ------------------------------------------------------------------ GET --
    if (request.method === "GET") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      if (id) {
        const row = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Not found" }, 404);
        return json({ ...row, items: JSON.parse(row.items || "[]") });
      }

      // ?customer_id=X -> a customer's full quote/invoice history, used by
      // the Customer Directory's View button.
      const docType = url.searchParams.get("doc_type");
      const customerId = url.searchParams.get("customer_id");
      const archived = url.searchParams.get("archived");
      const where = [];
      const binds = [];
      if (docType) { where.push("doc_type = ?"); binds.push(docType); }
      if (customerId) { where.push("customer_id = ?"); binds.push(customerId); }
      // The main Quotes & Invoices list (no customer_id, no explicit
      // ?archived=) only ever shows what's still active - archived rows are
      // a separate, deliberate lookup via ?archived=1, not folded into the
      // default view.
      if (archived) {
        where.push("archived_at IS NOT NULL");
      } else if (!customerId) {
        where.push("archived_at IS NULL");
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { results } = await db.prepare(
        `SELECT * FROM orders ${clause} ORDER BY created_at DESC`
      ).bind(...binds).all();

      return json(results.map((r) => ({ ...r, items: JSON.parse(r.items || "[]") })));
    }

    // ----------------------------------------------------------------- POST --
    // Always creates a new quote (invoices are only ever produced by
    // converting one - see the "convert_to_invoice" PUT action below).
    if (request.method === "POST") {
      const data = await request.json();
      const id = crypto.randomUUID();
      const priced = priceItems(data.items, data.discount_pct, data.discount_flat);
      const quote_number = await nextNumber("quote");

      await db.prepare(`
        INSERT INTO orders (
          id, doc_type, quote_number, customer_id, customer_name, customer_email,
          items, subtotal, discount_pct, discount_flat, discount_amount, total, status, notes
        ) VALUES (?, 'quote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        quote_number,
        data.customer_id || "",
        data.customer_name || "",
        data.customer_email || "",
        JSON.stringify(priced.items),
        priced.subtotal,
        priced.discount_pct,
        priced.discount_flat,
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

      if (data.action === "archive") {
        await db.prepare("UPDATE orders SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(data.id).run();
        return json({ success: true });
      }

      if (data.action === "unarchive") {
        await db.prepare("UPDATE orders SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(data.id).run();
        return json({ success: true });
      }

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
        // paid_at is set the moment it's marked paid, and cleared if it's
        // ever flipped back to unpaid - keeps it meaning "when this
        // actually became paid", not "has it ever been paid".
        await db.prepare(
          "UPDATE orders SET paid_status = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(status, status === "paid" ? new Date().toISOString() : null, data.id).run();
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
        data.discount_pct !== undefined ? data.discount_pct : existing.discount_pct,
        data.discount_flat !== undefined ? data.discount_flat : existing.discount_flat
      );

      await db.prepare(`
        UPDATE orders SET
          customer_id = ?, customer_name = ?, customer_email = ?,
          items = ?, subtotal = ?, discount_pct = ?, discount_flat = ?, discount_amount = ?, total = ?,
          notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        data.customer_id ?? existing.customer_id,
        data.customer_name ?? existing.customer_name,
        data.customer_email ?? existing.customer_email,
        JSON.stringify(priced.items),
        priced.subtotal,
        priced.discount_pct,
        priced.discount_flat,
        priced.discount_amount,
        priced.total,
        data.notes ?? existing.notes,
        data.status !== undefined ? String(data.status).slice(0, 30) : existing.status,
        data.id
      ).run();

      return json({ success: true, ...priced });
    }

    // --------------------------------------------------------------- DELETE --
    // A genuine Delete (not Archive - see the "archive" PUT action above,
    // which never touches design_proofs at all) removes every design proof
    // attached to the order too - both the D1 rows and their actual image/
    // PDF bytes in R2 (env.DESIGN_FILES, same bucket
    // functions/api/design-proofs.js writes to). The order itself is gone
    // for good, so there's nothing left for that record to be about.
    // Archived quotes keep everything indefinitely (including the actual
    // files) unless explicitly told otherwise via the "Remove image from
    // database" button in the Archived list, which only clears the file
    // bytes (see design-proofs.js's "remove_storage" action) while keeping
    // the record - who approved/declined what, and when - permanently.
    async function deleteOrphanedDesignProofs(orderIds) {
      if (!orderIds.length) return;
      const placeholders = orderIds.map(() => "?").join(",");
      // No proof has necessarily ever been attached to anything yet on a
      // given deploy - the table only gets created lazily by
      // functions/api/design-proofs.js the first time that's used. Rather
      // than depend on that having already run, tolerate its absence here
      // exactly like every other "already exists" check in this codebase.
      let results;
      try {
        ({ results } = await db.prepare(
          `SELECT r2_key FROM design_proofs WHERE order_id IN (${placeholders}) AND r2_key <> ''`
        ).bind(...orderIds).all());
      } catch (e) {
        return; // design_proofs table doesn't exist yet - nothing to clean up
      }
      if (env.DESIGN_FILES) {
        await Promise.all(results.map((r) => env.DESIGN_FILES.delete(r.r2_key).catch(() => {})));
      }
      await db.prepare(`DELETE FROM design_proofs WHERE order_id IN (${placeholders})`).bind(...orderIds).run();
    }

    if (request.method === "DELETE") {
      const { id, ids } = await request.json();
      if (Array.isArray(ids) && ids.length) {
        await deleteOrphanedDesignProofs(ids);
        const placeholders = ids.map(() => "?").join(",");
        await db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).bind(...ids).run();
        return json({ success: true, count: ids.length });
      }
      await deleteOrphanedDesignProofs([id]);
      await db.prepare("DELETE FROM orders WHERE id = ?").bind(id).run();
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
