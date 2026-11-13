// Deleted workspaces (docs/workspaces.md#deleting-a-workspace). WORKSPACE_PURGE_GRACE_DAYS after deleteWorkspace set
// status 'deleting' and deleting_at, the cron marks the workspace (purge_marked_at: the point of no return), then marks
// every live project of it deleted and due now; purgeDueProjects (project-deletion.js) removes their content in this
// and later runs, and purged_at is set once none is left. The workspaces row, members, invitations, billing and audits
// stay. Per run: fill deleting_at for rows an older Worker deleted (one statement on the shared workspaces table);
// select up to MARK_PER_RUN due workspaces and mark each; select up to RECOVER_PER_RUN marked workspaces that still
// have a live project (a project marking that failed) and mark their projects; then select up to FINISH_PER_RUN marked
// workspaces and try the finish. Never rejects; logs ids, counts and error codes only. The statement helpers take the
// database handle, so a later per-workspace store can pass its own.
import { RETENTION_DAYS } from "./project-deletion.js";
import { nowMs } from "./util.js";

export const WORKSPACE_PURGE_GRACE_DAYS = RETENTION_DAYS;
const DAY_MS = 864e5;
const MARK_PER_RUN = 5;
const RECOVER_PER_RUN = 5;
const FINISH_PER_RUN = 10;
const FILL_PER_RUN = 100;
const errorCode = (e) => String(e?.code ?? e?.name ?? "error").slice(0, 60);

/** The point of no return for one workspace: true if this call set purge_marked_at. */
async function markWorkspace(db, workspaceId, { now, cutoff }) {
  const r = await db.prepare(`UPDATE workspaces SET purge_marked_at = ? WHERE id = ? AND purge_marked_at IS NULL AND status = 'deleting' AND personal = 0
      AND deleting_at <= ?`).bind(now, workspaceId, cutoff).run();
  return !!r.meta.changes;
}

/**
 * Marks every live project of a marked workspace deleted and due now. A project the user deleted earlier is left as it
 * is: both grace periods are RETENTION_DAYS and no project can be deleted in a closed workspace, so it is already due.
 * Idempotent. Returns the number of projects it marked.
 * Per-workspace move: this reads workspaces inside a statement that writes projects; the caller then passes "marker
 * confirmed" instead.
 */
async function markWorkspaceProjects(db, workspaceId, now) {
  const r = await db.prepare(`UPDATE projects SET deleted_at = ?, deleted_by = 'system', purge_at = ?, deleted_slug = slug, slug = NULL
    WHERE workspace_id = ? AND purged_at IS NULL AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND status = 'deleting' AND personal = 0 AND purge_marked_at IS NOT NULL AND purged_at IS NULL)`)
    .bind(now, now, workspaceId, workspaceId).run();
  return r.meta.changes ?? 0;
}

/** Sets purged_at once no project of the workspace is left unpurged: true if this call set it. */
async function finishWorkspacePurge(db, workspaceId, now) {
  const r = await db.prepare(`UPDATE workspaces SET purged_at = ? WHERE id = ? AND purged_at IS NULL AND purge_marked_at IS NOT NULL AND status = 'deleting'
      AND NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id = ? AND purged_at IS NULL)`).bind(now, workspaceId, workspaceId).run();
  return !!r.meta.changes;
}

/** Cron (index.js scheduled). Returns { marked, recovered, projects_marked, pending, finished }. */
export async function purgeDeletingWorkspaces(env, { now = nowMs() } = {}) {
  const out = { marked: 0, recovered: 0, projects_marked: 0, pending: 0, finished: 0 };
  try {
    const db = env.DB;
    const cutoff = now - WORKSPACE_PURGE_GRACE_DAYS * DAY_MS;
    // Deleted by a Worker from before migration 0030: their grace starts now.
    await db.prepare(`UPDATE workspaces SET deleting_at = ? WHERE id IN (SELECT id FROM workspaces
        WHERE status = 'deleting' AND purge_marked_at IS NULL AND deleting_at IS NULL LIMIT ${FILL_PER_RUN})`).bind(now).run();
    const due = (await db.prepare(`SELECT id FROM workspaces WHERE status = 'deleting' AND purge_marked_at IS NULL AND personal = 0 AND deleting_at <= ?
        ORDER BY deleting_at LIMIT ${MARK_PER_RUN}`).bind(cutoff).all()).results;
    for (const { id } of due) {
      let step = "mark";
      try {
        if (!await markWorkspace(db, id, { now, cutoff })) {
          console.log(JSON.stringify({ event: "workspace_purge_skipped", workspaceId: id, reason: "no_longer_due" }));
          continue;
        }
        out.marked++;
        step = "mark_projects";
        out.projects_marked += await markWorkspaceProjects(db, id, now);
      } catch (e) { console.error(JSON.stringify({ event: "workspace_purge_failed", workspaceId: id, step, code: errorCode(e) })); }
    }
    // Marked workspaces whose project marking failed (or crashed) after their marker.
    const unmarked = (await db.prepare(`SELECT w.id FROM workspaces w WHERE w.status = 'deleting' AND w.purge_marked_at IS NOT NULL AND w.purged_at IS NULL
        AND EXISTS (SELECT 1 FROM projects p WHERE p.workspace_id = w.id AND p.deleted_at IS NULL) ORDER BY w.purge_marked_at LIMIT ${RECOVER_PER_RUN}`).all()).results;
    for (const { id } of unmarked) {
      try { out.projects_marked += await markWorkspaceProjects(db, id, now); out.recovered++; }
      catch (e) { console.error(JSON.stringify({ event: "workspace_purge_failed", workspaceId: id, step: "recover", code: errorCode(e) })); }
    }
    const pending = (await db.prepare(`SELECT id FROM workspaces WHERE status = 'deleting' AND purge_marked_at IS NOT NULL AND purged_at IS NULL
        ORDER BY purge_marked_at LIMIT ${FINISH_PER_RUN}`).all()).results;
    for (const { id } of pending) {
      try { if (await finishWorkspacePurge(db, id, now)) out.finished++; else out.pending++; }
      catch (e) { console.error(JSON.stringify({ event: "workspace_purge_failed", workspaceId: id, step: "finish", code: errorCode(e) })); }
    }
  } catch (e) { console.error(JSON.stringify({ event: "workspace_purge_failed", step: "run", code: errorCode(e) })); }
  if (out.marked || out.recovered || out.projects_marked || out.pending || out.finished) console.log(JSON.stringify({ event: "workspace_purge", ...out }));
  return out;
}
