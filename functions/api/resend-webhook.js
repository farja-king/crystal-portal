// Receives delivery-status events from Resend (delivered/bounced/complained/
// delayed) via a webhook configured in the Resend dashboard, and writes them
// back onto the matching email_log row (and, denormalized for cheap list-row
// display, onto orders.last_email_status) - so a failed send shows up in the
// portal itself instead of relying on Martin noticing a stray bounce in his
// own inbox. Resend signs these with Svix; RESEND_WEBHOOK_SECRET (the
// "whsec_..." value Resend shows when the webhook endpoint is created) is
// required to verify a request actually came from Resend before trusting it.
//
// Every send this portal makes stores Resend's own email id in
// email_log.resend_email_id (see functions/api/send-email.js and
// functions/api/design-proofs.js) - that id is how an event here gets
// matched back to a specific order/send, since Resend's payload only ever
// identifies the email by that id, never by anything of ours.
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Svix (what Resend's webhooks are built on) signs "{id}.{timestamp}.{body}"
// with HMAC-SHA256, base64-encoded, prefixed "v1,". The header can carry
// several space-separated signatures (key rotation) - a match on any of
// them is a valid signature.
async function verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignatureHeader) {
  const secretB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey(
    "raw", base64ToBytes(secretB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(new Uint8Array(sigBuffer));
  const provided = (svixSignatureHeader || "").split(" ").map((s) => s.split(",")[1]).filter(Boolean);
  return provided.includes(expected);
}

// Only these event types map to a status worth recording - anything
// unrecognised is ignored rather than erroring, since Resend can add new
// event types without warning. Events fire in roughly this order for a
// normal send (sent -> delivered -> opened -> clicked), each overwriting
// the previous status unconditionally below, so "clicked" naturally ends
// up as the most positive confirmation shown once it happens.
const STATUS_BY_EVENT = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.opened": "opened",
  "email.clicked": "clicked",
};

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!env.RESEND_WEBHOOK_SECRET) {
    return new Response("Webhook not configured - RESEND_WEBHOOK_SECRET is missing", { status: 500 });
  }

  const rawBody = await request.text();
  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing signature headers", { status: 400 });
  }

  const valid = await verifySvixSignature(env.RESEND_WEBHOOK_SECRET, svixId, svixTimestamp, rawBody, svixSignature);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const status = STATUS_BY_EVENT[payload.type];
  const emailId = payload.data && payload.data.email_id;
  if (!status || !emailId) {
    // Not an event type we track, or no email id to match against - not an
    // error, just nothing to do with it.
    return new Response("ok", { status: 200 });
  }

  // Independent guard, same "already exists" tolerance as every other
  // Function here - this endpoint can be hit before send-email.js's own
  // guards have ever run on a fresh D1.
  for (const col of ["resend_email_id TEXT", "delivery_status TEXT", "delivery_status_at TEXT", "delivery_detail TEXT"]) {
    try {
      await db.prepare(`ALTER TABLE email_log ADD COLUMN ${col}`).run();
    } catch {
      // already exists
    }
  }
  for (const col of ["last_email_status TEXT", "last_email_status_at TEXT", "last_email_status_detail TEXT"]) {
    try {
      await db.prepare(`ALTER TABLE orders ADD COLUMN ${col}`).run();
    } catch {
      // already exists
    }
  }
  // email_log/orders above only ever hold the LATEST status - fine for a
  // quick badge, but "how many times has this actually been opened, and
  // when" needs every event kept, not just overwritten by the next one.
  // This is that full history: one row per webhook call, never updated
  // once written, joined back to its email via resend_email_id in
  // functions/api/send-email.js's GET ?order_id= (which is what the
  // "View activity" report in admin.html's Communication History reads).
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS email_events (
      id TEXT PRIMARY KEY,
      resend_email_id TEXT NOT NULL,
      order_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT DEFAULT CURRENT_TIMESTAMP,
      detail TEXT
    )
  `).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_email_events_email ON email_events (resend_email_id)").run();

  // The bounce/complaint reason, if Resend included one - kept as a plain
  // string so it can just be shown as a tooltip, not parsed further.
  const detail = (payload.data && (payload.data.bounce?.message || payload.data.reason)) || null;

  const row = await db.prepare(
    "SELECT order_id FROM email_log WHERE resend_email_id = ?"
  ).bind(emailId).first();

  await db.prepare(
    "UPDATE email_log SET delivery_status = ?, delivery_status_at = CURRENT_TIMESTAMP, delivery_detail = ? WHERE resend_email_id = ?"
  ).bind(status, detail, emailId).run();
  await db.prepare(
    "INSERT INTO email_events (id, resend_email_id, order_id, event_type, detail) VALUES (?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), emailId, row ? row.order_id : null, status, detail).run();

  if (row && row.order_id) {
    await db.prepare(
      "UPDATE orders SET last_email_status = ?, last_email_status_at = CURRENT_TIMESTAMP, last_email_status_detail = ? WHERE id = ?"
    ).bind(status, detail, row.order_id).run();
  }

  return new Response("ok", { status: 200 });
}
