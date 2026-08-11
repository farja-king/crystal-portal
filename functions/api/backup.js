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
// own timestamped prefix - db/<table>.json per table, files/<original-key>
// for every referenced file - so old snapshots are never overwritten.
import { emailShell } from "../_lib/email-template.js";

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

    async function exportTable(table) {
      const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
      return results;
    }

    // Deletes every row then re-inserts from the snapshot, using each row's
    // own keys to build the INSERT - self-describing, so it doesn't need a
    // hardcoded column list per table (and tolerates a table having grown
    // new columns since the snapshot was taken; those just stay at their
    // DEFAULT for restored rows that predate them).
    async function restoreTable(table, rows) {
      await db.prepare(`DELETE FROM ${table}`).run();
      if (!rows || !rows.length) return;
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => "?").join(",");
      const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`);
      const statements = rows.map((r) => stmt.bind(...columns.map((c) => r[c])));
      for (let i = 0; i < statements.length; i += 50) {
        await db.batch(statements.slice(i, i + 50));
      }
    }

    function collectFileKeys(tableData) {
      const keys = new Set();
      for (const { table, column } of FILE_KEY_SOURCES) {
        for (const row of tableData[table] || []) {
          if (row[column]) keys.add(row[column]);
        }
      }
      return [...keys];
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
        const tableData = {};
        const tableCounts = {};
        for (const table of BACKUP_TABLES) {
          const rows = await exportTable(table);
          tableData[table] = rows;
          tableCounts[table] = rows.length;
          await env.BACKUPS.put(prefix + "db/" + table + ".json", JSON.stringify(rows));
        }

        const fileKeys = collectFileKeys(tableData);
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

    async function listBackups() {
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

      const tableData = {};
      for (const table of BACKUP_TABLES) {
        const text = await env.BACKUPS.get(target.r2_prefix + "db/" + table + ".json");
        tableData[table] = text ? JSON.parse(await text.text()) : [];
      }
      for (const table of BACKUP_TABLES) {
        await restoreTable(table, tableData[table]);
      }

      const fileKeys = collectFileKeys(tableData);
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
        tables_restored: Object.fromEntries(BACKUP_TABLES.map((t) => [t, (tableData[t] || []).length])),
        files_restored: filesRestored,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
