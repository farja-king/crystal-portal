// Bulk-writes available_colours/available_sizes parsed client-side from
// PenCarrie's own Shopify product-export CSVs (see importColoursSizesFromCsv
// in admin.html). This exists because the live PenCarrie sync (sync-colours.js)
// hits their API's 120-requests-per-window rate limit almost immediately
// against a catalog this size (3,900+ codes) and can't get through it in any
// reasonable number of runs. The CSV has the same data with full per-colour,
// per-size granularity, so once it's parsed in the browser this is a pure DB
// write - no external requests, no rate limit.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // Same guarded migration as the other sync endpoints, in case this is
    // the first one to run against a fresh table.
    for (const col of ["available_colours TEXT DEFAULT '[]'", "available_sizes TEXT DEFAULT '[]'", "on_website INTEGER DEFAULT 0"]) {
      try {
        await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    const body = await request.json();
    const codes = body && body.codes;
    if (!codes || typeof codes !== "object" || Array.isArray(codes)) {
      return json({ error: "Expected { codes: { CODE: { colours: [...], sizes: [...] } } }" }, 400);
    }

    const entries = Object.entries(codes);
    if (!entries.length) return json({ error: "No codes in payload" }, 400);

    const stmt = db.prepare(`
      UPDATE products SET available_colours = ?, available_sizes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE UPPER(supplier_code) = UPPER(?)
    `);

    // D1 batches are capped in size, so this goes through in chunks rather
    // than one call with thousands of statements.
    const CHUNK = 50;
    let matched = 0;
    let notMatched = 0;
    const notMatchedSample = [];

    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const results = await db.batch(chunk.map(([code, data]) => {
        const colours = Array.isArray(data && data.colours) ? [...new Set(data.colours.filter(Boolean))] : [];
        const sizes = Array.isArray(data && data.sizes) ? [...new Set(data.sizes.filter(Boolean))] : [];
        return stmt.bind(JSON.stringify(colours), JSON.stringify(sizes), code);
      }));

      results.forEach((r, idx) => {
        const changes = r.meta ? r.meta.changes : 0;
        if (changes > 0) {
          matched++;
        } else {
          notMatched++;
          if (notMatchedSample.length < 30) notMatchedSample.push(chunk[idx][0]);
        }
      });
    }

    return json({
      success: true,
      codes_in_file: entries.length,
      codes_matched: matched,
      codes_not_in_catalog: notMatched,
      sample_not_in_catalog: notMatchedSample,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
