// Garment quotes and invoices built in the back office - separate from the
// DTF length-based quotes in quotes.js, which stays untouched. A single row
// covers both a quote and the invoice it becomes: doc_type flips from
// 'quote' to 'invoice' on conversion rather than duplicating the row, so the
// original quote_number is never lost.
//
// Martin isn't VAT registered, so there is deliberately no VAT anywhere in
// this file - total is subtotal minus discount, full stop. Don't add a VAT
// column here by analogy with products.js; that VAT is what Martin pays
// suppliers (a cost), not something charged to his customers.
import { logOrderEvent, ensureOrderEventsTable } from "../_lib/order-events.js";
import { deductStockForOrder, restoreStockForOrder } from "../_lib/stock-deduct.js";
import { markInvoicePaidStepDone } from "../_lib/production-invoice-paid.js";

// A new invoice restarts that customer's reorder-reminder clock - see
// functions/api/reorder-reminders.js, which times its ~11-month nudge off
// reorder_reminder_sent_at being NULL. Without this reset, a customer who
// reorders right after getting nudged would never be eligible for the
// *next* year's nudge - the flag would stay permanently set from the first
// one. Best-effort: never let this block the invoice action it's attached to.
async function resetReorderReminder(db, customerId) {
  if (!customerId) return;
  try {
    await db.prepare("ALTER TABLE customers ADD COLUMN reorder_reminder_sent_at TEXT").run();
  } catch {
    // already exists
  }
  try {
    await db.prepare("UPDATE customers SET reorder_reminder_sent_at = NULL WHERE id = ?").bind(customerId).run();
  } catch {
    // never let this break the invoice action it's attached to
  }
}

// Sent when Martin chooses "Cancel & email customer" on the Cancel Invoice
// popup - a plain, short notice, not the full itemised invoice template
// (there's nothing left to itemise, it's cancelled). Logged into email_log
// the same way as every other customer-facing send, so it shows up in the
// order's own Communication History rather than looking like nothing was
// ever sent about the cancellation.
async function sendCancellationEmail(db, env, origin, order) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "Email isn't set up yet - the RESEND_API_KEY secret is missing." };
  const to = (order.customer_email || "").trim();
  if (!to) return { sent: false, reason: "No email address on file for this customer" };

  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
  const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
  const subject = `Invoice ${order.invoice_number} cancelled`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
      <h1 style="margin:0 0 4px;font-size:22px;">Crystal Custom Embroidery</h1>
      <div style="color:#64748b;margin-bottom:20px;">Invoice ${escapeHtml(order.invoice_number)} - cancelled</div>
      <p>Hi ${escapeHtml(order.customer_name)},</p>
      <p>This is to let you know that invoice <strong>${escapeHtml(order.invoice_number)}</strong> (total £${Number(order.total || 0).toFixed(2)}) has been cancelled - no payment is required for it.</p>
      <p>If you think this was a mistake, or have any questions, just reply to this email or message us on WhatsApp.</p>
      <p style="margin-top:32px;color:#64748b;font-size:13px;">Thanks,<br>Crystal Custom Embroidery<br>
        <a href="https://wa.me/447530576197?text=Hi%2C%20I%20have%20a%20question%20about%20${encodeURIComponent(order.invoice_number || "")}." style="color:#4f46e5;">Message us on WhatsApp</a></p>
    </div>`;

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
    });
    if (!resendRes.ok) return { sent: false, reason: "Resend rejected the email" };
    const resendEmailId = await resendRes.json().then((r) => r.id).catch(() => null);

    try {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS email_log (
          id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sent_to TEXT NOT NULL, subject TEXT,
          sent_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      for (const col of ["resend_email_id TEXT", "delivery_status TEXT", "delivery_status_at TEXT", "delivery_detail TEXT", "body_html TEXT", "kind TEXT", "step_id TEXT"]) {
        try { await db.prepare(`ALTER TABLE email_log ADD COLUMN ${col}`).run(); } catch {}
      }
      await db.prepare(
        "INSERT INTO email_log (id, order_id, sent_to, subject, resend_email_id, body_html, kind) VALUES (?, ?, ?, ?, ?, ?, 'cancellation')"
      ).bind(crypto.randomUUID(), order.id, to, subject, resendEmailId, html).run();
    } catch {
      // Best-effort logging - never undo an email that already went out.
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function sanitizeDecoration(d) {
    return {
      method: String(d.method || "").slice(0, 40),
      placement: String(d.placement || "").slice(0, 40),
      price: Number(d.price) || 0,
      qty: Math.max(1, parseInt(d.qty, 10) || 1),
      notes: String(d.notes || "").slice(0, 200),
    };
  }

  // Recomputed from the submitted items every time, never trusted verbatim
  // from the client - this is the thing that becomes an invoice, so the
  // stored total has to be right.
  function priceItems(items, discountPct, discountFlat) {
    const priced = (Array.isArray(items) ? items : []).map((item) => {
      const source = item.source === "customer_supplied" ? "customer_supplied" : "catalog";
      const isGarmentLine = source === "catalog" && !item.customer_item;

      // Catalog rows are often a pricing tier ("All Colours" / "XS - XXL"),
      // not one physical garment, so the real per-unit colour/size/qty is
      // itemized in breakdown - qty for the line is the sum of those, not a
      // single number the client could otherwise send disconnected from it.
      // Each row also carries its own decorations (e.g. Black/M gets a
      // "Highlanders Logo", Black/XL gets a different logo) - added so a
      // decoration is priced against, and later printed alongside, the
      // specific colour/size it was actually put on, not shared across
      // every row in the line ambiguously.
      const breakdown = (Array.isArray(item.breakdown) ? item.breakdown : []).map((b) => ({
        colour: String(b.colour || "").slice(0, 60),
        size: String(b.size || "").slice(0, 60),
        qty: Math.max(1, parseInt(b.qty, 10) || 1),
        decorations: (Array.isArray(b.decorations) ? b.decorations : []).map(sanitizeDecoration),
      }));

      const unitPrice = Number(item.unit_price) || 0;
      // Line-level decorations - still how a customer-supplied line or a
      // customer's flat saved item (no colour/size breakdown to attach a
      // decoration to) carries decorations, and also how an OLDER quote
      // saved before per-row decorations existed still has them stored.
      const decorations = (Array.isArray(item.decorations) ? item.decorations : []).map(sanitizeDecoration);
      const hasRowDecorations = breakdown.some((b) => b.decorations.length);

      let qty, lineTotal;
      if (isGarmentLine && breakdown.length) {
        qty = breakdown.reduce((sum, b) => sum + b.qty, 0);
        if (hasRowDecorations || !decorations.length) {
          // New-style: each row's own decorations only cost against that
          // row's own qty.
          lineTotal = round2(breakdown.reduce((sum, b) => {
            const rowDecTotal = b.decorations.reduce((s, d) => s + d.price * d.qty, 0);
            return sum + b.qty * (unitPrice + rowDecTotal);
          }, 0));
        } else {
          // Old-style: this item still only has line-level decorations (a
          // quote saved before this feature existed, not yet re-opened in
          // the builder) - keep the original formula so its stored total
          // doesn't shift underneath it.
          const decorationTotal = decorations.reduce((sum, d) => sum + d.price * d.qty, 0);
          lineTotal = round2(qty * (unitPrice + decorationTotal));
        }
      } else {
        // A customer's own saved catalog item (customer_item: true) still
        // carries its qty in breakdown[0].qty, not item.qty - it reuses the
        // same breakdown array a real garment line uses, just with a single
        // row and no colour/size, purely so the builder's qty input
        // (updateBreakdownQtyLive) has somewhere to write to. Must match
        // admin.html's lineQty() exactly (source === 'catalog' -> sum
        // breakdown), or the live total shown while editing silently
        // diverges from what actually gets saved.
        qty = breakdown.length
          ? breakdown.reduce((sum, b) => sum + b.qty, 0)
          : Math.max(1, parseInt(item.qty, 10) || 1);
        const decorationTotal = decorations.reduce((sum, d) => sum + d.price * d.qty, 0);
        lineTotal = round2(qty * (unitPrice + decorationTotal));
      }

      // Per-line discount - separate from the order-level discount_pct/
      // discount_flat above (which still applies on top of the already-
      // discounted subtotal, same as before). Martin wanted to knock money
      // off one specific garment/service line, not always the whole order.
      // Applied against this line's own gross total (garment + decoration,
      // the `lineTotal` just computed above) - discount_amount is what
      // every render surface (admin.html, document-pdf.js, send-email.js)
      // needs to reconcile Qty×Unit + Decoration - Discount = Total on the
      // line, same as the order-level discount already reconciles against
      // the order subtotal.
      const line_discount_pct = Math.min(100, Math.max(0, Number(item.discount_pct) || 0));
      const line_discount_flat = Math.max(0, Number(item.discount_flat) || 0);
      // discount_flat_per_unit: when set, the £ box means "per item" rather
      // than a flat amount off the whole line (e.g. £11 off each of 5 units
      // = £55, not £11 off the line) - multiply by this line's own qty.
      const line_discount_flat_per_unit = !!item.discount_flat_per_unit;
      const line_discount_flat_amount = line_discount_flat_per_unit ? line_discount_flat * qty : line_discount_flat;
      const line_discount_amount = round2(lineTotal * (line_discount_pct / 100) + line_discount_flat_amount);
      const netLineTotal = Math.max(0, round2(lineTotal - line_discount_amount));

      return {
        source,
        product_id: item.product_id || null,
        supplier_code: item.supplier_code || "",
        title: item.title || "",
        colour: item.colour || "",
        size: item.size || "",
        description: item.description || "",
        qty,
        unit_price: unitPrice,
        breakdown,
        decorations,
        discount_pct: line_discount_pct,
        discount_flat: line_discount_flat,
        discount_flat_per_unit: line_discount_flat_per_unit,
        discount_amount: line_discount_amount,
        line_total: netLineTotal,
        // Marks a line picked from a customer's own saved price list (see
        // products.customer_id) rather than the shared garment catalog -
        // carried through so re-opening this quote in the builder renders
        // the simple qty-only line it started as, not a garment colour/size
        // grid that was never meaningful for it.
        customer_item: !!item.customer_item,
        // For a "running tab" order that stays open while work gets added
        // over several days/weeks - each line remembers the day it was
        // actually added, not just the order's own created_at. admin.html
        // stamps this itself when a line is first added (addOrderLine) and
        // carries it unchanged on every later edit, so this is just a
        // passthrough-with-fallback: only ever defaults to today here for
        // an item that predates this field (an older saved quote/invoice,
        // or a client that doesn't send it) rather than trying to infer
        // "was this line just added in this edit" server-side - the PUT
        // handler below has no old-vs-new distinction to work with (blind
        // overwrite of the whole items array), so that has to be decided
        // client-side before it ever gets here.
        date_added: /^\d{4}-\d{2}-\d{2}$/.test(item.date_added || "") ? item.date_added : todayIso(),
      };
    });

    const subtotal = round2(priced.reduce((sum, i) => sum + i.line_total, 0));
    const discount_pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
    const discount_flat = Math.max(0, Number(discountFlat) || 0);
    const discount_amount = round2(subtotal * (discount_pct / 100) + discount_flat);
    const total = Math.max(0, round2(subtotal - discount_amount));

    return { items: priced, subtotal, discount_pct, discount_flat, discount_amount, total };
  }

  async function nextNumber(kind) {
    // kind is 'quote' or 'invoice'. Single upsert+RETURNING statement so the
    // increment is atomic - this is exactly what replaces the old
    // client-side "Q-" + quotes.length numbering, which could collide.
    const row = await db.prepare(`
      INSERT INTO counters (name, value) VALUES (?, 1)
      ON CONFLICT(name) DO UPDATE SET value = value + 1
      RETURNING value
    `).bind(kind).first();
    const n = row ? row.value : 1;
    const prefix = kind === "invoice" ? "INV" : "Q";
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER DEFAULT 0
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        doc_type TEXT DEFAULT 'quote',
        quote_number TEXT,
        invoice_number TEXT,
        customer_id TEXT,
        customer_name TEXT,
        customer_email TEXT,
        items TEXT NOT NULL DEFAULT '[]',
        subtotal REAL DEFAULT 0,
        discount_pct REAL DEFAULT 0,
        discount_flat REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        total REAL DEFAULT 0,
        status TEXT DEFAULT 'draft',
        paid_status TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        invoiced_at TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // The table already existed on live D1 before discount_flat was added to
    // the CREATE TABLE above - "IF NOT EXISTS" is a no-op against an existing
    // table, so it needs adding here instead (same pattern as customers.js).
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN discount_flat REAL DEFAULT 0`).run();
    } catch {
      // already exists
    }
    // paid_at - when an invoice was actually marked paid, not just that it
    // currently is (paid_status alone has no timestamp) - needed so the
    // Dashboard can report revenue against the date it actually came in,
    // not the date the invoice happened to be created.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN paid_at TEXT`).run();
    } catch {
      // already exists
    }
    // archived_at - a quote nobody ever responded to, tucked out of the way
    // without deleting it (still fully retrievable, unlike Delete). Only
    // affects the main pipeline list (the default GET, no id/customer_id) -
    // a customer's own profile history and a direct ?id= lookup show an
    // archived order exactly as normal, since archiving is about
    // decluttering the working list, not hiding it from their record.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN archived_at TEXT`).run();
    } catch {
      // already exists
    }
    // due_date - the date an invoice is due by, picked by hand in the
    // builder (not auto-calculated from a payment-terms setting, since
    // Martin sets terms per-customer/per-job). Quotes leave it blank; it's
    // only ever shown/used once something becomes an invoice.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN due_date TEXT`).run();
    } catch {
      // already exists
    }
    // archive_bucket - which of the two Archive sections ("Completed" or
    // "Pending") this lands in, picked by hand with one click at the moment
    // it's archived (see the archive_bucket-choice popup in admin.html) -
    // deliberately not derived from paid_status/status, since "the physical
    // job is finished" and "the invoice is paid" are different things.
    // NULL for anything archived before this existed - treated as Pending.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN archive_bucket TEXT`).run();
    } catch {
      // already exists
    }
    // reminder_interval_days - per-invoice override for how often
    // payment-reminders.js chases this one, set in the builder next to Due
    // by. NULL means "use the portal-wide default" (see reminder_settings
    // in payment-reminders.js) - most invoices never need a special cadence,
    // this is only for the odd one that should be chased more/less often.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN reminder_interval_days INTEGER`).run();
    } catch {
      // already exists
    }
    // reminder_paused - a full opt-out for this one invoice, distinct from
    // reminder_interval_days above (which only changes how OFTEN it's
    // chased, not whether). Toggled via the row actions' Pause/Resume
    // Reminders button - see admin.html's toggleReminderPause() and the
    // "toggle_reminder_pause" PUT action below.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN reminder_paused INTEGER DEFAULT 0`).run();
    } catch {
      // already exists
    }
    // is_manual - an invoice already produced in a separate app (e.g. Karl
    // Sports' own invoicing) and just uploaded here as a PDF, rather than
    // built from garment lines - see functions/api/manual-invoice.js. Still
    // a normal row in this table (shows in Quotes & Invoices, Dashboard,
    // payment reminders etc like any other invoice), it just has no items
    // and its PDF is the uploaded file, not a generated one - order-pdf.js
    // and send-email.js both branch on this.
    for (const col of ["is_manual INTEGER DEFAULT 0", "manual_pdf_r2_key TEXT", "manual_pdf_filename TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }
    // deposit_pct/deposit_amount - what's being asked for up front, set by
    // hand in the builder same as discount_pct/discount_flat (and additive
    // the same way - a job can have a % deposit and a flat top-up at once).
    // Deliberately metadata only, not fed into priceItems() - a deposit
    // doesn't change what's owed, only how big a first payment is being
    // requested. The actual "deposit due" figure is always computed live
    // from these plus the current total (see document-pdf.js/send-email.js),
    // never stored, so it can't drift if the order is edited afterwards.
    for (const col of ["deposit_pct REAL DEFAULT 0", "deposit_amount REAL DEFAULT 0"]) {
      try {
        await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }
    // production_due_date - when the customer actually needs/collects this
    // job, picked by hand in the builder same as due_date - deliberately a
    // separate column, not a reuse of due_date, since due_date is explicitly
    // an invoice's payment-terms deadline (see the comment on it above) and
    // is blank on every quote. This one applies to quotes and invoices alike
    // (production happens regardless of which stage the paperwork is at)
    // and is what the Production Calendar view (admin.html) buckets orders
    // by - conflating the two would mean a quote could never show up on the
    // calendar at all, and an invoice's payment deadline would get treated
    // as its collection date, which usually isn't the same thing.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN production_due_date TEXT`).run();
    } catch {
      // already exists
    }
    // followup_interval_days - per-quote override for how many days after
    // sending to send the one-off "still interested?" nudge (see
    // functions/api/quote-followups.js). NULL means "use the portal-wide
    // default" - the mirror image of reminder_interval_days above, just for
    // quotes instead of overdue invoices.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN followup_interval_days INTEGER`).run();
    } catch {
      // already exists
    }
    // pay_token - unguessable link identifier for the customer-facing "Pay
    // by card" link on an unpaid invoice email (see send-email.js, which
    // lazily generates this the first time an unpaid invoice is emailed,
    // and functions/api/pay-by-card.js, the only thing that ever reads it).
    // square_payment_id on payments (below) is the matching dedupe key for
    // the webhook that actually records the payment once Square confirms it.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN pay_token TEXT`).run();
    } catch {
      // already exists
    }
    // accept_token - unguessable link identifier for the customer-facing
    // "Accept & Confirm" button on a quote email (see send-email.js, which
    // lazily generates this the first time a quote is emailed, and the new
    // functions/api/accept-quote.js, which is the only thing that ever reads
    // it - same self-serve pattern as design_proofs.token, just one step
    // earlier in the pipeline).
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN accept_token TEXT`).run();
    } catch {
      // already exists
    }
    // amount_paid - running total of everything recorded against this
    // invoice in the payments ledger below, kept denormalized on the order
    // itself so every existing place that reads orders.* (list badges,
    // reminders, Dashboard) can see "how much has been paid so far" without
    // a join. Recomputed from payments on every insert/delete, never edited
    // directly.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN amount_paid REAL DEFAULT 0`).run();
    } catch {
      // already exists
    }
    // deleted_at - soft-delete, same universal-Trash pattern as
    // customers.deleted_at/stock_items.deleted_at/products.deleted_at (see
    // admin.html's unified Trash tab, which pulls from all four). Distinct
    // from archived_at above: archiving is a deliberate "tuck this away,
    // it's done" that still counts everywhere (Dashboard stats, customer
    // history); deleted_at means "gone", hidden from every listing until
    // restored or purged via permanent:true on DELETE.
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN deleted_at TEXT`).run();
    } catch {
      // already exists
    }

    // source - which front-end created this order, e.g. 'dtf-prep' for
    // gang-sheet-checkout.js. NULL for every existing order and every other
    // caller (admin.html's own New Quote builder, Crystal Quick) - they
    // never pass this field, so nothing about their behavior changes.
    // Purely so admin.html can keep DTF-Prep orders out of the main Quotes
    // & Invoices list (a display-only filter there, not a query change here
    // - see the DTF Builder sub-tab instead).
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN source TEXT`).run();
    } catch {
      // already exists
    }

    // payments - the real ledger, one row per payment actually received.
    // paid_status on the order stays a quick-glance summary ('unpaid' |
    // 'partial' | 'paid'), derived from this table; this is the record of
    // what was actually paid, when, how, and by whom it was recorded.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        amount REAL NOT NULL,
        method TEXT,
        type TEXT NOT NULL DEFAULT 'payment',
        notes TEXT,
        received_at TEXT NOT NULL,
        receipt_sent_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    // square_payment_id - set only on a payment recorded automatically by
    // functions/api/square-webhook.js off a card payment taken via Square's
    // Payment Links checkout (see pay-by-card.js) - null for every payment
    // entered by hand. Doubles as the webhook's own dedupe key, since Square
    // can and does redeliver the same notification more than once.
    try {
      await db.prepare(`ALTER TABLE payments ADD COLUMN square_payment_id TEXT`).run();
    } catch {
      // already exists
    }
    // refunded_at - set on a Square card payment once it's actually been
    // refunded via functions/api/square-refund.js, so that row's "Refund"
    // button in the portal can't fire twice against the same payment.
    // Never set on anything else - a manually-recorded payment is voided
    // (delete_payment above) instead of refunded, since there's no live
    // card transaction behind it to reverse.
    try {
      await db.prepare(`ALTER TABLE payments ADD COLUMN refunded_at TEXT`).run();
    } catch {
      // already exists
    }

    // One-time backfill: an invoice marked Paid via the old one-click
    // Mark Paid/Unpaid toggle (before this payments ledger existed) has
    // paid_status = 'paid' but amount_paid = 0 and zero rows in payments -
    // that toggle never touched either. Left alone, that invoice shows "£0
    // paid, full balance due, no payments recorded" in the Payments section
    // despite genuinely being paid, and contributes nothing to Dashboard
    // revenue/Top Customers now that both are driven off the real ledger.
    // Safe to run on every request: once an order gets its backfilled row,
    // it no longer matches "zero payments rows" and is never touched again.
    try {
      const { results: unbackfilled } = await db.prepare(`
        SELECT id, total, paid_at, created_at FROM orders
        WHERE doc_type = 'invoice' AND paid_status = 'paid'
          AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.order_id = orders.id)
      `).all();
      if (unbackfilled.length) {
        const insertStmt = db.prepare(`
          INSERT INTO payments (id, order_id, amount, method, type, notes, received_at)
          VALUES (?, ?, ?, ?, 'payment', ?, ?)
        `);
        const updateStmt = db.prepare("UPDATE orders SET amount_paid = ? WHERE id = ?");
        await db.batch(unbackfilled.flatMap((o) => [
          insertStmt.bind(
            crypto.randomUUID(),
            o.id,
            o.total,
            "",
            "Backfilled - this invoice was marked Paid before payment tracking existed",
            o.paid_at || o.created_at
          ),
          updateStmt.bind(o.total, o.id),
        ]));
      }
    } catch {
      // nothing to backfill, or ran before payments existed - fine either way
    }

    // Recomputes orders.amount_paid/paid_status/paid_at from the payments
    // ledger - called after every insert/delete so the denormalized summary
    // on the order never drifts from the actual rows.
    async function recomputePaymentSummary(orderId) {
      const order = await db.prepare("SELECT total, paid_status FROM orders WHERE id = ?").bind(orderId).first();
      if (!order) return null;
      const sumRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = ?").bind(orderId).first();
      const amountPaid = sumRow ? sumRow.total : 0;
      let status;
      if (amountPaid <= 0) status = "unpaid";
      else if (amountPaid >= order.total) status = "paid";
      else status = "partial";
      const paidAt = status === "paid" ? new Date().toISOString() : null;
      await db.prepare(
        "UPDATE orders SET amount_paid = ?, paid_status = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(amountPaid, status, paidAt, orderId).run();
      if (status === "paid") await markInvoicePaidStepDone(db, orderId);
      return { amount_paid: amountPaid, paid_status: status, paid_at: paidAt };
    }

    // ------------------------------------------------------------------ GET --
    if (request.method === "GET") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      // ?payments_for=X -> the payment ledger for one order, used by the
      // order detail panel's payment-history section.
      const paymentsFor = url.searchParams.get("payments_for");
      if (paymentsFor) {
        const { results } = await db.prepare(
          "SELECT * FROM payments WHERE order_id = ? ORDER BY received_at DESC, created_at DESC"
        ).bind(paymentsFor).all();
        return json(results);
      }
      // ?events_for=X -> the Activity Timeline for one order (see
      // functions/_lib/order-events.js, written to by every file that
      // touches an order's lifecycle) - chronological, oldest first, for
      // the order detail panel's timeline section.
      const eventsFor = url.searchParams.get("events_for");
      if (eventsFor) {
        await db.prepare(`
          CREATE TABLE IF NOT EXISTS order_events (
            id TEXT PRIMARY KEY, order_id TEXT NOT NULL, type TEXT NOT NULL,
            label TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `).run();
        const { results } = await db.prepare(
          "SELECT type, label, created_at FROM order_events WHERE order_id = ? ORDER BY created_at ASC"
        ).bind(eventsFor).all();
        return json(results);
      }
      // ?orphaned_payments=1 / ?orphaned_email_log=1 - the maintenance
      // backlog left behind by orders deleted before deleteOrderPaymentsAndLogs
      // existed. Same pattern as design-proofs.js's ?orphaned=1 - see
      // admin.html's cleanUpOrphanedProofs().
      if (url.searchParams.get("orphaned_payments")) {
        const { results } = await db.prepare(
          `SELECT p.id, p.amount, p.method, p.received_at FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE o.id IS NULL ORDER BY p.received_at DESC`
        ).all();
        return json(results);
      }
      if (url.searchParams.get("orphaned_email_log")) {
        const { results } = await db.prepare(
          `SELECT e.id, e.sent_to, e.subject, e.sent_at FROM email_log e LEFT JOIN orders o ON o.id = e.order_id WHERE o.id IS NULL ORDER BY e.sent_at DESC`
        ).all();
        return json(results);
      }
      // ?doc_number=X -> just the id/doc_type for a quote/invoice number
      // (e.g. "INV-0025"), looked up regardless of archived status. Used
      // by the Stock tab's "Allocated to" dropdown to make an OLDER
      // movement's free-text reason ("Invoiced on INV-0025", from before
      // stock_movements.order_id existed) clickable too, by resolving the
      // number it already shows back to an id.
      const docNumber = url.searchParams.get("doc_number");
      if (docNumber) {
        const row = await db.prepare(
          "SELECT id, doc_type FROM orders WHERE invoice_number = ?1 OR quote_number = ?1 LIMIT 1"
        ).bind(docNumber).first();
        return json(row || null);
      }
      if (id) {
        const row = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Not found" }, 404);
        // The order itself only snapshots customer_name/customer_email (set
        // once, at creation) - the current invoicing address always comes
        // live from the customer record, so an address edited after the
        // quote was raised still prints correctly.
        const customer = row.customer_id
          ? await db.prepare("SELECT address_1, address_2, city, county, postcode FROM customers WHERE id = ?").bind(row.customer_id).first()
          : null;
        return json({ ...row, items: JSON.parse(row.items || "[]"), customer_address: customer || null });
      }

      // ?trash=1 -> only soft-deleted orders, for the universal Trash tab.
      // A completely separate simple query, same as customers.js's own
      // ?trash=1 - a trashed row is never mixed into any other filter
      // combination below.
      if (url.searchParams.get("trash")) {
        const { results } = await db.prepare(
          "SELECT * FROM orders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
        ).all();
        return json(results.map((r) => ({ ...r, items: JSON.parse(r.items || "[]") })));
      }

      // ?customer_id=X -> a customer's full quote/invoice history, used by
      // the Customer Directory's View button.
      const docType = url.searchParams.get("doc_type");
      const customerId = url.searchParams.get("customer_id");
      const archived = url.searchParams.get("archived");
      // ?all=1 - every order regardless of archived_at, for reporting (the
      // Dashboard) where an archived sale still needs to count towards
      // revenue/stats - archiving only declutters the working list, it was
      // never meant to erase a completed sale from the numbers.
      const includeAll = url.searchParams.get("all");
      // Trashed rows are excluded everywhere else unconditionally - even
      // ?all=1 reporting, since a deleted (not just archived) sale
      // shouldn't count in the numbers until it's restored.
      const where = ["deleted_at IS NULL"];
      const binds = [];
      if (docType) { where.push("doc_type = ?"); binds.push(docType); }
      if (customerId) { where.push("customer_id = ?"); binds.push(customerId); }
      // The main Quotes & Invoices list (no customer_id, no explicit
      // ?archived=) only ever shows what's still active - archived rows are
      // a separate, deliberate lookup via ?archived=1, not folded into the
      // default view.
      if (archived) {
        where.push("archived_at IS NOT NULL");
      } else if (!customerId && !includeAll) {
        where.push("archived_at IS NULL");
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { results } = await db.prepare(
        `SELECT * FROM orders ${clause} ORDER BY created_at DESC`
      ).bind(...binds).all();

      return json(results.map((r) => ({ ...r, items: JSON.parse(r.items || "[]") })));
    }

    // ----------------------------------------------------------------- POST --
    // Usually creates a new quote (invoices are otherwise only ever
    // produced by converting one - see the "convert_to_invoice" PUT action
    // below), but data.doc_type === 'invoice' skips the quote stage
    // entirely - for a job that's already agreed and just needs invoicing,
    // not a proposal that needs approving first (see the New Quote/New
    // Invoice toggle in the builder).
    if (request.method === "POST") {
      const data = await request.json();
      const id = crypto.randomUUID();
      const priced = priceItems(data.items, data.discount_pct, data.discount_flat);
      const isInvoice = data.doc_type === "invoice";
      const docNumber = await nextNumber(isInvoice ? "invoice" : "quote");

      await db.prepare(`
        INSERT INTO orders (
          id, doc_type, quote_number, invoice_number, customer_id, customer_name, customer_email,
          items, subtotal, discount_pct, discount_flat, discount_amount, total, status, paid_status, notes, due_date, production_due_date, reminder_interval_days, followup_interval_days, invoiced_at, deposit_pct, deposit_amount, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        isInvoice ? "invoice" : "quote",
        isInvoice ? "" : docNumber,
        isInvoice ? docNumber : "",
        data.customer_id || "",
        data.customer_name || "",
        data.customer_email || "",
        JSON.stringify(priced.items),
        priced.subtotal,
        priced.discount_pct,
        priced.discount_flat,
        priced.discount_amount,
        priced.total,
        data.status || "draft",
        isInvoice ? "unpaid" : null,
        data.notes || "",
        data.due_date || "",
        data.production_due_date || "",
        data.reminder_interval_days ? Number(data.reminder_interval_days) : null,
        data.followup_interval_days ? Number(data.followup_interval_days) : null,
        isInvoice ? new Date().toISOString() : null,
        Number(data.deposit_pct) || 0,
        Number(data.deposit_amount) || 0,
        data.source || null
      ).run();

      await logOrderEvent(db, id, "created", `${isInvoice ? "Invoice" : "Quote"} ${docNumber} created`);

      // A job can be invoiced straight away, skipping the quote stage
      // entirely (see the comment above this branch) - that's still "an
      // invoice now exists", so stock comes off the shelf here too, same
      // as the convert_to_invoice path below.
      if (isInvoice) {
        const deducted = await deductStockForOrder(db, priced.items, `Invoiced on ${docNumber}`, env, new URL(request.url).origin, id);
        if (deducted.length) {
          await logOrderEvent(db, id, "stock", `Stock updated: ${deducted.map((d) => `${d.item} (${d.colour}/${d.size}) -${d.qty}`).join(", ")}`);
        }
        await resetReorderReminder(db, data.customer_id);
      }

      return json({
        success: true, id, ...priced,
        quote_number: isInvoice ? null : docNumber,
        invoice_number: isInvoice ? docNumber : null,
      });
    }

    // ------------------------------------------------------------------ PUT --
    if (request.method === "PUT") {
      const data = await request.json();

      // Restore from the Trash - see DELETE below, and GET's ?trash=1.
      // Doesn't touch stock/payments/anything else the order affected,
      // since a soft-delete never touched those either - restoring just
      // makes the order visible again, exactly as it was.
      if (data.restore) {
        await db.prepare("UPDATE orders SET deleted_at = NULL WHERE id = ?").bind(data.id).run();
        return json({ success: true });
      }

      // Not scoped to any one order (no data.id involved) - lets an admin
      // correct the invoice numbering sequence, e.g. after a batch of test
      // invoices got numbered ahead of where real numbering should resume.
      // Only ever moves the counter to an explicit value the admin typed in
      // (used by admin.html's resetInvoiceCounter(), which asks for that
      // value up front) - it never touches, renumbers, or deletes any
      // existing invoice, only where nextNumber('invoice') starts counting
      // from next.
      if (data.action === "set_invoice_counter") {
        const value = Math.max(0, parseInt(data.value, 10) || 0);
        await db.prepare(`
          INSERT INTO counters (name, value) VALUES ('invoice', ?)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value
        `).bind(value).run();
        return json({ success: true, value });
      }

      // Same as set_invoice_counter above, for the quote sequence (Q-XXXX)
      // instead - see admin.html's resetQuoteCounter().
      if (data.action === "set_quote_counter") {
        const value = Math.max(0, parseInt(data.value, 10) || 0);
        await db.prepare(`
          INSERT INTO counters (name, value) VALUES ('quote', ?)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value
        `).bind(value).run();
        return json({ success: true, value });
      }

      // One-off cleanup for a data-entry habit from before the decoration
      // "x N" field's meaning was clarified: on a legacy per-row decoration
      // (breakdown[].decorations, from before decorations moved to the
      // line level - see decorationsBlock in admin.html), the field means
      // "instances per garment" (e.g. 2 for both sleeves), but several old
      // rows have it set to match the row's own garment count instead
      // (e.g. 13 waistcoats with the decoration itself also set to "x13"),
      // which double-counts against the row's qty everywhere that
      // multiplies the two together (lineTotal, the dashboard's Top-Line
      // Analytics, the PDF/email itemization). Only touches a decoration
      // priced at £0 - real invoice totals were never affected by this
      // (0 x anything is still 0), so there's nothing financial to get
      // wrong by fixing it. A priced decoration with the same suspicious
      // pattern is left alone and reported instead, never silently
      // changed - that would touch a number that was actually charged and
      // possibly already paid.
      if (data.action === "fix_decoration_qty_mismatch") {
        const { results: allOrders } = await db.prepare("SELECT id, items FROM orders WHERE items IS NOT NULL AND items <> ''").all();
        let ordersFixed = 0, decorationsFixed = 0;
        const flaggedForReview = [];
        for (const row of allOrders) {
          let items;
          try { items = JSON.parse(row.items || "[]"); } catch { continue; }
          let changed = false;
          items.forEach((item) => {
            (item.breakdown || []).forEach((b) => {
              const rowQty = Number(b.qty) || 0;
              if (rowQty <= 1) return;
              (b.decorations || []).forEach((d) => {
                if (Number(d.qty) === rowQty) {
                  if (Number(d.price) === 0) {
                    d.qty = 1;
                    changed = true;
                    decorationsFixed++;
                  } else {
                    flaggedForReview.push({ order_id: row.id, method: d.method, price: d.price, qty: d.qty, row_qty: rowQty });
                  }
                }
              });
            });
          });
          if (changed) {
            await db.prepare("UPDATE orders SET items = ? WHERE id = ?").bind(JSON.stringify(items), row.id).run();
            ordersFixed++;
          }
        }
        return json({ success: true, orders_fixed: ordersFixed, decorations_fixed: decorationsFixed, flagged_for_review: flaggedForReview });
      }

      // One-off backfill for the Activity Timeline (functions/_lib/order-
      // events.js) - a real order predating that feature has no history
      // there at all, even though the history genuinely exists, just
      // scattered across orders/email_log/payments/production_steps. Skips
      // any order that already has at least one event (either already
      // backfilled, or has picked up live-tracked events since) - safe to
      // click more than once, admin.html's button for this is in the
      // Quotes & Invoices toolbar. Timestamps are normalized to the same
      // "YYYY-MM-DD HH:MM:SS" shape CURRENT_TIMESTAMP produces (what every
      // live-tracked event already uses) rather than left as whatever
      // format each source column happened to store - a plain text ORDER
      // BY created_at would otherwise sort a "2026-01-01 10:00:00" row
      // after a same-instant "2026-01-01T10:00:00.000Z" one, since ' ' <
      // 'T' is false lexicographically the wrong way round.
      if (data.action === "backfill_events") {
        await ensureOrderEventsTable(db);
        const normalizeTs = (raw) => {
          if (!raw) return null;
          const d = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
          return isNaN(d) ? null : d.toISOString().slice(0, 19).replace("T", " ");
        };

        const { results: allOrders } = await db.prepare("SELECT * FROM orders").all();
        let ordersBackfilled = 0;
        let eventsInserted = 0;
        for (const o of allOrders) {
          const already = await db.prepare("SELECT id FROM order_events WHERE order_id = ? LIMIT 1").bind(o.id).first();
          if (already) continue;

          const rows = [];
          const push = (type, label, rawTs) => {
            const ts = normalizeTs(rawTs);
            if (ts) rows.push({ type, label, ts });
          };

          push("created", o.quote_number ? `Quote ${o.quote_number} created` : `Invoice ${o.invoice_number} created`, o.created_at);
          if (o.quote_number && o.doc_type === "invoice" && o.invoiced_at) {
            push("converted", `Converted to invoice ${o.invoice_number}`, o.invoiced_at);
          }

          const { results: emails } = await db.prepare(
            "SELECT sent_to, sent_at FROM email_log WHERE order_id = ? ORDER BY sent_at ASC"
          ).bind(o.id).all();
          emails.forEach((e) => push("sent", `Emailed to ${e.sent_to}`, e.sent_at));

          const { results: pays } = await db.prepare(
            "SELECT amount, method, received_at, square_payment_id FROM payments WHERE order_id = ? ORDER BY received_at ASC"
          ).bind(o.id).all();
          pays.forEach((p) => {
            const amt = Number(p.amount);
            if (amt < 0) push("refunded", `Refunded £${Math.abs(amt).toFixed(2)}${p.method ? " via " + p.method : ""}`, p.received_at);
            else if (p.square_payment_id) push("payment_via_card", `Paid £${amt.toFixed(2)} by card via Square`, p.received_at);
            else push("payment_recorded", `Payment recorded: £${amt.toFixed(2)}${p.method ? " (" + p.method + ")" : ""}`, p.received_at);
          });

          const { results: steps } = await db.prepare(
            "SELECT title, completed_at FROM production_steps WHERE order_id = ? AND status = 'done' AND completed_at IS NOT NULL ORDER BY completed_at ASC"
          ).bind(o.id).all();
          steps.forEach((s) => push("production_step", `Production: ${s.title}`, s.completed_at));

          if (o.last_reminder_sent_at) push("reminder_sent", "Payment reminder emailed", o.last_reminder_sent_at);
          if (o.followup_sent_at) push("followup_sent", "Stale-quote follow-up emailed", o.followup_sent_at);
          if (o.archived_at) push("archived", "Archived", o.archived_at);

          if (!rows.length) continue;
          for (const r of rows) {
            await db.prepare(
              "INSERT INTO order_events (id, order_id, type, label, created_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(crypto.randomUUID(), o.id, r.type, r.label, r.ts).run();
            eventsInserted++;
          }
          ordersBackfilled++;
        }
        return json({ success: true, orders_backfilled: ordersBackfilled, events_inserted: eventsInserted });
      }

      const existing = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(data.id).first();
      if (!existing) return json({ error: "Order not found" }, 404);

      // Puts an order on the customer's My Orders page and ensures it has
      // the tokens (accept_token/pay_token) needed to actually do anything
      // there - previously only send-email.js's actual Resend send did
      // both of these, so an order shared purely via WhatsApp (admin.html's
      // sendOrderViaWhatsApp) never showed up in My Orders at all, and
      // couldn't have been accepted/paid from there even if it had. This
      // reuses email_sent_at as the same "has this genuinely gone out"
      // signal my-orders.js already filters on - deliberately NOT touching
      // email_sent_count (that still means "how many real emails", used by
      // send-email.js's isFirstSend/deposit-ask logic), so a later actual
      // email still correctly treats itself as the first real send.
      // Mints pay_token without any of mark_shared's side effects (it
      // shouldn't set email_sent_at or log "Shared via WhatsApp" - this is
      // for the "Take Payment" button in admin.html, staff keying in a
      // customer's card details themselves over the phone via Square's own
      // hosted checkout page at /api/pay-by-card?token=..., nothing was
      // actually sent to the customer). Only meaningful for an
      // invoice - a quote has nothing to pay yet.
      if (data.action === "ensure_pay_token") {
        if (existing.doc_type !== "invoice") return json({ error: "Only invoices take payments" }, 400);
        if (existing.paid_status === "paid") return json({ error: "This invoice is already paid" }, 409);
        let payToken = existing.pay_token;
        if (!payToken) {
          payToken = crypto.randomUUID();
          await db.prepare("UPDATE orders SET pay_token = ? WHERE id = ?").bind(payToken, existing.id).run();
        }
        return json({ success: true, pay_token: payToken });
      }

      if (data.action === "mark_shared") {
        let acceptToken = existing.accept_token;
        let payToken = existing.pay_token;
        if (existing.doc_type === "quote" && !acceptToken) {
          acceptToken = crypto.randomUUID();
          await db.prepare("UPDATE orders SET accept_token = ? WHERE id = ?").bind(acceptToken, existing.id).run();
        }
        if (existing.doc_type === "invoice" && existing.paid_status !== "paid" && !payToken) {
          payToken = crypto.randomUUID();
          await db.prepare("UPDATE orders SET pay_token = ? WHERE id = ?").bind(payToken, existing.id).run();
        }
        if (!existing.email_sent_at) {
          await db.prepare("UPDATE orders SET email_sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(existing.id).run();
        }
        await logOrderEvent(db, existing.id, "sent", "Shared via WhatsApp");
        return json({ success: true, accept_token: acceptToken, pay_token: payToken });
      }

      if (data.action === "archive") {
        const bucket = data.bucket === "completed" ? "completed" : data.bucket === "cancelled" ? "cancelled" : "pending";
        await db.prepare("UPDATE orders SET archived_at = CURRENT_TIMESTAMP, archive_bucket = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(bucket, data.id).run();
        await logOrderEvent(db, data.id, "archived", `Archived (${bucket})`);
        return json({ success: true });
      }

      // Cancel invoice - restores any stock reserved for it (same as a
      // Delete, but the record itself is kept, just tucked into Archived >
      // Cancelled rather than removed) and stops the automatic payment
      // chase (reminder_paused, same flag "Pause Reminders" uses - the
      // daily sweep in payment-reminders.js already skips anything with it
      // set, so nothing extra needed there). Only ever invoices - a quote
      // has nothing to cancel, it's just accepted or not.
      if (data.action === "cancel_invoice") {
        if (existing.doc_type !== "invoice") return json({ error: "Only invoices can be cancelled" }, 400);

        await restoreStockForOrder(db, existing.id, env, new URL(request.url).origin);
        await db.prepare(
          "UPDATE orders SET archived_at = CURRENT_TIMESTAMP, archive_bucket = 'cancelled', reminder_paused = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(existing.id).run();
        await logOrderEvent(db, existing.id, "cancelled", "Invoice cancelled");

        let emailResult = null;
        if (data.notify_customer) {
          emailResult = await sendCancellationEmail(db, env, new URL(request.url).origin, existing);
        }
        return json({ success: true, email: emailResult });
      }

      if (data.action === "unarchive") {
        await db.prepare("UPDATE orders SET archived_at = NULL, archive_bucket = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(data.id).run();
        await logOrderEvent(db, data.id, "unarchived", "Restored from archive");
        return json({ success: true });
      }

      // Toggles the full opt-out for this one invoice - unlike
      // reminder_interval_days (which only changes how often it's chased),
      // a paused invoice is skipped by the daily sweep entirely regardless
      // of due date/cadence (see payment-reminders.js's candidates query).
      // "Send reminder now" still works while paused - pausing only stops
      // the automatic chase, not a deliberate manual one.
      if (data.action === "toggle_reminder_pause") {
        const paused = existing.reminder_paused ? 0 : 1;
        await db.prepare("UPDATE orders SET reminder_paused = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(paused, data.id).run();
        return json({ success: true, reminder_paused: paused });
      }

      // Fixes a mis-filed archived item (Completed <-> Pending) without
      // having to unarchive and rearchive it.
      if (data.action === "set_archive_bucket") {
        const bucket = data.bucket === "completed" ? "completed" : data.bucket === "cancelled" ? "cancelled" : "pending";
        await db.prepare("UPDATE orders SET archive_bucket = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(bucket, data.id).run();
        return json({ success: true });
      }

      if (data.action === "convert_to_invoice") {
        if (existing.doc_type === "invoice") return json({ error: "Already an invoice" }, 409);
        const invoice_number = await nextNumber("invoice");
        // email_sent_count/email_sent_at reset here - send-email.js treats
        // "0/null" as this document's first-ever send to decide whether to
        // ask for the deposit (functions/api/send-email.js's isFirstSend,
        // document-pdf.js's matching check). Without resetting, a quote
        // that was already emailed once carries that count straight into
        // the invoice, so the invoice's actual first send gets mistaken for
        // a later one and shows a balance-due statement instead of the
        // deposit ask - the invoice is a new document as far as the
        // customer's concerned, even though it's the same row here.
        await db.prepare(`
          UPDATE orders SET doc_type = 'invoice', invoice_number = ?, paid_status = 'unpaid',
            invoiced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
            email_sent_count = 0, email_sent_at = NULL
          WHERE id = ?
        `).bind(invoice_number, data.id).run();
        await logOrderEvent(db, data.id, "converted", `Converted to invoice ${invoice_number}`);

        const deducted = await deductStockForOrder(db, JSON.parse(existing.items || "[]"), `Invoiced on ${invoice_number}`, env, new URL(request.url).origin, data.id);
        if (deducted.length) {
          await logOrderEvent(db, data.id, "stock", `Stock updated: ${deducted.map((d) => `${d.item} (${d.colour}/${d.size}) -${d.qty}`).join(", ")}`);
        }
        await resetReorderReminder(db, existing.customer_id);

        return json({ success: true, invoice_number });
      }

      if (data.action === "record_payment") {
        if (existing.doc_type !== "invoice") return json({ error: "Only invoices take payments" }, 400);
        const amount = Number(data.amount);
        if (!amount || amount <= 0) return json({ error: "Amount must be greater than zero" }, 400);
        const paymentId = crypto.randomUUID();
        await db.prepare(`
          INSERT INTO payments (id, order_id, amount, method, type, notes, received_at)
          VALUES (?, ?, ?, ?, 'payment', ?, ?)
        `).bind(
          paymentId,
          data.id,
          amount,
          data.method || "",
          data.notes || "",
          data.received_at || new Date().toISOString()
        ).run();
        const summary = await recomputePaymentSummary(data.id);
        await logOrderEvent(db, data.id, "payment_recorded", `Payment recorded: £${amount.toFixed(2)}${data.method ? " (" + data.method + ")" : ""}`);
        // payment_id is returned so the caller (the Record Payment modal's
        // optional "send receipt" checkbox) can fire the receipt email
        // against this exact payment without a second round-trip.
        return json({ success: true, payment_id: paymentId, ...summary });
      }

      if (data.action === "edit_payment") {
        if (!data.payment_id) return json({ error: "payment_id required" }, 400);
        const amount = Number(data.amount);
        if (!amount || amount <= 0) return json({ error: "Amount must be greater than zero" }, 400);
        await db.prepare(`
          UPDATE payments SET amount = ?, method = ?, notes = ?, received_at = ?
          WHERE id = ? AND order_id = ?
        `).bind(
          amount,
          data.method || "",
          data.notes || "",
          data.received_at || new Date().toISOString(),
          data.payment_id,
          data.id
        ).run();
        const summary = await recomputePaymentSummary(data.id);
        return json({ success: true, ...summary });
      }

      if (data.action === "delete_payment") {
        if (!data.payment_id) return json({ error: "payment_id required" }, 400);
        const voided = await db.prepare("SELECT amount FROM payments WHERE id = ? AND order_id = ?").bind(data.payment_id, data.id).first();
        await db.prepare("DELETE FROM payments WHERE id = ? AND order_id = ?").bind(data.payment_id, data.id).run();
        const summary = await recomputePaymentSummary(data.id);
        if (voided) await logOrderEvent(db, data.id, "payment_voided", `Payment voided: £${Number(voided.amount).toFixed(2)}`);
        return json({ success: true, ...summary });
      }

      if (data.action === "set_status") {
        await db.prepare(
          "UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(String(data.status || "draft").slice(0, 30), data.id).run();
        return json({ success: true });
      }

      // Full edit: re-price from the submitted items, same as create.
      const priced = priceItems(
        data.items !== undefined ? data.items : JSON.parse(existing.items || "[]"),
        data.discount_pct !== undefined ? data.discount_pct : existing.discount_pct,
        data.discount_flat !== undefined ? data.discount_flat : existing.discount_flat
      );

      await db.prepare(`
        UPDATE orders SET
          customer_id = ?, customer_name = ?, customer_email = ?,
          items = ?, subtotal = ?, discount_pct = ?, discount_flat = ?, discount_amount = ?, total = ?,
          notes = ?, status = ?, due_date = ?, production_due_date = ?, reminder_interval_days = ?, followup_interval_days = ?, deposit_pct = ?, deposit_amount = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        data.customer_id ?? existing.customer_id,
        data.customer_name ?? existing.customer_name,
        data.customer_email ?? existing.customer_email,
        JSON.stringify(priced.items),
        priced.subtotal,
        priced.discount_pct,
        priced.discount_flat,
        priced.discount_amount,
        priced.total,
        data.notes ?? existing.notes,
        data.status !== undefined ? String(data.status).slice(0, 30) : existing.status,
        data.due_date ?? existing.due_date,
        data.production_due_date ?? existing.production_due_date,
        data.reminder_interval_days !== undefined
          ? (data.reminder_interval_days ? Number(data.reminder_interval_days) : null)
          : existing.reminder_interval_days,
        data.followup_interval_days !== undefined
          ? (data.followup_interval_days ? Number(data.followup_interval_days) : null)
          : existing.followup_interval_days,
        data.deposit_pct !== undefined ? Number(data.deposit_pct) || 0 : existing.deposit_pct,
        data.deposit_amount !== undefined ? Number(data.deposit_amount) || 0 : existing.deposit_amount,
        data.id
      ).run();

      return json({ success: true, ...priced });
    }

    // --------------------------------------------------------------- DELETE --
    // A genuine Delete (not Archive - see the "archive" PUT action above,
    // which never touches design_proofs at all) removes every design proof
    // attached to the order too - both the D1 rows and their actual image/
    // PDF bytes in R2 (env.DESIGN_FILES, same bucket
    // functions/api/design-proofs.js writes to). The order itself is gone
    // for good, so there's nothing left for that record to be about.
    // Archived quotes keep everything indefinitely (including the actual
    // files) unless explicitly told otherwise via the "Remove image from
    // database" button in the Archived list, which only clears the file
    // bytes (see design-proofs.js's "remove_storage" action) while keeping
    // the record - who approved/declined what, and when - permanently.
    async function deleteOrphanedDesignProofs(orderIds) {
      if (!orderIds.length) return;
      const placeholders = orderIds.map(() => "?").join(",");
      // No proof has necessarily ever been attached to anything yet on a
      // given deploy - the table only gets created lazily by
      // functions/api/design-proofs.js the first time that's used. Rather
      // than depend on that having already run, tolerate its absence here
      // exactly like every other "already exists" check in this codebase.
      let results;
      try {
        ({ results } = await db.prepare(
          `SELECT r2_key FROM design_proofs WHERE order_id IN (${placeholders}) AND r2_key <> ''`
        ).bind(...orderIds).all());
      } catch (e) {
        return; // design_proofs table doesn't exist yet - nothing to clean up
      }
      if (env.DESIGN_FILES) {
        await Promise.all(results.map((r) => env.DESIGN_FILES.delete(r.r2_key).catch(() => {})));
      }
      await db.prepare(`DELETE FROM design_proofs WHERE order_id IN (${placeholders})`).bind(...orderIds).run();
    }

    // Same cleanup as deleteOrphanedDesignProofs above, for the Production
    // Tracker's own steps/photos (functions/api/production-steps.js) - an
    // order being deleted should take its whole tracker with it, not leave
    // the photos orphaned in R2.
    async function deleteOrphanedProductionSteps(orderIds) {
      if (!orderIds.length) return;
      const placeholders = orderIds.map(() => "?").join(",");
      let images;
      try {
        ({ results: images } = await db.prepare(
          `SELECT r2_key FROM production_step_images WHERE order_id IN (${placeholders}) AND r2_key <> ''`
        ).bind(...orderIds).all());
      } catch (e) {
        return; // production_step_images table doesn't exist yet - nothing to clean up
      }
      if (env.DESIGN_FILES) {
        await Promise.all(images.map((r) => env.DESIGN_FILES.delete(r.r2_key).catch(() => {})));
      }
      await db.prepare(`DELETE FROM production_step_images WHERE order_id IN (${placeholders})`).bind(...orderIds).run();
      await db.prepare(`DELETE FROM production_steps WHERE order_id IN (${placeholders})`).bind(...orderIds).run();
    }

    // Same cleanup again, for DTF-Prep gang sheets (gang_sheet_uploads,
    // written by functions/api/gang-sheet-upload.js) - with one difference:
    // a sheet marked keep_file (the "Keep file" toggle on the DTF Gang
    // Sheets dashboard) survives the order being deleted rather than being
    // removed with it - it's just detached (order_id cleared) so it still
    // shows up there afterward, un-attached to anything.
    async function deleteOrphanedGangSheetUploads(orderIds) {
      if (!orderIds.length) return;
      const placeholders = orderIds.map(() => "?").join(",");
      let rows;
      try {
        ({ results: rows } = await db.prepare(
          `SELECT id, r2_key, keep_file FROM gang_sheet_uploads WHERE order_id IN (${placeholders})`
        ).bind(...orderIds).all());
      } catch (e) {
        return; // gang_sheet_uploads table doesn't exist yet - nothing to clean up
      }
      const toDelete = rows.filter((r) => !r.keep_file);
      const toDetach = rows.filter((r) => r.keep_file);
      if (env.DESIGN_FILES && toDelete.length) {
        await Promise.all(toDelete.map((r) => env.DESIGN_FILES.delete(r.r2_key).catch(() => {})));
      }
      if (toDelete.length) {
        const delPlaceholders = toDelete.map(() => "?").join(",");
        await db.prepare(`DELETE FROM gang_sheet_uploads WHERE id IN (${delPlaceholders})`).bind(...toDelete.map((r) => r.id)).run();
      }
      if (toDetach.length) {
        const detachPlaceholders = toDetach.map(() => "?").join(",");
        await db.prepare(`UPDATE gang_sheet_uploads SET order_id = NULL WHERE id IN (${detachPlaceholders})`).bind(...toDetach.map((r) => r.id)).run();
      }
    }

    // Deletes an order's own uploaded manual-invoice PDF (if it has one) -
    // separate from deleteOrphanedDesignProofs/deleteOrphanedProductionSteps
    // above since this is a single column on the order itself, not a
    // related table.
    async function deleteManualInvoicePdfs(orderIds) {
      if (!orderIds.length || !env.DESIGN_FILES) return;
      const placeholders = orderIds.map(() => "?").join(",");
      const { results } = await db.prepare(
        `SELECT manual_pdf_r2_key FROM orders WHERE id IN (${placeholders}) AND manual_pdf_r2_key <> ''`
      ).bind(...orderIds).all();
      await Promise.all(results.map((r) => env.DESIGN_FILES.delete(r.manual_pdf_r2_key).catch(() => {})));
    }

    // payments/email_log rows belong to an order the same way design proofs
    // do, but were missed when this cascade was first written - deleting an
    // order left them behind forever with no valid order_id to ever find
    // them by again. Found via a real backlog of exactly this (payments and
    // email_log rows orphaned by already-deleted test invoices) - see the
    // ?orphaned_payments=1/?orphaned_email_log=1 GETs and
    // purge_orphaned_payments/purge_orphaned_email_log DELETE actions below
    // for cleaning up that existing backlog; this is what stops it
    // recurring for every deletion from now on.
    async function deleteOrderPaymentsAndLogs(orderIds) {
      if (!orderIds.length) return;
      const placeholders = orderIds.map(() => "?").join(",");
      try {
        await db.prepare(`DELETE FROM payments WHERE order_id IN (${placeholders})`).bind(...orderIds).run();
      } catch { /* payments table doesn't exist yet - nothing to clean up */ }
      try {
        await db.prepare(`DELETE FROM email_log WHERE order_id IN (${placeholders})`).bind(...orderIds).run();
      } catch { /* email_log table doesn't exist yet - nothing to clean up */ }
      try {
        await db.prepare(`DELETE FROM order_events WHERE order_id IN (${placeholders})`).bind(...orderIds).run();
      } catch { /* order_events table doesn't exist yet - nothing to clean up */ }
    }

    if (request.method === "DELETE") {
      const data = await request.json();

      // One-off cleanup for the backlog of payments/email_log rows left
      // behind by orders deleted before deleteOrderPaymentsAndLogs existed -
      // same "orphaned" maintenance pattern already used for design proofs/
      // production photos/design files (see design-proofs.js, production-
      // steps.js, design-files.js's own ?orphaned=1/purge_orphaned).
      if (data.action === "purge_orphaned_payments") {
        const { results: orphaned } = await db.prepare(
          `SELECT p.id FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE o.id IS NULL`
        ).all();
        if (!orphaned.length) return json({ success: true, purged: 0 });
        const ids = orphaned.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        await db.prepare(`DELETE FROM payments WHERE id IN (${placeholders})`).bind(...ids).run();
        return json({ success: true, purged: orphaned.length });
      }
      if (data.action === "purge_orphaned_email_log") {
        const { results: orphaned } = await db.prepare(
          `SELECT e.id FROM email_log e LEFT JOIN orders o ON o.id = e.order_id WHERE o.id IS NULL`
        ).all();
        if (!orphaned.length) return json({ success: true, purged: 0 });
        const ids = orphaned.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        await db.prepare(`DELETE FROM email_log WHERE id IN (${placeholders})`).bind(...ids).run();
        return json({ success: true, purged: orphaned.length });
      }

      const { id, ids, permanent } = data;
      const originUrl = new URL(request.url).origin;

      // The real, unrecoverable delete - everything the old DELETE used to
      // do unconditionally, now gated behind permanent:true (sent only by
      // the Trash tab's own "Delete forever"). Stock only gets restored
      // here, not on a soft-delete - a trashed order still conceptually
      // exists (it might get restored), so its stock effects stay in place
      // until it's actually gone for good.
      async function permanentlyDeleteOrders(orderIds) {
        await deleteOrphanedDesignProofs(orderIds);
        await deleteOrphanedProductionSteps(orderIds);
        await deleteOrphanedGangSheetUploads(orderIds);
        await deleteManualInvoicePdfs(orderIds);
        await deleteOrderPaymentsAndLogs(orderIds);
        for (const orderId of orderIds) await restoreStockForOrder(db, orderId, env, originUrl);
        const placeholders = orderIds.map(() => "?").join(",");
        await db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).bind(...orderIds).run();
      }

      // "Empty Trash" - permanently deletes every trashed quote/invoice in
      // one request rather than the Trash tab looping one DELETE per
      // selected row client-side. Reuses the exact same cleanup as a normal
      // permanent delete, just scoped to "everything currently trashed"
      // instead of an explicit id list.
      if (data.purge_all_trash && data.confirm) {
        const { results: trashed } = await db.prepare("SELECT id FROM orders WHERE deleted_at IS NOT NULL").all();
        const trashedIds = trashed.map((r) => r.id);
        if (trashedIds.length) await permanentlyDeleteOrders(trashedIds);
        return json({ success: true, purged: trashedIds.length });
      }

      if (Array.isArray(ids) && ids.length) {
        if (permanent) {
          await permanentlyDeleteOrders(ids);
        } else {
          const placeholders = ids.map(() => "?").join(",");
          await db.prepare(`UPDATE orders SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).bind(...ids).run();
        }
        return json({ success: true, count: ids.length });
      }
      if (permanent) {
        await permanentlyDeleteOrders([id]);
      } else {
        await db.prepare("UPDATE orders SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
      }
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
