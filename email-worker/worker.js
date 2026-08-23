// Cloudflare Email Worker for the Crystal Portal built-in inbox.
//
// NOT part of the crystal-portal Pages project - Cloudflare Email Routing
// can only target a standalone Worker (the email() handler below isn't
// something a Pages Function can expose), so this has to be deployed as
// its own separate Worker via the dashboard. See the setup steps that came
// with this file for exactly how.
//
// What it does on every inbound email:
//   1. Reads the raw message, stores a full copy in R2 (a safety net - the
//      text extraction below is best-effort, not a complete MIME parser)
//   2. Does a best-effort plain-text extraction for the portal's list/detail
//      view (handles the common cases: plain text, multipart/alternative,
//      base64 / quoted-printable encoding, one level of nested multipart)
//   3. Matches the sender's address against the customers table, if any
//   4. Inserts a row into inbox_emails (same table functions/api/inbox.js
//      reads from - both need the same D1 database bound to them)
//   5. Emails a notification via Resend so a new email doesn't sit unseen -
//      relies on your phone's own Mail app pushing that notification,
//      rather than a separate push service (see git history for the
//      ntfy.sh attempt this replaced - its free anonymous tier is rate
//      limited across everyone hitting it from Cloudflare's IPs, not
//      practical to rely on without a paid plan)
//
// Also runs two scheduled sweeps against the portal (see scheduled() below) -
// the Pages project itself has no cron/scheduler of its own, so this
// Worker's Cron Trigger is what actually fires them:
//   - functions/api/payment-reminders.js action:'run' - the daily overdue-
//     invoice chase. Fine to check once a day.
//   - functions/api/review-requests.js action:'run' - sends the "hope you
//     enjoyed it, please leave a review" email once its scheduled time
//     (chosen via the portal's "Confirmed Pickup?" popup - Now/in a couple
//     hours/tomorrow midday/custom) arrives. A "couple hours" or "midday"
//     choice only lands close to the actual time if this cron runs more
//     often than once a day - IMPORTANT: set the Cron Trigger to something
//     like every 15-30 minutes (e.g. "*/15 * * * *"), not once daily, or
//     review requests will sit for up to a day before going out. Running
//     the payment-reminder check that often too is harmless - it already
//     only ever sends when an invoice is actually due for a nudge.
//
// Bindings this Worker needs (Settings -> Variables and Bindings, on the
// Worker itself - separate from the Pages project's bindings):
//   D1 database   DB             -> crystal-portal-db (same one Pages uses)
//   R2 bucket     DESIGN_FILES   -> crystal-portal-customer-designs (same one)
//   Secret        RESEND_API_KEY -> same Resend API key as the Pages project
//   Text var      RESEND_FROM_EMAIL -> e.g. "Crystal Portal <hello@embroidery.click>"
//   Text var      NOTIFY_EMAIL_TO -> the personal address to notify, e.g.
//                                    martinlyon@icloud.com or martinlyon70@gmail.com
//                                    - whichever has push notifications on
//                                    your phone already
//   Text var      PORTAL_ORIGIN  -> e.g. "https://portal.embroidery.click"
//   Secret        PORTAL_API_KEY -> generated from the portal's "API Key"
//                                    button (admin.html), lets this Worker
//                                    call the portal without the portal
//                                    password - see functions/_middleware.js's
//                                    X-API-Key check
// Plus a Cron Trigger (Settings -> Triggers) - see the frequency note above.

export default {
  async email(message, env, ctx) {
    const id = crypto.randomUUID();

    // ---- 1. Store the untouched original first, before any parsing can
    // go wrong - this is the safety net the rest of this file leans on.
    const rawBuf = await streamToArrayBuffer(message.raw);
    const r2Key = `email-inbox/${id}.eml`;
    if (env.DESIGN_FILES) {
      await env.DESIGN_FILES.put(r2Key, rawBuf, { httpMetadata: { contentType: "message/rfc822" } });
    }

    // ---- 2. Headers Cloudflare already parses for us. Subject/From can
    // arrive as raw RFC 2047 encoded-words (=?utf-8?B?...?=) whenever they
    // contain anything outside plain ASCII - even just the non-breaking
    // space some mail clients insert after "Re:" is enough to trigger it -
    // decode before using, or it shows as gibberish and breaks subject-based
    // thread matching (the whole encoded blob never looks like "Re: ...").
    const subject = decodeMimeEncodedWords(message.headers.get("subject")) || "(no subject)";
    const fromHeader = decodeMimeEncodedWords(message.headers.get("from")) || message.from || "";
    const { name: fromName, address: fromAddress } = parseAddress(fromHeader) || { name: "", address: message.from || "" };
    const toAddress = message.to || message.headers.get("to") || "";

    // ---- 3. Best-effort body extraction - see extractBody for the actual
    // multipart/encoding handling. Keeps both the plain-text preview (list/
    // search) and, when present, the original HTML part (rendered in a
    // sandboxed iframe in the portal) rather than the old approach of only
    // ever stripping HTML down to text - that's what produced the "could
    // not extract a text preview" message on HTML-only emails with no
    // text/plain part, even though the HTML itself was perfectly readable.
    const rawText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(rawBuf);
    const { text: bodyText, html: bodyHtml } = extractBody(rawText, message.headers.get("content-type") || "text/plain");

    // ---- 4. Match to an existing customer by email, if any - brand new
    // enquiries from people not on file simply get no match (customer_id
    // stays null), which is fine: they still show up in the inbox, just not
    // attached to any customer record.
    let customerId = null;
    if (env.DB && fromAddress) {
      try {
        const match = await env.DB.prepare(
          "SELECT id FROM customers WHERE lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1"
        ).bind(fromAddress).first();
        if (match) customerId = match.id;
      } catch (e) {
        // customers table not reachable/created yet - not fatal, just no match
      }
    }

    // ---- 4b. Conversation threading. This email's own Message-ID gets
    // stored so a *reply to it* (sent from functions/api/inbox.js) can
    // reference it via In-Reply-To. Going the other direction: if THIS
    // email is itself a reply (In-Reply-To/References points at a message
    // we already have), it joins that message's thread_id instead of
    // starting a new one.
    const messageId = message.headers.get("message-id") || null;
    const inReplyTo = message.headers.get("in-reply-to")
      || (message.headers.get("references") || "").trim().split(/\s+/).filter(Boolean).pop()
      || null;
    let threadId = id;
    if (env.DB && inReplyTo) {
      try {
        const parent = await env.DB.prepare("SELECT id, thread_id FROM inbox_emails WHERE message_id = ?").bind(inReplyTo).first();
        if (parent) threadId = parent.thread_id || parent.id;
      } catch (e) {
        // inbox_emails table not created yet - falls back to starting its own thread
      }
    }
    // Fallback: the header match found nothing (no In-Reply-To at all, or
    // it didn't match anything on file - some providers don't let a sender
    // override Message-ID, so what we stored on our own outbound copy may
    // not be what was actually delivered). Match by same correspondent +
    // normalized subject instead - less precise than a real Message-ID,
    // but far more resilient than relying on that round-tripping cleanly
    // through every mail provider.
    if (env.DB && threadId === id) {
      try {
        const { results: candidates } = await env.DB.prepare(`
          SELECT id, thread_id, subject FROM inbox_emails
          WHERE deleted_at IS NULL AND (from_address = ?1 OR to_address = ?1)
          ORDER BY received_at DESC LIMIT 20
        `).bind(fromAddress).all();
        const normalizeSubject = (s) => (s || "").replace(/^\s*(re|fwd?)\s*:\s*/gi, "").trim().toLowerCase();
        const target = normalizeSubject(subject);
        if (target) {
          const match = candidates.find((c) => normalizeSubject(c.subject) === target);
          if (match) threadId = match.thread_id || match.id;
        }
      } catch (e) {
        // no candidates / table issue - falls back to starting its own thread
      }
    }

    // ---- 5. Write the row. Same lazy CREATE TABLE as functions/api/inbox.js
    // - whichever of the two runs first is the one that actually creates it.
    if (env.DB) {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS inbox_emails (
          id TEXT PRIMARY KEY,
          direction TEXT DEFAULT 'inbound',
          from_address TEXT,
          from_name TEXT,
          to_address TEXT,
          subject TEXT,
          body_text TEXT,
          body_html TEXT,
          customer_id TEXT,
          is_read INTEGER DEFAULT 0,
          raw_r2_key TEXT,
          deleted_at TEXT,
          received_at TEXT DEFAULT CURRENT_TIMESTAMP,
          saved_to_customer INTEGER DEFAULT 0,
          message_id TEXT,
          in_reply_to TEXT,
          thread_id TEXT
        )
      `).run();
      // CREATE TABLE IF NOT EXISTS is a no-op against a table that already
      // existed before these columns were added to it - same fallback as
      // functions/api/inbox.js, needed here too since either side could be
      // the first to ever touch the table on a fresh deploy.
      for (const col of ["saved_to_customer INTEGER DEFAULT 0", "message_id TEXT", "in_reply_to TEXT", "thread_id TEXT", "body_html TEXT"]) {
        try {
          await env.DB.prepare(`ALTER TABLE inbox_emails ADD COLUMN ${col}`).run();
        } catch (e) {
          // already exists
        }
      }

      await env.DB.prepare(`
        INSERT INTO inbox_emails (id, direction, from_address, from_name, to_address, subject, body_text, body_html, customer_id, raw_r2_key, message_id, in_reply_to, thread_id)
        VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, fromAddress, fromName, toAddress, subject, bodyText.slice(0, 20000), bodyHtml ? bodyHtml.slice(0, 200000) : null, customerId, r2Key, messageId, inReplyTo, threadId).run();
    }

    // ---- 6. Notification - a plain email via Resend (same service already
    // sending quotes/invoices) rather than a push service, since a phone's
    // Mail app already pushes new-mail notifications natively. Sidesteps
    // ntfy.sh's anonymous rate limit entirely (see git history on this file
    // if that's ever worth revisiting) by reusing infrastructure that's
    // already proven reliable. Doesn't block the email having been saved
    // (that already happened above); logs the response either way.
    if (env.RESEND_API_KEY && env.NOTIFY_EMAIL_TO) {
      ctx.waitUntil(
        (async () => {
          try {
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.RESEND_API_KEY.trim()}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: env.RESEND_FROM_EMAIL || "Crystal Portal <onboarding@resend.dev>",
                to: [env.NOTIFY_EMAIL_TO.trim()],
                subject: `New email: ${subject}`,
                html: `<p>New message in the portal Inbox, from <strong>${fromName || fromAddress}</strong>:</p><p>${subject}</p>`,
              }),
            });
            const bodyText = await res.text();
            console.log(`Notification email response: ${res.status} ${res.statusText} - ${bodyText}`);
          } catch (e) {
            console.log(`Notification email failed: ${e.message}`);
          }
        })()
      );
    }
  },

  // Fired by the Cron Trigger configured on this Worker (Settings ->
  // Triggers) - just kicks off the actual chase logic, which lives in
  // functions/api/payment-reminders.js so it stays next to the rest of the
  // orders/invoices code instead of being duplicated here. Authenticated
  // with X-API-Key rather than the portal password since there's no human
  // around to type one in - see functions/_middleware.js.
  async scheduled(event, env, ctx) {
    if (!env.PORTAL_ORIGIN || !env.PORTAL_API_KEY) {
      console.log("Skipping scheduled sweeps: PORTAL_ORIGIN or PORTAL_API_KEY isn't set on this Worker.");
      return;
    }

    async function sweep(path) {
      try {
        const res = await fetch(`${env.PORTAL_ORIGIN}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": env.PORTAL_API_KEY },
          body: JSON.stringify({ action: "run" }),
        });
        const bodyText = await res.text();
        console.log(`${path} run: ${res.status} ${res.statusText} - ${bodyText}`);
      } catch (e) {
        console.log(`${path} run failed: ${e.message}`);
      }
    }

    ctx.waitUntil(Promise.all([
      sweep("/api/payment-reminders"),
      sweep("/api/review-requests"),
      // Stale-quote follow-up - a quote sent but never accepted/declined
      // gets one gentle nudge past the configured threshold. See
      // functions/api/quote-followups.js - self-limiting the same way
      // (only sends once per quote), safe to hit every 15 min.
      sweep("/api/quote-followups"),
      // Self-throttled to ~once every 24 hours inside functions/api/
      // backup.js itself (checks the last successful backup_log row) -
      // safe to hit every 15 minutes like the other two sweeps, it just
      // no-ops most of the time.
      sweep("/api/backup"),
      // ~11 months after a customer's last portal invoice, one nudge to
      // reorder - see functions/api/reorder-reminders.js. Self-limiting
      // the same way as quote-followups (only sends once per order cycle).
      sweep("/api/reorder-reminders"),
      // 30-day retention sweep for customer-uploaded DTF-Prep gang sheets -
      // see functions/api/gang-sheet-cleanup.js. Self-throttled the same
      // way as backup.js, safe to hit every 15 minutes.
      sweep("/api/gang-sheet-cleanup"),
    ]));
  },
};

async function streamToArrayBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

function asciiSafe(str) {
  return String(str).replace(/[^\x20-\x7e]/g, "?");
}

// "John Smith" <john@x.com>  or  john@x.com
function parseAddress(header) {
  if (!header) return null;
  const match = header.match(/^\s*"?([^"<]*)"?\s*<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  if (!match) return { name: "", address: header.trim() };
  return { name: (match[1] || "").trim(), address: match[2].trim() };
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, "") // soft line break
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(str) {
  try {
    const binary = atob(str.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch (e) {
    return str;
  }
}

// Decodes RFC 2047 "encoded-word" syntax (=?charset?B?...?= or ?Q?),
// used for any header (Subject, From display-name, ...) that contains
// non-ASCII - triggered by far more than exotic characters; even the
// non-breaking space some clients insert after "Re:" is enough. Handles
// the common single-word case; a header with no encoded-word is returned
// unchanged.
function decodeMimeEncodedWords(str) {
  if (!str) return str;
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, text) => {
    try {
      let bytes;
      if (encoding.toUpperCase() === "B") {
        const binary = atob(text);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } else {
        const withSpaces = text.replace(/_/g, " ");
        const out = [];
        for (let i = 0; i < withSpaces.length; i++) {
          if (withSpaces[i] === "=" && i + 2 < withSpaces.length) {
            out.push(parseInt(withSpaces.substr(i + 1, 2), 16));
            i += 2;
          } else {
            out.push(withSpaces.charCodeAt(i));
          }
        }
        bytes = new Uint8Array(out);
      }
      return new TextDecoder(charset || "utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
    } catch (e) {
      return match; // couldn't decode - leave the raw encoded-word rather than losing data
    }
  });
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Splits a body on a MIME boundary into { headers: Map, body: string } parts
// - handles exactly one level of nesting if a part is itself multipart
// (multipart/alternative wrapped in multipart/mixed, the common case for a
// plain HTML+text email with an attachment). Anything deeper falls back to
// whatever plain text can be found.
function splitMultipart(body, boundary) {
  const marker = "--" + boundary;
  const pieces = body.split(marker).slice(1, -1); // drop preamble and the closing "--boundary--"
  return pieces.map((piece) => {
    const trimmed = piece.replace(/^\r?\n/, "");
    const headerEnd = trimmed.search(/\r?\n\r?\n/);
    if (headerEnd === -1) return { headers: new Map(), body: trimmed };
    const headerBlock = trimmed.slice(0, headerEnd);
    const partBody = trimmed.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
    const headers = new Map();
    for (const line of headerBlock.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > -1) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    return { headers, body: partBody };
  });
}

function decodePart(body, contentTransferEncoding) {
  const enc = (contentTransferEncoding || "").toLowerCase();
  if (enc === "base64") return decodeBase64(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

// Best-effort body extraction covering: a plain single-part email, a
// multipart/alternative or multipart/mixed email (picks text/plain and/or
// text/html), one level of nested multipart, and base64/quoted-printable
// decoding. Not a full MIME parser - anything more exotic just falls back
// to a truncated raw snippet, and the original is always in R2 regardless
// (see raw_r2_key). Returns both the plain-text preview (used in the list/
// search) and the raw HTML part when one exists, so the portal can render
// the actual email instead of only a stripped-down text approximation.
function extractBody(rawText, topContentType) {
  const headerBoundaryIdx = rawText.search(/\r?\n\r?\n/);
  const body = headerBoundaryIdx === -1 ? rawText : rawText.slice(headerBoundaryIdx).replace(/^\r?\n\r?\n/, "");

  const boundaryMatch = topContentType.match(/boundary="?([^";]+)"?/i);
  if (!/multipart/i.test(topContentType) || !boundaryMatch) {
    // Single part - top-level Content-Type is the only encoding info we have
    // for it, but Cloudflare's message.headers only exposes Content-Type,
    // not Content-Transfer-Encoding, at the top level reliably across all
    // sending clients, so just try both decodings and keep whichever looks
    // more like real text (fewer stray '=' / control characters).
    const asIs = body.trim();
    const qp = decodeQuotedPrintable(body).trim();
    const candidate = qp.length && qp !== asIs ? qp : asIs;
    if (/html/i.test(topContentType)) return { text: stripHtml(candidate), html: candidate };
    return { text: candidate, html: null };
  }

  const parts = splitMultipart(body, boundaryMatch[1]);
  let plain = null;
  let html = null;

  for (const part of parts) {
    const ct = part.headers.get("content-type") || "";
    const cte = part.headers.get("content-transfer-encoding") || "";

    if (/multipart/i.test(ct)) {
      const nestedBoundary = ct.match(/boundary="?([^";]+)"?/i);
      if (nestedBoundary) {
        for (const nested of splitMultipart(part.body, nestedBoundary[1])) {
          const nCt = nested.headers.get("content-type") || "";
          const nCte = nested.headers.get("content-transfer-encoding") || "";
          if (/text\/plain/i.test(nCt) && !plain) plain = decodePart(nested.body, nCte);
          if (/text\/html/i.test(nCt) && !html) html = decodePart(nested.body, nCte);
        }
      }
      continue;
    }
    if (/text\/plain/i.test(ct) && !plain) plain = decodePart(part.body, cte);
    if (/text\/html/i.test(ct) && !html) html = decodePart(part.body, cte);
  }

  const htmlOut = html && html.trim() ? html.trim() : null;
  if (plain && plain.trim()) return { text: plain.trim(), html: htmlOut };
  if (htmlOut) return { text: stripHtml(htmlOut), html: htmlOut };
  return { text: "(Could not extract a text preview - download the original to read this email.)", html: null };
}
