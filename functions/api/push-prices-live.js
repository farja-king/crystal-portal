// Write-back counterpart to sync-prices.js: pushes this catalog's sell_price
// out to the live embroidery.click pages, by committing straight to
// farja-king/embroidery-portal (a separate GitHub Pages repo) via the
// GitHub Contents API. GitHub Pages rebuilds automatically after the commit.
//
// Mechanism proven first against a throwaway repo (embroidery-portal-test,
// see push-price-test.js) before being pointed here - see the session-4/5
// handoff. Discovery of which pages exist mirrors sync-prices.js exactly
// (sitemap + collection crawl) so the two stay in sync with each other; the
// live pages are fetched over plain HTTPS (no auth needed, matches the read
// sync) purely to compare against the DB price, and the GitHub API (which
// does need auth) is only touched for pages that actually need a change -
// keeps this well under GitHub's rate limit even for a full-catalog run.
//
// A product's price actually lives in TWO places on the live site: its own
// product page (JSON-LD + display price), and a card on every collection/
// category page that lists it (its own independent "<div class=\"price\">",
// unrelated to the product page - found in production: pushing RX350's new
// price updated its product page correctly but the Hoodies & Sweatshirts
// category page kept showing the old price). Both are compared against the
// catalog independently, since a collection card can drift even when the
// product page itself is already correct.
//
// Always dry-run first (dryRun: true) - returns the list of proposed changes
// without committing anything. Only a second call with dryRun: false (or
// omitted) commits.
export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const db = env.DB;
  const REPO = "farja-king/embroidery-portal";
  const STORE_BASE = "https://embroidery.click";

  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun !== false; // default true - an explicit false is required to actually commit

    if (!dryRun && !env.GITHUB_LIVE_REPO_TOKEN) {
      return json({ error: "GITHUB_LIVE_REPO_TOKEN not configured - cannot write to the live site yet" }, 500);
    }

    // 1. Same discovery as sync-prices.js: sitemap first, then crawl every
    // collection page for anything the sitemap hasn't indexed yet. Each
    // collection page's HTML is kept (collectionHtmlByUrl) so the card-price
    // scan below doesn't need to re-fetch it.
    const sitemapRes = await fetch(`${STORE_BASE}/sitemap.xml`);
    if (!sitemapRes.ok) return json({ error: `Could not fetch sitemap: ${sitemapRes.status}` }, 502);
    const sitemapXml = await sitemapRes.text();

    const productUrls = new Set(
      [...sitemapXml.matchAll(/<loc>(https:\/\/embroidery\.click\/products\/[a-z0-9-]+\.html)<\/loc>/gi)]
        .map((m) => m[1])
    );

    const collectionUrls = [...sitemapXml.matchAll(/<loc>(https:\/\/embroidery\.click\/collections\/[a-z0-9-]+\.html)<\/loc>/gi)]
      .map((m) => m[1]);

    const collectionHtmlByUrl = new Map();
    for (const collectionUrl of collectionUrls) {
      try {
        const collectionRes = await fetch(collectionUrl);
        if (!collectionRes.ok) continue;
        const collectionHtml = await collectionRes.text();
        collectionHtmlByUrl.set(collectionUrl, collectionHtml);
        for (const m of collectionHtml.matchAll(/href="\.\.\/products\/([a-z0-9-]+)\.html"/gi)) {
          productUrls.add(`${STORE_BASE}/products/${m[1]}.html`);
        }
      } catch {
        // one bad collection page shouldn't abort the whole run
      }
    }

    if (!productUrls.size) return json({ error: "No product URLs found in sitemap or collections" }, 502);

    // 2. Catalog price lookup, cached per code since both the product-page
    // and collection-card comparisons below need it and a code can appear
    // on several collection pages. (customer_id IS NULL OR '') matters here
    // - without it this can pick up a customer-specific price-list row
    // (Sloane Helicopters, Karl Sports, etc - same supplier_code, their own
    // negotiated price) instead of the shared catalog price that's actually
    // meant to be on the public site, same filter products.js applies by
    // default when no customer_id is requested.
    const catalogPriceCache = new Map(); // code -> price or null (not in catalog / unpriced)
    async function catalogPriceFor(code) {
      if (catalogPriceCache.has(code)) return catalogPriceCache.get(code);
      const row = await db.prepare(
        "SELECT sell_price FROM products WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL AND sell_price IS NOT NULL LIMIT 1"
      ).bind(code).first();
      const price = row && isFinite(Number(row.sell_price)) && Number(row.sell_price) >= 0 ? Number(row.sell_price) : null;
      catalogPriceCache.set(code, price);
      return price;
    }

    // 3a. Product pages: read every live page's own sku+price first, before
    // touching the DB at all - this is what catches a sku reused across more
    // than one page (found in production: products/custom-printed-tshirt.html
    // embeds "sku":"AT002", the same code as the real products/at002.html).
    // A sku with more than one page is ambiguous - there's no safe way to
    // know which page a catalog price change is meant for - so it's excluded
    // from candidates entirely rather than guessed at.
    let failed = 0;
    const skuPages = new Map(); // code -> [{ url, livePrice }]
    for (const url of productUrls) {
      try {
        const pageRes = await fetch(url);
        if (!pageRes.ok) { failed++; continue; }
        const html = await pageRes.text();

        const codeMatch = html.match(/"sku"\s*:\s*"([A-Z0-9]+)"/i);
        const priceMatch = html.match(/"price"\s*:\s*"([\d.]+)"/);
        if (!codeMatch || !priceMatch) { failed++; continue; }

        const code = codeMatch[1].toUpperCase();
        const livePrice = Number(priceMatch[1]);
        if (!skuPages.has(code)) skuPages.set(code, []);
        skuPages.get(code).push({ url, livePrice });
      } catch {
        failed++;
      }
    }

    const candidates = [];
    let notInCatalog = 0;
    let noSellPrice = 0;
    let upToDate = 0;
    const notInCatalogCodes = [];
    const ambiguousSkus = [];

    for (const [code, pages] of skuPages) {
      if (pages.length > 1) {
        ambiguousSkus.push({ sku: code, pages: pages.map((p) => p.url) });
        continue;
      }
      const { url, livePrice } = pages[0];
      const dbPrice = await catalogPriceFor(code);

      if (dbPrice === null) {
        if (catalogPriceCache.get(code) === null) {
          // Distinguish "not in catalog at all" from "in catalog but unpriced"
          // only for the dry-run summary counts - both mean nothing to push.
          const exists = await db.prepare(
            "SELECT 1 FROM products WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL LIMIT 1"
          ).bind(code).first();
          if (exists) noSellPrice++; else { notInCatalog++; notInCatalogCodes.push(code); }
        }
        continue;
      }

      if (Math.abs(dbPrice - livePrice) < 0.005) { upToDate++; continue; }

      candidates.push({
        sku: code,
        repo_path: url.slice(STORE_BASE.length + 1), // e.g. "products/at001.html"
        live_price: livePrice.toFixed(2),
        new_price: dbPrice.toFixed(2),
        url,
      });
    }

    // 3b. Collection cards: independent of the product-page comparison above
    // - a card can drift even when the product's own page is already
    // correct, since the two are unrelated pieces of HTML on the live site.
    // Ambiguity doesn't apply here the way it does for product pages: the
    // catalog price for a code is well-defined regardless of how many
    // product pages happen to exist for it, so every mismatching card gets
    // fixed.
    const collectionMismatches = []; // { sku, collection_url, repo_path, live_price, new_price }
    for (const [collectionUrl, html] of collectionHtmlByUrl) {
      const seenOnThisPage = new Set();
      for (const m of html.matchAll(/\(([A-Z0-9]+)\)<\/div>\s*<div class="price">£([\d.]+)/g)) {
        const code = m[1];
        if (seenOnThisPage.has(code)) continue; // same code shouldn't repeat on one page, but be safe
        seenOnThisPage.add(code);

        const dbPrice = await catalogPriceFor(code);
        if (dbPrice === null) continue; // not in catalog / unpriced - nothing to compare against
        const liveCardPrice = Number(m[2]);
        if (Math.abs(dbPrice - liveCardPrice) < 0.005) continue;

        collectionMismatches.push({
          sku: code,
          collection_url: collectionUrl,
          repo_path: collectionUrl.slice(STORE_BASE.length + 1),
          live_price: liveCardPrice.toFixed(2),
          new_price: dbPrice.toFixed(2),
        });
      }
    }

    if (dryRun) {
      return json({
        success: true,
        dryRun: true,
        products_found_on_site: productUrls.size,
        changes_proposed: candidates.length,
        collection_card_changes_proposed: collectionMismatches.length,
        up_to_date: upToDate,
        codes_not_in_catalog: notInCatalogCodes,
        no_sell_price: noSellPrice,
        ambiguous_skus: ambiguousSkus,
        failed,
        candidates,
        collection_mismatches: collectionMismatches,
      });
    }

    // 4. Commit each change via the GitHub Contents API - only touched here,
    // never during the dry-run pass above.
    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_LIVE_REPO_TOKEN}`,
      "User-Agent": "crystal-portal-price-writeback",
      Accept: "application/vnd.github+json",
    };

    let updated = 0;
    const commitFailed = [];

    for (const c of candidates) {
      try {
        const apiUrl = `https://api.github.com/repos/${REPO}/contents/${c.repo_path}`;
        const getRes = await fetch(apiUrl, { headers: ghHeaders });
        if (!getRes.ok) { commitFailed.push({ sku: c.sku, error: `GET ${getRes.status}` }); continue; }
        const file = await getRes.json();

        const currentHtml = new TextDecoder().decode(
          Uint8Array.from(atob(file.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))
        );

        // Defensive re-check: the live page could have changed between the
        // dry-run read and this commit (e.g. Martin edited it by hand).
        const skuMatch = currentHtml.match(/"sku"\s*:\s*"([A-Z0-9]+)"/i);
        if (!skuMatch || skuMatch[1].toUpperCase() !== c.sku) {
          commitFailed.push({ sku: c.sku, error: "SKU mismatch on re-read - skipped" });
          continue;
        }

        const updatedHtml = currentHtml
          .replace(/"price":\s*"[\d.]+"/, `"price":  "${c.new_price}"`)
          .replace(/<div class="price">£[\d.]+<\/div>/, `<div class="price">£${c.new_price}</div>`);

        if (updatedHtml === currentHtml) {
          commitFailed.push({ sku: c.sku, error: "Price pattern not found on re-read - skipped" });
          continue;
        }

        const newContentB64 = btoa(String.fromCharCode(...new TextEncoder().encode(updatedHtml)));

        const putRes = await fetch(apiUrl, {
          method: "PUT",
          headers: { ...ghHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Price update: ${c.sku} £${c.live_price} -> £${c.new_price} (via Crystal Portal)`,
            content: newContentB64,
            sha: file.sha,
          }),
        });

        if (!putRes.ok) { commitFailed.push({ sku: c.sku, error: `PUT ${putRes.status}` }); continue; }
        updated++;
      } catch (err) {
        commitFailed.push({ sku: c.sku, error: err.message });
      }
    }

    // 5. Collection cards - grouped by page so a page with several
    // mismatching cards only gets one commit, not one per card.
    let collectionPagesUpdated = 0;
    const collectionCommitFailed = [];
    const mismatchesByPage = new Map(); // repo_path -> [{sku,new_price}]
    for (const cm of collectionMismatches) {
      if (!mismatchesByPage.has(cm.repo_path)) mismatchesByPage.set(cm.repo_path, []);
      mismatchesByPage.get(cm.repo_path).push(cm);
    }

    for (const [repoPath, mismatches] of mismatchesByPage) {
      try {
        const apiUrl = `https://api.github.com/repos/${REPO}/contents/${repoPath}`;
        const getRes = await fetch(apiUrl, { headers: ghHeaders });
        if (!getRes.ok) { collectionCommitFailed.push({ page: repoPath, error: `GET ${getRes.status}` }); continue; }
        const file = await getRes.json();

        let html = new TextDecoder().decode(
          Uint8Array.from(atob(file.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))
        );
        const original = html;

        for (const cm of mismatches) {
          const codeEscaped = cm.sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const cardPricePattern = new RegExp(`(\\(${codeEscaped}\\)</div>\\s*<div class="price">)£[\\d.]+`);
          html = html.replace(cardPricePattern, `$1£${cm.new_price}`);
        }

        if (html === original) { collectionCommitFailed.push({ page: repoPath, error: "Price pattern not found on re-read - skipped" }); continue; }

        const newContentB64 = btoa(String.fromCharCode(...new TextEncoder().encode(html)));
        const putRes = await fetch(apiUrl, {
          method: "PUT",
          headers: { ...ghHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Update collection card price(s): ${mismatches.map((m) => m.sku).join(", ")} (via Crystal Portal)`,
            content: newContentB64,
            sha: file.sha,
          }),
        });
        if (!putRes.ok) { collectionCommitFailed.push({ page: repoPath, error: `PUT ${putRes.status}` }); continue; }
        collectionPagesUpdated++;
      } catch (err) {
        collectionCommitFailed.push({ page: repoPath, error: err.message });
      }
    }

    return json({
      success: true,
      dryRun: false,
      updated,
      collection_pages_updated: collectionPagesUpdated,
      failed_commits: commitFailed,
      collection_failed_commits: collectionCommitFailed,
      up_to_date: upToDate,
      codes_not_in_catalog: notInCatalogCodes,
      no_sell_price: noSellPrice,
      ambiguous_skus: ambiguousSkus,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
