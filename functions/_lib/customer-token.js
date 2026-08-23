// Shared HMAC-signed-token helper for customer-facing (non-staff) tokens -
// same base64url(payload).base64url(HMAC-SHA256(secret, payload)) scheme as
// functions/api/auth.js's signToken/isValid, generalized to carry arbitrary
// claims (auth.js's version is hardcoded to {exp} only, and its hmac/b64url
// helpers aren't exported) so a customer_id/purpose/jti can ride along for
// DTF-Prep's magic-link + session tokens. See functions/api/gang-sheet-auth.js.
export async function signCustomerToken(secret, payload, ttlSeconds) {
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

// Returns the decoded payload if the signature is valid and it hasn't
// expired, otherwise null - callers still need to check payload.purpose
// themselves (a valid-but-wrong-purpose token should never be accepted).
export async function verifyCustomerToken(token, secret) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(body));
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
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

function fromB64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
