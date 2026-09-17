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
// Streamed, not buffered: the real backup (2026-09-17) is already ~50MB
// across 237 files and only grows - the products table alone holds 95k+
// rows from the PenCarrie/Uneek catalogue sync (see backup.js). An earlier
// version of this file built the whole ZIP in memory first, which is a hard
// wall against Workers' ~128MB isolate memory limit that was only getting
// closer with every catalogue sync, not a one-time problem to raise a
// constant past. This version instead reads one R2 object at a time,
// encrypts it, and uploads it as part of a Google Drive *resumable* upload
// session (see uploadZipStreamToDrive) - at most one file's bytes plus one
// upload chunk are ever resident in memory, regardless of total backup
// size. Only the small per-entry metadata (name/crc/size/offset - not the
// file contents) needed for the ZIP central directory accumulates for the
// whole run.
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
import { crc32, encryptEntryData, dosDateTime, buildLocalFileHeader, buildCentralDirectoryRecord, buildEndOfCentralDirectory, concatAll } from "../_lib/zip-encrypt.js";

const EXPORT_TIMEOUT_HOURS = 23; // once a day, off the 15-min cron sweep - same pattern as backup.js
const RETENTION_DAYS = 30;
// Google's resumable upload requires every chunk except the last to be a
// multiple of 256KiB. 8MiB keeps the number of PUT requests reasonable for
// a ~50-100MB backup without holding much in memory.
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

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

      const accessToken = await getGoogleAccessToken(env);
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `crystal-portal-backup-${dateStr}.zip`;
      const sessionUrl = await startResumableSession(accessToken, env.GOOGLE_DRIVE_FOLDER_ID, fileName);
      const uploader = createChunkedUploader(sessionUrl);

      const { dosTime, dosDate } = dosDateTime(new Date());
      const centralDirectoryEntries = [];
      let logicalPosition = 0; // total bytes handed to the uploader so far - not necessarily flushed to Drive yet
      let entryCount = 0;

      let cursor;
      do {
        const listing = await env.BACKUPS.list({ prefix, cursor, limit: 500 });
        for (const obj of listing.objects) {
          const got = await env.BACKUPS.get(obj.key);
          if (!got) continue;
          const fileBytes = new Uint8Array(await got.arrayBuffer());
          const crc = crc32(fileBytes);
          const encrypted = encryptEntryData(env.DRIVE_BACKUP_ZIP_PASSWORD, fileBytes, crc);
          const name = obj.key.startsWith(prefix) ? obj.key.slice(prefix.length) : obj.key;
          const meta = {
            name,
            crc,
            compressedSize: encrypted.length,
            uncompressedSize: fileBytes.length,
            dosTime,
            dosDate,
            offset: logicalPosition,
          };
          const localHeader = buildLocalFileHeader(meta);

          await uploader.write(localHeader);
          await uploader.write(encrypted);
          logicalPosition += localHeader.length + encrypted.length;
          centralDirectoryEntries.push(meta);
          entryCount++;
        }
        cursor = listing.truncated ? listing.cursor : undefined;
      } while (cursor);

      if (!entryCount) throw new Error(`Backup at ${prefix} has no files to export.`);

      const centralDirectoryOffset = logicalPosition;
      for (const meta of centralDirectoryEntries) {
        const record = buildCentralDirectoryRecord(meta);
        await uploader.write(record);
        logicalPosition += record.length;
      }
      const endRecord = buildEndOfCentralDirectory({
        entryCount,
        centralDirectorySize: logicalPosition - centralDirectoryOffset,
        centralDirectoryOffset,
      });
      await uploader.write(endRecord);
      logicalPosition += endRecord.length;

      const driveFile = await uploader.finish(logicalPosition);

      // ---- Retention: delete exports older than RETENTION_DAYS from Drive.
      await cleanupOldDriveExports(accessToken, env.GOOGLE_DRIVE_FOLDER_ID);

      await db.prepare(
        "UPDATE drive_export_log SET status = 'success', completed_at = CURRENT_TIMESTAMP, backup_r2_prefix = ?, drive_file_id = ?, zip_bytes = ? WHERE id = ?"
      ).bind(prefix, driveFile.id, logicalPosition, logId).run();

      return { drive_file_id: driveFile.id, zip_bytes: logicalPosition, backup_r2_prefix: prefix };
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

// Starts a Google Drive resumable upload session and returns the session URL
// every chunk gets PUT to. Metadata (name/parent folder) is sent here, once -
// the actual bytes come later via createChunkedUploader.
async function startResumableSession(accessToken, folderId, fileName) {
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ name: fileName, parents: [folderId] }),
  });
  if (!res.ok) throw new Error("Failed to start resumable upload: " + (await res.text()));
  const sessionUrl = res.headers.get("Location");
  if (!sessionUrl) throw new Error("Google didn't return a resumable session URL.");
  return sessionUrl;
}

// Buffers written bytes and flushes to the resumable session in
// UPLOAD_CHUNK_SIZE (a multiple of 256KiB) increments as soon as enough have
// accumulated, so memory use stays bounded by the chunk size, not by total
// upload size. The total file size isn't known until finish() is called
// (that's what tells Drive "this is the last chunk, here's the real size").
function createChunkedUploader(sessionUrl) {
  let buffer = new Uint8Array(0);
  let uploadedBytes = 0; // bytes already PUT to Drive (confirmed by a 308)

  function appendToBuffer(bytes) {
    buffer = concatAll([buffer, bytes]);
  }

  async function putChunk(chunk, isFinal, totalSize) {
    const rangeEnd = uploadedBytes + chunk.length - 1;
    const totalStr = isFinal ? String(totalSize) : "*";
    const headers = { "Content-Range": `bytes ${uploadedBytes}-${rangeEnd}/${totalStr}` };
    // A genuinely empty final chunk still has to report the total size some
    // way - Drive accepts a Content-Range with no byte range for that case.
    if (chunk.length === 0 && isFinal) headers["Content-Range"] = `bytes */${totalSize}`;
    else headers["Content-Length"] = String(chunk.length);

    const res = await fetch(sessionUrl, { method: "PUT", headers, body: chunk.length ? chunk : undefined });
    uploadedBytes += chunk.length;
    if (isFinal) {
      if (!res.ok) throw new Error(`Drive upload failed to finalize (status ${res.status}): ` + (await res.text()));
      return res.json();
    }
    // Intermediate chunk: Drive responds 308 Resume Incomplete when it's
    // accepted a partial chunk and is waiting for more.
    if (res.status !== 308 && !res.ok) {
      throw new Error(`Drive chunk upload failed (status ${res.status}): ` + (await res.text()));
    }
    return null;
  }

  return {
    async write(bytes) {
      appendToBuffer(bytes);
      while (buffer.length >= UPLOAD_CHUNK_SIZE) {
        const chunk = buffer.slice(0, UPLOAD_CHUNK_SIZE);
        buffer = buffer.slice(UPLOAD_CHUNK_SIZE);
        await putChunk(chunk, false, null);
      }
    },
    async finish(totalSize) {
      return await putChunk(buffer, true, totalSize);
    },
  };
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
