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
import { staleWritesBefore } from "./cleanup.js";
import { deleteBlob, listBlobKeys } from "./content-store.js";
import { unindexMany } from "./search/indexing.js";
import { explainLimit, limitGuard } from "./limits.js";
import { ensureSlug } from "./paths.js";
import { memberRoleSql, projectWorkspaceSql, requireWorkspaceRole, workspaceRoleSql } from "./tenancy.js";
import { HttpError, cutLists, nowIso, nowMs } from "./util.js";

export const RETENTION_DAYS = 30;
/** Recently deleted lists at most this many projects (the UI's "Showing the first N" note uses the same number). */
export const DELETED_PROJECTS_MAX = 200;
// Restore closes an hour before purge_at, so a restore and a purge running on different clocks can't overlap.
const RESTORE_MARGIN_MS = 36e5;
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
  // Deleting, restoring and purging all need the admin (or owner) role in the project's workspace, whatever any
  // per-project cap says: it's a workspace-level action, like creating a project.
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
        WHERE id = ? AND deleted_at IS NULL AND ${workspaceRoleSql("?", "admin")}`).bind(now, ctx.principal.id, now + RETENTION_DAYS * DAY, projectId, ctx.principal.id, p.workspace_id),
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
       (SELECT COUNT(*) FROM artifacts a WHERE a.project_id = p.id AND a.head_rev > 0 AND a.trashed_at IS NULL) AS items
     FROM projects p LEFT JOIN principals pr ON pr.id = p.deleted_by
     WHERE p.workspace_id = ? AND p.deleted_at IS NOT NULL AND p.purged_at IS NULL AND p.purge_at > ? ORDER BY p.deleted_at DESC LIMIT ${DELETED_PROJECTS_MAX + 1}`
  ).bind(workspaceId, nowMs()).all();
  return { truncated: cutLists({ projects: r.results.length > DELETED_PROJECTS_MAX }), projects: r.results.slice(0, DELETED_PROJECTS_MAX).map((p) => ({ id: p.id, title: p.title, items: p.items, deleted_by: p.deleted_by_label ?? null,
    deleted_at: new Date(p.deleted_at).toISOString(), purge_at: new Date(p.purge_at).toISOString() })) };
}

async function deletedRow(ctx, projectId) {
  const p = await ctx.env.DB.prepare("SELECT id, title, deleted_slug AS slug, workspace_id, purge_at FROM projects WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL AND purge_at > ?")
    .bind(projectId, nowMs()).first();
  // Same 404 whether it doesn't exist or the caller isn't an admin of its workspace (nothing about it is revealed).
  // workspaceRoleSql's SQL names the principal (join) before the workspace (where): bind in that order.
  const admin = p?.workspace_id && await ctx.env.DB.prepare(`SELECT ${workspaceRoleSql("?", "admin", "?", true)} AS ok`).bind(ctx.principal.id, p.workspace_id).first("ok");
  if (!admin) throw new HttpError(404, "not_found", "Deleted project not found");
  await requireWorkspaceRole(ctx, p.workspace_id, "admin");   // read-only (suspended) workspaces: 403 workspace_read_only
  return p;
}

/** POST /api/projects/:id/restore: back to normal, with its content and agent access, if the projects limit has room. */
export async function restoreProject(ctx, projectId) {
  requireHuman(ctx);
  const p = await deletedRow(ctx, projectId);
  // Its legacy grant tokens come back with it and count as agents again.
  const grants = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ?").bind(projectId, nowMs()).first("n");
  const adds = { projects: 1, ...grants ? { agents: grants } : {} };
  const lg = await limitGuard(ctx.env, p.workspace_id, adds);
  // Not in its last hour: the purge may already be running then (it starts once purge_at passes, on any clock).
  const live = "deleted_at IS NOT NULL AND purged_at IS NULL AND purge_at > ?";
  const [u] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE projects SET deleted_at = NULL, deleted_by = NULL, purge_at = NULL, deleted_slug = NULL
        WHERE id = ? AND ${live} AND ${workspaceRoleSql("?", "admin")} AND ${lg.sql}`).bind(projectId, nowMs() + RESTORE_MARGIN_MS, ctx.principal.id, p.workspace_id, ...lg.params),
    audit(ctx, projectId, "project.restore", "ok", "changes() = 1", [])
  ]);
  if (!u.meta.changes) {
    await explainLimit(ctx.env, p.workspace_id, adds, lg.limits);
    if (p.purge_at <= nowMs() + RESTORE_MARGIN_MS) throw new HttpError(409, "purge_started", "This project is being deleted permanently and can't be restored any more.");
    throw new HttpError(409, "conflict", "The project changed meanwhile. Reload and try again.");
  }
  // Its old address if still free (a new project may have taken it meanwhile), else a fresh one from the title.
  let slug = null;
  if (p.slug) {
    try { if ((await ctx.env.DB.prepare("UPDATE projects SET slug = ? WHERE id = ? AND slug IS NULL").bind(p.slug, projectId).run()).meta.changes) slug = p.slug; }
    catch (e) { if (!/UNIQUE|constraint/i.test(String(e))) throw e; }
  }
  slug ??= await ensureSlug(ctx.env, { id: projectId, slug: null, title: p.title });
  return { ok: true, id: projectId, title: p.title, slug, address_changed: !!p.slug && slug !== p.slug };
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
  // Start right away (bounded) unless an upload could still be finishing (its lease is 60 s) or writing; the cron
  // finishes the rest.
  const leased = await ctx.env.DB.prepare(`SELECT 1 FROM uploads u WHERE u.project_id = ?1 AND ${UPLOAD_BUSY} LIMIT 1`).bind(projectId, now, staleWritesBefore(ctx.env, now)).first();
  if (!leased) await purgeDueProjects(ctx.env, { projectId, rowBudget: 2000, blobBudget: 200 });
  return { ok: true, id: projectId };
}

// An upload whose finish lease is live, or whose PUT may still write final_key (receiving, or a write counted), unless
// that count is stale (cleanup.js staleWritesBefore: no PUT commits that late), so a leaked count can't block a purge
// forever. ?2 = now, ?3 = staleWritesBefore.
const UPLOAD_BUSY = "(u.finalize_until > ?2 OR ((u.state = 'receiving' OR u.final_writes > 0) AND u.expires_at > ?3))";
const STILL_DUE = "EXISTS (SELECT 1 FROM projects d WHERE d.id = ?1 AND d.deleted_at IS NOT NULL AND d.purged_at IS NULL AND d.purge_at <= ?3)";
// Purge order: children before parents (composite foreign keys), and R2 files before the rows that name them so a
// crash never leaves a file nobody can find. Each step deletes at most `n` rows.
const STEPS = [
  ["transfer_links", "project_id = ?1"],
  ["view_links", "project_id = ?1"],
  ["idempotency", "project_id = ?1"],
  ["comments", "project_id = ?1"],
  ["meta_versions", "project_id = ?1"],
  ["project_changes", "project_id = ?1"],
  ["publisher_generation_parts", "publisher_id IN (SELECT id FROM publishers WHERE project_id = ?1)"],
  ["publisher_generations", "project_id = ?1"],
  ["snapshots", "publisher_id IN (SELECT id FROM publishers WHERE project_id = ?1)"],
  ["uploads", "project_id = ?1"],
  ["proposals", "project_id = ?1"],
  ["reviews", "project_id = ?1"],
  ["project_review_settings", "project_id = ?1"],
  ["review_grants", "project_id = ?1"],
  ["revisions", "project_id = ?1"],
  ["artifacts", "project_id = ?1"],
  ["folders", "project_id = ?1"],
  ["project_members", "project_id = ?1"],
  ["project_change_state", "project_id = ?1"],
  ["change_scope_epochs", "project_id = ?1"]
];
// Kept (credentials and history; all closed by the gate): grants, oauth_connections, oauth_connection_projects,
// api_credentials, api_credential_projects, publishers and audits. At purge, publishers and grants for this project are
// revoked, and so are API keys left with no live project. An OAuth connection left with none stays (zero projects is a
// normal state: the owner shares others with it, or disconnects it).

/**
 * Cron: remove the content of projects whose purge_at has passed. Bounded per run (rowBudget rows, blobBudget R2
 * deletes); safe to repeat and to run concurrently (every step is a plain idempotent delete).
 */
export async function purgeDueProjects(env, { projectId, rowBudget = 5000, blobBudget = 500 } = {}) {
  const now = nowMs();
  // A project with an upload still inside its finish lease or still writing waits for the next run, so no file lands
  // after its rows go.
  const due = (await env.DB.prepare(`SELECT id FROM projects WHERE purge_at IS NOT NULL AND purge_at <= ?2 AND purged_at IS NULL AND deleted_at IS NOT NULL${projectId ? " AND id = ?4" : ""}
      AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.project_id = projects.id AND ${UPLOAD_BUSY}) ORDER BY purge_at LIMIT 5`)
    .bind(null, now, staleWritesBefore(env, now), ...projectId ? [projectId] : []).all()).results;
  const out = { projects: 0, rows: 0, files: 0, finished: [] };
  for (const { id } of due) {
    const stillDue = async () => !!await env.DB.prepare(`SELECT 1 AS ok WHERE ${STILL_DUE}`).bind(id, null, now).first("ok");
    // R2 first: files named by this project's revisions and uploads (keys always start blobs/<id>/ or staging/<id>/).
    for (;;) {
      if (blobBudget <= 0) return out;
      // D1 allows five compound SELECT terms per level; group referenced content before the other key sources.
      const keys = (await env.DB.prepare(
        `SELECT k FROM (SELECT k FROM (
           SELECT blob_key AS k FROM revisions WHERE project_id = ?1 AND blob_key IS NOT NULL
           UNION SELECT body_key FROM revisions WHERE project_id = ?1 AND body_key IS NOT NULL
           UNION SELECT body_key FROM comments WHERE project_id = ?1 AND body_key IS NOT NULL
           UNION SELECT body_key FROM proposals WHERE project_id = ?1 AND body_key IS NOT NULL
           UNION SELECT blob_key FROM proposals WHERE project_id = ?1 AND blob_key IS NOT NULL)
           UNION SELECT key FROM content_writes WHERE project_id = ?1
           UNION SELECT staging_key FROM uploads WHERE project_id = ?1 AND staging_key IS NOT NULL AND staging_purged_at IS NULL
           UNION SELECT final_key FROM uploads WHERE project_id = ?1 AND final_key IS NOT NULL AND final_purged_at IS NULL) LIMIT ?2`
      ).bind(id, Math.min(100, blobBudget)).all()).results.map((r) => r.k);
      if (!keys.length) break;
      if (!await stillDue()) return out;
      for (const k of keys) {
        if (!k.startsWith(`blobs/${id}/`) && !k.startsWith(`staging/${id}/`) && !k.startsWith(`text/${id}/`)) { console.error("purge_foreign_key_skipped"); continue; }
        await deleteBlob(env, k);
      }
      blobBudget -= keys.length; out.files += keys.length;
      // Forget the deleted keys so the next round moves on (rows go in the steps below).
      await env.DB.batch([
        env.DB.prepare("UPDATE revisions SET blob_key = NULL WHERE project_id = ? AND blob_key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE revisions SET body_key = NULL WHERE project_id = ? AND body_key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE comments SET body_key = NULL WHERE project_id = ? AND body_key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE proposals SET body_key = NULL WHERE project_id = ? AND body_key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE proposals SET blob_key = NULL WHERE project_id = ? AND blob_key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(keys)),
        env.DB.prepare("DELETE FROM content_writes WHERE project_id = ? AND key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE uploads SET staging_purged_at = ? WHERE project_id = ? AND staging_key IN (SELECT value FROM json_each(?))").bind(now, id, JSON.stringify(keys)),
        env.DB.prepare("UPDATE uploads SET final_purged_at = ? WHERE project_id = ? AND final_key IN (SELECT value FROM json_each(?))").bind(now, id, JSON.stringify(keys))
      ]);
    }
    // The full-text index goes first (its entries are keyed by artifact id), in the same bounded steps as the rows.
    for (;;) {
      if (rowBudget <= 0) return out;
      const n = Math.min(500, rowBudget);
      const gone = await env.DB.batch(unindexMany(env.DB, `a.project_id = ?1 AND ${STILL_DUE}`, [id, n, now], "?2"));
      const k = gone[1].meta.changes ?? 0;
      rowBudget -= k; out.rows += k;
      if (k < n) break;
    }
    for (const [table, where] of STEPS) {
      for (;;) {
        if (rowBudget <= 0) return out;
        const n = Math.min(500, rowBudget);
        // Every step re-checks that the project is still deleted and due (defence in depth against a late restore).
        const r = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} AND ${STILL_DUE} LIMIT ?2)`).bind(id, n, now).run();
        const k = r.meta.changes ?? 0;
        rowBudget -= k; out.rows += k;
        if (k < n) break;
      }
    }
    // Then sweep both prefixes for anything no row names (a write that landed after its row went, or an earlier
    // crash). The run waits while an upload is inside its finish lease or writing (see `due`), so nothing new arrives
    // after this.
    for (const prefix of [`blobs/${id}/`, `staging/${id}/`, `text/${id}/`]) {
      for (;;) {
        if (blobBudget <= 0) return out;
        if (!await stillDue()) return out;
        const keys = await listBlobKeys(env, prefix, Math.min(100, blobBudget));
        if (!keys.length) break;
        for (const k of keys) await deleteBlob(env, k);
        blobBudget -= keys.length; out.files += keys.length;
      }
    }
    // Search index entries went above, before their artifacts. Publishers stop for good; API keys whose every project is
    // purged are revoked (they can't reach anything and would hold an agents slot forever). A project still in Recently
    // deleted counts as live here, so restoring it brings its credentials back. An OAuth connection left with no
    // project is NOT revoked: having no projects is a normal state (Connections shows "No projects shared yet"), and the
    // owner may share others with it or disconnect it.
    const noLive = (table, col) => `NOT EXISTS (SELECT 1 FROM ${table} x JOIN projects pj ON pj.id = x.project_id WHERE x.${col} = c.id AND x.project_id <> ?2 AND pj.purged_at IS NULL)`;
    // One transaction, tombstone first: the rest runs only if this call tombstoned it (still deleted and due).
    const [tomb] = await env.DB.batch([
      env.DB.prepare(`UPDATE projects SET purged_at = ?3, title = 'Deleted project', slug = NULL, deleted_slug = NULL WHERE id = ?1 AND purged_at IS NULL AND deleted_at IS NOT NULL AND purge_at <= ?3`).bind(id, null, now),
      env.DB.prepare("UPDATE publishers SET revoked_at = COALESCE(revoked_at, ?1) WHERE project_id = ?2 AND EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND purged_at = ?1)").bind(now, id),
      env.DB.prepare(`UPDATE api_credentials AS c SET revoked_at = ?1 WHERE c.revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND purged_at = ?1) AND EXISTS (SELECT 1 FROM api_credential_projects WHERE credential_id = c.id AND project_id = ?2) AND ${noLive("api_credential_projects", "credential_id")}`).bind(now, id),
      env.DB.prepare("UPDATE grants SET revoked_at = COALESCE(revoked_at, ?1) WHERE project_id = ?2 AND EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND purged_at = ?1)").bind(now, id),
      env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
        SELECT ?, 'system', ?, 'project.purge', ?, 'ok', 'cron', workspace_id FROM projects WHERE id = ? AND purged_at = ?`).bind(nowIso(), id, id, id, now)
    ]);
    if (!tomb.meta.changes) continue;
    out.projects++; out.finished.push(id);
  }
  return out;
}
