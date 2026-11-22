// Nested folders (docs/folders.md; migration 0018_nested_folders.sql). Spliced into // src/service.ts by
// build-folders.mjs. One implementation for every transport (browser /api, /v1, both MCP endpoints, App Connect).
//  - Folders form a tree per project: parent_id (NULL = project root), name = leaf, path = full display path
//    ("Reports/2026/Q1"). name_key = lower(path) keeps the existing UNIQUE (project_id, name_key), so sibling names
//    are unique case-insensitively. Top-level folders keep name_key = lower(name) as older Workers wrote it.
//  - artifacts.folder_id is the source of truth; artifacts.folder (text) mirrors the folder's path for older
//    readers, backups and the change feed. Legacy free-text labels are adopted into the tree once per project.
//  - Create: anyone who can write to the project (agents can file things into new folders). Rename, move and
//    delete: the human owner only; they change where many documents live at once, including protected ones.
//  - Every write re-checks project authorization in the same statement (authzSql).
var FD_MAX_DEPTH = 8;
var FD_MAX_PATH = 200;
var FD_MAX_LIST = 2000;
// Folders per project. Equal to the listing cap, so a listing is never truncated.
var FD_MAX_FOLDERS = 2000;
// One path segment: 1-80 chars after trim, no "/" or control characters.
function fdSegment(raw, what = "Folder name") {
  const s = String(raw).trim();
  if (s.length < 1 || s.length > 80) throw new HttpError(400, "invalid_input", `${what} must be 1-80 characters`);
  if (/[\/\u0000-\u001f\u007f]/.test(s)) throw new HttpError(400, "invalid_input", `${what} cannot contain / or control characters`);
  if (s === "." || s === "..") throw new HttpError(400, "invalid_input", `${what} cannot be . or ..`);
  return s;
}
__name(fdSegment, "fdSegment");
// "a / b//c/" -> ["a", "b", "c"]; "" or "/" -> [] (project root).
function fdParsePath(v, name = "folder") {
  if (v === void 0 || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "invalid_input", `${name} must be a string`);
  if (v.length > FD_MAX_PATH + 64) throw new HttpError(413, "too_large", `${name} exceeds ${FD_MAX_PATH} characters`);
  const segs = v.split("/").map((s) => s.trim()).filter(Boolean).map((s) => fdSegment(s));
  if (segs.length > FD_MAX_DEPTH) throw new HttpError(400, "invalid_input", `Folders can be nested at most ${FD_MAX_DEPTH} levels deep`);
  if (segs.join("/").length > FD_MAX_PATH) throw new HttpError(413, "too_large", `${name} exceeds ${FD_MAX_PATH} characters`);
  return segs;
}
__name(fdParsePath, "fdParsePath");
var fdKey = /* @__PURE__ */ __name((path) => path.toLowerCase(), "fdKey");
var fdPathOf = /* @__PURE__ */ __name((f) => f ? f.path ?? f.name : "", "fdPathOf");
function fdView(f, extra = {}) {
  return { id: f.id, name: f.name, path: fdPathOf(f), parent_id: f.parent_id ?? null, publisher_id: f.publisher_id ?? null, created_at: f.created_at, ...extra };
}
__name(fdView, "fdView");
async function fdGet(ctx, projectId, id) {
  if (typeof id !== "string" || !/^fld_[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, "invalid_input", "folder_id must be a folder id");
  const f = await db(ctx).prepare("SELECT * FROM folders WHERE id = ? AND project_id = ?").bind(id, projectId).first();
  if (!f) throw new HttpError(404, "not_found", "Folder not found");
  return f;
}
__name(fdGet, "fdGet");
async function fdByPath(ctx, projectId, path) {
  return db(ctx).prepare("SELECT * FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, fdKey(path)).first();
}
__name(fdByPath, "fdByPath");
// Legacy free-text folder labels (artifacts.folder without folder_id) become real folders once per project, so the
// tree is the only folder model. Labels that are not valid paths stay as they are (shown, not navigable).
// Per isolate: project id -> how many unadopted labelled rows were left after the last scan (labels that are not valid
// paths). A listing rescans only when that number changes.
var fdAdopted = /* @__PURE__ */ new Map();
async function fdAdoptLegacy(ctx, projectId) {
  const k = projectId;
  // Only write-capable callers (the owner, or a grant that can write here) adopt: a read never writes data.
  if (ctx.publisher || (ctx.principal.kind === "agent" && !ctx.grant?.can_write)) return;
  // The per-isolate count is only a fast path: a cheap count finds labels written later (e.g. by an older Worker
  // during a rollback window), while labels that can never be adopted don't force a rescan on every listing.
  const left = () => db(ctx).prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND folder_id IS NULL AND folder <> '' AND publisher_id IS NULL").bind(projectId).first("n");
  if (fdAdopted.has(k) && (await left()) === fdAdopted.get(k)) return;
  fdAdopted.delete(k);
  const rows = await db(ctx).prepare("SELECT DISTINCT folder FROM artifacts WHERE project_id = ? AND folder_id IS NULL AND folder <> '' AND publisher_id IS NULL LIMIT 500").bind(projectId).all();
  for (const r of rows.results) {
    let segs;
    try { segs = fdParsePath(r.folder); } catch { continue; }
    if (!segs || !segs.length) continue;
    let f;
    try { f = await fdEnsure(ctx, projectId, segs); } catch { continue; }
    const az = authzSql(ctx, projectId);
    const u = await db(ctx).prepare(`UPDATE artifacts SET folder_id = ?, folder = ? WHERE project_id = ? AND folder_id IS NULL AND folder = ? AND publisher_id IS NULL AND ${az.sql}`).bind(f.id, fdPathOf(f), projectId, r.folder, ...az.params).run();
    if (u.meta.changes) await audit(ctx, projectId, "folder.adopt", f.id, null, "ok").run();
  }
  if (rows.results.length < 500) fdAdopted.set(k, await left());
}
__name(fdAdoptLegacy, "fdAdoptLegacy");
// Find or create every folder of segs (under base, a folder row or null = root). Returns the last folder row.
// opts.publisherId marks folders created for an App Connect publisher. opts.system skips the authorization gate
// (legacy adoption only; it runs after the caller was authorized for the project).
async function fdEnsure(ctx, projectId, segs, opts = {}) {
  let parent = opts.base ?? null;
  const az = opts.system ? { sql: "1", params: [] } : authzSql(ctx, projectId);
  for (const seg of segs) {
    const path = parent ? fdPathOf(parent) + "/" + seg : seg;
    if (path.length > FD_MAX_PATH) throw new HttpError(413, "too_large", `Folder path exceeds ${FD_MAX_PATH} characters`);
    if (path.split("/").length > FD_MAX_DEPTH) throw new HttpError(400, "invalid_input", `Folders can be nested at most ${FD_MAX_DEPTH} levels deep`);
    let f = await fdByPath(ctx, projectId, path);
    if (!f) {
      const id = randomId("fld");
      await db(ctx).prepare(`INSERT OR IGNORE INTO folders (id, project_id, name, name_key, created_at, created_by, publisher_id, parent_id, path)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${az.sql}
            AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ? AND name_key = ?))
            AND (SELECT COUNT(*) FROM folders WHERE project_id = ?) < ${FD_MAX_FOLDERS}`)
        .bind(id, projectId, seg, fdKey(path), nowIso(), ctx.principal.id, opts.publisherId ?? null, parent?.id ?? null, parent ? path : null, ...az.params,
          parent?.id ?? null, parent?.id ?? null, projectId, parent ? fdKey(fdPathOf(parent)) : null, projectId).run();
      f = await fdByPath(ctx, projectId, path);
      if (!f) {
        // The parent was renamed, moved or deleted meanwhile (the guard on its path), the project is full, or the
        // grant ended.
        if (parent && !(await db(ctx).prepare("SELECT 1 AS x FROM folders WHERE id = ? AND name_key = ?").bind(parent.id, fdKey(fdPathOf(parent))).first("x")))
          throw new HttpError(409, "folder_conflict", "A folder on this path was renamed, moved or deleted meanwhile; retry");
        if ((await db(ctx).prepare("SELECT COUNT(*) AS n FROM folders WHERE project_id = ?").bind(projectId).first("n")) >= FD_MAX_FOLDERS)
          throw new HttpError(413, "quota_exceeded", `A project can hold at most ${FD_MAX_FOLDERS} folders`);
        throw new HttpError(403, "forbidden", "Grant no longer valid");
      }
      if (f.id === id && !opts.system) await audit(ctx, projectId, "folder.create", id, null, "ok").run();
    }
    parent = f;
  }
  return parent;
}
__name(fdEnsure, "fdEnsure");
// Resolve a write's destination: folder_id wins; else a folder path (created as needed when create is true).
// Returns { folderId, path } (null / "" = project root), or undefined when the input names no folder at all.
async function fdResolve(ctx, projectId, input, opts = {}) {
  const create = opts.create !== false;
  if (input?.folder_id !== void 0 && input?.folder_id !== null && input.folder_id !== "") {
    if (input.folder_id === "root") return { folderId: null, path: "" };
    const f = await fdGet(ctx, projectId, String(input.folder_id));
    if (input.folder !== void 0 && input.folder !== null) {
      const segs = fdParsePath(input.folder);
      if (segs && segs.join("/").toLowerCase() !== fdPathOf(f).toLowerCase()) throw new HttpError(400, "invalid_input", "folder and folder_id name different folders; pass one");
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
  if (!create) throw new HttpError(404, "not_found", "Folder not found", { folder: path });
  const f = await fdEnsure(ctx, projectId, segs);
  return { folderId: f.id, path: fdPathOf(f) };
}
__name(fdResolve, "fdResolve");
async function fdList(ctx, projectId, q = {}) {
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
      (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS folder_count,
      (SELECT COUNT(*) FROM artifacts a WHERE a.folder_id = f.id AND a.head_rev > 0 AND a.trashed_at IS NULL AND a.pending_review = 0) AS item_count
      FROM folders f WHERE f.project_id = ?${where} ORDER BY COALESCE(f.path, f.name) COLLATE NOCASE LIMIT ${FD_MAX_LIST + 1}`).bind(...params).all();
  const rows = r.results.slice(0, FD_MAX_LIST);
  return { folders: rows.map((f) => fdView(f, { folder_count: f.folder_count, item_count: f.item_count })), truncated: r.results.length > FD_MAX_LIST };
}
__name(fdList, "fdList");
// POST folders: { name, parent_id? } or { path } (missing parents are created). Idempotent by key.
async function fdCreate(ctx, projectId, input, key) {
  await authorizeProject(ctx, projectId, true);
  if (ctx.publisher) throw new HttpError(403, "forbidden", "Publishers cannot create folders here");
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
  if (await fdByPath(ctx, projectId, full)) {
    const ex = await fdByPath(ctx, projectId, full);
    throw new HttpError(409, "folder_exists", "A folder with this name already exists here", { folder_id: ex.id, path: fdPathOf(ex) });
  }
  const f = await fdEnsure(ctx, projectId, segs, { base });
  const body2 = { ...fdView(f), id: f.id };
  await idemInsert(ctx, i, 201, body2, "1", []).run().catch(() => {
  });
  return { status: 201, body: body2 };
}
__name(fdCreate, "fdCreate");
// Every folder in the subtree of f (f included), deepest last.
async function fdSubtree(ctx, projectId, f) {
  const r = await db(ctx).prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT c.id FROM folders c JOIN t ON c.parent_id = t.id WHERE c.project_id = ?)
      SELECT f.* FROM folders f JOIN t ON t.id = f.id`).bind(f.id, projectId).all();
  return r.results;
}
__name(fdSubtree, "fdSubtree");
// PATCH folder: { name? (rename), parent_id? (move; "root" or null = project root), expected_path? (optional guard) }.
async function fdUpdate(ctx, projectId, id, input, key) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, true);
  const f = await fdGet(ctx, projectId, id);
  const i = { op: "folder.update:" + id, key, projectId, digest: await sha256Hex(JSON.stringify([input?.name ?? null, input?.parent_id ?? null, input?.expected_path ?? null])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const oldPath = fdPathOf(f);
  if (input?.expected_path !== void 0 && input.expected_path !== oldPath) throw new HttpError(409, "folder_conflict", "This folder was renamed or moved elsewhere; reload", { current_path: oldPath });
  const name = input?.name !== void 0 ? fdSegment(str(input.name, "name", 200, { min: 1 })) : f.name;
  let parent = null, parentId = f.parent_id ?? null;
  if (input?.parent_id !== void 0) {
    parentId = input.parent_id === null || input.parent_id === "root" || input.parent_id === "" ? null : String(input.parent_id);
  }
  const subtree = await fdSubtree(ctx, projectId, f);
  if (subtree.length > FD_MAX_FOLDERS) throw new HttpError(413, "too_large", "This folder has too many subfolders to rename or move at once");
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
  const az = authzSql(ctx, projectId);
  const now = nowIso();
  // Folder rows first: rename/move the folder itself, guarded on its old path (a concurrent rename/move of it loses
  // cleanly) and on the new parent's path as read (so two crossing moves can't form a cycle, and a parent renamed
  // meanwhile can't leave a stale path). Then every descendant gets its new path and key, computed here (JS
  // toLowerCase, like every lookup; SQLite's lower() is ASCII-only) and each guarded on its own old key, so a
  // subfolder moved out meanwhile is left alone.
  const ids = subtree.map((x) => x.id);
  const idsJson = JSON.stringify(ids);
  const desc = JSON.stringify(subtree.filter((x) => x.id !== f.id).map((x) => {
    const p2 = newPath + fdPathOf(x).slice(oldPath.length);
    return { id: x.id, p: p2, k: fdKey(p2), ok: x.name_key };
  }));
  const gate = "EXISTS (SELECT 1 FROM folders WHERE id = ? AND name_key = ?)";
  const gp = [f.id, fdKey(newPath)];
  // The subtree as read: every (id, name_key) under f. The first UPDATE only runs if the live subtree is still
  // exactly this (no subfolder created, renamed, moved in or out meanwhile), so the descendant rewrite can't miss or
  // misplace a row; otherwise the whole batch is a no-op and the caller gets 409 folder_conflict.
  const snap = JSON.stringify(subtree.map((x) => x.id + "\u0000" + x.name_key).sort());
  const same = `(SELECT json_group_array(k) FROM (SELECT t.id || char(0) || f2.name_key AS k FROM (WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT c.id FROM folders c JOIN t ON c.parent_id = t.id WHERE c.project_id = ?) SELECT id FROM t) t JOIN folders f2 ON f2.id = t.id ORDER BY k)) = ?`;
  const mv = "(SELECT value FROM json_each(?) WHERE json_extract(value, '$.id') = folders.id)";
  const body0 = { ...fdView({ ...f, name, parent_id: parentId, path: parentId ? newPath : null }), moved_items: null };
  const stmts = [
    db(ctx).prepare(`UPDATE folders SET name = ?, parent_id = ?, path = ?, name_key = ? WHERE id = ? AND project_id = ? AND name_key = ? AND ${az.sql}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ? AND name_key = ?)) AND ${same}`)
      .bind(name, parentId, parentId ? newPath : null, fdKey(newPath), f.id, projectId, fdKey(oldPath), ...az.params,
        parent?.id ?? null, parent?.id ?? null, projectId, parent ? fdKey(fdPathOf(parent)) : null, f.id, projectId, snap),
    db(ctx).prepare(`UPDATE folders SET path = json_extract(${mv}, '$.p'), name_key = json_extract(${mv}, '$.k')
      WHERE project_id = ? AND json_extract(${mv}, '$.ok') = name_key AND ${gate}`)
      .bind(desc, desc, projectId, desc, ...gp),
    // Documents in the subtree keep their folder_id; their path label follows (metadata version unchanged: the
    // document did not move relative to its folder).
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
    const cur = await db(ctx).prepare("SELECT path, name FROM folders WHERE id = ?").bind(f.id).first();
    if (parent && !(await db(ctx).prepare("SELECT 1 AS x FROM folders WHERE id = ? AND name_key = ?").bind(parent.id, fdKey(fdPathOf(parent))).first("x")))
      throw new HttpError(409, "folder_conflict", "The destination folder was renamed, moved or deleted meanwhile; reload");
    if (cur && fdPathOf(cur) !== oldPath) throw new HttpError(409, "folder_conflict", "This folder was renamed or moved elsewhere; reload", { current_path: fdPathOf(cur) });
    if (cur) {
      const now2 = await fdSubtree(ctx, projectId, f);
      if (JSON.stringify(now2.map((x) => x.id + "\u0000" + x.name_key).sort()) !== snap) throw new HttpError(409, "folder_conflict", "Something inside this folder changed meanwhile; reload and try again");
    }
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  const after = await fdGet(ctx, projectId, f.id);
  const body2 = { ...fdView(after), moved_items: res[2].meta.changes ?? 0 };
  await db(ctx).prepare("UPDATE idempotency SET response = ? WHERE principal_id = ? AND project_id = ? AND op = ? AND key = ?").bind(JSON.stringify(body2), ctx.principal.id, projectId, i.op, key).run();
  return { status: 200, body: body2 };
}
__name(fdUpdate, "fdUpdate");
// DELETE folder: only an empty folder (no subfolders, no live or pending documents) that is no live publisher's
// destination. Trashed documents in it move to the project root first, so restoring them still works.
async function fdDelete(ctx, projectId, id) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, true);
  const f = await fdGet(ctx, projectId, id);
  const c = await db(ctx).prepare(`SELECT (SELECT COUNT(*) FROM folders WHERE parent_id = ?) AS subfolders,
      (SELECT COUNT(*) FROM artifacts WHERE folder_id = ? AND trashed_at IS NULL AND (head_rev > 0 OR pending_review = 1)) AS items,
      (SELECT COUNT(*) FROM publishers WHERE folder_id = ? AND revoked_at IS NULL) AS publishers`).bind(f.id, f.id, f.id).first();
  if (c.subfolders || c.items) throw new HttpError(409, "folder_not_empty", "Only empty folders can be deleted; move or trash what is inside first", { subfolders: c.subfolders, items: c.items });
  if (c.publishers) throw new HttpError(409, "folder_in_use", "A connected app publishes into this folder; revoke it first", { publishers: c.publishers });
  const az = authzSql(ctx, projectId);
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
__name(fdDelete, "fdDelete");
// The folder of an approved details proposal, re-read at approval: the folder may have been renamed (use its current
// path), deleted (fall back to the project root), or not exist yet (a proposed new path: created now, by the
// approver).
async function fdProposalMeta(ctx, projectId, p) {
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
__name(fdProposalMeta, "fdProposalMeta");
// listArtifacts folder filter: folder_id / folder path, optionally recursive. Returns SQL + params, or null.
async function fdListFilter(ctx, projectId, q) {
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
__name(fdListFilter, "fdListFilter");
// ---------- agent tools (both MCP endpoints) ----------
var FD_FOLDER_PROP = { type: "string", maxLength: 200, description: 'Folder path, e.g. "Reports/2026/Q1" ("/" separates nested folders; missing folders are created). Empty or omitted = project root.' };
var FD_LIST_PROPS = {
  folder: { type: "string", maxLength: 200, description: 'Only items in this folder path, e.g. "Reports/2026" ("" = project root)' },
  folder_id: { type: "string", maxLength: 64, description: 'Only items in this folder (fld_\u2026), or "root"' },
  recursive: { type: "boolean", description: "With folder/folder_id: include items in all subfolders" }
};
function fdTools(oauth = false) {
  const project = { type: "string", maxLength: 64, description: "Project ID from list_projects" };
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
__name(fdTools, "fdTools");
// ---------- backup ----------
async function fdBackupExport(ctx, projectId) {
  const r = await db(ctx).prepare("SELECT id, name, parent_id, path, created_at, created_by FROM folders WHERE project_id = ? ORDER BY length(COALESCE(path, name)), id").bind(projectId).all();
  return r.results;
}
__name(fdBackupExport, "fdBackupExport");
function fdRestoreStatements(DB, backup, pid, ownerId) {
  if (backup.folders === void 0) return [];
  if (!Array.isArray(backup.folders) || backup.folders.length > 5000) throw new HttpError(400, "bad_backup", "folders must be a list");
  const seen = new Map(), out2 = [];
  for (const f of backup.folders) {
    if (!f || typeof f.id !== "string" || !/^fld_[A-Za-z0-9_-]{1,40}$/.test(f.id) || seen.has(f.id)) throw new HttpError(400, "bad_backup", "Invalid folder id");
    const name = fdSegment(f.name ?? "");
    let path = name;
    if (f.parent_id !== null && f.parent_id !== void 0) {
      const parent = seen.get(f.parent_id);
      if (!parent) throw new HttpError(400, "bad_backup", "Folder parent must come before its children");
      path = parent + "/" + name;
    }
    if (path.split("/").length > FD_MAX_DEPTH || path.length > FD_MAX_PATH) throw new HttpError(400, "bad_backup", "Folder path too long or too deep");
    seen.set(f.id, path);
    out2.push(DB.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by, parent_id, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(f.id, pid, name, fdKey(path), String(f.created_at ?? nowIso()), ownerId, f.parent_id ?? null, f.parent_id ? path : null));
  }
  for (const a of backup.artifacts ?? []) if (a.folder_id) {
    if (!seen.has(a.folder_id)) throw new HttpError(400, "bad_backup", "Artifact folder_id names no folder in the backup");
    out2.push(DB.prepare("UPDATE artifacts SET folder_id = ?, folder = ? WHERE id = ? AND project_id = ?").bind(a.folder_id, seen.get(a.folder_id), a.id, pid));
  }
  return out2;
}
__name(fdRestoreStatements, "fdRestoreStatements");
