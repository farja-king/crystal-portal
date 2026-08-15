// Shared helpers for talking to Uneek's live product-data API. Used by
// uneek-product.js (single product code lookup, CPU-cheap) and
// add-product-live.js (publish-to-website, when a product's supplier is
// UNEEK rather than PenCarrie).
//
// Uneek's API double-encodes its response: the HTTP body is itself a JSON
// string literal containing the real (already-minified) JSON array as
// escaped text - e.g. `"[{\"Company\":\"Uneek Clothing\",...}]"` rather than
// a bare array (confirmed against a real response). fetchUneekRawText()
// unwraps that outer layer with one JSON.parse() so callers get the real
// JSON text to work with.
export async function fetchUneekRawText(env) {
  if (!env.UNEEK_EMAIL || !env.UNEEK_PASSWORD) {
    throw new Error("UNEEK_EMAIL / UNEEK_PASSWORD not configured as Cloudflare secrets");
  }
  const customerNo = env.UNEEK_CUSTOMER_NO || "";
  const apiUrl = "https://api.uneekclothing.com/productdata/all" + (customerNo ? `?CustomerNo=${encodeURIComponent(customerNo)}` : "");
  const auth = btoa(`${env.UNEEK_EMAIL}:${env.UNEEK_PASSWORD}`);

  const res = await fetch(apiUrl, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Uneek API returned HTTP ${res.status}`);

  const rawText = await res.text();
  try {
    const parsedOnce = JSON.parse(rawText);
    if (typeof parsedOnce === "string") return parsedOnce; // unwrap the double-encoding
  } catch {
    // rawText wasn't valid JSON on its own - use as-is (already the real array text)
  }
  return rawText;
}

// Extracts just one product code's variant rows from the already-unwrapped
// JSON text via targeted substring search rather than a full JSON.parse -
// keeps CPU cost tiny regardless of how big the overall catalog response is
// (parsing the whole thing in one request hit Cloudflare's Worker CPU limit
// on this account's plan - see uneek-sync.js). Every object in the real
// array starts with `{"Company":` (confirmed against a real response),
// which marks object boundaries without needing a full JSON tokenizer.
export function extractUneekVariants(text, code) {
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
  return variants;
}

export async function fetchUneekProductVariants(env, code) {
  const text = await fetchUneekRawText(env);
  return extractUneekVariants(text, code.toUpperCase());
}
