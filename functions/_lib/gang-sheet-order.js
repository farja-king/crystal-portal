// Shared helper for turning a DTF-Prep customer's paid-for-or-approved gang
// sheet uploads into a real Crystal Portal order. Used by both:
//  - gang-sheet-checkout.js's credit-account branch (creates the order
//    immediately - there's no external payment step to wait on, the credit
//    approval itself IS the confirmation), and
//  - square-webhook.js's deferred-creation branch (creates the order for
//    the FIRST time only once Square confirms payment - see
//    gang_sheet_pending_checkouts in gang-sheet-checkout.js for why the
//    order doesn't exist yet at Payment-Link-creation time).
// Kept here rather than duplicated so both call sites build the same shape
// of order/line-items from the same gang_sheet_uploads rows.

export function buildDtfOrderItems(uploads) {
  return uploads.map((u) => {
    const qty = Math.max(1, parseInt(u.qty, 10) || 1);
    return {
      source: "customer_supplied",
      title: `DTF gang sheet - ${u.filename} (${Math.round(u.width_mm || 0)}×${Math.round(u.height_mm || 0)}mm)${qty > 1 ? ` ×${qty}` : ""}`,
      unit_price: Number(u.price || 0),
      qty,
    };
  });
}

// origin/authHeaders match the internal server-to-server call pattern every
// other file here already uses to reach /api/orders (see gang-sheet-
// checkout.js's own original comment on why - invoice numbering, totals,
// and pay_token minting all come from there for free).
export async function createDtfOrder({ origin, authHeaders, customer }, orderItems) {
  const createRes = await fetch(`${origin}/api/orders`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      doc_type: "invoice",
      customer_id: customer.id,
      customer_name: customer.name,
      customer_email: customer.email || "",
      items: orderItems,
      notes: "Created automatically from a DTF-Prep checkout.",
      source: "dtf-prep",
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok || !created.success) {
    throw new Error("Couldn't create the order");
  }
  return created.id;
}
