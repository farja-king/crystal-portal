// Manual invoices - for a customer (Karl Sports, currently the only one)
// whose invoicing is actually done in a separate app. Martin just uploads
// the PDF that app already produced and fills in the number/total/due date
// by hand; it's still a normal row in the orders table (doc_type='invoice',
// is_manual=1) so it shows in Quotes & Invoices, the Dashboard, payment
// reminders etc exactly like a system-built invoice - only its PDF source
// differs (order-pdf.js and send-email.js both branch on is_manual to
// stream/attach the uploaded file instead of generating one).
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!bucket) {
    return json({ error: "File storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  // orders.js's own migrations create/extend the orders table on its own
  // requests - this file only ever runs after that's had a chance to (the
  // portal always loads orders before Customer View can even be opened),
  // but guard against a fresh database hitting this endpoint first anyway.
  try {
    for (const col of ["is_manual INTEGER DEFAULT 0", "manual_pdf_r2_key TEXT", "manual_pdf_filename TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const customerId = form.get("customer_id");
      const customerName = form.get("customer_name");
      const invoiceNumber = (form.get("invoice_number") || "").toString().trim();
      const totalRaw = form.get("total");
      if (!customerId || !invoiceNumber) return json({ error: "customer_id and invoice_number are required" }, 400);
      const total = Number(totalRaw);
      if (!isFinite(total) || total < 0) return json({ error: "total must be a non-negative number" }, 400);

      const file = form.get("file");
      if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
        return json({ error: "A PDF file is required" }, 400);
      }

      const id = crypto.randomUUID();
      const key = `manual-invoices/${id}/${file.name}`;
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || "application/pdf" },
      });

      await db.prepare(`
        INSERT INTO orders (
          id, doc_type, quote_number, invoice_number, customer_id, customer_name, customer_email,
          items, subtotal, discount_pct, discount_flat, discount_amount, total, status, paid_status,
          notes, due_date, is_manual, manual_pdf_r2_key, manual_pdf_filename, invoiced_at
        ) VALUES (?, 'invoice', '', ?, ?, ?, ?, '[]', ?, 0, 0, 0, ?, 'approved', 'unpaid', ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
      `).bind(
        id, invoiceNumber, customerId, customerName || "", form.get("customer_email") || "",
        total, total, form.get("notes") || "", form.get("due_date") || "", key, file.name
      ).run();

      return json({ success: true, id, invoice_number: invoiceNumber });
    }

    // Edits a manual invoice's details, optionally replacing its PDF -
    // never touches items/pricing (there are none), just the fields typed
    // in by hand at upload time.
    if (request.method === "PUT") {
      const form = await request.formData();
      const id = form.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      const existing = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
      if (!existing) return json({ error: "Invoice not found" }, 404);
      if (!existing.is_manual) return json({ error: "This isn't a manual invoice" }, 400);

      const invoiceNumber = (form.get("invoice_number") || "").toString().trim() || existing.invoice_number;
      const totalRaw = form.get("total");
      const total = totalRaw !== null && totalRaw !== "" ? Number(totalRaw) : Number(existing.total);
      if (!isFinite(total) || total < 0) return json({ error: "total must be a non-negative number" }, 400);
      const dueDate = form.has("due_date") ? form.get("due_date") : existing.due_date;
      const notes = form.has("notes") ? form.get("notes") : existing.notes;

      let pdfKey = existing.manual_pdf_r2_key;
      let pdfFilename = existing.manual_pdf_filename;
      const file = form.get("file");
      if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
        const newKey = `manual-invoices/${id}/${file.name}`;
        await bucket.put(newKey, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || "application/pdf" },
        });
        if (pdfKey && pdfKey !== newKey) await bucket.delete(pdfKey).catch(() => {});
        pdfKey = newKey;
        pdfFilename = file.name;
      }

      await db.prepare(`
        UPDATE orders SET invoice_number = ?, total = ?, subtotal = ?, due_date = ?, notes = ?,
          manual_pdf_r2_key = ?, manual_pdf_filename = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(invoiceNumber, total, total, dueDate || "", notes || "", pdfKey, pdfFilename, id).run();

      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
