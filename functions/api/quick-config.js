// Central config for Crystal Quick (the mobile companion app) - lets Martin
// set the Home screen tile order/visibility and the garment category tile
// order/visibility for the quote builder entirely from the back office,
// rather than each device having its own local settings. Single shared row,
// same pattern as functions/api/settings.js. Crystal Quick only ever GETs
// this (read-only, applies it as the source of truth); admin.html is the
// only thing that PUTs it.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS quick_app_config (
        id TEXT PRIMARY KEY,
        config_json TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    if (request.method === "GET") {
      const row = await db.prepare("SELECT config_json FROM quick_app_config WHERE id = 'default'").first();
      let config = null;
      if (row && row.config_json) {
        try { config = JSON.parse(row.config_json); } catch { config = null; }
      }
      return new Response(JSON.stringify(config), { headers: corsHeaders });
    }

    if (request.method === "PUT") {
      const data = await request.json();
      await db.prepare(`
        INSERT INTO quick_app_config (id, config_json, updated_at)
        VALUES ('default', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = CURRENT_TIMESTAMP
      `).bind(JSON.stringify(data)).run();
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
