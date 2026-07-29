// Pulls authoritative colour/size data from PenCarrie (the actual wholesaler
// behind these products - pencarrie.com), one request per unique supplier_code
// already in the catalog. This replaces trying to scrape colour/size off
// embroidery.click: that only works when a product's page template happens to
// expose a size <select>, which several don't (AT001/AT002, anything one-size
// like caps). PenCarrie's public product API has complete colour + size data
// for every code regardless of page template, and doesn't require login -
// only its prices are gated, and this never touches price.
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

  const PENCARRIE_BASE = "https://www.pencarrie.com";

  try {
    // Same guarded migration as products.js/sync-prices.js, in case this ends
    // up being the first sync endpoint to run against a fresh table.
    for (const col of ["available_colours TEXT DEFAULT '[]'", "available_sizes TEXT DEFAULT '[]'", "on_website INTEGER DEFAULT 0"]) {
      try {
        await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    // One request per unique style code, not per catalog row - a code can
    // have dozens of colour/size variant rows sharing the same code. Only
    // codes not yet successfully synced are candidates, so a run that gets
    // cut short by the rate limit below still makes forward progress next
    // time instead of re-spending its budget on the same leading codes.
    const { results: codeRows } = await db.prepare(
      "SELECT DISTINCT supplier_code FROM products WHERE supplier_code <> '' AND available_colours = '[]' AND available_sizes = '[]'"
    ).all();

    let updated = 0;
    let notFound = 0;
    let failed = 0;
    let attempted = 0;
    let rateLimited = false;
    const notFoundCodes = [];

    for (const { supplier_code: code } of codeRows) {
      try {
        const res = await fetch(
          `${PENCARRIE_BASE}/api/internal/products/${encodeURIComponent(code)}?detail=1`,
          { headers: { Accept: "application/json" } }
        );
        attempted++;

        // PenCarrie's API is rate-limited (seen: 120 requests per window,
        // via x-ratelimit-* response headers). Stop cleanly with headroom
        // rather than hammering into 429s - whatever's left just gets
        // picked up by running the sync again, since codes already synced
        // are excluded from the candidate list above.
        const remaining = Number(res.headers.get("x-ratelimit-remaining"));
        if (res.status === 429 || (isFinite(remaining) && remaining <= 5)) {
          rateLimited = true;
          break;
        }

        if (res.status === 404) { notFound++; notFoundCodes.push(code); continue; }
        if (!res.ok) { failed++; continue; }

        const data = await res.json();
        const colours = Array.isArray(data.brand_colours)
          ? [...new Set(data.brand_colours.map((c) => c.name).filter(Boolean))]
          : [];
        const sizes = Array.isArray(data.sizes)
          ? [...new Set(data.sizes.filter(Boolean))]
          : [];

        if (!colours.length && !sizes.length) { notFound++; notFoundCodes.push(code); continue; }

        const result = await db.prepare(`
          UPDATE products SET available_colours = ?, available_sizes = ?, updated_at = CURRENT_TIMESTAMP
          WHERE supplier_code = ?
        `).bind(JSON.stringify(colours), JSON.stringify(sizes), code).run();

        updated += result.meta ? result.meta.changes : 0;
      } catch {
        failed++;
      }
    }

    return json({
      success: true,
      codes_checked: attempted,
      codes_remaining: codeRows.length - attempted,
      variants_updated: updated,
      codes_not_on_pencarrie: notFoundCodes,
      failed,
      rate_limited: rateLimited,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
