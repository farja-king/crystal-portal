// 30-day retention sweep for customer-uploaded DTF-Prep gang sheets - the
// piece that makes the promise on DTF-Prep's own checkout page ("Uploaded
// gang sheets are stored for 30 days and then automatically removed")
// actually true. Self-throttled the same way as backup.js, safe to hit
// every 15 minutes from the cron Worker. Staff/API-key gated (no public
// exemption) - this is a destructive maintenance sweep, not customer- or
// public-facing.
const CLEANUP_TIMEOUT_HOURS = 23; // "once every 24 hours" off a 15-min cron
const RETENTION_DAYS = 30;

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!db) return json({ error: "Database isn't set up yet" }, 500);

  try {
    await db.prepare(`ALTER TABLE gang_sheet_uploads ADD COLUMN keep_file INTEGER DEFAULT 0`).run();
  } catch {
    // already exists
  }
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS gang_sheet_cleanup_log (
      id TEXT PRIMARY KEY,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expired_count INTEGER DEFAULT 0
    )
  `).run();
  // Guarded independently here too (same convention as every other table in
  // this codebase) - this sweep could in principle run before gang-sheet-
  // checkout.js ever has, on a cold deploy.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS gang_sheet_pending_checkouts (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      upload_ids TEXT NOT NULL,
      total REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const data = await request.json().catch(() => ({}));
  if (data.action !== "run") return json({ error: "Unknown action" }, 400);

  if (!data.force) {
    const last = await db.prepare("SELECT started_at FROM gang_sheet_cleanup_log ORDER BY started_at DESC LIMIT 1").first();
    if (last) {
      const ageMs = Date.now() - new Date(last.started_at.includes("T") ? last.started_at : last.started_at.replace(" ", "T") + "Z").getTime();
      if (ageMs < CLEANUP_TIMEOUT_HOURS * 3600000) return json({ success: true, skipped: true });
    }
  }

  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();

    // Soft-expire: the R2 bytes actually go, but the D1 row (filename,
    // dimensions, price, which order it was attached to) stays forever -
    // same "keep the record, drop the bytes" pattern design-proofs.js's
    // remove_storage uses, so an old order's history still shows what was
    // printed even after the file itself is gone.
    const { results: expiring } = await db.prepare(
      "SELECT id, r2_key FROM gang_sheet_uploads WHERE uploaded_at < ? AND keep_file = 0 AND status != 'expired'"
    ).bind(cutoff).all();

    if (expiring.length && bucket) {
      await Promise.all(expiring.map((r) => bucket.delete(r.r2_key).catch(() => {})));
    }
    if (expiring.length) {
      const placeholders = expiring.map(() => "?").join(",");
      await db.prepare(`UPDATE gang_sheet_uploads SET status = 'expired' WHERE id IN (${placeholders})`)
        .bind(...expiring.map((r) => r.id)).run();
    }

    // Login tokens are worthless once expired regardless of keep_file - see
    // gang-sheet-auth.js, this table only ever exists to enforce single-use
    // within a 15-minute window.
    await db.prepare("DELETE FROM gang_sheet_login_tokens WHERE expires_at < ?").bind(Math.floor(Date.now() / 1000)).run();

    // Stray gang_sheet_pending_checkouts rows - created by gang-sheet-
    // checkout.js right before redirecting to Square, deleted by square-
    // webhook.js the moment payment completes. One that's still here after
    // a few hours means the customer abandoned the Square page - nothing
    // customer-facing depends on it surviving (the actual order was never
    // created for it in the first place - that's the whole point), so it's
    // just hard-deleted. Piggybacks on this sweep's own once-a-day throttle
    // rather than a separate schedule - a few hours' slack before it's
    // actually removed doesn't matter for a row nobody's waiting on.
    const pendingCutoff = new Date(Date.now() - 6 * 3600000).toISOString();
    const { meta: pendingMeta } = await db.prepare(
      "DELETE FROM gang_sheet_pending_checkouts WHERE created_at < ?"
    ).bind(pendingCutoff).run();

    await db.prepare("INSERT INTO gang_sheet_cleanup_log (id, expired_count) VALUES (?, ?)")
      .bind(crypto.randomUUID(), expiring.length).run();

    return json({ success: true, expired: expiring.length, pending_checkouts_removed: (pendingMeta && pendingMeta.changes) || 0 });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
