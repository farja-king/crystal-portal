// Full-system backup & restore - every D1 table except auth_config (never
// backed up or restored - login credentials, deliberately excluded so a
// restore can never revert someone's password or leak credentials into a
// stored/emailed snapshot) plus every file in DESIGN_FILES that's actually
// referenced by a D1 row. Runs automatically once a day (self-throttled
// below - triggered every 15 minutes by the same cron sweep that already
// drives payment-reminders.js/review-requests.js, see email-worker/
// worker.js), and on demand from the admin Backups tab.
//
// Storage: a second R2 bucket, env.BACKUPS (crystal-portal-backups),
// separate from env.DESIGN_FILES (the live file storage) so a backup can
// never be corrupted by whatever it's backing up. Each run writes under its
// own timestamped prefix - db/<table>-<page>.json per PAGE_SIZE-row chunk of
// each table, files/<original-key> for every referenced file - so old
// snapshots are never overwritten.
//
// Tables are paged (keyset pagination on id, not OFFSET - stays index-backed
// however deep it goes) rather than pulled with one SELECT * / JSON.stringify
// - the products table alone holds 100k+ rows since the PenCarrie/Uneek
// catalogue syncs (see functions/api/pencarrie-sync.js), and a single-shot
// export of that size silently ran past this Function's execution limit
// with no catchable error, leaving backup_log stuck on 'running' forever -
// every 15-minute cron sweep just piled up another dead row (never actually
// backing anything up) instead of the once-a-day snapshot this is meant to
// be. Paging keeps every individual D1 query and R2 write small regardless
// of table size.
import { emailShell } from "../_lib/email-template.js";

const PAGE_SIZE = 2000;

// Every table backed up/restored. Order matters for restore: tables with no
// foreign-key-ish dependency on others go first, though D1/SQLite here
// doesn't enforce real foreign keys, so this is mostly for readability.
const BACKUP_TABLES = [
  "customers", "orders", "payments", "products", "settings",
  "production_steps", "production_step_images", "inbox_emails",
  "design_files", "design_proofs", "email_log", "reminder_settings", "counters",
];

// Which table.column pairs hold an R2 key in DESIGN_FILES worth backing up.
const FILE_KEY_SOURCES = [
  { table: "design_files", column: "r2_key" },
  { table: "design_proofs", column: "r2_key" },
  { table: "production_step_images", column: "r2_key" },
  { table: "orders", column: "manual_pdf_r2_key" },
  { table: "inbox_emails", column: "raw_r2_key" },
];

const BACKUP_TIMEOUT_HOURS = 23; // "once every 24 hours" off a 15-min cron

// The keyset-pagination column for each table - every table here uses
// `id TEXT PRIMARY KEY` except counters, which predates that convention and
// keys on its own name instead.
const PK_COLUMN = { counters: "name" };

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (!env.BACKUPS) {
    return json({ error: "Backup storage isn't set up yet - the BACKUPS R2 bucket binding is missing from this Pages project." }, 500);
  }
  if (!env.DESIGN_FILES) {
    return json({ error: "File storage isn't set up - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_log (
        id TEXT PRIMARY KEY,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        status TEXT DEFAULT 'running',
        triggered_by TEXT,
        r2_prefix TEXT,
        table_counts TEXT,
        files_count INTEGER,
        total_bytes INTEGER,
        error_message TEXT
      )
    `).run();

    // Pages through the table in id order (keyset, not OFFSET) writing one
    // JSON file to R2 per PAGE_SIZE-row chunk, plus a small `.pages.json`
    // manifest recording how many chunks there are - so both the export
    // query and every individual write stay small no matter how large the
    // table is. Returns the row count and any R2 file keys this table's
    // rows referenced (per FILE_KEY_SOURCES), collected page-by-page rather
    // than by holding the whole table in memory.
    async function exportTable(table, prefix) {
      const pk = PK_COLUMN[table] || "id";
      const fileColumns = FILE_KEY_SOURCES.filter((s) => s.table === table).map((s) => s.column);
      const fileKeys = [];
      let cursor = "";
      let page = 0;
      let total = 0;
      while (true) {
        const { results } = await db.prepare(
          `SELECT * FROM ${table} WHERE ${pk} > ? ORDER BY ${pk} LIMIT ?`
        ).bind(cursor, PAGE_SIZE).all();
        if (!results.length) break;
        await env.BACKUPS.put(`${prefix}db/${table}-${page}.json`, JSON.stringify(results));
        for (const col of fileColumns) {
          for (const row of results) if (row[col]) fileKeys.push(row[col]);
        }
        total += results.length;
        cursor = results[results.length - 1][pk];
        page += 1;
        if (results.length < PAGE_SIZE) break;
      }
      await env.BACKUPS.put(`${prefix}db/${table}.pages.json`, JSON.stringify({ pages: page, rows: total }));
      return { total, fileKeys };
    }

    async function insertRows(table, rows) {
      if (!rows || !rows.length) return;
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => "?").join(",");
      const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`);
      const statements = rows.map((r) => stmt.bind(...columns.map((c) => r[c])));
      for (let i = 0; i < statements.length; i += 50) {
        await db.batch(statements.slice(i, i + 50));
      }
    }

    // Deletes every row then re-inserts from the snapshot's chunk files,
    // page by page - the export-side counterpart above. Falls back to the
    // old single db/<table>.json format for backups taken before chunking
    // existed (the six from 11-16 Aug, back when the tables were still
    // small enough for that to work) so those stay restorable too.
    async function restoreTable(table, prefix) {
      await db.prepare(`DELETE FROM ${table}`).run();
      const pagesText = await env.BACKUPS.get(prefix + "db/" + table + ".pages.json");
      if (!pagesText) {
        const legacy = await env.BACKUPS.get(prefix + "db/" + table + ".json");
        if (!legacy) return 0;
        const rows = JSON.parse(await legacy.text());
        await insertRows(table, rows);
        return rows.length;
      }
      const { pages } = JSON.parse(await pagesText.text());
      let total = 0;
      for (let p = 0; p < pages; p++) {
        const text = await env.BACKUPS.get(`${prefix}db/${table}-${p}.json`);
        if (!text) continue;
        const rows = JSON.parse(await text.text());
        await insertRows(table, rows);
        total += rows.length;
      }
      return total;
    }

    function fmtBytes(n) {
      if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
      if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
      return n + " B";
    }

    async function sendBackupEmail({ ok, prefix, tableCounts, filesCount, totalBytes, errorMessage }) {
      if (!env.RESEND_API_KEY) return; // best-effort only - never blocks the backup itself
      const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
      const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
      const to = "martinlyon70@gmail.com";
      const subject = ok ? "Backup completed" : "Backup FAILED";
      const bodyHtml = ok
        ? `<p>Today's full-system backup finished successfully.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0;font-size:14px;">
            ${Object.entries(tableCounts || {}).map(([t, c]) => `<tr><td style="padding:2px 12px 2px 0;color:#64748b;">${t}</td><td style="font-weight:600;">${c} row${c === 1 ? "" : "s"}</td></tr>`).join("")}
          </table>
          <p>${filesCount} file(s), ${fmtBytes(totalBytes || 0)} total.</p>
          <p style="color:#64748b;font-size:12px;">Stored in your Cloudflare backup bucket under <code>${escapeHtml(prefix)}</code>.</p>`
        : `<p style="font-weight:600;color:#dc2626;">Today's backup did not complete.</p>
          <p>${escapeHtml(errorMessage || "Unknown error")}</p>
          <p>Nothing about your data has changed - this only means today's backup copy wasn't made. Worth checking the Backups tab.</p>`;
      const html = emailShell({ heading: subject, bodyHtml, ctaColor: ok ? "#16a34a" : "#dc2626" });
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
        });
      } catch {
        // best-effort - a failed notification email shouldn't fail the backup response
      }
    }

    const escapeHtml = (str) => String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    // Does the actual work of one backup run - shared by action:'run' and
    // the pre-restore safety snapshot inside action:'restore'.
    async function runBackup(triggeredBy) {
      const id = crypto.randomUUID();
      const startedAt = new Date();
      const prefix = `backups/${startedAt.toISOString().replace(/[:.]/g, "-")}/`;
      await db.prepare(
        "INSERT INTO backup_log (id, started_at, status, triggered_by, r2_prefix) VALUES (?, ?, 'running', ?, ?)"
      ).bind(id, startedAt.toISOString(), triggeredBy, prefix).run();

      try {
        const tableCounts = {};
        const fileKeySet = new Set();
        for (const table of BACKUP_TABLES) {
          const { total, fileKeys: keys } = await exportTable(table, prefix);
          tableCounts[table] = total;
          keys.forEach((k) => fileKeySet.add(k));
        }

        const fileKeys = [...fileKeySet];
        let filesCount = 0;
        let totalBytes = 0;
        for (const key of fileKeys) {
          const obj = await env.DESIGN_FILES.get(key);
          if (!obj) continue; // referenced but missing - skip rather than fail the whole backup
          await env.BACKUPS.put(prefix + "files/" + key, obj.body, { httpMetadata: obj.httpMetadata });
          filesCount += 1;
          totalBytes += obj.size || 0;
        }

        await db.prepare(`
          UPDATE backup_log SET status = 'success', completed_at = CURRENT_TIMESTAMP,
            table_counts = ?, files_count = ?, total_bytes = ? WHERE id = ?
        `).bind(JSON.stringify(tableCounts), filesCount, totalBytes, id).run();

        await sendBackupEmail({ ok: true, prefix, tableCounts, filesCount, totalBytes });
        return { id, prefix, tableCounts, filesCount, totalBytes };
      } catch (e) {
        await db.prepare(
          "UPDATE backup_log SET status = 'error', completed_at = CURRENT_TIMESTAMP, error_message = ? WHERE id = ?"
        ).bind(e.message || "Unknown error", id).run();
        await sendBackupEmail({ ok: false, errorMessage: e.message });
        throw e;
      }
    }

    // A row can only ever be left on 'running' by something that killed the
    // Function mid-backup (this is exactly how the pre-paging bug above
    // surfaced - every attempt died silently, past the point where the
    // try/catch could mark it 'error', and the 15-min cron just kept piling
    // up more of them). Anything still 'running' after 10 minutes - far
    // longer than a real paged backup takes - gets swept to 'error' so a
    // genuine future failure shows up honestly instead of sitting there
    // looking perpetually in-progress.
    async function reapStaleRunning() {
      await db.prepare(`
        UPDATE backup_log SET status = 'error', completed_at = CURRENT_TIMESTAMP,
          error_message = 'Timed out - the Function was stopped before this backup could finish'
        WHERE status = 'running' AND started_at < datetime('now', '-10 minutes')
      `).run();
    }

    async function listBackups() {
      await reapStaleRunning();
      const { results } = await db.prepare(
        "SELECT * FROM backup_log ORDER BY started_at DESC LIMIT 60"
      ).all();
      return json(results.map((r) => ({ ...r, table_counts: r.table_counts ? JSON.parse(r.table_counts) : null })));
    }

    if (request.method === "GET") return listBackups();
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const data = await request.json();

    if (data.action === "list") return listBackups();

    if (data.action === "run") {
      if (!data.force) {
        const last = await db.prepare(
          "SELECT started_at FROM backup_log WHERE status = 'success' ORDER BY started_at DESC LIMIT 1"
        ).first();
        if (last) {
          const ageMs = Date.now() - new Date(last.started_at.includes("T") ? last.started_at : last.started_at.replace(" ", "T") + "Z").getTime();
          if (ageMs < BACKUP_TIMEOUT_HOURS * 3600000) {
            return json({ success: true, skipped: true });
          }
        }
      }
      const result = await runBackup(data.force ? "manual" : "cron");
      return json({ success: true, ...result });
    }

    if (data.action === "restore") {
      if (!data.backup_id) return json({ error: "backup_id required" }, 400);
      const target = await db.prepare("SELECT * FROM backup_log WHERE id = ? AND status = 'success'").bind(data.backup_id).first();
      if (!target) return json({ error: "Backup not found" }, 404);

      const expectedPhrase = `RESTORE ${target.started_at.slice(0, 10)}`;
      if (data.confirm_phrase !== expectedPhrase) {
        return json({ error: `Confirmation phrase didn't match. Expected exactly: ${expectedPhrase}` }, 400);
      }

      // Safety net - always take a fresh backup of the CURRENT state before
      // touching anything, no way to skip this.
      const preRestore = await runBackup("pre_restore");

      const tableCounts = {};
      for (const table of BACKUP_TABLES) {
        tableCounts[table] = await restoreTable(table, target.r2_prefix);
      }

      // Re-derive which files are needed from the rows just restored into
      // D1, rather than from the snapshot's own JSON (works the same for
      // both the chunked and legacy single-file backup formats, so this
      // doesn't need its own format fallback).
      const fileKeys = new Set();
      for (const { table, column } of FILE_KEY_SOURCES) {
        const { results } = await db.prepare(`SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL`).all();
        results.forEach((r) => { if (r[column]) fileKeys.add(r[column]); });
      }
      let filesRestored = 0;
      for (const key of fileKeys) {
        const obj = await env.BACKUPS.get(target.r2_prefix + "files/" + key);
        if (!obj) continue;
        await env.DESIGN_FILES.put(key, obj.body, { httpMetadata: obj.httpMetadata });
        filesRestored += 1;
      }

      return json({
        success: true,
        restored_to: target.started_at,
        pre_restore_backup_id: preRestore.id,
        tables_restored: tableCounts,
        files_restored: filesRestored,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
