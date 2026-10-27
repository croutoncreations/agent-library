// Upload reconciliation: expire abandoned uploads and delete their R2 objects. Idempotent and
// bounded per run; safe to run concurrently with uploads (only terminal or long-expired rows are touched).
import type { Env } from "./auth";
import { limitsFor } from "./auth";
import { nowMs } from "./util";

const EXPIRED = JSON.stringify({ status: 410, code: "upload_expired", message: "Upload expired" });
const CRASHED = JSON.stringify({ status: 500, code: "finish_abandoned", message: "Upload finish did not complete" });

export async function reconcileUploads(env: Env, opts: { projectId?: string; limit?: number } = {}) {
  const now = nowMs();
  const grace = limitsFor(env).cleanupGraceMs;
  const limit = opts.limit ?? 50;
  const pf = opts.projectId ? " AND project_id = ?" : "";
  const pp = opts.projectId ? [opts.projectId] : [];
  const DB = env.DB;

  // 1. Expire abandoned uploads. 'receiving' only after a grace period (a PUT may still be streaming);
  //    'sealed' only after grace (finish crashed between seal and publish).
  const e1 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state IN ('pending','received') AND expires_at <= ?${pf}`)
    .bind(EXPIRED, now, ...pp).run();
  const e2 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state = 'receiving' AND expires_at <= ?${pf}`)
    .bind(EXPIRED, now - grace, ...pp).run();
  const e3 = await DB.prepare(`UPDATE uploads SET state = 'failed', result = ? WHERE state = 'sealed' AND expires_at <= ?${pf}
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.id = uploads.final_revision_id)`)
    .bind(CRASHED, now - grace, ...pp).run();

  // 2. Delete staging objects of terminal uploads (published ones normally purge inline already).
  let purgedStaging = 0, purgedFinal = 0;
  const st = await DB.prepare(`SELECT id, staging_key FROM uploads WHERE staging_purged_at IS NULL AND state IN ('failed','conflict','published')${pf} LIMIT ?`)
    .bind(...pp, limit).all<{ id: string; staging_key: string }>();
  for (const u of st.results) {
    await env.BLOBS.delete(u.staging_key); // R2 delete is idempotent
    const r = await DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE id = ? AND staging_purged_at IS NULL AND state IN ('failed','conflict','published')")
      .bind(now, u.id).run();
    purgedStaging += r.meta.changes ? 1 : 0;
  }
  // 3. Delete unreferenced final objects of uploads that never published (crash after the final put).
  const fi = await DB.prepare(`SELECT id, final_key FROM uploads u WHERE final_key IS NOT NULL AND final_purged_at IS NULL AND state IN ('failed','conflict')
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key)${pf.replace("project_id", "u.project_id")} LIMIT ?`)
    .bind(...pp, limit).all<{ id: string; final_key: string }>();
  for (const u of fi.results) {
    await env.BLOBS.delete(u.final_key);
    const r = await DB.prepare("UPDATE uploads SET final_purged_at = ? WHERE id = ? AND final_purged_at IS NULL").bind(now, u.id).run();
    purgedFinal += r.meta.changes ? 1 : 0;
  }
  // 4. Prune old rate-limit windows, and single-use markers older than the longest token lifetime (31 d).
  await DB.prepare("DELETE FROM rate_counters WHERE win < ?").bind(Math.floor(now / 60_000) - 2).run();
  await DB.prepare("DELETE FROM oauth_code_redemptions WHERE redeemed_at < ?").bind(now - 31 * 24 * 3600_000).run().catch(() => {});
  return { expired: (e1.meta.changes ?? 0) + (e2.meta.changes ?? 0) + (e3.meta.changes ?? 0), purged_staging: purgedStaging, purged_final: purgedFinal };
}
