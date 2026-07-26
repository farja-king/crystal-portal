export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        printable_width_mm REAL,
        film_width_mm REAL,
        minimum_billable_length_mm REAL,
        minimum_charge REAL,
        price_per_additional_100mm REAL,
        vat_rate REAL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // GET: Fetch the single shared settings row
    if (request.method === "GET") {
      const row = await db.prepare("SELECT * FROM settings WHERE id = 'default'").first();
      return new Response(JSON.stringify(row || null), { headers: corsHeaders });
    }

    // PUT: Upsert the single shared settings row
    if (request.method === "PUT") {
      const data = await request.json();

      await db.prepare(`
        INSERT INTO settings (
          id, printable_width_mm, film_width_mm, minimum_billable_length_mm,
          minimum_charge, price_per_additional_100mm, vat_rate, updated_at
        ) VALUES ('default', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          printable_width_mm = excluded.printable_width_mm,
          film_width_mm = excluded.film_width_mm,
          minimum_billable_length_mm = excluded.minimum_billable_length_mm,
          minimum_charge = excluded.minimum_charge,
          price_per_additional_100mm = excluded.price_per_additional_100mm,
          vat_rate = excluded.vat_rate,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        data.printable_width_mm ?? 0,
        data.film_width_mm ?? 0,
        data.minimum_billable_length_mm ?? 0,
        data.minimum_charge ?? 0,
        data.price_per_additional_100mm ?? 0,
        data.vat_rate ?? 0
      ).run();

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
