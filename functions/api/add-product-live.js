// Publishes a brand-new product page to the live embroidery.click site for a
// garment already in this catalog, via the same GitHub Contents API path as
// push-prices-live.js. Three files get committed: a new products/<code>.html
// page, a new card on the chosen collection page, and a new sitemap.xml entry.
//
// Colours, sizes, and the exact per-colour image filename come from the
// product's own supplier - PenCarrie's public product API for most brands,
// or Uneek's live API (functions/_lib/uneek.js) when products.supplier is
// "UNEEK" (set by importUneekCsv/uneek-sync.js). PenCarrie's colour "code"
// field (e.g. "BLK") is exactly what the embroidery.click image CDN URLs
// use, but the filename suffix isn't always predictable ("FRONT.jpg" vs
// "FRONT 1.jpg" - see RX151's Turquoise Blue/Stone in the live site's own
// template), so each candidate filename is HEAD-checked against the real
// CDN before being used. Uneek's response already gives a real, resolved
// per-colour image URL directly - no CDN filename guessing needed there.
//
// Always dry-run first (dryRun: true) - returns a full preview (title, price,
// resolved image per colour, sizes, material) without writing anything. Only
// dryRun: false actually commits, matching push-prices-live.js's pattern.
import { fetchUneekProductVariants } from "../_lib/uneek.js";

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  const db = env.DB;
  const REPO = "farja-king/embroidery-portal";
  const STORE_BASE = "https://embroidery.click";
  const PENCARRIE_BASE = "https://www.pencarrie.com";

  // The site's actual collections - label shown in the portal UI, and the
  // nav text baked into every generated product page's breadcrumb.
  const COLLECTIONS = {
    "collections/custom-tshirts.html": "T-Shirts",
    "collections/polos-category.html": "Polos",
    "collections/hoodies-sweatshirts-category.html": "Hoodies & Sweatshirts",
    "collections/fleeces-category.html": "Fleeces",
    "collections/gilets-jackets-category.html": "Gilets & Jackets",
    "collections/headwear-category.html": "Headwear",
    "collections/leavers-category.html": "Leavers",
  };

  if (request.method === "GET") {
    return json({ collections: COLLECTIONS });
  }

  // -------------------------------------------------------------- DELETE --
  // Unpublish: removes the product page, its card from every collection
  // page it's found on (normally one, but checks all seven since a page
  // could have been added by hand outside this tool), and its sitemap
  // entry - then clears on_website in the catalog. Same dry-run/confirm
  // pattern as publishing: dryRun (default true) just reports what would
  // be removed.
  if (request.method === "DELETE") {
    try {
      const body = await request.json().catch(() => ({}));
      const dryRun = body.dryRun !== false;
      const code = (body.supplier_code || "").trim().toUpperCase();
      if (!code) return json({ error: "supplier_code is required" }, 400);

      if (!dryRun && !env.GITHUB_LIVE_REPO_TOKEN) {
        return json({ error: "GITHUB_LIVE_REPO_TOKEN not configured - cannot write to the live site yet" }, 500);
      }

      const productRepoPath = `products/${code.toLowerCase()}.html`;
      const productLiveUrl = `${STORE_BASE}/${productRepoPath}`;

      const existsRes = await fetch(productLiveUrl);
      if (!existsRes.ok) {
        return json({ error: `${code} has no live product page at ${productRepoPath}` }, 404);
      }

      // Check every collection for a card referencing this product - a page
      // added by hand (not through Publish) could be linked from more than
      // one, or from a collection this tool didn't put it on.
      const foundOn = [];
      for (const [path, label] of Object.entries(COLLECTIONS)) {
        const res = await fetch(`${STORE_BASE}/${path}`);
        if (!res.ok) continue;
        const html = await res.text();
        if (html.includes(`../${productRepoPath}`)) foundOn.push({ path, label });
      }

      const sitemapRes = await fetch(`${STORE_BASE}/sitemap.xml`);
      const sitemapHasEntry = sitemapRes.ok && (await sitemapRes.text()).includes(productLiveUrl);

      if (dryRun) {
        return json({
          success: true,
          dryRun: true,
          code,
          product_repo_path: productRepoPath,
          found_on_collections: foundOn,
          sitemap_entry_found: sitemapHasEntry,
        });
      }

      const ghHeaders = {
        Authorization: `Bearer ${env.GITHUB_LIVE_REPO_TOKEN}`,
        "User-Agent": "crystal-portal-unpublish-product",
        Accept: "application/vnd.github+json",
      };
      const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

      // Remove the card from every collection page it's found on.
      const collectionsUpdated = [];
      const collectionFailures = [];
      for (const { path, label } of foundOn) {
        try {
          const apiUrl = `https://api.github.com/repos/${REPO}/contents/${path}`;
          const getRes = await fetch(apiUrl, { headers: ghHeaders });
          if (!getRes.ok) { collectionFailures.push({ path, error: `GET ${getRes.status}` }); continue; }
          const file = await getRes.json();
          const html = new TextDecoder().decode(
            Uint8Array.from(atob(file.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))
          );

          // Remove the whole <a class="product-card" ... > ... </a> block
          // that links to this product. Found in production: a regex like
          // "<a class=\"product-card\"[\s\S]*?href=\"...\"[\s\S]*?</a>" is
          // NOT scoped to one card - since [\s\S]*? only cares about
          // reaching the target href eventually, on a page with several
          // cards it happily bridges from the very FIRST card's opening tag
          // through several unrelated ones to reach the target, deleting
          // all of them as collateral damage (wiped 3 real listings off
          // headwear-category.html on a live test before this fix). Instead:
          // find the unique href first, then walk backward/forward from
          // that exact position to the nearest card boundaries - cards
          // never nest, so the nearest preceding "<a class=\"product-card\""
          // and nearest following "</a>" are guaranteed to be this card's
          // own, not a neighbour's.
          const hrefNeedle = `href="../${productRepoPath}"`;
          const hrefIdx = html.indexOf(hrefNeedle);
          if (hrefIdx === -1) { collectionFailures.push({ path, error: "Card not found on re-read" }); continue; }
          const cardStart = html.lastIndexOf('<a class="product-card"', hrefIdx);
          const cardCloseIdx = html.indexOf("</a>", hrefIdx);
          if (cardStart === -1 || cardCloseIdx === -1) { collectionFailures.push({ path, error: "Could not locate card boundaries" }); continue; }
          const cardEnd = cardCloseIdx + "</a>".length;

          // Trim back over the leading whitespace/newline this card sits on,
          // so removing it doesn't leave a blank line behind.
          let removeStart = cardStart;
          while (removeStart > 0 && /[ \t]/.test(html[removeStart - 1])) removeStart--;
          if (removeStart > 0 && html[removeStart - 1] === "\n") removeStart--;

          const updatedHtml = html.slice(0, removeStart) + html.slice(cardEnd);
          if (updatedHtml === html) { collectionFailures.push({ path, error: "Card removal produced no change" }); continue; }

          const putRes = await fetch(apiUrl, {
            method: "PUT",
            headers: { ...ghHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `Remove ${code} card from ${label} (via Crystal Portal)`,
              content: b64(updatedHtml),
              sha: file.sha,
            }),
          });
          if (!putRes.ok) { collectionFailures.push({ path, error: `PUT ${putRes.status}` }); continue; }
          collectionsUpdated.push(path);
        } catch (err) {
          collectionFailures.push({ path, error: err.message });
        }
      }

      // Remove the sitemap entry.
      let sitemapUpdated = false;
      try {
        const sitemapApiUrl = `https://api.github.com/repos/${REPO}/contents/sitemap.xml`;
        const getRes = await fetch(sitemapApiUrl, { headers: ghHeaders });
        if (getRes.ok) {
          const file = await getRes.json();
          const xml = new TextDecoder().decode(
            Uint8Array.from(atob(file.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))
          );
          const entryPattern = new RegExp(
            `\\s*<url>\\s*<loc>${productLiveUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>[\\s\\S]*?<\\/url>`
          );
          const updatedXml = xml.replace(entryPattern, "");
          if (updatedXml !== xml) {
            const putRes = await fetch(sitemapApiUrl, {
              method: "PUT",
              headers: { ...ghHeaders, "Content-Type": "application/json" },
              body: JSON.stringify({
                message: `Remove ${productRepoPath} from sitemap (via Crystal Portal)`,
                content: b64(updatedXml),
                sha: file.sha,
              }),
            });
            sitemapUpdated = putRes.ok;
          }
        }
      } catch {
        // sitemap failure isn't fatal - a stale sitemap entry pointing at a
        // 404 only affects search indexing, not the live site itself
      }

      // Delete the product page file itself.
      let productPageDeleted = false;
      try {
        const apiUrl = `https://api.github.com/repos/${REPO}/contents/${productRepoPath}`;
        const getRes = await fetch(apiUrl, { headers: ghHeaders });
        if (getRes.ok) {
          const file = await getRes.json();
          const delRes = await fetch(apiUrl, {
            method: "DELETE",
            headers: { ...ghHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `Remove ${code} product page (via Crystal Portal)`,
              sha: file.sha,
            }),
          });
          productPageDeleted = delRes.ok;
        }
      } catch {
        // handled by productPageDeleted staying false
      }

      await db.prepare(
        "UPDATE products SET on_website = 0 WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL"
      ).bind(code).run();

      return json({
        success: true,
        dryRun: false,
        code,
        product_page_deleted: productPageDeleted,
        collections_updated: collectionsUpdated,
        collection_failures: collectionFailures,
        sitemap_updated: sitemapUpdated,
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun !== false;
    const code = (body.supplier_code || "").trim().toUpperCase();
    const collectionPath = (body.collection || "").trim();
    const specsLines = Array.isArray(body.specs) ? body.specs.filter((s) => s && s.trim()) : [];
    const descriptionOverride = (body.description || "").trim();

    if (!code) return json({ error: "supplier_code is required" }, 400);
    if (!COLLECTIONS[collectionPath]) return json({ error: "Unknown or missing collection" }, 400);

    if (!dryRun && !env.GITHUB_LIVE_REPO_TOKEN) {
      return json({ error: "GITHUB_LIVE_REPO_TOKEN not configured - cannot write to the live site yet" }, 500);
    }

    // 1. Pull this code's shared-catalog price/title - same customer_id
    // filter as push-prices-live.js, for the same reason (never publish a
    // customer's own negotiated price onto the public site). A code can
    // have duplicate rows across suppliers/imports over time - ordering by
    // most-recently-synced first means the freshest data wins instead of
    // whichever row SQLite happens to return first.
    const row = await db.prepare(
      "SELECT title, brand, supplier, sell_price FROM products WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL AND item_type = 'garment' ORDER BY updated_at DESC LIMIT 1"
    ).bind(code).first();
    const isUneek = row && String(row.supplier || "").toUpperCase() === "UNEEK";

    if (!row) return json({ error: `${code} not found in the shared catalog` }, 404);
    if (row.sell_price === null || row.sell_price === undefined) {
      return json({ error: `${code} has no sell price set yet - price it first` }, 400);
    }
    const price = Number(row.sell_price).toFixed(2);

    const productRepoPath = `products/${code.toLowerCase()}.html`;

    // 2. Refuse to clobber a page that already exists - "add a product"
    // should never silently overwrite one push-prices-live.js is already
    // managing.
    const existsRes = await fetch(`${STORE_BASE}/${productRepoPath}`);
    if (existsRes.ok) {
      return json({ error: `${code} already has a live product page - use the catalog's price sync instead` }, 400);
    }

    // 3. Colours/sizes/material come from the product's own supplier.
    let brand, name, sizes, material, weight, IMG_BASE, colours, resolvedColours, mainColour, mainImageUrl;

    if (isUneek) {
      // Uneek's own API is the source of truth here - see functions/_lib/uneek.js
      // for why this is a targeted string extraction rather than a full
      // catalog parse (Cloudflare Worker CPU limit). Unlike PenCarrie, the
      // response already gives a real, resolved per-colour image URL
      // directly, so there's no CDN filename guessing/HEAD-checking needed
      // and IMG_BASE stays empty (each colour's "file" is already the full URL).
      let variants;
      try {
        variants = await fetchUneekProductVariants(env, code);
      } catch (err) {
        return json({ error: `Uneek lookup failed for ${code}: ${err.message}` }, 502);
      }
      if (!variants.length) return json({ error: `Uneek has no data for ${code}` }, 502);

      brand = "Uneek";
      name = variants[0].ProductName || row.title || code;
      sizes = [...new Set(variants.map((v) => v.Size).filter(Boolean))];
      material = variants[0].Composition || "";
      weight = variants[0].GSM ? `${variants[0].GSM}gsm` : "";
      IMG_BASE = "";

      const seenColours = new Map();
      for (const v of variants) {
        if (!v.Colour || seenColours.has(v.Colour)) continue;
        const file = v.ColourImage || v.Image || "";
        seenColours.set(v.Colour, { name: v.Colour, code: v.ColourCode || "", file, resolved: !!file });
      }
      colours = [...seenColours.values()];
      resolvedColours = colours.filter((c) => c.resolved);
      if (!resolvedColours.length) {
        return json({ error: `Uneek returned no usable image for any colour of ${code}` }, 502);
      }
      mainColour = resolvedColours[0];
      mainImageUrl = mainColour.file;
    } else {
      // PenCarrie is the source of truth for colours/sizes/material - same
      // API sync-colours.js already uses, chosen there specifically because
      // it has complete data regardless of what a given embroidery.click
      // page template happens to expose.
      const pcRes = await fetch(`${PENCARRIE_BASE}/api/internal/products/${encodeURIComponent(code)}?detail=1`, {
        headers: { Accept: "application/json" },
      });
      if (!pcRes.ok) return json({ error: `PenCarrie lookup failed for ${code}: HTTP ${pcRes.status}` }, 502);
      const pc = await pcRes.json();

      brand = pc.brand || row.brand || "";
      name = pc.name || row.title || code;
      const brandColours = Array.isArray(pc.brand_colours) ? pc.brand_colours : [];
      if (!brandColours.length) return json({ error: `PenCarrie has no colour data for ${code}` }, 502);

      // Sizes/material/weight are per-colour in PenCarrie's response but
      // uniform for the product in practice - first colour's values stand in
      // for the whole product, same as every existing hand-built page here.
      const firstColour = brandColours[0];
      sizes = Array.isArray(firstColour.sizes) ? [...new Set(firstColour.sizes.map((s) => s.size).filter(Boolean))] : [];
      material = firstColour.material || "";
      weight = firstColour.weight || "";

      // Prefer image URLs already stored from the full PenCarrie catalog
      // import (functions/api/pencarrie-import.js) - those come directly
      // from PenCarrie's own trade export, already resolved, no guessing.
      // Only fall back to the old CDN-filename-guessing/HEAD-check dance
      // for catalog rows that predate that import (or a code the import
      // hasn't covered yet).
      const dbColourRows = await db.prepare(
        "SELECT DISTINCT colour, colour_code, image_url FROM products WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL AND image_url IS NOT NULL AND image_url <> ''"
      ).bind(code).all();

      if (dbColourRows.results && dbColourRows.results.length) {
        IMG_BASE = "";
        colours = dbColourRows.results.map((r) => ({ name: r.colour, code: r.colour_code || "", file: r.image_url, resolved: true }));
        resolvedColours = colours;
      } else {
        IMG_BASE = `https://www.fullcollection.com/storage/phoenix/2026/Phoenix%20All%20Images/${encodeURIComponent(brand)}/Product%20Images/${code}/ProductCarouselMain/`;

        // Resolve each colour's real image filename - HEAD-checked against
        // the actual CDN rather than assumed, since the suffix isn't always
        // "FRONT.jpg" (some are "FRONT 1.jpg" - see RX151's own template).
        colours = [];
        for (const bc of brandColours) {
          const colourName = bc.name;
          const colourCode = bc.code;
          if (!colourName || !colourCode) continue;

          const candidates = [
            `${code}%20${colourCode}%20FRONT.jpg`,
            `${code}%20${colourCode}%20FRONT%201.jpg`,
          ];
          let resolvedFile = null;
          for (const candidate of candidates) {
            try {
              const headRes = await fetch(IMG_BASE + candidate, { method: "HEAD" });
              if (headRes.ok) { resolvedFile = candidate; break; }
            } catch {
              // try the next candidate
            }
          }
          colours.push({ name: colourName, code: colourCode, file: resolvedFile, resolved: !!resolvedFile });
        }

        resolvedColours = colours.filter((c) => c.resolved);
        if (!resolvedColours.length) {
          return json({ error: `Could not resolve a working image for any colour of ${code} - PenCarrie's CDN layout may not match the expected pattern` }, 502);
        }
      }
      mainColour = resolvedColours[0];
      mainImageUrl = IMG_BASE + mainColour.file;
    }

    const description = descriptionOverride ||
      "Price includes embroidery or DTF print to front. If we don't already have your logo on file, a £15 set-up fee applies — we'll confirm with you directly if needed.";

    if (dryRun) {
      return json({
        success: true,
        dryRun: true,
        code,
        name,
        brand,
        price,
        description,
        collection: collectionPath,
        collection_label: COLLECTIONS[collectionPath],
        main_image_url: mainImageUrl,
        material,
        weight,
        sizes,
        colours,
        unresolved_colours: colours.filter((c) => !c.resolved).map((c) => c.name),
        product_repo_path: productRepoPath,
      });
    }

    // 5. Build the three files. Structure mirrors every hand-built page on
    // the site (see products/rx151.html) so a newly-published product looks
    // and behaves identically to one added by hand.
    const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const navLinks = Object.entries(COLLECTIONS)
      .map(([path, label]) => `    <a href="../${path}">${label.replace(" & ", " &amp; ")}</a>`)
      .join("\n");

    const sizeOptions = sizes.length
      ? sizes.map((s, i) => `        <option${i === 0 ? " selected" : ""}>${escapeHtml(s)}</option>`).join("\n")
      : `        <option selected>One Size</option>`;

    const statRow = (material || weight)
      ? `    <div class="stat-row">\n${material ? `      <div><strong>Material</strong>${escapeHtml(material)}</div>\n` : ""}${weight ? `      <div><strong>Weight</strong>${escapeHtml(weight)}</div>\n` : ""}    </div>\n\n`
      : "";

    const specsBlock = specsLines.length
      ? `    <ul class="specs">\n${specsLines.map((s) => `      <li>${escapeHtml(s)}.</li>`).join("\n")}\n    </ul>\n\n`
      : "";

    const coloursJs = resolvedColours
      .map((c) => `    { name: ${JSON.stringify(c.name)}, code: ${JSON.stringify(c.code)}, file: ${JSON.stringify(c.file)} }`)
      .join(",\n");

    const productHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://www.fullcollection.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..700,0..100,0..1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>${escapeHtml(name)} ${code} – Crystal Custom Embroidery of Raunds</title>
<link rel="canonical" href="${STORE_BASE}/${productRepoPath}">
<meta property="og:site_name" content="Crystal Custom Embroidery of Raunds">
<meta property="og:type" content="website">
<link rel="stylesheet" href="../assets/style.css?v=5">
<script type="application/ld+json">
{
    "@context":  "https://schema.org/",
    "@type":  "Product",
    "name":  ${JSON.stringify(name)},
    "image":  ${JSON.stringify(mainImageUrl)},
    "description":  ${JSON.stringify(description)},
    "sku":  ${JSON.stringify(code)},
    "offers":  {
                   "@type":  "Offer",
                   "url":  "${STORE_BASE}/${productRepoPath}",
                   "priceCurrency":  "GBP",
                   "price":  ${JSON.stringify(price)},
                   "availability":  "https://schema.org/InStock",
                   "shippingDetails":  {
                                           "@type":  "OfferShippingDetails",
                                           "shippingRate":  {
                                                                "currency":  "GBP",
                                                                "value":  "9.99",
                                                                "@type":  "MonetaryAmount"
                                                            },
                                           "shippingDestination":  {
                                                                       "@type":  "DefinedRegion",
                                                                       "addressCountry":  "GB"
                                                                   },
                                           "deliveryTime":  {
                                                                "@type":  "ShippingDeliveryTime",
                                                                "handlingTime":  {
                                                                                     "maxValue":  7,
                                                                                     "minValue":  5,
                                                                                     "@type":  "QuantitativeValue",
                                                                                     "unitCode":  "d"
                                                                                 },
                                                                "transitTime":  {
                                                                                    "maxValue":  3,
                                                                                    "minValue":  1,
                                                                                    "@type":  "QuantitativeValue",
                                                                                    "unitCode":  "d"
                                                                                }
                                                            }
                                       },
                   "hasMerchantReturnPolicy":  {
                                                   "returnFees":  "https://schema.org/ReturnShippingFees",
                                                   "applicableCountry":  "GB",
                                                   "merchantReturnDays":  14,
                                                   "returnPolicyCategory":  "https://schema.org/MerchantReturnFiniteReturnWindow",
                                                   "@type":  "MerchantReturnPolicy",
                                                   "returnMethod":  "https://schema.org/ReturnByMail"
                                               }
               }
}
</script>
</head>
<body>
<div class="announcement-bar" id="announcement-bar">Embroidery, printing &amp; digitising — made in Raunds, Northamptonshire</div>


<header class="site-header">
  <a href="../index.html" class="logo">Crystal Custom Embroidery<small>Raunds · Northamptonshire</small></a>
  <nav class="main-nav">
${navLinks}
    <a href="../faq.html">FAQ</a>
  </nav>
  <a href="../cart.html" class="cart-icon" aria-label="View cart">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
    <span id="cart-count" class="cart-badge">0</span>
  </a>
</header>

<div class="breadcrumb"><a href="../index.html">Home</a> / <a href="../${collectionPath}">${COLLECTIONS[collectionPath].replace(" & ", " &amp; ")}</a> / ${code}</div>

<div class="product-page">
  <div class="product-image">
    <img id="product-photo" src="${mainImageUrl}" alt="${escapeHtml(name)}">
  </div>

  <div class="product-details">
    <h1>${escapeHtml(name)}</h1>
    <div class="code">${code} — <span id="colour-name">${escapeHtml(mainColour.name)}</span></div>
    <div class="price">£${price}</div>
    <p style="color:#6b6459; font-size:0.9rem;">${escapeHtml(description)}</p>

    <div class="colour-swatches" id="swatches"></div>

    <div class="size-field">
      <label for="size-select">Size</label>
      <select id="size-select">
${sizeOptions}
      </select>
    </div>

    <div class="size-field">
      <label for="qty-input">Quantity</label>
      <input type="number" id="qty-input" min="1" value="1">
    </div>

${statRow}${specsBlock}    <div class="upload-box">
      <p>Upload your logo or design so we know what we're working with before we chat.</p>
      <p style="font-size:0.8rem; color:#6b6459; margin-top:-0.5rem;">Accepted: JPG, PNG, or PDF, up to 15MB.</p>
      <button id="upload-btn" type="button">Upload your design</button>
      <div class="upload-status" id="upload-status"></div>
    </div>

    <p style="font-size:0.85rem; color:#6b6459; margin-bottom:0.75rem;">Add items from any product page, then send the whole list to us on WhatsApp for a quote — we'll confirm final pricing, sizes and payment with you directly.</p>

    <button class="add-to-cart-btn" type="button" onclick="addCurrentSelectionToCart('cart-status')">Add to Cart</button>
    <div class="upload-status" id="cart-status"></div>

    <a class="whatsapp-btn" id="whatsapp-cta" href="#" target="_blank" rel="noopener">Find Out More on WhatsApp</a>
  </div>
</div>

<footer class="site-footer">
  <div class="shell">
    <div class="footer-grid">
      <div class="footer-brand">
        <h3>Crystal Custom Embroidery</h3>
        <p>Family-run embroidery, printing and digitising in Raunds, Northamptonshire. Every order is proofed before production and finished in-store.</p>
      </div>
      <div class="footer-col">
        <h4>Shop</h4>
        <ul>
${Object.entries(COLLECTIONS).map(([path, label]) => `          <li><a href="../${path}">${label.replace(" & ", " &amp; ")}</a></li>`).join("\n")}
        </ul>
      </div>
      <div class="footer-col">
        <h4>Visit</h4>
        <ul>
          <li>26 Grove St, Raunds</li>
          <li>Wellingborough NN9 6DS</li>
          <li><a href="https://www.google.com/maps/dir/?api=1&amp;destination=26+Grove+St+Raunds+Wellingborough+NN9+6DS" target="_blank" rel="noopener">Get directions</a></li>
          <li><a href="https://wa.me/447530576197" target="_blank" rel="noopener">WhatsApp 07530 576197</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Help</h4>
        <ul>
          <li><a href="../faq.html">Frequently asked questions</a></li>
          <li><a href="../shipping-policy.html">Shipping</a></li>
          <li><a href="../refund-policy.html">Returns &amp; refunds</a></li>
          <li><a href="../cart.html">Your cart</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; 2026 Crystal Custom Embroidery of Raunds. All work carried out in-store.</span>
      <div class="legal-links">
        <a href="../privacy-policy.html">Privacy</a>
        <a href="../terms-of-service.html">Terms</a>
        <a href="../shipping-policy.html">Shipping</a>
        <a href="../refund-policy.html">Refunds</a>
        <a href="../cookie-policy.html">Cookies</a>
      </div>
    </div>
  </div>
</footer>

<script src="../assets/main.js?v=8"></script>
<script>
  const colours = [
${coloursJs}
  ];

  const IMG_BASE = ${JSON.stringify(IMG_BASE)};

  const swatchContainer = document.getElementById("swatches");
  const photo = document.getElementById("product-photo");
  const colourName = document.getElementById("colour-name");
  const whatsappCta = document.getElementById("whatsapp-cta");

  let currentColour = ${JSON.stringify(mainColour.name)};
  let pendingDesign = null;

  function imgFor(c) {
    return IMG_BASE + c.file;
  }

  function buildMsg(imageUrl) {
    let msg = \`Hi, I'd like to enquire about the ${escapeHtml(name).replace(/`/g, "\\`")} (${code}). Colour: \${currentColour}, Size: \${sizeSelect.value}.\`;
    if (imageUrl) {
      msg += \` Here's my design: \${imageUrl}\`;
    }
    return msg;
  }

  function updateWhatsappLink() {
    whatsappCta.href = whatsappLink(buildMsg(null));
  }

  function selectColour(c, btn) {
    photo.src = imgFor(c);
    colourName.textContent = c.name;
    currentColour = c.name;
    document.querySelectorAll(".swatch").forEach(s => s.classList.remove("selected"));
    btn.classList.add("selected");
    updateWhatsappLink();
  }

  colours.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.className = "swatch" + (i === 0 ? " selected" : "");
    btn.style.backgroundImage = \`url(\${imgFor(c)})\`;
    btn.title = c.name;
    btn.type = "button";
    btn.addEventListener("click", () => selectColour(c, btn));
    swatchContainer.appendChild(btn);
  });

  const sizeSelect = document.getElementById("size-select");
  sizeSelect.addEventListener("change", updateWhatsappLink);

  updateWhatsappLink();
  initDeferredUpload("upload-btn", "upload-status", "customer-designs/${code.toLowerCase()}", (info) => {
    pendingDesign = info;
    setPendingImageForCart(info);
    updateWhatsappLink();
  });
  initWhatsappCta("whatsapp-cta", buildMsg, () => pendingDesign);
</script>

</body>
</html>
`;

    const cardImagesJson = JSON.stringify(resolvedColours.map((c) => c.file));
    const cardHtml = `    <a class="product-card"
       href="../${productRepoPath}"
       data-images='${cardImagesJson}'
       data-base="${IMG_BASE}">
      <img src="${mainImageUrl}" alt="${escapeHtml(name)}" loading="lazy">
      <div class="label">${escapeHtml(name)} (${code})</div>
      <div class="price">£${price} — ${resolvedColours.length} colour${resolvedColours.length === 1 ? "" : "s"}</div>
    </a>
`;

    const sitemapEntry = `  <url>
    <loc>${STORE_BASE}/${productRepoPath}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
`;

    // 6. Commit all three files via the GitHub Contents API.
    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_LIVE_REPO_TOKEN}`,
      "User-Agent": "crystal-portal-add-product",
      Accept: "application/vnd.github+json",
    };

    const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

    // 6a. New product page - straightforward create, no existing sha.
    const createRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${productRepoPath}`, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Add ${name} (${code}) product page (via Crystal Portal)`,
        content: b64(productHtml),
      }),
    });
    if (!createRes.ok) {
      return json({ error: `Could not create product page: ${createRes.status} ${await createRes.text()}` }, 502);
    }

    // 6b. Insert the new card into the chosen collection page - right after
    // the LAST card inside <div class="product-grid">, found by scoping the
    // search to start AFTER that opening tag and taking the FIRST
    // "</a>\n  </div>" from there (the grid's own closing div, 2-space
    // indented, one level up from card content). Matching the last
    // occurrence in the whole document was wrong - it can land inside the
    // footer instead (its "legal-links" div closes with the same
    // "</a>\n      </div>" shape as the grid does), which is exactly what
    // happened on a live test run against headwear-category.html before
    // this fix - caught and corrected immediately, see admin's own history.
    const collectionApiUrl = `https://api.github.com/repos/${REPO}/contents/${collectionPath}`;
    const collectionGetRes = await fetch(collectionApiUrl, { headers: ghHeaders });
    if (!collectionGetRes.ok) {
      return json({ error: `Could not read collection page: ${collectionGetRes.status}` }, 502);
    }
    const collectionFile = await collectionGetRes.json();
    const collectionHtml = new TextDecoder().decode(
      Uint8Array.from(atob(collectionFile.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))
    );

    const gridOpenIdx = collectionHtml.indexOf('<div class="product-grid">');
    if (gridOpenIdx === -1) {
      return json({ error: "Could not find the product grid on the collection page" }, 502);
    }
    const closeMatch = collectionHtml.slice(gridOpenIdx).match(/<\/a>\r?\n(\s*)<\/div>/);
    if (!closeMatch) {
      return json({ error: "Could not find the product grid's closing tag on the collection page" }, 502);
    }
    const insertAt = gridOpenIdx + closeMatch.index + "</a>".length;
    const updatedCollectionHtml =
      collectionHtml.slice(0, insertAt) + "\n" + cardHtml.trimEnd() + collectionHtml.slice(insertAt);

    const collectionPutRes = await fetch(collectionApiUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Add ${code} card to ${COLLECTIONS[collectionPath]} (via Crystal Portal)`,
        content: b64(updatedCollectionHtml),
        sha: collectionFile.sha,
      }),
    });
    if (!collectionPutRes.ok) {
      return json({ error: `Product page created, but could not add collection card: ${collectionPutRes.status}` }, 502);
    }

    // 6c. sitemap.xml - insert before </urlset>.
    const sitemapApiUrl = `https://api.github.com/repos/${REPO}/contents/sitemap.xml`;
    const sitemapGetRes = await fetch(sitemapApiUrl, { headers: ghHeaders });
    if (sitemapGetRes.ok) {
      const sitemapFile = await sitemapGetRes.json();
      const sitemapXml = new TextDecoder().decode(
        Uint8Array.from(atob(sitemapFile.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))
      );
      const closeIdx = sitemapXml.lastIndexOf("</urlset>");
      if (closeIdx !== -1) {
        const updatedSitemap = sitemapXml.slice(0, closeIdx) + sitemapEntry + sitemapXml.slice(closeIdx);
        await fetch(sitemapApiUrl, {
          method: "PUT",
          headers: { ...ghHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Add ${productRepoPath} to sitemap (via Crystal Portal)`,
            content: b64(updatedSitemap),
            sha: sitemapFile.sha,
          }),
        });
      }
      // sitemap failure isn't fatal - the page and collection card are
      // already live and reachable, sitemap only affects search indexing.
    }

    // 7. Mark on_website in the catalog now that the page is genuinely live.
    await db.prepare(
      "UPDATE products SET on_website = 1 WHERE supplier_code = ? AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL"
    ).bind(code).run();

    return json({
      success: true,
      dryRun: false,
      code,
      product_url: `${STORE_BASE}/${productRepoPath}`,
      colours_published: resolvedColours.length,
      colours_unresolved: colours.length - resolvedColours.length,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
