// Read-only bulk access to the payments ledger (see the `payments` table
// created lazily in functions/api/orders.js) - the Dashboard needs every
// payment across every invoice to bucket revenue by each payment's own
// received_at date, not just one order at a time (that's what orders.js's
// existing `?payments_for=<order_id>` GET is for). Mirrors the `?all=1`
// pattern already used by orders.js/production-steps.js for the same
// "give me everything, the client filters by date range" reporting need.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  if (url.searchParams.get("all") !== "1") return json({ error: "Only ?all=1 is supported" }, 400);

  try {
    // payments is created lazily by orders.js - tolerate it not existing
    // yet on a fresh DB rather than erroring the whole Dashboard.
    const { results } = await db.prepare(
      "SELECT * FROM payments ORDER BY received_at ASC"
    ).all();
    return json(results);
  } catch {
    return json([]);
  }
}
