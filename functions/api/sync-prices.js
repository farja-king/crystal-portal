// Auto-discovers every product on embroidery.click via its sitemap.xml and
// pulls each product's SKU + price into the catalog's sell_price. This is
// how new products added to the web store get their price into the back
// office without a manual re-scrape or a code change: adding a page to the
// site's sitemap is all that's required, so it works for entirely new
// collections too, not just new items in existing ones.
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

  const STORE_BASE = "https://embroidery.click";

  try {
    // These columns may not exist yet on a products table created before this
    // sync started writing them - see the matching comment in products.js.
    // ALTER TABLE throws if the column's already there, so each attempt is
    // swallowed individually.
    for (const col of ["available_colours TEXT DEFAULT '[]'", "available_sizes TEXT DEFAULT '[]'", "on_website INTEGER DEFAULT 0"]) {
      try {
        await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    // 1. Pull every product page URL straight from the sitemap - this is how
    // brand-new collections get picked up with zero code changes here.
    const sitemapRes = await fetch(`${STORE_BASE}/sitemap.xml`);
    if (!sitemapRes.ok) return json({ error: `Could not fetch sitemap: ${sitemapRes.status}` }, 502);
    const sitemapXml = await sitemapRes.text();

    const productUrls = new Set(
      [...sitemapXml.matchAll(/<loc>(https:\/\/embroidery\.click\/products\/[a-z0-9-]+\.html)<\/loc>/gi)]
        .map((m) => m[1])
    );

    // 2. The sitemap can lag behind newly-added products, so also crawl every
    // collection page it lists and pick up any product link not yet indexed.
    const collectionUrls = [...sitemapXml.matchAll(/<loc>(https:\/\/embroidery\.click\/collections\/[a-z0-9-]+\.html)<\/loc>/gi)]
      .map((m) => m[1]);

    for (const collectionUrl of collectionUrls) {
      try {
        const collectionRes = await fetch(collectionUrl);
        if (!collectionRes.ok) continue;
        const collectionHtml = await collectionRes.text();
        for (const m of collectionHtml.matchAll(/href="\.\.\/products\/([a-z0-9-]+)\.html"/gi)) {
          productUrls.add(`${STORE_BASE}/products/${m[1]}.html`);
        }
      } catch {
        // one bad collection page shouldn't abort the whole sync
      }
    }

    if (!productUrls.size) return json({ error: "No product URLs found in sitemap or collections" }, 502);

    let imported = 0;
    let notFound = 0;
    let failed = 0;
    const notFoundCodes = [];

    for (const url of productUrls) {
      try {
        const pageRes = await fetch(url);
        if (!pageRes.ok) { failed++; continue; }
        const html = await pageRes.text();

        const codeMatch = html.match(/"sku"\s*:\s*"([A-Z0-9]+)"/i);
        const priceMatch = html.match(/"price"\s*:\s*"([\d.]+)"/);
        if (!codeMatch || !priceMatch) { failed++; continue; }

        const code = codeMatch[1].toUpperCase();
        const price = Number(priceMatch[1]);
        if (!isFinite(price) || price < 0) { failed++; continue; }

        // Scrape available colours and sizes from the product page.
        // The site renders sizes as plain <option> tags inside
        // <select id="size-select">, and colours as a "const colours = [...]"
        // JS array (each entry has a "name" field, e.g. { name: "Black", img: "..." }) -
        // there is no <select> for colour, it's swatch buttons built from that array.
        const colours = new Set();
        const sizes = new Set();

        const sizeBlockMatch = html.match(/<select[^>]*id=["']size-select["'][^>]*>([\s\S]*?)<\/select>/i);
        if (sizeBlockMatch) {
          for (const m of sizeBlockMatch[1].matchAll(/<option[^>]*>([^<]+)<\/option>/gi)) {
            const text = m[1].trim();
            if (text) sizes.add(text);
          }
        }

        const coloursBlockMatch = html.match(/const\s+colours\s*=\s*\[([\s\S]*?)\];/i);
        if (coloursBlockMatch) {
          for (const m of coloursBlockMatch[1].matchAll(/name:\s*"([^"]+)"/gi)) {
            const text = m[1].trim();
            if (text) colours.add(text);
          }
        }

        const { results } = await db.prepare(
          "SELECT id, cost_price, vat_rate FROM products WHERE supplier_code = ?"
        ).bind(code).all();

        if (!results.length) { notFound++; notFoundCodes.push(code); continue; }

        const coloursList = Array.from(colours).filter(c => c && c.length > 0);
        const sizesList = Array.from(sizes).filter(s => s && s.length > 0);

        // on_website = 1 unconditionally here: reaching this point means the
        // code was just found live on the site during this sync pass, which
        // is the one thing that actually confirms it belongs under "On my
        // website" - unlike sell_price, which can also be set by hand for
        // something Martin is only quoting, not selling online.
        const stmt = db.prepare(`
          UPDATE products
          SET sell_price = ?, profit = ROUND(? - cost_price * (1 + vat_rate), 2),
              available_colours = ?, available_sizes = ?, on_website = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
        await db.batch(results.map((r) => stmt.bind(
          price, price,
          JSON.stringify(coloursList), JSON.stringify(sizesList),
          r.id
        )));
        imported += results.length;
      } catch {
        failed++;
      }
    }

    return json({
      success: true,
      products_found_on_site: productUrls.size,
      variants_updated: imported,
      codes_not_in_catalog: notFoundCodes,
      failed,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
