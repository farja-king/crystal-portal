// Read-only bulk access to the payments ledger (see the `payments` table
// created lazily in functions/api/orders.js) - the Dashboard needs every
// payment across every invoice to bucket revenue by each payment's own
// received_at date, not just one order at a time (that's what orders.js's
// existing `?payments_for=<order_id>` GET is for). Mirrors the `?all=1`
// pattern already used by orders.js/production-steps.js for the same
// "give me everything, the client filters by date range" reporting need.
//
// Also backs the Dashboard's "new payments" popup (?new=1 / mark_seen) -
// same seen_by_staff pattern as gang-sheet-uploads.js's "new DTF-Prep
// orders" popup, so a payment that lands while nobody's looking at the
// portal (a Square card payment, most of these) still gets surfaced
// instead of only ever showing up if someone happens to check.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  // payments is created lazily by orders.js - tolerate it not existing yet
  // on a fresh DB rather than erroring the whole Dashboard/popup. The
  // backfill only runs the instant this column is first added (the ALTER
  // succeeding is exactly that signal) - without it, every payment ever
  // recorded would default to seen_by_staff = 0 and all pop up as "new"
  // in one go the moment this deployed.
  try {
    await db.prepare(`ALTER TABLE payments ADD COLUMN seen_by_staff INTEGER DEFAULT 0`).run();
    await db.prepare(`UPDATE payments SET seen_by_staff = 1`).run();
  } catch {
    // table doesn't exist yet, or column already exists - either way, fine
  }

  if (request.method === "POST") {
    try {
      const data = await request.json();
      if (data.action === "mark_seen") {
        await db.prepare(
          "UPDATE payments SET seen_by_staff = 1 WHERE type = 'payment' AND seen_by_staff = 0"
        ).run();
        return json({ success: true });
      }
      return json({ error: "Unknown action" }, 400);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);

  // The popup's own lookup - real incoming money only (type = 'payment'),
  // never a refund (that's money going out, and firing "you've been paid!"
  // over one would be actively misleading). Joins back to orders for the
  // customer name/invoice number the popup message actually needs, same
  // as gang-sheet-uploads.js's count_new does for order_id.
  if (url.searchParams.get("new") === "1") {
    try {
      const { results } = await db.prepare(`
        SELECT p.id, p.order_id, p.amount, p.method, p.received_at,
               o.invoice_number, o.quote_number, o.customer_name
        FROM payments p LEFT JOIN orders o ON o.id = p.order_id
        WHERE p.type = 'payment' AND p.seen_by_staff = 0
        ORDER BY p.received_at ASC
      `).all();
      return json(results);
    } catch {
      return json([]);
    }
  }

  if (url.searchParams.get("all") !== "1") return json({ error: "Only ?all=1 is supported" }, 400);

  try {
    const { results } = await db.prepare(
      "SELECT * FROM payments ORDER BY received_at ASC"
    ).all();
    return json(results);
  } catch {
    return json([]);
  }
}
