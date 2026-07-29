// Password setup / login / logout for the portal.
//
// The password lives in D1 (PBKDF2-hashed) rather than a Cloudflare env var so
// it can be set from the browser on first run - there is no wrangler CLI on the
// machine this is maintained from. The signing secret is generated at setup, so
// changing the password invalidates every existing session.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  const json = (body, status = 200, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });

  if (request.method === "OPTIONS") return new Response(null, { headers });

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS auth_config (
        id TEXT PRIMARY KEY,
        password_hash TEXT,
        salt TEXT,
        secret TEXT,
        api_key TEXT,
        failed_attempts INTEGER DEFAULT 0,
        locked_until INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    const cfg = await db.prepare("SELECT * FROM auth_config WHERE id = 'default'").first();

    if (request.method === "GET") {
      return json({ configured: !!(cfg && cfg.password_hash) });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const data = await request.json();
    const action = data.action || "login";

    if (action === "logout") {
      return json({ success: true }, 200, {
        "Set-Cookie": "portal_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      });
    }

    if (action === "api_key") {
      if (!cfg || !cfg.password_hash) {
        return json({ error: "No password has been set yet. Use setup first." }, 409);
      }
      const ok = await verify(String(data.password || ""), cfg);
      if (!ok) {
        await recordFailure(db, cfg, now);
        return json({ error: "Incorrect password" }, 401);
      }
      const key = randomHex(32);
      await db.prepare(
        "UPDATE auth_config SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 'default'"
      ).bind(key).run();
      return json({ success: true, api_key: key });
    }

    if (action === "setup") {
      if (cfg && cfg.password_hash) {
        return json({ error: "A password is already set. Use change instead." }, 409);
      }
      const pw = String(data.password || "");
      if (pw.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

      const salt = randomHex(16);
      const secret = randomHex(32);
      const hash = await hashPassword(pw, salt);

      await db.prepare(`
        INSERT INTO auth_config (id, password_hash, salt, secret, failed_attempts, locked_until, updated_at)
        VALUES ('default', ?, ?, ?, 0, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          password_hash = excluded.password_hash, salt = excluded.salt,
          secret = excluded.secret, failed_attempts = 0, locked_until = 0,
          updated_at = CURRENT_TIMESTAMP
      `).bind(hash, salt, secret).run();

      const token = await signToken(secret);
      return json({ success: true, token }, 200, { "Set-Cookie": cookieFor(token) });
    }

    if (!cfg || !cfg.password_hash) {
      return json({ error: "No password has been set yet", configured: false }, 409);
    }

    // A single shared password on a public URL needs at least a brute-force brake.
    const now = Math.floor(Date.now() / 1000);
    if (cfg.locked_until && cfg.locked_until > now) {
      return json({ error: `Too many failed attempts. Try again in ${cfg.locked_until - now}s` }, 429);
    }

    if (action === "change") {
      const okOld = await verify(String(data.current_password || ""), cfg);
      if (!okOld) {
        await recordFailure(db, cfg, now);
        return json({ error: "Current password is incorrect" }, 401);
      }
      const pw = String(data.password || "");
      if (pw.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

      const salt = randomHex(16);
      const secret = randomHex(32);
      const hash = await hashPassword(pw, salt);
      await db.prepare(`
        UPDATE auth_config SET password_hash = ?, salt = ?, secret = ?,
          failed_attempts = 0, locked_until = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = 'default'
      `).bind(hash, salt, secret).run();

      const token = await signToken(secret);
      return json({ success: true, token }, 200, { "Set-Cookie": cookieFor(token) });
    }

    // login
    const ok = await verify(String(data.password || ""), cfg);
    if (!ok) {
      await recordFailure(db, cfg, now);
      return json({ error: "Incorrect password" }, 401);
    }

    await db.prepare(
      "UPDATE auth_config SET failed_attempts = 0, locked_until = 0 WHERE id = 'default'"
    ).run();

    const token = await signToken(cfg.secret);
    return json({ success: true, token }, 200, { "Set-Cookie": cookieFor(token) });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function recordFailure(db, cfg, now) {
  const n = (cfg.failed_attempts || 0) + 1;
  const lock = n >= 10 ? now + 900 : 0;
  await db.prepare(
    "UPDATE auth_config SET failed_attempts = ?, locked_until = ? WHERE id = 'default'"
  ).bind(n >= 10 ? 0 : n, lock).run();
}

async function verify(password, cfg) {
  const attempt = await hashPassword(password, cfg.salt);
  return timingSafeEqual(attempt, cfg.password_hash);
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieFor(token) {
  return `portal_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

// Shared with _middleware.js: token is base64url(payload).base64url(hmac)
export async function signToken(secret, days = 30) {
  const payload = { exp: Math.floor(Date.now() / 1000) + days * 86400 };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return b64urlBytes(new Uint8Array(sig));
}

function b64url(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

function b64urlBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
