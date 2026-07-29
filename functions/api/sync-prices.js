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
    // 1. Pull every product page URL straight from the sitemap - no need to
    // know collection names or crawl category pages.
    const sitemapRes = await fetch(`${STORE_BASE}/sitemap.xml`);
    if (!sitemapRes.ok) return json({ error: `Could not fetch sitemap: ${sitemapRes.status}` }, 502);
    const sitemapXml = await sitemapRes.text();

    const productUrls = [...sitemapXml.matchAll(/<loc>(https:\/\/embroidery\.click\/products\/[a-z0-9-]+\.html)<\/loc>/gi)]
      .map((m) => m[1]);

    if (!productUrls.length) return json({ error: "No product URLs found in sitemap" }, 502);

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

        const { results } = await db.prepare(
          "SELECT id, cost_price, vat_rate FROM products WHERE supplier_code = ?"
        ).bind(code).all();

        if (!results.length) { notFound++; notFoundCodes.push(code); continue; }

        const stmt = db.prepare(`
          UPDATE products
          SET sell_price = ?, profit = ROUND(? - cost_price * (1 + vat_rate), 2), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
        await db.batch(results.map((r) => stmt.bind(price, price, r.id)));
        imported += results.length;
      } catch {
        failed++;
      }
    }

    return json({
      success: true,
      products_found_on_site: productUrls.length,
      variants_updated: imported,
      codes_not_in_catalog: notFoundCodes,
      failed,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
