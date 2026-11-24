// Nested folders (docs/folders.md; migration 0036_nested_folders.sql). One implementation for every transport (owner
// /api, /v1, both MCP endpoints, App Connect). Ported from public main's src/folders/service.js (#30, #31).
//  - Folders form a tree per project: parent_id (NULL = project root), name = leaf, path = full display path
//    ("Reports/2026/Q1"; NULL for a top-level folder). name_key = lower(full path) keeps the existing UNIQUE
//    (project_id, name_key), so sibling names are unique case-insensitively. Top-level folders keep name_key =
//    lower(name), exactly what older Workers wrote.
//  - artifacts.folder_id is the source of truth; artifacts.folder (text) mirrors the folder's path for older readers,
//    backups and the change feed. Legacy free-text labels are adopted into the tree by write-capable callers.
//  - Create: anyone who can write to the project. Rename, move and delete: a person with the admin role on the
//    project; they change where many documents live at once, including protected ones. Subfolders an App Connect app
//    created inside its destination stay the app's while it is connected (409 folder_app_owned).
//  - Every write re-checks project authorization in the same statement (authzSql).
import { authorizeProject, authzSql, requireHuman } from "./auth.js";
import { humanGate, requireProjectRole } from "./tenancy.js";
import { FOLDERS_PER_PROJECT, audit, idemInsert, idemLookup, tooManyFolders } from "./service.js";
import { HttpError, idemKey, nowIso, randomId, sha256Hex, str } from "./util.js";

export const FD_MAX_DEPTH = 8;
export const FD_MAX_PATH = 200;
/** Folders one connected app may create (its subfolders persist after its files go, until the owner deletes them). */
export const FD_PER_APP = 200;
const db = (ctx) => ctx.env.DB;

/** One path segment: 1-80 chars after trim, no "/" or control characters, not "." or "..". */
export function fdSegment(raw, what = "Folder name") {
  const s = String(raw).trim();
  if (s.length < 1 || s.length > 80) throw new HttpError(400, "invalid_input", `${what} must be 1-80 characters`);
  if (/[\/\u0000-\u001f\u007f]/.test(s)) throw new HttpError(400, "invalid_input", `${what} cannot contain / or control characters`);
  if (s === "." || s === "..") throw new HttpError(400, "invalid_input", `${what} cannot be . or ..`);
  return s;
}
/** "a / b//c/" -> ["a", "b", "c"]; "" or "/" -> [] (project root); undefined/null -> null (no folder named). */
export function fdParsePath(v, name = "folder") {
  if (v === void 0 || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "invalid_input", `${name} must be a string`);
  if (v.length > FD_MAX_PATH + 64) throw new HttpError(413, "too_large", `${name} exceeds ${FD_MAX_PATH} characters`);
  const segs = v.split("/").map((s) => s.trim()).filter(Boolean).map((s) => fdSegment(s));
  if (segs.length > FD_MAX_DEPTH) throw new HttpError(400, "invalid_input", `Folders can be nested at most ${FD_MAX_DEPTH} levels deep`);
  if (segs.join("/").length > FD_MAX_PATH) throw new HttpError(413, "too_large", `${name} exceeds ${FD_MAX_PATH} characters`);
  return segs;
}
// JS toLowerCase, like every lookup (SQLite's lower() is ASCII-only); top-level keys equal what older Workers wrote.
export const fdKey = (path) => path.toLowerCase();
export const fdPathOf = (f) => f ? f.path ?? f.name : "";
export function fdView(f, extra = {}) {
  return { id: f.id, name: f.name, path: fdPathOf(f), parent_id: f.parent_id ?? null, publisher_id: f.publisher_id ?? null, created_at: f.created_at, ...extra };
}
export async function fdGet(ctx, projectId, id) {
  if (typeof id !== "string" || !/^fld_[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, "invalid_input", "folder_id must be a folder id");
  const f = await db(ctx).prepare("SELECT * FROM folders WHERE id = ? AND project_id = ?").bind(id, projectId).first();
  if (!f) throw new HttpError(404, "not_found", "Folder not found");
  return f;
}
export async function fdByPath(ctx, projectId, path) {
  return db(ctx).prepare("SELECT * FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, fdKey(path)).first();
}
const folderCount = (ctx, projectId) => db(ctx).prepare("SELECT COUNT(*) AS n FROM folders WHERE project_id = ?").bind(projectId).first("n");

// Legacy free-text folder labels (artifacts.folder without folder_id) become real folders, so the tree is the only
// folder model. Labels that are not valid paths stay as they are (shown, not navigable). Per isolate: project id -> how
// many unadopted labelled rows were left after the last scan; a listing rescans only when that number changes.
const fdAdopted = new Map();
async function fdAdoptLegacy(ctx, projectId) {
  if (ctx.publisher) return;
  // Only callers that can write here adopt (checked live): a read never writes data.
  const az = authzSql(ctx, projectId);
  if (!(await db(ctx).prepare(`SELECT ${az.sql} AS ok`).bind(...az.params).first("ok"))) return;
  const left = () => db(ctx).prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND folder_id IS NULL AND folder <> '' AND publisher_id IS NULL").bind(projectId).first("n");
  if (fdAdopted.has(projectId) && (await left()) === fdAdopted.get(projectId)) return;
  fdAdopted.delete(projectId);
  const rows = await db(ctx).prepare("SELECT DISTINCT folder FROM artifacts WHERE project_id = ? AND folder_id IS NULL AND folder <> '' AND publisher_id IS NULL LIMIT 500").bind(projectId).all();
  for (const r of rows.results) {
    let segs;
    try { segs = fdParsePath(r.folder); } catch { continue; }
    if (!segs || !segs.length) continue;
    let f;
    try { f = await fdEnsure(ctx, projectId, segs, { quiet: true }); } catch { continue; }
    const u = await db(ctx).prepare(`UPDATE artifacts SET folder_id = ?, folder = ? WHERE project_id = ? AND folder_id IS NULL AND folder = ? AND publisher_id IS NULL AND ${az.sql}`)
      .bind(f.id, fdPathOf(f), projectId, r.folder, ...az.params).run();
    if (u.meta.changes) await audit(ctx, projectId, "folder.adopt", f.id, null, "ok").run();
  }
  if (rows.results.length < 500) fdAdopted.set(projectId, await left());
}

/**
 * Find or create every folder of segs under base (a folder row, or null = project root). Returns the last folder row.
 * opts.publisherId marks folders created for an App Connect app; opts.fence {sql, params} is an extra condition every
 * insert must meet (the app's live authorization); opts.quiet skips the folder.create audit (legacy adoption).
 */
export async function fdEnsure(ctx, projectId, segs, opts = {}) {
  let parent = opts.base ?? null;
  const az0 = authzSql(ctx, projectId);
  const az = opts.fence ? { sql: `${az0.sql} AND ${opts.fence.sql}`, params: [...az0.params, ...opts.fence.params] } : az0;
  for (const seg of segs) {
    const path = parent ? fdPathOf(parent) + "/" + seg : seg;
    if (path.length > FD_MAX_PATH) throw new HttpError(413, "too_large", `Folder path exceeds ${FD_MAX_PATH} characters`);
    if (path.split("/").length > FD_MAX_DEPTH) throw new HttpError(400, "invalid_input", `Folders can be nested at most ${FD_MAX_DEPTH} levels deep`);
    let f = await fdByPath(ctx, projectId, path);
    if (!f) {
      const id = randomId("fld");
      // Guarded on the parent's path as read (a parent renamed, moved or deleted meanwhile refuses) and the cap.
      await db(ctx).prepare(`INSERT OR IGNORE INTO folders (id, project_id, name, name_key, created_at, created_by, publisher_id, parent_id, path)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${az.sql}
            AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ? AND name_key = ?))
            AND (SELECT COUNT(*) FROM folders WHERE project_id = ?) < ?
            AND (? IS NULL OR (SELECT COUNT(*) FROM folders WHERE publisher_id = ?) < ?)`)
        .bind(id, projectId, seg, fdKey(path), nowIso(), ctx.principal.id, opts.publisherId ?? null, parent?.id ?? null, parent ? path : null, ...az.params,
          parent?.id ?? null, parent?.id ?? null, projectId, parent ? fdKey(fdPathOf(parent)) : null, projectId, FOLDERS_PER_PROJECT,
          opts.publisherId ?? null, opts.publisherId ?? null, FD_PER_APP).run();
      f = await fdByPath(ctx, projectId, path);
      if (!f) {
        if (parent && !(await db(ctx).prepare("SELECT 1 AS x FROM folders WHERE id = ? AND name_key = ?").bind(parent.id, fdKey(fdPathOf(parent))).first("x")))
          throw new HttpError(409, "folder_conflict", "A folder on this path was renamed, moved or deleted meanwhile; retry");
        if ((await folderCount(ctx, projectId)) >= FOLDERS_PER_PROJECT) throw tooManyFolders();
        if (opts.publisherId && (await db(ctx).prepare("SELECT COUNT(*) AS n FROM folders WHERE publisher_id = ?").bind(opts.publisherId).first("n")) >= FD_PER_APP)
          throw new HttpError(409, "limit_reached", `An app can create at most ${FD_PER_APP} folders; delete or reuse some`, { limit: FD_PER_APP });
        throw new HttpError(403, "forbidden", "Grant no longer valid");
      }
      if (f.id === id && !opts.quiet) await audit(ctx, projectId, "folder.create", id, null, "ok").run();
    }
    parent = f;
  }
  return parent;
}

/**
 * Resolve a write's destination: folder_id wins; else a folder path (created as needed unless opts.create is false;
 * opts.defer returns { missing: true } instead of creating). Returns { folderId, path } (null / "" = project root), or
 * undefined when the input names no folder at all.
 */
export async function fdResolve(ctx, projectId, input, opts = {}) {
  if (input?.folder_id !== void 0 && input?.folder_id !== null && input.folder_id !== "") {
    if (input.folder_id === "root") return { folderId: null, path: "" };
    const f = await fdGet(ctx, projectId, String(input.folder_id));
    if (input.folder !== void 0 && input.folder !== null) {
      const segs = fdParsePath(input.folder);
      if (segs?.length && segs.join("/").toLowerCase() !== fdPathOf(f).toLowerCase()) throw new HttpError(400, "invalid_input", "folder and folder_id name different folders; pass one");
    }
    return { folderId: f.id, path: fdPathOf(f) };
  }
  const segs = fdParsePath(input?.folder);
  if (segs === null) return void 0;
  if (!segs.length) return { folderId: null, path: "" };
  const path = segs.join("/");
  const ex = await fdByPath(ctx, projectId, path);
  if (ex) return { folderId: ex.id, path: fdPathOf(ex) };
  if (opts.defer) return { folderId: null, path, missing: true };
  if (opts.create === false) throw new HttpError(404, "not_found", "Folder not found", { folder: path });
  const f = await fdEnsure(ctx, projectId, segs);
  return { folderId: f.id, path: fdPathOf(f) };
}

/** GET folders: the whole tree, or one level (parent path, "" = root; or parent_id / "root"). */
export async function fdList(ctx, projectId, q = {}) {
  await authorizeProject(ctx, projectId, false);
  if (ctx.publisher) throw new HttpError(404, "not_found", "Not found");
  await fdAdoptLegacy(ctx, projectId);
  let parentFilter = null;
  if (q.parent_id !== void 0 && q.parent_id !== null && q.parent_id !== "") parentFilter = q.parent_id === "root" ? "root" : (await fdGet(ctx, projectId, String(q.parent_id))).id;
  else if (q.parent !== void 0 && q.parent !== null) {
    const segs = fdParsePath(q.parent, "parent");
    if (!segs.length) parentFilter = "root";
    else {
      const p = await fdByPath(ctx, projectId, segs.join("/"));
      if (!p) throw new HttpError(404, "not_found", "Folder not found");
      parentFilter = p.id;
    }
  }
  const where = parentFilter === null ? "" : parentFilter === "root" ? " AND f.parent_id IS NULL" : " AND f.parent_id = ?";
  const params = parentFilter === null || parentFilter === "root" ? [projectId] : [projectId, parentFilter];
  const r = await db(ctx).prepare(`SELECT f.*,
      (SELECT COUNT(*) FROM folders c WHERE c.project_id = f.project_id AND c.parent_id = f.id) AS folder_count,
      (SELECT COUNT(*) FROM artifacts a WHERE a.project_id = f.project_id AND a.folder_id = f.id AND a.head_rev > 0 AND a.trashed_at IS NULL AND a.pending_review = 0) AS item_count
      FROM folders f WHERE f.project_id = ?${where} ORDER BY COALESCE(f.path, f.name) COLLATE NOCASE LIMIT ?`).bind(...params, FOLDERS_PER_PROJECT).all();
  return { folders: r.results.map((f) => fdView(f, { folder_count: f.folder_count, item_count: f.item_count })) };
}

/** POST folders: { name, parent_id? } or { path } (missing parents are created). Idempotent by key. */
export async function fdCreate(ctx, projectId, input, key) {
  await authorizeProject(ctx, projectId, true);
  if (ctx.publisher) throw new HttpError(403, "forbidden", "Publishers cannot create folders");
  let segs, base = null;
  if (input?.path !== void 0) {
    segs = fdParsePath(input.path, "path");
    if (!segs.length) throw new HttpError(400, "invalid_input", "path must name a folder");
  } else {
    segs = [fdSegment(str(input?.name, "name", 200, { min: 1 }))];
    if (input?.parent_id) base = await fdGet(ctx, projectId, String(input.parent_id));
  }
  const full = (base ? fdPathOf(base) + "/" : "") + segs.join("/");
  const i = { op: "folder.create", key, projectId, digest: await sha256Hex(JSON.stringify([fdKey(full)])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const ex = await fdByPath(ctx, projectId, full);
  if (ex) throw new HttpError(409, "folder_exists", "A folder with this name already exists here", { folder_id: ex.id, path: fdPathOf(ex) });
  const f = await fdEnsure(ctx, projectId, segs, { base });
  const body = fdView(f);
  await idemInsert(ctx, i, 201, body, "1", []).run().catch(() => {});
  return { status: 201, body };
}

// Every folder in the subtree of f (f included).
async function fdSubtree(ctx, projectId, f) {
  const r = await db(ctx).prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT c.id FROM folders c JOIN t ON c.parent_id = t.id WHERE c.project_id = ?)
      SELECT f.* FROM folders f JOIN t ON t.id = f.id`).bind(f.id, projectId).all();
  return r.results;
}
// A subfolder a connected app created inside its destination (not the destination itself) is the app's.
const APP_OWNED_SQL = `EXISTS (SELECT 1 FROM publishers pb WHERE pb.id = folders.publisher_id AND pb.revoked_at IS NULL AND pb.folder_id IS NOT folders.id)`;
// A live app's files and folders map to paths below its destination. A folder whose subtree (JSON ids, param 1) holds
// some of them, while that app's destination lies outside the subtree, can't be renamed, moved or deleted: that would
// change paths relative to the destination. Moving the destination itself (or an ancestor) keeps them all. An app
// whose destination is the project root (folder_id NULL) has every folder below its destination.
const APP_SUBTREE_SQL = `EXISTS (SELECT 1 FROM publishers pb WHERE pb.revoked_at IS NULL AND (pb.folder_id IS NULL OR pb.folder_id NOT IN (SELECT value FROM json_each(?1)))
    AND (EXISTS (SELECT 1 FROM folders d WHERE d.publisher_id = pb.id AND d.id IN (SELECT value FROM json_each(?1)))
      OR EXISTS (SELECT 1 FROM artifacts a WHERE a.publisher_id = pb.id AND a.export_name IS NOT NULL AND a.trashed_at IS NULL AND a.folder_id IN (SELECT value FROM json_each(?1)))))`;
const appLockedError = () => new HttpError(409, "folder_app_owned", "A connected app keeps its files in this folder; revoke the app first");
async function assertNotAppOwned(ctx, f, idsJson = JSON.stringify([f.id])) {
  if (f.publisher_id) {
    const live = await db(ctx).prepare("SELECT folder_id FROM publishers WHERE id = ? AND revoked_at IS NULL").bind(f.publisher_id).first();
    if (live && live.folder_id !== f.id) throw new HttpError(409, "folder_app_owned", "A connected app keeps its files in this folder; revoke the app first", { publisher_id: f.publisher_id });
  }
  if (await db(ctx).prepare(`SELECT ${APP_SUBTREE_SQL} AS x`).bind(idsJson).first("x")) throw appLockedError();
}
const manager = async (ctx, projectId) => { requireHuman(ctx); await requireProjectRole(ctx, projectId, "admin"); };
// The in-statement re-check for folder management is the same admin role as the up-front check.
const adminGate = (ctx, projectId) => humanGate(ctx.principal.id, projectId, "admin");

/** PATCH folder: { name? (rename), parent_id? (move; "root" or null = project root), expected_path? (optional guard) }. */
export async function fdUpdate(ctx, projectId, id, input, key) {
  await manager(ctx, projectId);
  const f = await fdGet(ctx, projectId, id);
  const i = { op: "folder.update:" + id, key, projectId, digest: await sha256Hex(JSON.stringify([input?.name ?? null, input?.parent_id ?? null, input?.expected_path ?? null])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const oldPath = fdPathOf(f);
  if (input?.expected_path !== void 0 && input.expected_path !== oldPath) throw new HttpError(409, "folder_conflict", "This folder was renamed or moved elsewhere; reload", { current_path: oldPath });
  const name = input?.name !== void 0 ? fdSegment(str(input.name, "name", 200, { min: 1 })) : f.name;
  let parent = null, parentId = f.parent_id ?? null;
  if (input?.parent_id !== void 0) parentId = input.parent_id === null || input.parent_id === "root" || input.parent_id === "" ? null : String(input.parent_id);
  const subtree = await fdSubtree(ctx, projectId, f);
  await assertNotAppOwned(ctx, f, JSON.stringify(subtree.map((x) => x.id)));
  if (parentId) {
    parent = await fdGet(ctx, projectId, parentId);
    if (subtree.some((x) => x.id === parent.id)) throw new HttpError(400, "invalid_input", "A folder cannot be moved into itself or one of its subfolders");
  }
  const newPath = (parent ? fdPathOf(parent) + "/" : "") + name;
  if (newPath.length > FD_MAX_PATH) throw new HttpError(413, "too_large", `Folder path exceeds ${FD_MAX_PATH} characters`);
  const depthAdd = newPath.split("/").length - oldPath.split("/").length;
  const deepest = Math.max(...subtree.map((x) => fdPathOf(x).split("/").length));
  if (deepest + depthAdd > FD_MAX_DEPTH) throw new HttpError(400, "invalid_input", `Folders can be nested at most ${FD_MAX_DEPTH} levels deep`);
  if (subtree.some((x) => (newPath + fdPathOf(x).slice(oldPath.length)).length > FD_MAX_PATH)) throw new HttpError(413, "too_large", `A subfolder path would exceed ${FD_MAX_PATH} characters`);
  if (newPath === oldPath && parentId === (f.parent_id ?? null)) return { status: 200, body: { ...fdView(f), moved_items: 0 } };
  const clash = await fdByPath(ctx, projectId, newPath);
  if (clash && clash.id !== f.id) throw new HttpError(409, "folder_exists", "A folder with this name already exists there", { folder_id: clash.id, path: fdPathOf(clash) });
  const az = adminGate(ctx, projectId);
  const now = nowIso();
  // The folder row first, guarded on its old key, on the new parent's key as read (two crossing moves can't form a
  // cycle) and on the live subtree being exactly the one read (no subfolder created, renamed or moved meanwhile).
  // Then every descendant gets its new path and key (computed here, JS toLowerCase), each guarded on its old key.
  const idsJson = JSON.stringify(subtree.map((x) => x.id));
  const desc = JSON.stringify(subtree.filter((x) => x.id !== f.id).map((x) => {
    const p2 = newPath + fdPathOf(x).slice(oldPath.length);
    return { id: x.id, p: p2, k: fdKey(p2), ok: x.name_key };
  }));
  // The follow-on statements run only if the folder row now holds exactly the new name, parent and path (compared
  // case-sensitively): a case-only rename has the same key before and after, so the key alone would not prove that
  // statement 0 ran.
  const gate = "EXISTS (SELECT 1 FROM folders WHERE id = ? AND name_key = ? AND name = ? AND parent_id IS ? AND path IS ?)";
  const gp = [f.id, fdKey(newPath), name, parentId, parentId ? newPath : null];
  const snap = JSON.stringify(subtree.map((x) => x.id + "\u0000" + x.name_key).sort());
  const same = `(SELECT json_group_array(k) FROM (SELECT t.id || char(0) || f2.name_key AS k FROM (WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT c.id FROM folders c JOIN t ON c.parent_id = t.id WHERE c.project_id = ?) SELECT id FROM t) t JOIN folders f2 ON f2.id = t.id ORDER BY k)) = ?`;
  const mv = "(SELECT value FROM json_each(?) WHERE json_extract(value, '$.id') = folders.id)";
  const body0 = { ...fdView({ ...f, name, parent_id: parentId, path: parentId ? newPath : null }), moved_items: null };
  const stmts = [
    db(ctx).prepare(`UPDATE folders SET name = ?, parent_id = ?, path = ?, name_key = ? WHERE id = ? AND project_id = ? AND name_key = ? AND ${az.sql}
        AND NOT ${APP_OWNED_SQL} AND NOT ${APP_SUBTREE_SQL.replaceAll("?1", "?")}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ? AND name_key = ?)) AND ${same}`)
      .bind(name, parentId, parentId ? newPath : null, fdKey(newPath), f.id, projectId, fdKey(oldPath), ...az.params, idsJson, idsJson, idsJson,
        parent?.id ?? null, parent?.id ?? null, projectId, parent ? fdKey(fdPathOf(parent)) : null, f.id, projectId, snap),
    db(ctx).prepare(`UPDATE folders SET path = json_extract(${mv}, '$.p'), name_key = json_extract(${mv}, '$.k')
      WHERE project_id = ? AND json_extract(${mv}, '$.ok') = name_key AND ${gate}`).bind(desc, desc, projectId, desc, ...gp),
    // Documents in the subtree keep their folder_id; their path label follows (no new metadata version).
    db(ctx).prepare(`UPDATE artifacts SET folder = (SELECT COALESCE(path, name) FROM folders WHERE id = artifacts.folder_id), updated_at = ?
      WHERE project_id = ? AND folder_id IN (SELECT value FROM json_each(?)) AND ${gate}`).bind(now, projectId, idsJson, ...gp),
    idemInsert(ctx, i, 200, body0, gate, gp),
    audit(ctx, projectId, input?.parent_id !== void 0 && parentId !== (f.parent_id ?? null) ? "folder.move" : "folder.rename", f.id, null, "ok", gate, gp)
  ];
  let res;
  try { res = await db(ctx).batch(stmts); }
  catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, "folder_exists", "A folder with this name already exists there");
    throw e;
  }
  if (!res[0].meta.changes) {
    const cur = await db(ctx).prepare("SELECT * FROM folders WHERE id = ?").bind(f.id).first();
    if (parent && !(await db(ctx).prepare("SELECT 1 AS x FROM folders WHERE id = ? AND name_key = ?").bind(parent.id, fdKey(fdPathOf(parent))).first("x")))
      throw new HttpError(409, "folder_conflict", "The destination folder was renamed, moved or deleted meanwhile; reload");
    if (cur && fdPathOf(cur) !== oldPath) throw new HttpError(409, "folder_conflict", "This folder was renamed or moved elsewhere; reload", { current_path: fdPathOf(cur) });
    if (cur) {
      await assertNotAppOwned(ctx, cur, idsJson);
      const now2 = await fdSubtree(ctx, projectId, f);
      if (JSON.stringify(now2.map((x) => x.id + "\u0000" + x.name_key).sort()) !== snap) throw new HttpError(409, "folder_conflict", "Something inside this folder changed meanwhile; reload and try again");
    }
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  const after = await fdGet(ctx, projectId, f.id);
  const body = { ...fdView(after), moved_items: res[2].meta.changes ?? 0 };
  await db(ctx).prepare("UPDATE idempotency SET response = ? WHERE principal_id = ? AND project_id = ? AND op = ? AND key = ?").bind(JSON.stringify(body), ctx.principal.id, projectId, i.op, key).run();
  return { status: 200, body };
}

/**
 * DELETE folder: only an empty folder (no subfolders, no live or pending documents) that is no live app's destination
 * (an empty app subfolder may go). Trashed documents in it move to the project root first, so restoring them still works.
 */
export async function fdDelete(ctx, projectId, id) {
  await manager(ctx, projectId);
  const f = await fdGet(ctx, projectId, id);
  // An empty subfolder an app created can be deleted (the app recreates it on its next write there): emptiness
  // already keeps every live file in place, and an app's destination is refused below (folder_in_use).
  const c = await db(ctx).prepare(`SELECT (SELECT COUNT(*) FROM folders WHERE project_id = ?1 AND parent_id = ?2) AS subfolders,
      (SELECT COUNT(*) FROM artifacts WHERE project_id = ?1 AND folder_id = ?2 AND trashed_at IS NULL AND (head_rev > 0 OR pending_review = 1)) AS items,
      (SELECT COUNT(*) FROM publishers WHERE folder_id = ?2 AND revoked_at IS NULL) AS publishers`).bind(projectId, f.id).first();
  if (c.subfolders || c.items) throw new HttpError(409, "folder_not_empty", "Only empty folders can be deleted; move or trash what is inside first", { subfolders: c.subfolders, items: c.items });
  if (c.publishers) throw new HttpError(409, "folder_in_use", "A connected app publishes into this folder; revoke it first", { publishers: c.publishers });
  const az = adminGate(ctx, projectId);
  const empty = `NOT EXISTS (SELECT 1 FROM folders WHERE parent_id = ?) AND NOT EXISTS (SELECT 1 FROM artifacts WHERE folder_id = ? AND trashed_at IS NULL AND (head_rev > 0 OR pending_review = 1))
    AND NOT EXISTS (SELECT 1 FROM publishers WHERE folder_id = ? AND revoked_at IS NULL)`;
  const res = await db(ctx).batch([
    db(ctx).prepare(`UPDATE artifacts SET folder_id = NULL, folder = '' WHERE project_id = ? AND folder_id = ? AND ${empty} AND ${az.sql}`).bind(projectId, f.id, f.id, f.id, f.id, ...az.params),
    db(ctx).prepare(`DELETE FROM folders WHERE id = ? AND project_id = ? AND ${empty} AND ${az.sql}`).bind(f.id, projectId, f.id, f.id, f.id, ...az.params),
    audit(ctx, projectId, "folder.delete", f.id, null, "ok", "NOT EXISTS (SELECT 1 FROM folders WHERE id = ?)", [f.id])
  ]);
  if (!res[1].meta.changes) {
    if (await db(ctx).prepare("SELECT 1 AS x FROM folders WHERE id = ?").bind(f.id).first("x")) throw new HttpError(409, "folder_not_empty", "Something was added to this folder; reload");
    throw new HttpError(404, "not_found", "Folder not found");
  }
  return { status: 200, body: { id: f.id, path: fdPathOf(f), deleted: true } };
}

/**
 * The folder of an approved details proposal, re-read at approval: renamed (use its current path), deleted (project
 * root), or not there yet (a proposed new path: created now, by the approver). fdSet: whether to write folder_id.
 */
export async function fdProposalMeta(ctx, projectId, p) {
  const meta = { title: p.title, folder: p.folder ?? "", tags: p.tags ?? "[]", folderId: p.folder_id ?? null, fdSet: true };
  if (p.folder_id) {
    const f = await db(ctx).prepare("SELECT * FROM folders WHERE id = ? AND project_id = ?").bind(p.folder_id, projectId).first();
    if (f) meta.folder = fdPathOf(f);
    else { meta.folderId = null; meta.folder = ""; }
  } else if (meta.folder) {
    let r;
    try { r = await fdResolve(ctx, projectId, { folder: meta.folder }); } catch (e) { if (e instanceof HttpError && e.status === 400) r = void 0; else throw e; }
    if (r) { meta.folder = r.path; meta.folderId = r.folderId; } else meta.fdSet = false;
  }
  return meta;
}

/** listArtifacts folder filter: folder_id / folder path, optionally recursive. Returns { sql, params } or null. */
export async function fdListFilter(ctx, projectId, q) {
  let f = null;
  if (q.folder_id !== void 0 && q.folder_id !== null && q.folder_id !== "") {
    if (q.folder_id === "root") return { sql: q.recursive ? "1" : "a.folder_id IS NULL", params: [] };
    f = await fdGet(ctx, projectId, String(q.folder_id));
  } else if (q.folder !== void 0 && q.folder !== null) {
    const segs = fdParsePath(q.folder);
    if (!segs.length) return { sql: q.recursive ? "1" : "a.folder_id IS NULL", params: [] };
    f = await fdByPath(ctx, projectId, segs.join("/"));
    if (!f) throw new HttpError(404, "not_found", "Folder not found", { folder: segs.join("/") });
  } else return null;
  if (!q.recursive) return { sql: "a.folder_id = ?", params: [f.id] };
  return { sql: `a.folder_id IN (WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT c.id FROM folders c JOIN t ON c.parent_id = t.id WHERE c.project_id = ?) SELECT id FROM t)`, params: [f.id, projectId] };
}
export const fdRecursive = (v) => v === true || v === "1" || v === "true";

// ---------- agent tools (both MCP endpoints) ----------
export const FD_FOLDER_PROP = { type: "string", maxLength: 200, description: 'Folder path, e.g. "Reports/2026/Q1" ("/" separates nested folders; missing folders are created). Empty or omitted = project root.' };
export const FD_LIST_PROPS = {
  folder: { type: "string", maxLength: 200, description: 'Only items in this folder path, e.g. "Reports/2026" ("" = project root)' },
  folder_id: { type: "string", maxLength: 64, description: 'Only items in this folder (fld_\u2026), or "root"' },
  recursive: { type: "boolean", description: "With folder/folder_id: include items in all subfolders" }
};
export function fdTools(oauth = false) {
  const project = { type: "string", maxLength: 110, description: "Project ID or path (workspace/project) from list_projects" };
  const schema = (properties, required) => ({ type: "object", properties: { project_id: project, ...properties }, required: oauth ? required : ["project_id", ...required], additionalProperties: false });
  const run = (f) => oauth ? (c, p, a) => f(c, p, a) : (c, a) => f(c, a.project_id, a);
  return [
    { name: "list_folders", title: "List folders", write: false, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description: 'List the folders of a project as a tree: each folder has id, name, path ("A/B/C"), parent_id and counts of subfolders and items. Pass parent (a path, "" = root) or parent_id to list one level only.',
      inputSchema: schema({ parent: { type: "string", maxLength: 200 }, parent_id: { type: "string", maxLength: 64 } }, []),
      run: run((c, p, a) => fdList(c, p, a)) },
    { name: "create_folder", title: "Create folder", write: true, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Create a folder by path, e.g. "Reports/2026/Q1" (missing parent folders are created). folder_exists (409) if it is already there. You can also just pass folder to create_markdown or an upload.',
      inputSchema: schema({ path: { type: "string", minLength: 1, maxLength: 200 }, idempotency_key: { type: "string", minLength: 8, maxLength: 128 } }, ["path", "idempotency_key"]),
      run: run(async (c, p, a) => (await fdCreate(c, p, { path: a.path }, idemKey(a.idempotency_key))).body) }
  ];
}

// ---------- backup ----------
/** A document's folder in a backup: its full path (folder_name; older backups hold a single name, also a valid path). */
export const fdBackupName = "(SELECT COALESCE(path, name) FROM folders WHERE id = artifacts.folder_id AND project_id = artifacts.project_id)";
/** Validate a backup's folder_name (a folder path). */
export function fdBackupCheck(v) {
  let segs;
  try { segs = fdParsePath(v); } catch (e) { throw new HttpError(400, "bad_backup", `Invalid folder: ${e.message}`); }
  if (!segs?.length) throw new HttpError(400, "bad_backup", "Invalid folder: empty path");
  return segs;
}
/**
 * The folders a backup's documents sit in, recreated in project `pid` with fresh ids, parents first: statements that
 * insert them (owned by the restoring person, never by an app) and folderOf(document) -> new folder id or null.
 */
export function fdRestoreRows(DB, backup, pid, me, at) {
  const byKey = new Map(), stmts = [];
  for (const a of backup.artifacts) {
    if (a.folder_name == null) continue;
    const segs = fdBackupCheck(a.folder_name);
    let parentId = null, path = "";
    for (const seg of segs) {
      path = path ? path + "/" + seg : seg;
      const key = fdKey(path);
      if (!byKey.has(key)) {
        if (byKey.size >= FOLDERS_PER_PROJECT) throw new HttpError(400, "bad_backup", `A project can have up to ${FOLDERS_PER_PROJECT.toLocaleString("en-US")} folders`);
        const id = randomId("fld");
        byKey.set(key, id);
        stmts.push(DB.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by, parent_id, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, pid, seg, key, at, me, parentId, parentId ? path : null));
      }
      parentId = byKey.get(key);
    }
  }
  return { stmts, folderOf: (a) => a.folder_name == null ? null : byKey.get(fdKey(fdBackupCheck(a.folder_name).join("/"))) };
}
