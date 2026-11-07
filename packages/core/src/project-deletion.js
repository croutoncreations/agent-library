// Deleting a project (decision D21 B, docs/workspaces.md#deleting-a-project). Human workspace admins only.
//   delete:   the project is closed to everyone at once (every gate is built from memberRoleSql, which excludes
//             deleted projects), stops counting toward the projects limit, and its address is free for a new project.
//             Agent access isn't revoked: it simply stops working, and comes back unchanged if the project is restored.
//   restore:  within RETENTION_DAYS, by an admin of the (active) workspace, if the projects limit has room. It gets
//             its old address back, or a fresh one if a new project took it meanwhile.
//   purge:    after RETENTION_DAYS (or at once with "delete permanently"), the cron removes its content in bounded
//             batches: every row keyed by the project and its R2 files. The projects row stays as a tombstone
//             (title "Deleted project", no address) because API keys, connections and audits reference it.
// Nothing here runs for agents, and nothing is removed outside purgeDueProjects.
import { requireHuman } from "./auth.js";
import { deleteBlob } from "./content-store.js";
import { explainLimit, limitGuard } from "./limits.js";
import { ensureSlug } from "./paths.js";
import { memberRoleSql, projectWorkspaceSql, requireWorkspaceRole, workspaceRoleSql } from "./tenancy.js";
import { HttpError, nowIso, nowMs } from "./util.js";

export const RETENTION_DAYS = 30;
const DAY = 864e5;

function audit(ctx, projectId, action, result, gate, gateParams) {
  return ctx.env.DB.prepare(
    `INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, (SELECT ${projectWorkspaceSql("p")} FROM projects p WHERE p.id = ?) WHERE ${gate}`
  ).bind(nowIso(), ctx.principal.id, projectId, action, projectId, result, ctx.requestId, projectId, ...gateParams);
}
const confirmTitle = (input, title) => {
  // The caller types the project's title (as in the app) so a stray request can't delete the wrong project.
  if (typeof input?.confirm_title !== "string" || input.confirm_title.trim() !== String(title).trim())
    throw new HttpError(400, "confirmation_required", "Type the project's name to confirm");
};

/** DELETE /api/projects/:id {confirm_title}: workspace admins (project admin role); the workspace must be active. */
export async function deleteProject(ctx, projectId, input) {
  requireHuman(ctx);
  const p = await ctx.env.DB.prepare(`SELECT p.id, p.title, ${projectWorkspaceSql("p")} AS workspace_id FROM projects p WHERE p.id = ? AND p.deleted_at IS NULL AND ${memberRoleSql("p.id", "viewer")}`)
    .bind(projectId, ctx.principal.id).first();
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  await requireWorkspaceRole(ctx, p.workspace_id, "admin");
  confirmTitle(input, p.title);
  const now = nowMs();
  const gate = "changes() = 1";
  const [u] = await ctx.env.DB.batch([
    // workspace_id is filled for legacy rows so the Recently deleted list (by workspace) finds them. The address is
    // released (a new project can take it) and kept in deleted_slug for a restore.
    ctx.env.DB.prepare(`UPDATE projects SET deleted_at = ?, deleted_by = ?, purge_at = ?, deleted_slug = slug, slug = NULL, workspace_id = COALESCE(workspace_id, 'wsp_' || owner_id)
        WHERE id = ? AND deleted_at IS NULL AND ${memberRoleSql("?", "admin")}`).bind(now, ctx.principal.id, now + RETENTION_DAYS * DAY, projectId, ctx.principal.id, projectId),
    audit(ctx, projectId, "project.delete", "ok", gate, [])
  ]);
  if (!u.meta.changes) throw new HttpError(403, "forbidden", "Needs the admin role in this workspace");
  return { ok: true, id: projectId, deleted_at: new Date(now).toISOString(), purge_at: new Date(now + RETENTION_DAYS * DAY).toISOString() };
}

/** GET /api/workspaces/:id/deleted-projects: admins; projects that can still be restored. */
export async function listDeletedProjects(ctx, workspaceId) {
  requireHuman(ctx);
  await requireWorkspaceRole(ctx, workspaceId, "admin", true);
  const r = await ctx.env.DB.prepare(
    `SELECT p.id, p.title, p.deleted_at, p.purge_at, pr.label AS deleted_by_label,
       (SELECT COUNT(*) FROM artifacts a WHERE a.project_id = p.id AND a.head_rev > 0) AS items
     FROM projects p LEFT JOIN principals pr ON pr.id = p.deleted_by
     WHERE p.workspace_id = ? AND p.deleted_at IS NOT NULL AND p.purged_at IS NULL AND p.purge_at > ? ORDER BY p.deleted_at DESC LIMIT 200`
  ).bind(workspaceId, nowMs()).all();
  return { projects: r.results.map((p) => ({ id: p.id, title: p.title, items: p.items, deleted_by: p.deleted_by_label ?? null,
    deleted_at: new Date(p.deleted_at).toISOString(), purge_at: new Date(p.purge_at).toISOString() })) };
}

async function deletedRow(ctx, projectId) {
  const p = await ctx.env.DB.prepare("SELECT id, title, deleted_slug AS slug, workspace_id, purge_at FROM projects WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL AND purge_at > ?")
    .bind(projectId, nowMs()).first();
  if (!p?.workspace_id) throw new HttpError(404, "not_found", "Deleted project not found");
  await requireWorkspaceRole(ctx, p.workspace_id, "admin");
  return p;
}

/** POST /api/projects/:id/restore: back to normal, with its content and agent access, if the projects limit has room. */
export async function restoreProject(ctx, projectId) {
  requireHuman(ctx);
  const p = await deletedRow(ctx, projectId);
  const lg = await limitGuard(ctx.env, p.workspace_id, { projects: 1 });
  const live = "deleted_at IS NOT NULL AND purged_at IS NULL AND purge_at > ?";
  const [u] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE projects SET deleted_at = NULL, deleted_by = NULL, purge_at = NULL, deleted_slug = NULL
        WHERE id = ? AND ${live} AND ${workspaceRoleSql("?", "admin")} AND ${lg.sql}`).bind(projectId, nowMs(), ctx.principal.id, p.workspace_id, ...lg.params),
    audit(ctx, projectId, "project.restore", "ok", "changes() = 1", [])
  ]);
  if (!u.meta.changes) {
    await explainLimit(ctx.env, p.workspace_id, { projects: 1 }, lg.limits);
    throw new HttpError(409, "conflict", "The project changed meanwhile. Reload and try again.");
  }
  // Its old address if still free (a new project may have taken it meanwhile), else a fresh one from the title.
  let slug = null;
  if (p.slug) {
    try { if ((await ctx.env.DB.prepare("UPDATE projects SET slug = ? WHERE id = ? AND slug IS NULL").bind(p.slug, projectId).run()).meta.changes) slug = p.slug; }
    catch (e) { if (!/UNIQUE|constraint/i.test(String(e))) throw e; }
  }
  slug ??= await ensureSlug(ctx.env, { id: projectId, slug: null, title: p.title });
  return { ok: true, id: projectId, title: p.title, slug };
}

/** POST /api/projects/:id/purge {confirm_title}: delete permanently now (an already-deleted project). Irreversible. */
export async function purgeProjectNow(ctx, projectId, input) {
  requireHuman(ctx);
  const p = await deletedRow(ctx, projectId);
  confirmTitle(input, p.title);
  const now = nowMs();
  const [u] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE projects SET purge_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL AND purge_at > ? AND ${workspaceRoleSql("?", "admin")}`)
      .bind(now, projectId, now, ctx.principal.id, p.workspace_id),
    audit(ctx, projectId, "project.purge_requested", "ok", "changes() = 1", [])
  ]);
  if (!u.meta.changes) throw new HttpError(409, "conflict", "The project changed meanwhile. Reload and try again.");
  // Start right away (bounded); the cron finishes anything left.
  await purgeDueProjects(ctx.env, { projectId, rowBudget: 2000, blobBudget: 200 });
  return { ok: true, id: projectId };
}

// Purge order: children before parents (composite foreign keys), and R2 files before the rows that name them so a
// crash never leaves a file nobody can find. Each step deletes at most `n` rows.
const STEPS = [
  ["transfer_links", "project_id = ?1"],
  ["idempotency", "project_id = ?1"],
  ["comments", "project_id = ?1"],
  ["meta_versions", "project_id = ?1"],
  ["project_changes", "project_id = ?1"],
  ["publisher_generation_parts", "publisher_id IN (SELECT id FROM publishers WHERE project_id = ?1)"],
  ["publisher_generations", "project_id = ?1"],
  ["snapshots", "publisher_id IN (SELECT id FROM publishers WHERE project_id = ?1)"],
  ["uploads", "project_id = ?1"],
  ["revisions", "project_id = ?1"],
  ["artifacts", "project_id = ?1"],
  ["folders", "project_id = ?1"],
  ["project_members", "project_id = ?1"],
  ["project_change_state", "project_id = ?1"],
  ["change_scope_epochs", "project_id = ?1"]
];
// Kept (they hold credentials and history, all closed by the gate): grants, oauth_connection_projects,
// api_credential_projects, publishers (revoked here), audits.

/**
 * Cron: remove the content of projects whose purge_at has passed. Bounded per run (rowBudget rows, blobBudget R2
 * deletes); safe to repeat and to run concurrently (every step is a plain idempotent delete).
 */
export async function purgeDueProjects(env, { projectId, rowBudget = 5000, blobBudget = 500 } = {}) {
  const now = nowMs();
  const due = (await env.DB.prepare(`SELECT id FROM projects WHERE purge_at IS NOT NULL AND purge_at <= ? AND purged_at IS NULL AND deleted_at IS NOT NULL${projectId ? " AND id = ?" : ""} ORDER BY purge_at LIMIT 5`)
    .bind(now, ...projectId ? [projectId] : []).all()).results;
  const out = { projects: 0, rows: 0, files: 0, finished: [] };
  for (const { id } of due) {
    // R2 first: files named by this project's revisions and uploads (keys always start blobs/<id>/ or staging/<id>/).
    for (;;) {
      if (blobBudget <= 0) return out;
      const keys = (await env.DB.prepare(
        `SELECT k FROM (SELECT blob_key AS k FROM revisions WHERE project_id = ?1 AND blob_key IS NOT NULL
           UNION SELECT staging_key FROM uploads WHERE project_id = ?1 AND staging_key IS NOT NULL AND staging_purged_at IS NULL
           UNION SELECT final_key FROM uploads WHERE project_id = ?1 AND final_key IS NOT NULL AND final_purged_at IS NULL) LIMIT ?2`
      ).bind(id, Math.min(100, blobBudget)).all()).results.map((r) => r.k);
      if (!keys.length) break;
      for (const k of keys) {
        if (!k.startsWith(`blobs/${id}/`) && !k.startsWith(`staging/${id}/`)) { console.error("purge_foreign_key_skipped"); continue; }
        await deleteBlob(env, k);
      }
      blobBudget -= keys.length; out.files += keys.length;
      // Forget the deleted keys so the next round moves on (rows go in the steps below).
      await env.DB.batch([
        env.DB.prepare("UPDATE revisions SET blob_key = NULL WHERE project_id = ? AND blob_key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE project_id = ? AND staging_key IN (SELECT value FROM json_each(?))").bind(now, id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE uploads SET final_purged_at = ? WHERE project_id = ? AND final_key IN (SELECT value FROM json_each(?))").bind(now, id, JSON.stringify(keys))
      ]);
    }
    for (const [table, where] of STEPS) {
      for (;;) {
        if (rowBudget <= 0) return out;
        const n = Math.min(500, rowBudget);
        const r = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?2)`).bind(id, n).run();
        const k = r.meta.changes ?? 0;
        rowBudget -= k; out.rows += k;
        if (k < n) break;
      }
    }
    // Search index rows go with their artifacts (trigger). Publishers stop for good; the project row becomes a tombstone.
    await env.DB.batch([
      env.DB.prepare("UPDATE publishers SET revoked_at = COALESCE(revoked_at, ?) WHERE project_id = ?").bind(now, id),
      env.DB.prepare("UPDATE projects SET purged_at = ?, title = 'Deleted project', slug = NULL, deleted_slug = NULL WHERE id = ? AND purged_at IS NULL").bind(now, id),
      env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
        SELECT ?, 'system', ?, 'project.purge', ?, 'ok', 'cron', workspace_id FROM projects WHERE id = ?`).bind(nowIso(), id, id, id)
    ]);
    out.projects++; out.finished.push(id);
  }
  return out;
}
