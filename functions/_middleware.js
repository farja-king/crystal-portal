// Gates the whole site once a password has been set.
//
// Deliberately fails OPEN while no password exists: the site was already public
// before this shipped, so an unconfigured deployment is no worse than the status
// quo, and it means nobody gets locked out waiting for a password to be created.
// The moment a password is set via /api/auth, everything below is enforced.
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Marks every response this middleware passes through, so it can be confirmed
  // from outside that the gate really is in front of static pages and not just
  // the API routes.
  async function pass(state) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("X-Portal-Auth", state);
    return out;
  }

  if (request.method === "OPTIONS") return pass("preflight");
  if (url.pathname === "/api/auth") return pass("auth-endpoint");
  if (!env.DB) return pass("no-db");

  let cfg = null;
  try {
    cfg = await env.DB.prepare(
      "SELECT password_hash, secret FROM auth_config WHERE id = 'default'"
    ).first();
  } catch {
    return pass("unconfigured"); // auth_config not created yet - nothing to enforce
  }

  if (!cfg || !cfg.password_hash) return pass("unconfigured");

  const apiKey = request.headers.get("X-API-Key") || new URL(request.url).searchParams.get("api_key");
  if (apiKey && cfg.api_key && apiKey === cfg.api_key) return pass("authenticated-api-key");

  const token = tokenFrom(request);
  if (token && (await isValid(token, cfg.secret))) return pass("authenticated");

  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return new Response(loginPage(), {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function tokenFrom(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();

  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "portal_token") return v.join("=");
  }
  return null;
}

async function isValid(token, secret) {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(body));
    if (!ok) return false;

    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function fromB64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loginPage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crystal Portal - Sign in</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background:#0f172a; color:#e2e8f0; padding:1.5rem; }
  .card { width:100%; max-width:380px; background:#1e293b; border:1px solid #334155;
          border-radius:14px; padding:2rem; box-shadow:0 20px 45px rgba(0,0,0,.45); }
  h1 { margin:0 0 .35rem; font-size:1.4rem; }
  p.sub { margin:0 0 1.5rem; color:#94a3b8; font-size:.9rem; }
  label { display:block; font-size:.8rem; text-transform:uppercase; letter-spacing:.05em;
          color:#94a3b8; margin-bottom:.4rem; }
  input { width:100%; padding:.7rem .85rem; border-radius:8px; border:1px solid #475569;
          background:#0f172a; color:#e2e8f0; font-size:1rem; }
  input:focus { outline:2px solid #38bdf8; outline-offset:1px; }
  button { width:100%; margin-top:1.1rem; padding:.75rem; border:0; border-radius:8px;
           background:#0ea5e9; color:#fff; font-size:1rem; font-weight:600; cursor:pointer; }
  button:hover { background:#0284c7; }
  button:disabled { opacity:.6; cursor:default; }
  .msg { margin-top:1rem; font-size:.875rem; min-height:1.2em; color:#fca5a5; }
</style></head>
<body>
  <form class="card" id="f">
    <h1>Crystal Portal</h1>
    <p class="sub">Enter your password to continue.</p>
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password" autofocus required>
    <button id="btn" type="submit">Sign in</button>
    <div class="msg" id="msg"></div>
  </form>
<script>
  var f = document.getElementById('f');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = document.getElementById('btn'), msg = document.getElementById('msg');
    btn.disabled = true; msg.style.color = '#94a3b8'; msg.textContent = 'Checking...';
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', password: document.getElementById('pw').value })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.success) { location.reload(); return; }
        msg.style.color = '#fca5a5';
        msg.textContent = res.d.error || 'Sign in failed';
        btn.disabled = false;
      })
      .catch(function () {
        msg.style.color = '#fca5a5';
        msg.textContent = 'Network error - please try again';
        btn.disabled = false;
      });
  });
</script>
</body></html>`;
}
