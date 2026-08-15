// PROOF-OF-MECHANISM ONLY - writes a price to the throwaway test repo
// farja-king/embroidery-portal-test via the GitHub Contents API, never the
// real embroidery-portal site. This is the write-back counterpart to
// sync-prices.js's read-only scrape: instead of scraping HTML off the live
// site, it edits one known test product page's embedded JSON-LD price and
// display price, and commits the change straight to that repo's main
// branch (GitHub Pages then rebuilds automatically). Once Martin's happy
// this mechanism works, the real feature targets embroidery-portal instead
// - deliberately paused until then, see the session-4 handoff.
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
  if (!env.GITHUB_TEST_REPO_TOKEN) return json({ error: "GITHUB_TEST_REPO_TOKEN not configured" }, 500);

  const REPO = "farja-king/embroidery-portal-test";
  const PATH = "products/test-product.html";
  const API_BASE = `https://api.github.com/repos/${REPO}/contents/${PATH}`;

  try {
    const { price } = await request.json();
    const newPrice = Number(price);
    if (!isFinite(newPrice) || newPrice < 0) return json({ error: "Invalid price" }, 400);
    const priceStr = newPrice.toFixed(2);

    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_TEST_REPO_TOKEN}`,
      "User-Agent": "crystal-portal-price-writeback-test",
      Accept: "application/vnd.github+json",
    };

    const getRes = await fetch(API_BASE, { headers: ghHeaders });
    if (!getRes.ok) return json({ error: `Could not read test file: ${getRes.status} ${await getRes.text()}` }, 502);
    const file = await getRes.json();

    const currentHtml = new TextDecoder().decode(
      Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0))
    );

    const updatedHtml = currentHtml
      .replace(/"price":\s*"[\d.]+"/, `"price":  "${priceStr}"`)
      .replace(/<div class="price">£[\d.]+<\/div>/, `<div class="price">£${priceStr}</div>`);

    if (updatedHtml === currentHtml) return json({ error: "Price pattern not found in test file - nothing changed" }, 500);

    const newContentB64 = btoa(String.fromCharCode(...new TextEncoder().encode(updatedHtml)));

    const putRes = await fetch(API_BASE, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Test price write-back: TESTSKU001 -> £${priceStr}`,
        content: newContentB64,
        sha: file.sha,
      }),
    });

    if (!putRes.ok) return json({ error: `GitHub commit failed: ${putRes.status} ${await putRes.text()}` }, 502);
    const putBody = await putRes.json();

    return json({
      success: true,
      price: priceStr,
      commit_sha: putBody.commit?.sha,
      commit_url: putBody.commit?.html_url,
      live_page: "https://farja-king.github.io/embroidery-portal-test/products/test-product.html",
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
