// DTF-Prep's own "Account" page - lets a signed-in customer complete their
// profile (name + delivery address, which promotes them from 'guest' to
// 'registered' - see gang-sheet-upload.js, where 'registered' waives the
// upscale charge) and apply for a credit account (approved/rejected by
// staff in admin.html - see gang-sheet-admin.js).
//
// Auth: identical bearer-token check to gang-sheet-upload.js/gang-sheet-
// checkout.js - reachable only with a valid gang-sheet-session token, and
// exempted from the staff login gate the same way (see functions/_middleware.js).
import { verifyCustomerToken } from "../_lib/customer-token.js";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!db) return json({ error: "Database isn't set up yet" }, 500);

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
    const customerId = payload.customer_id;

    if (request.method === "GET") {
      const customer = await db.prepare(`
        SELECT name, email, phone, address_1, address_2, city, county, postcode,
               dtf_account_tier, dtf_credit_status, dtf_credit_limit
        FROM customers WHERE id = ? AND deleted_at IS NULL
      `).bind(customerId).first();
      if (!customer) return json({ error: "That account no longer exists." }, 404);
      return json(customer);
    }

    if (request.method === "POST") {
      const data = await request.json();

      if (data.action === "complete_profile") {
        const name = String(data.name || "").trim().slice(0, 200);
        const address1 = String(data.address_1 || "").trim().slice(0, 200);
        const address2 = String(data.address_2 || "").trim().slice(0, 200);
        const city = String(data.city || "").trim().slice(0, 120);
        const county = String(data.county || "").trim().slice(0, 120);
        const postcode = String(data.postcode || "").trim().slice(0, 20);
        const phone = String(data.phone || "").trim().slice(0, 40);

        if (!name || !postcode) return json({ error: "Please enter at least your name and postcode." }, 400);

        await db.prepare(`
          UPDATE customers
          SET name = ?, address_1 = ?, address_2 = ?, city = ?, county = ?, postcode = ?, phone = ?,
              dtf_account_tier = CASE WHEN dtf_account_tier IS NULL OR dtf_account_tier = 'guest' THEN 'registered' ELSE dtf_account_tier END
          WHERE id = ?
        `).bind(name, address1, address2, city, county, postcode, phone, customerId).run();

        return json({ success: true });
      }

      if (data.action === "apply_credit") {
        const customer = await db.prepare("SELECT dtf_account_tier, dtf_credit_status FROM customers WHERE id = ?").bind(customerId).first();
        if (!customer || customer.dtf_account_tier !== "registered") {
          return json({ error: "Please complete your account (name and address) before applying for credit." }, 400);
        }
        if (customer.dtf_credit_status === "pending" || customer.dtf_credit_status === "approved") {
          return json({ error: "You already have a credit application on file." }, 409);
        }

        const notes = String(data.notes || "").trim().slice(0, 2000);
        await db.prepare(
          "UPDATE customers SET dtf_credit_status = 'pending', dtf_credit_notes = ? WHERE id = ?"
        ).bind(notes, customerId).run();

        return json({ success: true });
      }

      return json({ error: "Unknown action" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
