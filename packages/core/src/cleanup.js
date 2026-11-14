import { deleteBlob, TEXT_WRITE_STALE_MS } from "./content-store.js";
import { limitsFor } from "./auth.js";
import { nowMs } from "./util.js";
import { rvPurge } from "./review/service.js";

var EXPIRED = JSON.stringify({ status: 410, code: "upload_expired", message: "Upload expired" });
var CRASHED = JSON.stringify({ status: 500, code: "finish_abandoned", message: "Upload finish did not complete" });
// uploadPut aborts its body at the upload's expires_at, so no put commits after expires_at + PUT_MARGIN_MS. A write
// count (uploads.final_writes) on an upload that expired before staleWritesBefore() is stale: its PUT died without
// releasing it (an isolate that dies never runs its finally). Cleanup, orphan placeholders and project purge then
// treat it as final_writes = 0, so a leaked count can't hold quota, an object or a purge forever.
var PUT_MARGIN_MS = 6e4;
// At least 10 minutes past the margin even when UPLOAD_CLEANUP_GRACE_SECONDS is 0: the handler stops waiting at the
// margin, but R2 can't be told to abort a put whose body has already fully arrived, so give a slow commit room to land
// before the object is treated as never written.
var STALE_WRITE_MIN_GRACE_MS = 6e5;
var staleWritesBefore = (env, now) => now - Math.max(limitsFor(env).cleanupGraceMs, STALE_WRITE_MIN_GRACE_MS) - PUT_MARGIN_MS;
async function reconcileUploads(env, opts = {}) {
  const now = nowMs();
  const grace = limitsFor(env).cleanupGraceMs;
  const stale = staleWritesBefore(env, now);
  const limit = opts.limit ?? 50;
  const pf = opts.projectId ? " AND project_id = ?" : "";
  const pp = opts.projectId ? [opts.projectId] : [];
  const DB = env.DB;
  const e1 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state IN ('pending','received') AND expires_at <= ?${pf}`).bind(EXPIRED, now, ...pp).run();
  const e2 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state = 'receiving' AND expires_at <= ?${pf}`).bind(EXPIRED, now - grace, ...pp).run();
  const e3 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ?, finalize_token = NULL, finalize_until = NULL WHERE state = 'sealed' AND expires_at <= ? AND (finalize_until IS NULL OR finalize_until <= ?)${pf}
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.id = uploads.final_revision_id)`).bind(CRASHED, now - grace, now, ...pp).run();
  // Stale counts on failed/conflicting uploads and published text inputs are released below; published binaries stay referenced.
  const retained = await DB.prepare(`SELECT COUNT(*) AS count, MIN(expires_at) AS oldest_expiry FROM uploads WHERE state IN ('failed','conflict','published') AND final_writes > 0 AND final_key IS NOT NULL AND final_purged_at IS NULL
      AND ((state = 'published' AND mime NOT IN ('text/markdown','text/html','application/json','text/csv')) OR expires_at > ?)${pf}`).bind(stale, ...pp).first();
  if (retained?.count > 0) console.warn(JSON.stringify({ event: "upload_final_writes_retained", count: retained.count, oldest_expiry_age_ms: Math.max(0, now - retained.oldest_expiry) }));
  let purgedStaging = 0, purgedFinal = 0;
  const st = await DB.prepare(`SELECT id, staging_key, mime, state, final_key, final_purged_at, final_writes, expires_at FROM uploads WHERE staging_purged_at IS NULL AND state IN ('failed','conflict','published')${pf} LIMIT ?`).bind(...pp, limit).all();
  const purgeStagingRow = async (u) => {
    await deleteBlob(env, u.staging_key);
    const r = await DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE id = ? AND staging_purged_at IS NULL AND state IN ('failed','conflict','published') AND (mime NOT IN ('text/markdown','text/html','application/json','text/csv') OR final_purged_at IS NOT NULL)").bind(now, u.id).run();
    purgedStaging += r.meta.changes ? 1 : 0;
  };
  for (const u of st.results) {
    const text = ['text/markdown','text/html','application/json','text/csv'].includes(u.mime);
    if (text) {
      if (u.final_writes > 0 && u.expires_at > stale) continue;
      if (u.final_purged_at === null) {
        // Failed/conflicting rows go through the unchanged reference-guarded final lane below.
        if (u.state !== 'published') continue;
        await deleteBlob(env, u.final_key);
        const r = await DB.prepare("UPDATE uploads SET final_purged_at = ?, final_writes = 0 WHERE id = ? AND final_purged_at IS NULL").bind(now, u.id).run();
        purgedFinal += r.meta.changes ? 1 : 0;
      }
    }
    await purgeStagingRow(u);
  }
  const fi = await DB.prepare(`SELECT id, final_key FROM uploads u WHERE final_key IS NOT NULL AND final_purged_at IS NULL AND state IN ('failed','conflict') AND (final_writes = 0 OR expires_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key) AND NOT EXISTS (SELECT 1 FROM proposals pr WHERE pr.blob_key = u.final_key)${pf.replace("project_id", "u.project_id")} LIMIT ?`).bind(stale, ...pp, limit).all();
  for (const u of fi.results) {
    await deleteBlob(env, u.final_key);
    const r = await DB.prepare("UPDATE uploads SET final_purged_at = ?, final_writes = 0 WHERE id = ? AND final_purged_at IS NULL").bind(now, u.id).run();
    purgedFinal += r.meta.changes ? 1 : 0;
    // Complete a failed text row's staging lane in this run too, before orphan-placeholder deletion.
    const waitingText = st.results.find(s => s.id === u.id && ['text/markdown','text/html','application/json','text/csv'].includes(s.mime));
    if (waitingText) await purgeStagingRow(waitingText);
  }
  // Second delete of ended uploads' final keys, 1 to 3 hours after the first: R2 can't abort a put whose body fully
  // arrived, so an abandoned put that commits after the first purge is removed here (deletes of absent keys are free).
  const late = await DB.prepare(`SELECT final_key FROM uploads u WHERE final_key IS NOT NULL AND state IN ('failed','conflict')
      AND final_purged_at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key) AND NOT EXISTS (SELECT 1 FROM proposals pr WHERE pr.blob_key = u.final_key)${pf.replace("project_id", "u.project_id")} LIMIT ?`)
    .bind(now - 3 * 36e5, now - 36e5, ...pp, limit).all().catch(() => ({ results: [] }));
  for (const u of late.results) await deleteBlob(env, u.final_key).catch(() => {
  });
  // Best effort: a failure here must not stop the rest of cleanup or the upload begin that called it.
  const placeholders = await deleteOrphanPlaceholders(env, now, stale, opts.projectId, limit).catch(() => {
    console.error(JSON.stringify({ event: "placeholder_cleanup_failed" }));
    return 0;
  });
  await sweepContentWrites(env, { projectId: opts.projectId, limit });
  // Bytes of proposals closed more than 30 days ago (review gating).
  await rvPurge(env, now, limit, opts.projectId ?? null).catch(() => console.error(JSON.stringify({ event: "proposal_purge_failed" })));
  // rate_counters.win is a minute number. Only past windows are deleted: longer counters (hosted daily email caps) use
  // the minute their period ends, so keep this "older than" and never delete future windows.
  await DB.prepare("DELETE FROM rate_counters WHERE win < ?").bind(Math.floor(now / 6e4) - 2).run();
  await DB.prepare("DELETE FROM transfer_links WHERE expires_at < ?").bind(now).run().catch(() => {
  });
  await DB.prepare("DELETE FROM view_links WHERE expires_at < ?").bind(now).run().catch(() => {
  });
  await DB.prepare("DELETE FROM oauth_code_redemptions WHERE redeemed_at < ?").bind(now - 31 * 24 * 36e5).run().catch(() => {
  });
  return { expired: (e1.meta.changes ?? 0) + (e2.meta.changes ?? 0) + (e3.meta.changes ?? 0), purged_staging: purgedStaging, purged_final: purgedFinal, deleted_placeholders: placeholders };
}

// A new file's placeholder (artifacts head_rev = 0, uploads.js upload begin) whose upload never published. It is hidden
// from every list but counts toward items_per_project, so the cron deletes it, with its upload rows (they reference
// it), once every upload for it is finished with: terminal, expired more than PLACEHOLDER_GRACE_MS ago (finish keeps
// answering 410 upload_expired until then) and with its R2 objects purged. Nothing can start a new upload for it
// (loadArtifact hides all artifacts at head_rev 0). A stale write count (PUT_MARGIN_MS) does not keep it. Bounded per run.
var PLACEHOLDER_GRACE_MS = 864e5;
// Only a placeholder nothing else refers to: a comment, details version or revision on it (all foreign keys to
// artifacts) leaves it alone, so the delete can never fail a foreign key and roll the cleanup batch back.
// pending_review = 1 (migration 0017_review_gating.sql) is a new document that exists only as a proposal: never an orphan.
var ORPHAN_PLACEHOLDER_SQL = `a.head_rev = 0 AND a.publisher_id IS NULL AND a.pending_review = 0
  AND NOT EXISTS (SELECT 1 FROM meta_versions m WHERE m.artifact_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.artifact_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.artifact_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.artifact_id = a.id AND (u.state NOT IN ('failed','conflict') OR u.expires_at > ?
    OR u.staging_purged_at IS NULL OR (u.final_writes > 0 AND u.expires_at > ?) OR (u.final_key IS NOT NULL AND u.final_purged_at IS NULL)))`;
async function deleteOrphanPlaceholders(env, now, stale, projectId, limit) {
  const cutoff = now - PLACEHOLDER_GRACE_MS;
  const pf = projectId ? " AND a.project_id = ?" : "";
  const rows = (await env.DB.prepare(`SELECT a.id FROM artifacts a WHERE ${ORPHAN_PLACEHOLDER_SQL}${pf} LIMIT ?`).bind(cutoff, stale, ...projectId ? [projectId] : [], limit).all()).results;
  if (!rows.length) return 0;
  const stmts = [];
  for (const { id } of rows) {
    // Re-checked in each statement, so a row that changed since the SELECT is left alone.
    const still = `EXISTS (SELECT 1 FROM artifacts a WHERE a.id = ? AND ${ORPHAN_PLACEHOLDER_SQL})`;
    stmts.push(env.DB.prepare(`DELETE FROM uploads WHERE artifact_id = ? AND ${still}`).bind(id, id, cutoff, stale),
      env.DB.prepare(`DELETE FROM artifacts AS a WHERE a.id = ? AND ${ORPHAN_PLACEHOLDER_SQL}`).bind(id, cutoff, stale));
  }
  const res = await env.DB.batch(stmts);
  return res.filter((_, i) => i % 2 === 1).reduce((n, r) => n + (r.meta.changes ? 1 : 0), 0);
}

// Retention (cron, every 15 minutes): each table loses at most PRUNE_BATCH rows per run, oldest first, through its index
// (migration 0027). 5000 rows a run is 480,000 a day per table, far above what a busy installation writes.
// - sessions: expired ones (expires_at, ms). A signed-out session has a past expiry or revoked_at; revoked ones go
//   when they expire (at most 30 days later).
// - idempotency: records older than 30 days (created_at, ISO text). Replays are for retries of the same request:
//   upload begin/finish retries happen within the upload's lifetime (UPLOAD_TTL_SECONDS, default 15 minutes; a finished
//   upload also replays from uploads.result), publisher snapshot and backup import retries within minutes. A key
//   reused after 30 days is treated as a new request.
// - audits: older than AUDIT_RETENTION_DAYS (default 365; "0" keeps them forever). Nothing reads old audits back:
//   the project audit list shows the newest 200, and project purge only adds one.
var PRUNE_BATCH = 5e3;
var IDEMPOTENCY_RETENTION_DAYS = 30;
// Audits are incident history: a configured retention below this is raised to it.
var AUDIT_RETENTION_MIN_DAYS = 30;
function auditRetentionDays(env) {
  const v = env.AUDIT_RETENTION_DAYS;
  if (v === void 0 || !/^\d{1,6}$/.test(v)) return 365;
  const n = Number(v);
  return n === 0 ? 0 : Math.max(n, AUDIT_RETENTION_MIN_DAYS);
}
async function pruneExpiredRows(env, { batch = PRUNE_BATCH } = {}) {
  const now = nowMs(), day = 864e5, DB = env.DB;
  const del = (table, where, value) => DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} < ? ORDER BY ${where} LIMIT ?)`).bind(value, batch).run();
  const out = {};
  out.sessions = (await del("sessions", "expires_at", now)).meta.changes ?? 0;
  out.idempotency = (await del("idempotency", "created_at", new Date(now - IDEMPOTENCY_RETENTION_DAYS * day).toISOString())).meta.changes ?? 0;
  const keep = auditRetentionDays(env);
  out.audits = keep > 0 ? (await del("audits", "at", new Date(now - keep * day).toISOString())).meta.changes ?? 0 : 0;
  for (const [table, n] of Object.entries(out)) if (n >= batch) console.warn(JSON.stringify({ event: "retention_cleanup_batch_full", table, deleted: n, limit: batch }));
  return out;
}

// The one-hour sweep age exceeds the ten-minute SQL publication deadline. A reclaimed intent cannot publish,
// even if its R2 put is still in flight. Failed deletes leave the intent for a later run.
async function sweepContentWrites(env, { projectId, limit = 50 } = {}) {
  const cutoff = nowMs() - TEXT_WRITE_STALE_MS;
  const rows = await env.DB.prepare(`SELECT key FROM content_writes WHERE created_at < ?${projectId ? " AND project_id = ?" : ""} ORDER BY created_at LIMIT ?`)
    .bind(cutoff, ...projectId ? [projectId] : [], limit).all();
  for (const { key } of rows.results) {
    const referenced = await env.DB.prepare("SELECT 1 FROM revisions WHERE body_key = ? UNION ALL SELECT 1 FROM comments WHERE body_key = ? UNION ALL SELECT 1 FROM proposals WHERE body_key = ? LIMIT 1").bind(key, key, key).first();
    if (!referenced) await deleteBlob(env, key);
    await env.DB.prepare("DELETE FROM content_writes WHERE key = ? AND created_at < ?").bind(key, cutoff).run();
  }
}

// Database size (cron, every 15 minutes). D1 reports the database size in bytes in result.meta.size_after of any query,
// so one SELECT 1 measures it (local miniflare may omit it: size_bytes is then null). Logs {event:"db_size", size_bytes}
// every run and, when DB_SIZE_WARN_BYTES (a positive integer) is set and reached, {event:"db_size_warning", ...}. An
// unset or invalid DB_SIZE_WARN_BYTES means no warning; invalid logs one db_size_config_invalid per isolate.
// Installation-wide numbers only. The first sample of each UTC day is kept in db_size_samples (migration 0032) for 400
// days. Never throws: a failure here must not stop the other cron steps.
var DB_SIZE_SAMPLE_RETENTION_DAYS = 400;
var dbSizeConfigErrorLogged = false;
function dbSizeWarnBytes(env) {
  const v = env.DB_SIZE_WARN_BYTES;
  if (v === void 0 || v === null || v === "") return null;
  const n = typeof v === "string" && /^[1-9]\d{0,15}$/.test(v.trim()) ? Number(v) : typeof v === "number" ? v : NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  if (!dbSizeConfigErrorLogged) {
    dbSizeConfigErrorLogged = true;
    console.error(JSON.stringify({ event: "db_size_config_invalid", var: "DB_SIZE_WARN_BYTES", message: "must be a positive integer number of bytes; no warning is logged" }));
  }
  return null;
}
async function recordDbSize(env) {
  try {
    const warnBytes = dbSizeWarnBytes(env);
    const res = await env.DB.prepare("SELECT 1").run();
    const raw = res?.meta?.size_after;
    const sizeBytes = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
    console.log(JSON.stringify({ event: "db_size", size_bytes: sizeBytes }));
    if (sizeBytes === null) return;
    if (warnBytes !== null && sizeBytes >= warnBytes) console.warn(JSON.stringify({ event: "db_size_warning", size_bytes: sizeBytes, warn_bytes: warnBytes }));
    const now = nowMs();
    const day = new Date(now).toISOString().slice(0, 10);
    const kept = await env.DB.prepare("INSERT OR IGNORE INTO db_size_samples (day, size_bytes, sampled_at) VALUES (?, ?, ?)").bind(day, sizeBytes, new Date(now).toISOString()).run();
    if (kept.meta?.changes) await env.DB.prepare("DELETE FROM db_size_samples WHERE day < ?").bind(new Date(now - DB_SIZE_SAMPLE_RETENTION_DAYS * 864e5).toISOString().slice(0, 10)).run();
  } catch (e) {
    console.error(JSON.stringify({ event: "db_size_failed", message: String(e?.message ?? e).slice(0, 200) }));
  }
}

export { PUT_MARGIN_MS, pruneExpiredRows, reconcileUploads, recordDbSize, staleWritesBefore };
