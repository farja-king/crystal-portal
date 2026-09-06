// Staff-only back office for DTF-Prep accounts - the "DTF Builder" sub-tab
// under Customers in admin.html. No auth code in this file itself: every
// path here falls through functions/_middleware.js's normal staff login
// gate unchanged (same as quote-requests.js's GET/PUT), since this is
// entirely a staff-facing endpoint with no public/customer path at all.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!db) return json({ error: "Database isn't set up yet" }, 500);

  try {
    if (request.method === "GET") {
      const view = new URL(request.url).searchParams.get("view");

      // Every DTF-Prep customer, whether they signed up themselves via the
      // magic link or were manually granted access below - anyone with a
      // non-null tier is "in" the DTF Builder world, kept out of the Store
      // customers list by admin.html's own render filter (never at the
      // query/data level - see the Store customers list, unchanged).
      if (view === "customers") {
        const { results } = await db.prepare(`
          SELECT id, name, email, phone, dtf_account_tier, dtf_credit_status, dtf_credit_limit, dtf_credit_notes, created_at
          FROM customers WHERE dtf_account_tier IS NOT NULL AND deleted_at IS NULL
          ORDER BY created_at DESC
        `).all();
        return json(results);
      }

      if (view === "orders") {
        const { results } = await db.prepare(`
          SELECT id, invoice_number, customer_id, customer_name, total, amount_paid, paid_status, created_at
          FROM orders WHERE source = 'dtf-prep'
          ORDER BY created_at DESC
        `).all();
        return json(results);
      }

      if (view === "credit") {
        const { results } = await db.prepare(`
          SELECT id, name, email, dtf_credit_status, dtf_credit_limit, dtf_credit_notes
          FROM customers WHERE dtf_credit_status IS NOT NULL AND deleted_at IS NULL
          ORDER BY created_at DESC
        `).all();
        return json(results);
      }

      return json({ error: "Unknown view" }, 400);
    }

    if (request.method === "PUT") {
      const data = await request.json();
      if (!data.customer_id) return json({ error: "customer_id is required" }, 400);

      // Pulls an existing, ordinary store customer into the DTF-Prep world
      // without creating a duplicate row - the next time they sign in via
      // DTF-Prep's magic link, gang-sheet-auth.js's find-by-email resolves
      // straight to this same customer id.
      if (data.action === "grant_access") {
        const tier = ["guest", "registered"].includes(data.tier) ? data.tier : "guest";
        await db.prepare("UPDATE customers SET dtf_account_tier = ? WHERE id = ?").bind(tier, data.customer_id).run();
        return json({ success: true });
      }

      if (data.action === "credit_decision") {
        const status = ["approved", "rejected"].includes(data.status) ? data.status : null;
        if (!status) return json({ error: "Invalid status" }, 400);
        const limit = status === "approved" ? Number(data.credit_limit) || 0 : null;
        await db.prepare(
          "UPDATE customers SET dtf_credit_status = ?, dtf_credit_limit = ? WHERE id = ?"
        ).bind(status, limit, data.customer_id).run();
        return json({ success: true });
      }

      return json({ error: "Unknown action" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
