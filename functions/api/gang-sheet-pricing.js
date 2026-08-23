// Lets DTF-Prep ask "what will this specific customer actually be charged?"
// at any point while they're logged in (not just at checkout) - a trade
// customer's flat sheet price (see customers.js/gang-sheet-upload.js) only
// changes the price they'd see if the builder bothers to ask, and the
// builder can't know a customer is logged in until it checks their stored
// session token against this. Same customer-session-bearer-token auth as
// gang-sheet-upload.js; no staff/portal-password path, this is entirely
// customer-facing.
import { verifyCustomerToken } from "../_lib/customer-token.js";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!db) return json({ error: "Database isn't set up yet" }, 500);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  try {
    const auth = request.headers.get("Authorization") || "";
    const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    if (!bearerToken) return json({ error: "Not authenticated" }, 401);

    const cfg = await db.prepare("SELECT customer_token_secret FROM auth_config WHERE id = 'default'").first();
    if (!cfg || !cfg.customer_token_secret) return json({ error: "Not authenticated" }, 401);

    const payload = await verifyCustomerToken(bearerToken, cfg.customer_token_secret);
    if (!payload || payload.purpose !== "gang-sheet-session" || !payload.customer_id) {
      return json({ error: "Your session has expired - please sign in again." }, 401);
    }

    const customer = await db.prepare("SELECT dtf_flat_sheet_price FROM customers WHERE id = ?").bind(payload.customer_id).first();
    return json({
      success: true,
      flat_sheet_price: customer && customer.dtf_flat_sheet_price != null ? Number(customer.dtf_flat_sheet_price) : null,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
