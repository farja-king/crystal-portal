export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        company TEXT,
        email TEXT,
        phone TEXT,
        type TEXT,
        discount_pct REAL DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // GET: Fetch all customers for the Portal and Back Office
    if (request.method === "GET") {
      const { results } = await db.prepare(
        "SELECT * FROM customers ORDER BY name ASC"
      ).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // POST: Save a new customer
    if (request.method === "POST") {
      const data = await request.json();
      const id = data.id || crypto.randomUUID();

      await db.prepare(`
        INSERT INTO customers (id, name, company, email, phone, type, discount_pct, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        data.name || "Unnamed",
        data.company || "",
        data.email || "",
        data.phone || "",
        data.type || "Retail",
        data.discount_pct ?? 0,
        data.notes || ""
      ).run();

      return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
    }

    // PUT: Update an existing customer
    if (request.method === "PUT") {
      const data = await request.json();

      await db.prepare(`
        UPDATE customers
        SET name = ?, company = ?, email = ?, phone = ?, type = ?, discount_pct = ?, notes = ?
        WHERE id = ?
      `).bind(
        data.name || "Unnamed",
        data.company || "",
        data.email || "",
        data.phone || "",
        data.type || "Retail",
        data.discount_pct ?? 0,
        data.notes || "",
        data.id
      ).run();

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // DELETE: Remove a customer
    if (request.method === "DELETE") {
      const { id } = await request.json();
      await db.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
