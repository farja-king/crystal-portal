// Shared event-log writer for the Activity Timeline (see the timeline panel
// in admin.html's viewOrder(), backed by orders.js's ?events_for= GET).
// Every meaningful thing that happens to a quote/invoice - created, sent,
// viewed, accepted/declined, paid, reminded, refunded, production progress -
// gets one row here, from whichever file actually does that thing. This is
// the one shared table nearly every order-touching Function writes to, so it
// lives in _lib rather than being owned by any single one of them.
//
// "viewed" events are deliberately deduped (see logViewOnce below) - a
// customer refreshing their own invoice ten times shouldn't produce ten
// timeline entries, just "first opened X ago". Every other event type logs
// every occurrence - a second payment, a second reminder, etc. are each
// genuinely worth their own row.
export async function ensureOrderEventsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id)").run();
}

export async function logOrderEvent(db, orderId, type, label) {
  try {
    await ensureOrderEventsTable(db);
    await db.prepare(
      "INSERT INTO order_events (id, order_id, type, label) VALUES (?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), orderId, type, label.slice(0, 500)).run();
  } catch (e) {
    // Never let a timeline write break the real action it's logging - a
    // failed INSERT here just means one missing row in a nice-to-have
    // feed, not a failed payment/send/whatever actually happened.
  }
}

// "Viewed by customer" only ever logs its FIRST occurrence per order+type -
// called with a distinct type per surface (e.g. 'viewed_quote',
// 'viewed_invoice', 'viewed_pdf') so opening the accept-quote link and later
// the PDF both still get their own single entry, without either spamming on
// repeat visits.
export async function logViewOnce(db, orderId, type, label) {
  try {
    await ensureOrderEventsTable(db);
    const existing = await db.prepare(
      "SELECT id FROM order_events WHERE order_id = ? AND type = ? LIMIT 1"
    ).bind(orderId, type).first();
    if (existing) return;
    await db.prepare(
      "INSERT INTO order_events (id, order_id, type, label) VALUES (?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), orderId, type, label.slice(0, 500)).run();
  } catch (e) {
    // Same reasoning as logOrderEvent - never break the real request over this.
  }
}
