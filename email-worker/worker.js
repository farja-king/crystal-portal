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

    // ---- 2. Headers Cloudflare already parses for us.
    const subject = message.headers.get("subject") || "(no subject)";
    const fromHeader = message.headers.get("from") || message.from || "";
    const { name: fromName, address: fromAddress } = parseAddress(fromHeader) || { name: "", address: message.from || "" };
    const toAddress = message.to || message.headers.get("to") || "";

    // ---- 3. Best-effort body extraction - see extractPlainText for the
    // actual multipart/encoding handling.
    const rawText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(rawBuf);
    const bodyText = extractPlainText(rawText, message.headers.get("content-type") || "text/plain");

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
          customer_id TEXT,
          is_read INTEGER DEFAULT 0,
          raw_r2_key TEXT,
          deleted_at TEXT,
          received_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      await env.DB.prepare(`
        INSERT INTO inbox_emails (id, direction, from_address, from_name, to_address, subject, body_text, customer_id, raw_r2_key)
        VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, fromAddress, fromName, toAddress, subject, bodyText.slice(0, 20000), customerId, r2Key).run();
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

// Best-effort plain-text extraction covering: a plain single-part email, a
// multipart/alternative or multipart/mixed email (picks text/plain, falls
// back to text/html with tags stripped), one level of nested multipart, and
// base64/quoted-printable decoding. Not a full MIME parser - anything more
// exotic just falls back to a truncated raw snippet, and the original is
// always in R2 regardless (see raw_r2_key).
function extractPlainText(rawText, topContentType) {
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
    return /html/i.test(topContentType) ? stripHtml(candidate) : candidate;
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

  if (plain && plain.trim()) return plain.trim();
  if (html && html.trim()) return stripHtml(html);
  return "(Could not extract a text preview - download the original to read this email.)";
}
