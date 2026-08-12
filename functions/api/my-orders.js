// Customer-facing "My Orders" self-service view - a login-free page (see
// my-orders.html) showing everything ever emailed to a customer, so they're
// not entirely dependent on digging through old email threads for their own
// order history and current balance.
//
// One unguessable token per CUSTOMER (customers.portal_token, generated
// lazily by send-email.js the first time anything's emailed to them) -
// unlike accept-quote.js/pay-by-card.js, which are scoped to one order via
// their own per-order token. Read-only: there's no decision to record here,
// so this is a plain public GET, no POST branch at all.
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

  try {
    // Guard against a cold deploy hitting this file before customers.js has
    // - same "already exists" tolerance as everywhere else.
    try {
      await db.prepare(`ALTER TABLE customers ADD COLUMN portal_token TEXT`).run();
    } catch {
      // already exists
    }

    const token = new URL(request.url).searchParams.get("token");
    if (!token) return json({ error: "Missing token" }, 400);

    const customer = await db.prepare(
      "SELECT id, name FROM customers WHERE portal_token = ? AND deleted_at IS NULL"
    ).bind(token).first();
    if (!customer) return json({ error: "This link isn't valid." }, 404);

    // Only what's actually been sent to them - a draft still being built in
    // the portal has no business showing up here, even though it already
    // carries this customer's id. email_sent_at is exactly the same
    // "has this genuinely gone out" signal send-email.js itself tracks.
    const { results: orders } = await db.prepare(`
      SELECT id, doc_type, quote_number, invoice_number, status, paid_status,
             total, amount_paid, deposit_pct, deposit_amount, created_at, due_date,
             accept_token, pay_token
      FROM orders
      WHERE customer_id = ? AND email_sent_at IS NOT NULL AND email_sent_at <> ''
      ORDER BY created_at DESC
    `).bind(customer.id).all();

    // Balance summary across every unpaid/partial invoice - the same figure
    // Aged Debtors computes per-customer, just scoped to this one customer
    // and always current rather than bucketed by age.
    let totalOwed = 0;
    const rows = orders.map((o) => {
      const balance = o.doc_type === "invoice" ? Number(o.total) - Number(o.amount_paid || 0) : 0;
      if (o.doc_type === "invoice" && o.paid_status !== "paid") totalOwed += balance;
      const depositDue = o.doc_type === "quote"
        ? Math.min(o.total, o.total * (Number(o.deposit_pct || 0) / 100) + Number(o.deposit_amount || 0))
        : 0;
      return {
        id: o.id, doc_type: o.doc_type,
        number: o.doc_type === "invoice" ? o.invoice_number : o.quote_number,
        status: o.status, paid_status: o.paid_status,
        total: o.total, balance, created_at: o.created_at, due_date: o.due_date,
        // Only handed back when it's actually still actionable - an already
        // decided quote or fully-paid invoice has nothing to offer a button
        // for, so the page just shows its status instead.
        accept_token: (o.doc_type === "quote" && o.status !== "approved" && o.status !== "declined") ? o.accept_token : null,
        pay_token: (o.doc_type === "invoice" && o.paid_status !== "paid") ? o.pay_token : null,
        deposit_due: depositDue > 0 && depositDue < o.total ? depositDue : 0,
      };
    });

    return json({ customer_name: customer.name, total_owed: totalOwed, orders: rows });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
