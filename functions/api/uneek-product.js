// Per-product-code Uneek data lookup - deliberately NOT a full JSON.parse of
// /productdata/all's response, unlike uneek-sync.js. That endpoint's response
// covers the whole catalog (thousands of SKU rows with full descriptions and
// several image URLs each), and parsing/looping over all of it in a single
// Workers invocation blew Cloudflare's CPU-time limit (Error 1102 - "Worker
// exceeded resource limits"), even though the code itself was correct. Since
// this only ever needs ONE product code's variant rows (called from "Publish
// to website" to pull real images/description for a single garment), it does
// a raw substring scan for that code's objects instead of parsing everything -
// every object in the response starts with `{"Company":` (confirmed from a
// real response), so that marks object boundaries without needing a full JSON
// tokenizer. This keeps CPU cost close to a handful of native String.indexOf
// calls regardless of how big the overall catalog response is.
export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  if (!env.UNEEK_EMAIL || !env.UNEEK_PASSWORD) {
    return json({ error: "UNEEK_EMAIL / UNEEK_PASSWORD not configured as Cloudflare secrets" }, 500);
  }

  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return json({ error: "?code=<UNEEK product code> is required" }, 400);

  try {
    const customerNo = env.UNEEK_CUSTOMER_NO || "";
    const apiUrl = "https://api.uneekclothing.com/productdata/all" + (customerNo ? `?CustomerNo=${encodeURIComponent(customerNo)}` : "");
    const auth = btoa(`${env.UNEEK_EMAIL}:${env.UNEEK_PASSWORD}`);

    const uneekRes = await fetch(apiUrl, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!uneekRes.ok) return json({ error: `Uneek API returned HTTP ${uneekRes.status}` }, 502);

    const text = await uneekRes.text();
    const OBJ_START = '{"Company":';
    const marker = `"ProductCode":"${code}"`;

    const variants = [];
    let searchFrom = 0;
    while (true) {
      const markerPos = text.indexOf(marker, searchFrom);
      if (markerPos === -1) break;
      searchFrom = markerPos + marker.length;

      const objStart = text.lastIndexOf(OBJ_START, markerPos);
      if (objStart === -1) continue;

      const nextObjStart = text.indexOf(OBJ_START, objStart + OBJ_START.length);
      let objText = nextObjStart === -1 ? text.slice(objStart) : text.slice(objStart, nextObjStart);
      objText = objText.trim();
      // Trailing separator before the next object (",") or the closing
      // array bracket (for the last object) - strip down to the object's
      // own final "}" so it's valid JSON on its own.
      const lastBrace = objText.lastIndexOf("}");
      if (lastBrace === -1) continue;
      objText = objText.slice(0, lastBrace + 1);

      try {
        variants.push(JSON.parse(objText));
      } catch {
        // malformed slice (shouldn't happen given the API's consistent
        // formatting) - skip rather than fail the whole lookup
      }
    }

    if (!variants.length) return json({ error: `No Uneek data found for code "${code}"` }, 404);

    return json({ success: true, code, variants });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
