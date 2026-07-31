export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    // Without this, a GET to this same URL (always identical - no query
    // params vary it) is fair game for the browser to serve straight from
    // its HTTP cache instead of hitting the Worker - so a customer added or
    // edited in one request could stay invisible to search/lookups in
    // another that already has this URL cached (see the same fix in
    // products.js, which hit the identical symptom for saved items).
    "Cache-Control": "no-store",
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
        square_customer_id TEXT,
        lifetime_spend REAL DEFAULT 0,
        transaction_count INTEGER DEFAULT 0,
        last_visit TEXT,
        address_1 TEXT,
        address_2 TEXT,
        city TEXT,
        county TEXT,
        postcode TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // The table already existed on live D1 before these columns were added
    // to the CREATE TABLE above - "IF NOT EXISTS" is a no-op against an
    // existing table, so they need adding here instead (same pattern as
    // products.js). ALTER TABLE throws if the column's already there, so
    // each attempt is swallowed individually.
    for (const col of [
      "square_customer_id TEXT", "lifetime_spend REAL DEFAULT 0", "transaction_count INTEGER DEFAULT 0", "last_visit TEXT",
      "address_1 TEXT", "address_2 TEXT", "city TEXT", "county TEXT", "postcode TEXT",
    ]) {
      try {
        await db.prepare(`ALTER TABLE customers ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    // GET: Fetch all customers for the Portal and Back Office
    if (request.method === "GET") {
      const { results } = await db.prepare(
        "SELECT * FROM customers ORDER BY name ASC"
      ).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // POST: Save a new customer, or bulk-import { rows: [...] } from a Square
    // export - upserts by id (see importCustomersCsv in admin.html, which
    // derives a stable id from the Square Customer ID so re-importing an
    // updated export updates existing customers rather than duplicating them).
    if (request.method === "POST") {
      const data = await request.json();

      if (Array.isArray(data.rows)) {
        const stmt = db.prepare(`
          INSERT INTO customers (
            id, name, company, email, phone, type, discount_pct, notes,
            square_customer_id, lifetime_spend, transaction_count, last_visit,
            address_1, address_2, city, county, postcode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            company = excluded.company,
            email = excluded.email,
            phone = excluded.phone,
            square_customer_id = excluded.square_customer_id,
            lifetime_spend = excluded.lifetime_spend,
            transaction_count = excluded.transaction_count,
            last_visit = excluded.last_visit,
            address_1 = excluded.address_1,
            address_2 = excluded.address_2,
            city = excluded.city,
            county = excluded.county,
            postcode = excluded.postcode
        `);
        // type/discount_pct/notes are left off the DO UPDATE SET - those are
        // Martin's own edits (trade discount, notes), which a re-import of
        // the same Square data shouldn't ever overwrite.

        const batch = data.rows.map((r) => stmt.bind(
          r.id,
          r.name || "Unnamed",
          r.company || "",
          r.email || "",
          r.phone || "",
          r.type || "Retail",
          r.discount_pct ?? 0,
          r.notes || "",
          r.square_customer_id || "",
          Number(r.lifetime_spend) || 0,
          Number(r.transaction_count) || 0,
          r.last_visit || "",
          r.address_1 || "",
          r.address_2 || "",
          r.city || "",
          r.county || "",
          r.postcode || ""
        ));

        await db.batch(batch);
        return new Response(JSON.stringify({ success: true, imported: batch.length }), { headers: corsHeaders });
      }

      const id = data.id || crypto.randomUUID();

      await db.prepare(`
        INSERT INTO customers (id, name, company, email, phone, type, discount_pct, notes, address_1, address_2, city, county, postcode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        data.name || "Unnamed",
        data.company || "",
        data.email || "",
        data.phone || "",
        data.type || "Retail",
        data.discount_pct ?? 0,
        data.notes || "",
        data.address_1 || "",
        data.address_2 || "",
        data.city || "",
        data.county || "",
        data.postcode || ""
      ).run();

      return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
    }

    // PUT: Update an existing customer
    if (request.method === "PUT") {
      const data = await request.json();

      await db.prepare(`
        UPDATE customers
        SET name = ?, company = ?, email = ?, phone = ?, type = ?, discount_pct = ?, notes = ?,
            address_1 = ?, address_2 = ?, city = ?, county = ?, postcode = ?
        WHERE id = ?
      `).bind(
        data.name || "Unnamed",
        data.company || "",
        data.email || "",
        data.phone || "",
        data.type || "Retail",
        data.discount_pct ?? 0,
        data.notes || "",
        data.address_1 || "",
        data.address_2 || "",
        data.city || "",
        data.county || "",
        data.postcode || "",
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
