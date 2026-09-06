export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    // Without this, a GET to this same URL (always identical - no query
    // params vary it) is fair game for the browser to serve straight from
    // its HTTP cache instead of hitting the Worker - so a customer added or
    // edited in one request could stay invisible to search/lookups in
    // another that already has this URL cached (see the same fix in
    // products.js, which hit the identical symptom for saved items).
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        company TEXT,
        email TEXT,
        phone TEXT,
        type TEXT,
        discount_pct REAL DEFAULT 0,
        notes TEXT,
        square_customer_id TEXT,
        lifetime_spend REAL DEFAULT 0,
        transaction_count INTEGER DEFAULT 0,
        last_visit TEXT,
        address_1 TEXT,
        address_2 TEXT,
        city TEXT,
        county TEXT,
        postcode TEXT,
        deleted_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // The table already existed on live D1 before these columns were added
    // to the CREATE TABLE above - "IF NOT EXISTS" is a no-op against an
    // existing table, so they need adding here instead (same pattern as
    // products.js). ALTER TABLE throws if the column's already there, so
    // each attempt is swallowed individually.
    for (const col of [
      "square_customer_id TEXT", "lifetime_spend REAL DEFAULT 0", "transaction_count INTEGER DEFAULT 0", "last_visit TEXT",
      "address_1 TEXT", "address_2 TEXT", "city TEXT", "county TEXT", "postcode TEXT", "deleted_at TEXT",
      // portal_token - this customer's own unguessable "my orders" link
      // identifier (see functions/api/my-orders.js and my-orders.html).
      // One per customer, not per-order like accept_token/pay_token -
      // generated lazily by send-email.js the first time anything's ever
      // emailed to them, and never regenerated after that, so the link
      // they're given stays good indefinitely rather than going stale.
      "portal_token TEXT",
      // dtf_flat_sheet_price - a trade/bespoke customer's own fixed price
      // for a DTF-Prep gang sheet, replacing the standard length-based rate
      // entirely (any length up to the 600mm max costs this one figure).
      // NULL means "no override, use standard pricing" - see gang-sheet-
      // upload.js, where this is looked up and applied server-side so the
      // discount can't be bypassed by an unauthenticated/tampered request.
      "dtf_flat_sheet_price REAL",
      // review_requested - staff-ticked "we've already asked this customer
      // for a Google review" (any channel, not just this portal), so the
      // automatic ask that fires off the Production Tracker's "Order
      // collected" step doesn't ask the same customer again on a later
      // order too. Deliberately customer-level, not per-order - see
      // review-requests.js's confirm_pickup, which refuses to schedule/send
      // while this is set unless the request is explicitly marked manual
      // (the "Send Review Request Manually" override in admin.html).
      "review_requested INTEGER DEFAULT 0",
      // dtf_account_tier - NULL means "not a DTF-Prep customer at all" (an
      // ordinary store customer never touches this). Set to 'guest' the
      // moment someone signs up via gang-sheet-auth.js's magic link, or set
      // manually by staff via gang-sheet-admin.js's grant_access action for
      // an existing store customer who should get DTF-Prep access too.
      // Flips guest -> 'registered' when gang-sheet-account.js's
      // complete_profile action succeeds (name + postcode on file) - see
      // gang-sheet-upload.js, where 'registered' waives the upscale charge.
      "dtf_account_tier TEXT",
      // dtf_credit_status / dtf_credit_limit / dtf_credit_notes - a DTF-Prep
      // credit account, applied for by the customer (gang-sheet-account.js's
      // apply_credit, registered tier only) and approved/rejected by staff
      // (gang-sheet-admin.js's credit_decision, which also sets the limit).
      // NULL status = never applied. Balance isn't stored here - it's
      // computed on demand from unpaid orders at checkout time, see
      // gang-sheet-checkout.js.
      "dtf_credit_status TEXT",
      "dtf_credit_limit REAL",
      "dtf_credit_notes TEXT",
    ]) {
      try {
        await db.prepare(`ALTER TABLE customers ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    // GET: everyone by default; ?trash=1 flips to *only* the soft-deleted
    // ones (see DELETE below) - a customer merged or deleted by mistake
    // (e.g. picking the wrong side of a merge, or the Square-activity
    // combining bug that prompted adding this trash in the first place)
    // stays recoverable rather than being gone the moment Delete is clicked.
    if (request.method === "GET") {
      const trash = new URL(request.url).searchParams.get("trash");
      const { results } = await db.prepare(
        trash
          ? "SELECT * FROM customers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
          : "SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY name ASC"
      ).all();

      // lifetime_spend/transaction_count/last_visit above are pure Square-
      // import figures (see the comment on those columns further down, and
      // admin.html's renderCustomersTable) - left untouched here since a lot
      // of other code (the merge-customers flow especially) assumes they
      // mean exactly that. Instead, fold in a customer's own portal-built
      // invoices as separate portal_* fields, so the Directory's Activity
      // column can show combined totals without a customer who's never
      // synced from Square (or has invoices this app built directly)
      // wrongly showing "no activity" just because Square never saw them.
      // Order count includes every invoice regardless of paid status (an
      // unpaid invoice is still a real job on the books); spend only counts
      // what's actually been paid (paid_status 'paid'/'partial'), via
      // amount_paid rather than the invoice's full total.
      let portalByCustomer = {};
      try {
        const { results: portalRows } = await db.prepare(`
          SELECT customer_id,
            COUNT(*) AS portal_order_count,
            SUM(CASE WHEN paid_status IN ('paid', 'partial') THEN amount_paid ELSE 0 END) AS portal_spend,
            MAX(created_at) AS portal_last_order
          FROM orders
          WHERE doc_type = 'invoice' AND customer_id IS NOT NULL AND customer_id <> ''
          GROUP BY customer_id
        `).all();
        portalRows.forEach((r) => { portalByCustomer[r.customer_id] = r; });
      } catch {
        // orders table doesn't exist yet on a brand-new DB - no portal
        // activity to fold in, Square-only figures still work fine.
      }

      const withPortalActivity = results.map((c) => {
        const p = portalByCustomer[c.id];
        return {
          ...c,
          portal_order_count: p ? p.portal_order_count : 0,
          portal_spend: p ? p.portal_spend : 0,
          portal_last_order: p ? p.portal_last_order : null,
        };
      });

      return new Response(JSON.stringify(withPortalActivity), { headers: corsHeaders });
    }

    // POST: Save a new customer, or bulk-import { rows: [...] } from a Square
    // export - upserts by id (see importCustomersCsv in admin.html, which
    // derives a stable id from the Square Customer ID so re-importing an
    // updated export updates existing customers rather than duplicating them).
    if (request.method === "POST") {
      const data = await request.json();

      if (Array.isArray(data.rows)) {
        const stmt = db.prepare(`
          INSERT INTO customers (
            id, name, company, email, phone, type, discount_pct, notes,
            square_customer_id, lifetime_spend, transaction_count, last_visit,
            address_1, address_2, city, county, postcode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            company = excluded.company,
            email = excluded.email,
            phone = excluded.phone,
            square_customer_id = excluded.square_customer_id,
            lifetime_spend = excluded.lifetime_spend,
            transaction_count = excluded.transaction_count,
            last_visit = excluded.last_visit,
            address_1 = excluded.address_1,
            address_2 = excluded.address_2,
            city = excluded.city,
            county = excluded.county,
            postcode = excluded.postcode,
            deleted_at = NULL
        `);
        // A re-import matching a previously-deleted customer's id un-deletes
        // them - if they're back in a fresh Square export, they're active.
        // type/discount_pct/notes are left off the DO UPDATE SET - those are
        // Martin's own edits (trade discount, notes), which a re-import of
        // the same Square data shouldn't ever overwrite.

        const batch = data.rows.map((r) => stmt.bind(
          r.id,
          r.name || "Unnamed",
          r.company || "",
          r.email || "",
          r.phone || "",
          r.type || "Retail",
          r.discount_pct ?? 0,
          r.notes || "",
          r.square_customer_id || "",
          Number(r.lifetime_spend) || 0,
          Number(r.transaction_count) || 0,
          r.last_visit || "",
          r.address_1 || "",
          r.address_2 || "",
          r.city || "",
          r.county || "",
          r.postcode || ""
        ));

        await db.batch(batch);
        return new Response(JSON.stringify({ success: true, imported: batch.length }), { headers: corsHeaders });
      }

      const id = data.id || crypto.randomUUID();

      await db.prepare(`
        INSERT INTO customers (id, name, company, email, phone, type, discount_pct, notes, address_1, address_2, city, county, postcode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        data.name || "Unnamed",
        data.company || "",
        data.email || "",
        data.phone || "",
        data.type || "Retail",
        data.discount_pct ?? 0,
        data.notes || "",
        data.address_1 || "",
        data.address_2 || "",
        data.city || "",
        data.county || "",
        data.postcode || ""
      ).run();

      return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
    }

    // PUT: Update an existing customer. Fetches the existing row first and
    // falls back to it field-by-field (data.field ?? existing.field) rather
    // than blindly overwriting with "" - the ordinary Edit form never sends
    // square_customer_id/lifetime_spend/transaction_count/last_visit at all
    // (those are Square-only, not editable there), so without the fallback
    // every plain edit would silently wipe a customer's Square activity.
    // Merging two duplicate customers (see performMergeCustomers in
    // admin.html) is the one caller that *does* set these explicitly, to
    // combine the duplicate's activity into the record being kept before
    // it's deleted.
    if (request.method === "PUT") {
      const data = await request.json();
      const existing = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(data.id).first();
      if (!existing) return new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: corsHeaders });

      // Restore from the trash - see DELETE below, and GET's ?trash=1.
      if (data.restore) {
        await db.prepare("UPDATE customers SET deleted_at = NULL WHERE id = ?").bind(data.id).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // Same lazy-generation pattern as accept_token/pay_token in
      // send-email.js, just triggered from the admin side instead - the
      // "💬 WhatsApp" button (admin.html) needs this customer's My Orders
      // link before it can build the wa.me message, and a customer who's
      // never been emailed anything yet won't have one otherwise.
      if (data.action === "ensure_portal_token") {
        let portalToken = existing.portal_token;
        if (!portalToken) {
          portalToken = crypto.randomUUID();
          await db.prepare("UPDATE customers SET portal_token = ? WHERE id = ?").bind(portalToken, data.id).run();
        }
        return new Response(JSON.stringify({ success: true, portal_token: portalToken }), { headers: corsHeaders });
      }

      // "Already asked (this customer) for a review" toggle - the Production
      // Tracker's "Order collected" step in admin.html. Its own narrow
      // action, same reasoning as ensure_portal_token above: the main PUT
      // below is a full-record replace (every field has to be resent or it
      // gets blanked/defaulted), and this toggle is fired from a checkbox
      // that only ever has the customer's id and the new boolean to hand.
      if (data.action === "set_review_requested") {
        await db.prepare("UPDATE customers SET review_requested = ? WHERE id = ?").bind(data.review_requested ? 1 : 0, data.id).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      await db.prepare(`
        UPDATE customers
        SET name = ?, company = ?, email = ?, phone = ?, type = ?, discount_pct = ?, notes = ?,
            address_1 = ?, address_2 = ?, city = ?, county = ?, postcode = ?,
            square_customer_id = ?, lifetime_spend = ?, transaction_count = ?, last_visit = ?,
            dtf_flat_sheet_price = ?
        WHERE id = ?
      `).bind(
        data.name || "Unnamed",
        data.company || "",
        data.email || "",
        data.phone || "",
        data.type || "Retail",
        data.discount_pct ?? 0,
        data.notes || "",
        data.address_1 || "",
        data.address_2 || "",
        data.city || "",
        data.county || "",
        data.postcode || "",
        data.square_customer_id ?? existing.square_customer_id,
        data.lifetime_spend ?? existing.lifetime_spend,
        data.transaction_count ?? existing.transaction_count,
        data.last_visit ?? existing.last_visit,
        data.dtf_flat_sheet_price === "" || data.dtf_flat_sheet_price == null ? null : Number(data.dtf_flat_sheet_price),
        data.id
      ).run();

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // DELETE: soft-deletes by default (sets deleted_at, so it drops out of
    // the normal list and search but stays recoverable via ?trash=1 / the
    // restore action above) - only actually removed from the database when
    // permanent:true is explicitly sent (from the trash view's own "Delete
    // forever", or the deliberate cleanup pass this whole thing exists for).
    if (request.method === "DELETE") {
      const data = await request.json();
      const { id, permanent } = data;
      // "Empty Trash" - permanently deletes every trashed customer in one
      // request. Same R2 cleanup as the single-customer permanent delete
      // below, just gathered across every trashed row first. See
      // products.js/orders.js/stock.js's own purge_all_trash for why this
      // exists - the Trash tab's per-row bulk delete loops one request per
      // selected row client-side.
      if (data.purge_all_trash && data.confirm) {
        const { results: trashedCustomers } = await db.prepare(
          "SELECT id FROM customers WHERE deleted_at IS NOT NULL"
        ).all();
        const trashedIds = trashedCustomers.map((r) => r.id);
        if (trashedIds.length && env.DESIGN_FILES) {
          try {
            const placeholders = trashedIds.map(() => "?").join(",");
            const { results: files } = await db.prepare(
              `SELECT r2_key FROM design_files WHERE customer_id IN (${placeholders})`
            ).bind(...trashedIds).all();
            await Promise.all(files.map((f) => env.DESIGN_FILES.delete(f.r2_key).catch(() => {})));
            await db.prepare(`DELETE FROM design_files WHERE customer_id IN (${placeholders})`).bind(...trashedIds).run();
          } catch (e) {
            // design_files table doesn't exist yet - nothing to clean up
          }
        }
        if (trashedIds.length) {
          const placeholders = trashedIds.map(() => "?").join(",");
          await db.prepare(`DELETE FROM customers WHERE id IN (${placeholders})`).bind(...trashedIds).run();
        }
        return new Response(JSON.stringify({ success: true, purged: trashedIds.length }), { headers: corsHeaders });
      }
      if (permanent) {
        // Their design file backups (functions/api/design-files.js) are
        // scoped to this customer_id and nothing else references them -
        // permanently deleting the customer would otherwise strand those
        // files in R2 forever with no row left to find them by.
        if (env.DESIGN_FILES) {
          try {
            const { results: files } = await db.prepare(
              "SELECT r2_key FROM design_files WHERE customer_id = ?"
            ).bind(id).all();
            await Promise.all(files.map((f) => env.DESIGN_FILES.delete(f.r2_key).catch(() => {})));
            await db.prepare("DELETE FROM design_files WHERE customer_id = ?").bind(id).run();
          } catch (e) {
            // design_files table doesn't exist yet - nothing to clean up
          }
        }
        await db.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
      } else {
        await db.prepare("UPDATE customers SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
