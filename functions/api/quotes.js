export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB; // Bound D1 database instance

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // GET: Fetch all quotes for the Back Office
    if (request.method === "GET") {
      const { results } = await db.prepare(
        "SELECT * FROM quotes ORDER BY created_at DESC"
      ).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // POST: Save a new quote
    if (request.method === "POST") {
      const data = await request.json();
      const id = data.id || "q-" + Date.now();
      
      await db.prepare(`
        INSERT INTO quotes (
          id, quote_number, customer_id, customer_name, length_mm,
          quantity, vat, unit_price, subtotal, vat_amount, total, status, source, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        data.quoteNumber || "Q-PENDING",
        data.customerId || "GUEST",
        data.customerName || "Online Lead",
        data.lengthMm,
        data.quantity,
        data.vat ? 1 : 0,
        data.unitPrice,
        data.subtotal,
        data.vatAmount,
        data.total,
        data.status || "Pending Approval",
        data.source || "Customer",
        data.notes || ""
      ).run();

      return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
    }

    // PUT: Update quote status (e.g. Approve)
    if (request.method === "PUT") {
      const { id, status } = await request.json();
      await db.prepare("UPDATE quotes SET status = ? WHERE id = ?").bind(status, id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
