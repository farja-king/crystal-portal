// Per-product-code Uneek data lookup - deliberately NOT a full JSON.parse of
// /productdata/all's response, unlike uneek-sync.js. See functions/_lib/uneek.js
// for why (Cloudflare Worker CPU limit) and how (targeted substring scan,
// double-encoding unwrap). Used standalone here for testing/debugging, and
// by add-product-live.js for real when publishing a Uneek-branded product.
import { fetchUneekRawText, extractUneekVariants } from "../_lib/uneek.js";

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

  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return json({ error: "?code=<UNEEK product code> is required" }, 400);

  try {
    const text = await fetchUneekRawText(env);

    if (url.searchParams.get("debug") === "1") {
      const codeIdx = text.indexOf(`"ProductCode":"${code}"`);
      return json({
        length: text.length,
        contains_code: codeIdx !== -1,
        around_code: codeIdx === -1 ? null : text.slice(Math.max(0, codeIdx - 300), codeIdx + 300),
      });
    }

    const variants = extractUneekVariants(text, code);
    if (!variants.length) return json({ error: `No Uneek data found for code "${code}"` }, 404);

    return json({ success: true, code, variants });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
