// Daily off-Cloudflare backup export: takes the most recent successful
// snapshot backup.js already wrote to R2 (env.BACKUPS), packs it into a
// single password-protected ZIP, and uploads it to a Google Drive folder in
// Martin's own personal Google account - so a real copy of the business's
// data exists outside Cloudflare entirely, not just in a second R2 bucket
// under the same Cloudflare account. Self-throttled the same way as
// backup.js/gang-sheet-cleanup.js and triggered by the same 15-minute cron
// sweep (see email-worker/worker.js) - safe to hit constantly, it no-ops
// almost all of the time.
//
// Why a hand-written ZIP encoder (functions/_lib/zip-encrypt.js) instead of
// a library: this codebase has zero npm dependencies anywhere by design, and
// nothing in Cloudflare's Workers runtime does AES-encrypted ZIPs reliably.
// ZipCrypto (the classic ZIP password, what that file implements) is weak
// against a determined offline attacker, but the actual threat model here is
// casual access to the Drive account, not cryptographic cracking - the files
// already sit behind Martin's own Google login as the first layer. Verified
// by hand against 7-Zip (correct password extracts byte-exact content,
// wrong password is rejected) before this went anywhere near production.
//
// Credentials (all Cloudflare secrets on this Pages project, none of them
// ever in this file or in Git):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET - this integration's OAuth app
//     (Google Cloud project "Crystal Portal Backups")
//   GOOGLE_REFRESH_TOKEN - from the one-time consent Martin granted; lets
//     this Function mint a fresh access token on every run without him
//     re-authorizing
//   GOOGLE_DRIVE_FOLDER_ID - the "Crystal Portal Backups" folder in his Drive
//   DRIVE_BACKUP_ZIP_PASSWORD - the fixed password used for every export
//     (deliberately never rotates - a different password every day would be
//     unusable, per Martin's own explicit ask)
//
// Memory safety: everything gets buffered in memory to build one ZIP, which
// is fine at this business's current data volume but is a real limit to
// revisit if backups ever grow large - see MAX_TOTAL_INPUT_BYTES below.
import { buildEncryptedZip } from "../_lib/zip-encrypt.js";

const EXPORT_TIMEOUT_HOURS = 23; // once a day, off the 15-min cron sweep - same pattern as backup.js
const RETENTION_DAYS = 30;
// Conservative relative to Workers' ~128MB isolate memory limit - leaves
// headroom for the ZIP output buffer (roughly the same size again) and
// normal JS/runtime overhead on top of the raw input bytes.
const MAX_TOTAL_INPUT_BYTES = 60 * 1024 * 1024;

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (!env.BACKUPS) return json({ error: "BACKUPS R2 bucket binding is missing from this Pages project." }, 500);
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_FOLDER_ID", "DRIVE_BACKUP_ZIP_PASSWORD"]) {
    if (!env[name]) return json({ error: `${name} secret is missing from this Pages project.` }, 500);
  }

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS drive_export_log (
      id TEXT PRIMARY KEY,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      status TEXT DEFAULT 'running',
      backup_r2_prefix TEXT,
      drive_file_id TEXT,
      zip_bytes INTEGER,
      error_message TEXT
    )
  `).run();

  if (request.method === "GET") return listExports();
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const data = await request.json().catch(() => ({}));

  if (data.action === "list") return listExports();

  if (data.action === "run") {
    if (!data.force) {
      const last = await db.prepare("SELECT started_at FROM drive_export_log WHERE status = 'success' ORDER BY started_at DESC LIMIT 1").first();
      if (last) {
        const ageMs = Date.now() - new Date(last.started_at.includes("T") ? last.started_at : last.started_at.replace(" ", "T") + "Z").getTime();
        if (ageMs < EXPORT_TIMEOUT_HOURS * 3600000) return json({ success: true, skipped: true });
      }
    }
    try {
      const result = await runExport();
      return json({ success: true, ...result });
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  }

  return json({ error: "Unknown action" }, 400);

  async function listExports() {
    const { results } = await db.prepare("SELECT * FROM drive_export_log ORDER BY started_at DESC LIMIT 30").all();
    return json({ exports: results });
  }

  async function runExport() {
    const logId = crypto.randomUUID();
    await db.prepare("INSERT INTO drive_export_log (id, status) VALUES (?, 'running')").bind(logId).run();

    try {
      const latestBackup = await db.prepare("SELECT r2_prefix FROM backup_log WHERE status = 'success' ORDER BY started_at DESC LIMIT 1").first();
      if (!latestBackup) throw new Error("No successful backup exists yet to export.");
      const prefix = latestBackup.r2_prefix;

      // ---- Gather every object under this backup's prefix into ZIP entries.
      const entries = [];
      let totalBytes = 0;
      let cursor;
      do {
        const listing = await env.BACKUPS.list({ prefix, cursor, limit: 500 });
        for (const obj of listing.objects) {
          const got = await env.BACKUPS.get(obj.key);
          if (!got) continue;
          const buf = new Uint8Array(await got.arrayBuffer());
          totalBytes += buf.length;
          if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
            throw new Error(
              `Backup is too large for this export path (over ${(MAX_TOTAL_INPUT_BYTES / 1024 / 1024).toFixed(0)}MB) - needs a chunked/streaming redesign, not a one-shot in-memory ZIP.`
            );
          }
          // Strip the timestamped prefix so the zip's own folder structure
          // reads as db/... and files/... rather than one giant nested path.
          const name = obj.key.startsWith(prefix) ? obj.key.slice(prefix.length) : obj.key;
          entries.push({ name, data: buf });
        }
        cursor = listing.truncated ? listing.cursor : undefined;
      } while (cursor);

      if (!entries.length) throw new Error(`Backup at ${prefix} has no files to export.`);

      const zipBytes = buildEncryptedZip(entries, env.DRIVE_BACKUP_ZIP_PASSWORD);

      // ---- Upload to Drive.
      const accessToken = await getGoogleAccessToken(env);
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `crystal-portal-backup-${dateStr}.zip`;
      const driveFileId = await uploadToDrive(accessToken, env.GOOGLE_DRIVE_FOLDER_ID, fileName, zipBytes);

      // ---- Retention: delete exports older than RETENTION_DAYS from Drive.
      await cleanupOldDriveExports(accessToken, env.GOOGLE_DRIVE_FOLDER_ID);

      await db.prepare(
        "UPDATE drive_export_log SET status = 'success', completed_at = CURRENT_TIMESTAMP, backup_r2_prefix = ?, drive_file_id = ?, zip_bytes = ? WHERE id = ?"
      ).bind(prefix, driveFileId, zipBytes.length, logId).run();

      return { drive_file_id: driveFileId, zip_bytes: zipBytes.length, backup_r2_prefix: prefix };
    } catch (err) {
      await db.prepare("UPDATE drive_export_log SET status = 'error', completed_at = CURRENT_TIMESTAMP, error_message = ? WHERE id = ?").bind(String(err.message || err), logId).run();
      throw err;
    }
  }
}

async function getGoogleAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("Google token refresh failed: " + JSON.stringify(data));
  return data.access_token;
}

// Multipart upload (metadata + media in one request) so the file lands with
// the right name and parent folder immediately - no separate rename/move step.
async function uploadToDrive(accessToken, folderId, fileName, zipBytes) {
  const boundary = "crystalportalbackup" + crypto.randomUUID().replace(/-/g, "");
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: application/zip\r\n\r\n`),
    zipBytes,
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error("Drive upload failed: " + JSON.stringify(data));
  return data.id;
}

async function cleanupOldDriveExports(accessToken, folderId) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600000;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    `'${folderId}' in parents and trashed = false`
  )}&fields=${encodeURIComponent("files(id,name,createdTime)")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok || !data.files) return; // best-effort - a failed cleanup shouldn't fail the whole export

  for (const file of data.files) {
    if (new Date(file.createdTime).getTime() < cutoff) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => {});
    }
  }
}
