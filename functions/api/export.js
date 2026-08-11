// Plain-English data export - CSV/JSON of customers, orders, and payments,
// on demand from the Backups tab. Deliberately separate from backup.js's
// full-system snapshot (every table, every R2 file, restorable) - this is
// the lightweight "just the records, in a format I can open in Excel or read
// in a text editor" insurance copy, worth having simply because the business
// is moving off Square as the source of truth and nobody wants their whole
// customer/order history living only in one D1 database with nothing
// portable to fall back on.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const TABLES = { customers: "customers", orders: "orders", payments: "payments" };

  function toCsv(rows) {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(","));
    return lines.join("\n");
  }

  try {
    const url = new URL(request.url);
    const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
    const table = url.searchParams.get("table");
    const stamp = new Date().toISOString().slice(0, 10);

    if (table) {
      if (!TABLES[table]) {
        return new Response(JSON.stringify({ error: "Unknown table" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { results } = await db.prepare(`SELECT * FROM ${TABLES[table]} ORDER BY rowid`).all();
      if (format === "csv") {
        return new Response(toCsv(results), {
          headers: { ...corsHeaders, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${table}-${stamp}.csv"` },
        });
      }
      return new Response(JSON.stringify(results, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${table}-${stamp}.json"` },
      });
    }

    // No ?table= - the "export everything" case, always JSON (a single CSV
    // can't hold three differently-shaped tables at once).
    const [customers, orders, payments] = await Promise.all(
      Object.values(TABLES).map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().then((r) => r.results))
    );
    return new Response(JSON.stringify({ exported_at: new Date().toISOString(), customers, orders, payments }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Content-Disposition": `attachment; filename="crystal-portal-export-${stamp}.json"` },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
