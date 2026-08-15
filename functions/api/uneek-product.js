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

    // Temporary diagnostic - returns a raw slice of Uneek's actual response
    // instead of doing any extraction, so we can see its real shape rather
    // than guess. Remove once the extraction logic is confirmed working.
    if (url.searchParams.get("debug") === "1") {
      const codeIdx = text.indexOf(code);
      return json({
        length: text.length,
        contains_code: codeIdx !== -1,
        code_index: codeIdx,
        start: text.slice(0, 1500),
        around_code: codeIdx === -1 ? null : text.slice(Math.max(0, codeIdx - 500), codeIdx + 500),
      });
    }

    // Whitespace-tolerant - the API may return pretty-printed JSON (space
    // after ":", newline+indent after "{"), not minified, so exact
    // substring matching on '{"Company":' would silently match nothing.
    const objStarts = [];
    { const re = /\{\s*"Company"\s*:/g; let m; while ((m = re.exec(text))) objStarts.push(m.index); }

    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const markerRe = new RegExp(`"ProductCode"\\s*:\\s*"${escaped}"`, "g");
    const markerPositions = [];
    { let m; while ((m = markerRe.exec(text))) markerPositions.push(m.index); }

    const variants = [];
    for (const markerPos of markerPositions) {
      // Largest object-start position at or before this marker.
      let objStart = -1;
      for (const s of objStarts) { if (s <= markerPos) objStart = s; else break; }
      if (objStart === -1) continue;

      const nextObjStart = objStarts.find((s) => s > markerPos);
      let objText = nextObjStart === undefined ? text.slice(objStart) : text.slice(objStart, nextObjStart);
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
