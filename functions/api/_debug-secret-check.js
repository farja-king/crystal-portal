// TEMPORARY diagnostic - never returns the secret itself, only its length
// and a SHA-256 hash, to compare against a known-good local value while
// tracking down why GOOGLE_CLIENT_SECRET keeps coming back invalid_client
// after being re-stored multiple times. Delete this file once resolved.
export async function onRequest(context) {
  const { env } = context;
  async function hash(val) {
    const enc = new TextEncoder().encode(val);
    const digest = await crypto.subtle.digest("SHA-256", enc);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function info(name) {
    const val = env[name];
    if (!val) return { present: false };
    const stripped = val.replace(/^﻿/, "");
    return {
      present: true,
      length: val.length,
      sha256: await hash(val),
      strippedLength: stripped.length,
      strippedSha256: await hash(stripped),
    };
  }
  return new Response(JSON.stringify({
    GOOGLE_CLIENT_SECRET: await info("GOOGLE_CLIENT_SECRET"),
    GOOGLE_CLIENT_ID: await info("GOOGLE_CLIENT_ID"),
    GOOGLE_REFRESH_TOKEN: await info("GOOGLE_REFRESH_TOKEN"),
  }, null, 2), { headers: { "Content-Type": "application/json" } });
}
