// Passwordless "magic link" login for DTF-Prep customers - matches or
// creates a crystal-portal customers row by email, then emails a short-lived
// sign-in link. No password anywhere.
//
// Two token types (see functions/_lib/customer-token.js for the signing
// scheme - same idea as the staff session in functions/api/auth.js, but a
// separate signing secret, auth_config.customer_token_secret, so a staff
// password change never invalidates every customer's DTF-Prep session):
//  - magic-link token (purpose "gang-sheet-login", 15 min) - single-use,
//    tracked in gang_sheet_login_tokens so a forwarded/intercepted email
//    can't be redeemed twice within its window. Signature+expiry alone
//    can't stop that - replaying a still-valid token is exactly what a
//    magic link *is* until something marks it spent.
//  - session token (purpose "gang-sheet-session", 30 days) - stateless,
//    handed back to DTF-Prep as Authorization: Bearer on every later call
//    (DTF-Prep and this portal are different origins, so no shared cookie).
import { signCustomerToken, verifyCustomerToken, randomHex } from "../_lib/customer-token.js";
import { emailShell } from "../_lib/email-template.js";
import { ensureDtfCustomerColumns } from "../_lib/dtf-schema.js";

const LOGIN_TOKEN_TTL = 15 * 60;
const SESSION_TOKEN_TTL = 30 * 24 * 60 * 60;

// DTF-Prep passes along why it's asking for sign-in (its own login modal
// shows matching copy - see LOGIN_REASONS in src/cart.js), so the emailed
// link says the same thing rather than always "finish your order" even
// when what triggered it was Upscale or the Ready-to-Upload page.
const REQUEST_REASON_COPY = {
  checkout: {
    subject: "Sign in to DTF-Prep",
    heading: "Sign in to DTF-Prep",
    body: "Click below to sign in and finish your order. This link works once and expires in 15 minutes.",
    cta: "Sign in to DTF-Prep",
  },
  upload: {
    subject: "Sign in to upload your gang sheet",
    heading: "Sign in to upload your gang sheet",
    body: "Click below to sign in and upload your print-ready gang sheet. This link works once and expires in 15 minutes.",
    cta: "Sign in to upload",
  },
  upscale: {
    subject: "Sign in to upscale your image",
    heading: "Sign in to upscale to 300 DPI",
    body: "Click below to sign in and upscale your image to 300 DPI. This link works once and expires in 15 minutes. Registered accounts (with a name and address on file) get DPI upscaling for free.",
    cta: "Sign in to upscale",
  },
  account: {
    subject: "Sign in to DTF-Prep",
    heading: "Sign in to DTF-Prep",
    body: "Click below to sign in to your account. This link works once and expires in 15 minutes.",
    cta: "Sign in to DTF-Prep",
  },
};

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!db) return json({ error: "Database isn't set up yet" }, 500);
  if (!env.DTF_PREP_ORIGIN) return json({ error: "DTF-Prep isn't configured yet - DTF_PREP_ORIGIN is missing" }, 500);

  try {
    // customers - same CREATE TABLE/ALTER TABLE guard as customers.js. Each
    // Function's D1 guards are independent, not shared just because another
    // file also touches the same table (established convention here).
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
    for (const col of ["deleted_at TEXT", "portal_token TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE customers ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }
    await ensureDtfCustomerColumns(db);

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS gang_sheet_login_tokens (
        jti TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        used_at TEXT,
        expires_at INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // auth_config.customer_token_secret - separate signing key from the
    // staff session's auth_config.secret, lazily created the first time
    // this endpoint runs (same "generate on first use" shape as
    // auth_config.api_key in auth.js).
    try {
      await db.prepare(`ALTER TABLE auth_config ADD COLUMN customer_token_secret TEXT`).run();
    } catch {
      // already exists
    }
    let cfg = await db.prepare("SELECT customer_token_secret FROM auth_config WHERE id = 'default'").first();
    if (!cfg || !cfg.customer_token_secret) {
      const secret = randomHex(32);
      await db.prepare(`
        INSERT INTO auth_config (id, customer_token_secret, updated_at)
        VALUES ('default', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET customer_token_secret = excluded.customer_token_secret, updated_at = CURRENT_TIMESTAMP
      `).bind(secret).run();
      cfg = { customer_token_secret: secret };
    }
    const secret = cfg.customer_token_secret;

    const data = await request.json();
    const action = data.action;

    if (action === "request") {
      const email = String(data.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) return json({ error: "A valid email address is required" }, 400);

      let customer = await db.prepare(
        "SELECT id, name, dtf_account_tier FROM customers WHERE lower(email) = ? AND deleted_at IS NULL LIMIT 1"
      ).bind(email).first();

      // No matching customer - auto-create one under this email, same as a
      // brand new lead would get today via request-quote.html. Name is just
      // the email's local-part since this form only collects an email;
      // staff can rename it later from the Customers tab like any other
      // lightly-populated record. dtf_account_tier starts 'guest' - see
      // gang-sheet-account.js for how a customer becomes 'registered'.
      if (!customer) {
        const id = crypto.randomUUID();
        const name = email.split("@")[0];
        await db.prepare("INSERT INTO customers (id, name, email, dtf_account_tier) VALUES (?, ?, ?, 'guest')").bind(id, name, email).run();
        customer = { id, name, dtf_account_tier: "guest" };
      } else if (!customer.dtf_account_tier) {
        // An existing store customer signing into DTF-Prep for the first
        // time (or a pre-migration DTF-Prep customer from before this
        // column existed) - lazily backfilled to 'guest' here rather than a
        // one-off bulk migration, same "set it the first time it's needed"
        // convention as auth_config.customer_token_secret above.
        await db.prepare("UPDATE customers SET dtf_account_tier = 'guest' WHERE id = ?").bind(customer.id).run();
      }

      const jti = crypto.randomUUID();
      const loginToken = await signCustomerToken(
        secret,
        { jti, customer_id: customer.id, purpose: "gang-sheet-login" },
        LOGIN_TOKEN_TTL
      );
      const expiresAt = Math.floor(Date.now() / 1000) + LOGIN_TOKEN_TTL;
      await db.prepare(
        "INSERT INTO gang_sheet_login_tokens (jti, customer_id, expires_at) VALUES (?, ?, ?)"
      ).bind(jti, customer.id, expiresAt).run();

      if (env.RESEND_API_KEY) {
        const reason = REQUEST_REASON_COPY[data.reason] ? data.reason : "checkout";
        // The link goes straight to the page the reason actually belongs
        // on - checkout stays on cart.html (resumes automatically there if
        // there's a cart, see handleLoginTokenInUrl in src/cart.js), but
        // upload/upscale/account used to *also* land on cart.html first,
        // pointlessly, before src/cart.js worked out where to send them
        // next. Now that the builder autosaves (see src/autosave.js), it's
        // safe to land directly on it - nothing to lose by skipping the
        // cart.html stop entirely. reason still rides along in the URL too,
        // in case a link-wrapping email client strips the path but keeps
        // query params, or the link's opened on a different device than
        // the one that requested it (src/cart.js also keeps a localStorage
        // copy for the common same-device case).
        const REASON_DESTINATION = { checkout: "cart.html", upload: "upload.html", upscale: "builder.html", account: "account.html" };
        const destination = REASON_DESTINATION[reason];
        const loginUrl = `${env.DTF_PREP_ORIGIN}/${destination}?login_token=${loginToken}&reason=${encodeURIComponent(reason)}`;
        const copy = REQUEST_REASON_COPY[reason];
        const html = emailShell({
          heading: copy.heading,
          bodyHtml: `<p>${copy.body}</p>`,
          ctaText: copy.cta,
          ctaUrl: loginUrl,
        });
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>",
              to: [email],
              reply_to: env.RESEND_REPLY_TO || "hello@embroidery.click",
              subject: copy.subject,
              html,
            }),
          });
        } catch {
          // Fall through to the same always-success response below - a send
          // failure here shouldn't reveal anything to the caller either.
        }
      }

      // Always succeed regardless of whether the email existed before or
      // whether Resend is even configured, so this endpoint can't be used
      // to enumerate which emails are on file.
      return json({ success: true });
    }

    if (action === "verify") {
      const token = String(data.token || "");
      const payload = await verifyCustomerToken(token, secret);
      if (!payload || payload.purpose !== "gang-sheet-login" || !payload.jti) {
        return json({ error: "This sign-in link is invalid or has expired." }, 401);
      }

      const row = await db.prepare("SELECT * FROM gang_sheet_login_tokens WHERE jti = ?").bind(payload.jti).first();
      if (!row) return json({ error: "This sign-in link is invalid or has expired." }, 401);
      if (row.used_at) return json({ error: "This sign-in link has already been used - request a new one." }, 409);

      // Atomic claim: only the first verify call to reach this WHERE clause
      // actually flips used_at, so two near-simultaneous redemptions of the
      // same link can't both succeed.
      const claim = await db.prepare(
        "UPDATE gang_sheet_login_tokens SET used_at = CURRENT_TIMESTAMP WHERE jti = ? AND used_at IS NULL"
      ).bind(payload.jti).run();
      if (!claim.meta || claim.meta.changes !== 1) {
        return json({ error: "This sign-in link has already been used - request a new one." }, 409);
      }

      const customer = await db.prepare(
        "SELECT id, name FROM customers WHERE id = ? AND deleted_at IS NULL"
      ).bind(payload.customer_id).first();
      if (!customer) return json({ error: "That account no longer exists." }, 404);

      const sessionToken = await signCustomerToken(
        secret,
        { customer_id: customer.id, purpose: "gang-sheet-session" },
        SESSION_TOKEN_TTL
      );
      return json({ success: true, session_token: sessionToken, customer_id: customer.id, customer_name: customer.name });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
