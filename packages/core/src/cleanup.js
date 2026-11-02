import { deleteBlob } from "./content-store.js";
import { limitsFor } from "./auth.js";
import { nowMs } from "./util.js";

var EXPIRED = JSON.stringify({ status: 410, code: "upload_expired", message: "Upload expired" });
var CRASHED = JSON.stringify({ status: 500, code: "finish_abandoned", message: "Upload finish did not complete" });
async function reconcileUploads(env, opts = {}) {
  const now = nowMs();
  const grace = limitsFor(env).cleanupGraceMs;
  const limit = opts.limit ?? 50;
  const pf = opts.projectId ? " AND project_id = ?" : "";
  const pp = opts.projectId ? [opts.projectId] : [];
  const DB = env.DB;
  const e1 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state IN ('pending','received') AND expires_at <= ?${pf}`).bind(EXPIRED, now, ...pp).run();
  const e2 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state = 'receiving' AND expires_at <= ?${pf}`).bind(EXPIRED, now - grace, ...pp).run();
  const e3 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ?, finalize_token = NULL, finalize_until = NULL WHERE state = 'sealed' AND expires_at <= ? AND (finalize_until IS NULL OR finalize_until <= ?)${pf}
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.id = uploads.final_revision_id)`).bind(CRASHED, now - grace, now, ...pp).run();
  const retained = await DB.prepare(`SELECT COUNT(*) AS count, MIN(expires_at) AS oldest_expiry FROM uploads WHERE state IN ('failed','conflict','published') AND final_writes > 0 AND final_key IS NOT NULL AND final_purged_at IS NULL${pf}`).bind(...pp).first();
  if (retained?.count > 0) console.warn(JSON.stringify({ event: "upload_final_writes_retained", count: retained.count, oldest_expiry_age_ms: Math.max(0, now - retained.oldest_expiry) }));
  let purgedStaging = 0, purgedFinal = 0;
  const st = await DB.prepare(`SELECT id, staging_key FROM uploads WHERE staging_purged_at IS NULL AND state IN ('failed','conflict','published')${pf} LIMIT ?`).bind(...pp, limit).all();
  for (const u of st.results) {
    await deleteBlob(env, u.staging_key);
    const r = await DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE id = ? AND staging_purged_at IS NULL AND state IN ('failed','conflict','published')").bind(now, u.id).run();
    purgedStaging += r.meta.changes ? 1 : 0;
  }
  const fi = await DB.prepare(`SELECT id, final_key FROM uploads u WHERE final_key IS NOT NULL AND final_purged_at IS NULL AND state IN ('failed','conflict') AND final_writes = 0
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key)${pf.replace("project_id", "u.project_id")} LIMIT ?`).bind(...pp, limit).all();
  for (const u of fi.results) {
    await deleteBlob(env, u.final_key);
    const r = await DB.prepare("UPDATE uploads SET final_purged_at = ? WHERE id = ? AND final_purged_at IS NULL").bind(now, u.id).run();
    purgedFinal += r.meta.changes ? 1 : 0;
  }
  await DB.prepare("DELETE FROM rate_counters WHERE win < ?").bind(Math.floor(now / 6e4) - 2).run();
  await DB.prepare("DELETE FROM transfer_links WHERE expires_at < ?").bind(now).run().catch(() => {
  });
  await DB.prepare("DELETE FROM oauth_code_redemptions WHERE redeemed_at < ?").bind(now - 31 * 24 * 36e5).run().catch(() => {
  });
  return { expired: (e1.meta.changes ?? 0) + (e2.meta.changes ?? 0) + (e3.meta.changes ?? 0), purged_staging: purgedStaging, purged_final: purgedFinal };
}

export { reconcileUploads };
