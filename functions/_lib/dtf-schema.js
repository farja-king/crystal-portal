// Shared guard for the DTF-Prep account-tier/credit columns on `customers`.
// Bug fix: these columns were only ever added by customers.js's own guard,
// so gang-sheet-auth.js (hit first, at sign-in, on a fresh magic-link
// request) could throw "no such column: dtf_account_tier" if the admin
// Customers tab hadn't been opened yet since this feature deployed - which
// is exactly what happened in production. Every gang-sheet-*.js endpoint
// that reads or writes these columns now calls this first, so none of them
// depend on another endpoint having run before it. Idempotent/safe to call
// on every request, same "swallow the already-exists error" pattern as
// every other ALTER TABLE guard in this codebase.
export async function ensureDtfCustomerColumns(db) {
  for (const col of [
    "dtf_account_tier TEXT",
    "dtf_credit_status TEXT",
    "dtf_credit_limit REAL",
    "dtf_credit_notes TEXT",
    // Backs the Dashboard's "new DTF credit application" popup (see
    // gang-sheet-admin.js's ?new_credit=1/mark_seen) - same seen_by_staff
    // pattern as gang_sheet_uploads/payments, so a credit application
    // submitted while nobody's looking at the portal still gets surfaced.
    // Left NULL (not defaulted to 0) for a customer who's never applied,
    // so the popup query's own IS NOT NULL guard on dtf_credit_status is
    // enough to keep them out without this column needing its own check.
    "dtf_credit_seen_by_staff INTEGER DEFAULT 1",
  ]) {
    try {
      await db.prepare(`ALTER TABLE customers ADD COLUMN ${col}`).run();
    } catch {
      // already exists
    }
  }
}
