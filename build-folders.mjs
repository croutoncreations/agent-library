// Nested folders (docs/folders.md; src/folders/*; migration 0018_nested_folders.sql). Runs after
// build-artifact-limits.mjs and before build-app-connect-files.mjs. Exact patches: each anchor matches exactly the
// stated number of times and sits in its named module (browser patches inside APP_JS); every byte outside the patched
// spans is preserved (manifest hash). No config, credentials, database or network is used.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('artifact-limits-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-artifact-limits.mjs before build-folders.mjs');
const SOURCES = ['src/folders/service.js', 'src/folders/browser.js', 'src/folders/browser.css'];
const src = Object.fromEntries(SOURCES.map((f) => [f, readFileSync(f, 'utf8').replace(/\n*$/, '\n')]));
if (/^(import|export)\s/m.test(src['src/folders/service.js'])) throw Error('src/folders/service.js must define nothing importable');
for (const f of ['src/folders/browser.js', 'src/folders/browser.css']) if (/[`]|\$\{/.test(src[f]) || (f.endsWith('.css') && src[f].includes('\\'))) throw Error(f + ' would break its template literal');
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
const SERVICE = '// src/service.ts', UPLOADS = '// src/uploads.ts', BACKUP = '// src/backup.ts', OMCP = '// src/oauth/mcp.ts', LMCP = '// src/mcp.ts',
  V1 = '// src/api/v1.ts', INDEX = '// src/index.ts', UI = '// src/ui.ts', SERVER = '// src/oauth/server.ts',
  PUB = '// src/api/publisher.ts — isolated readable-generation integration';
// [name, module, find, replace, count = 1]
const PATCHES = [
  // ------------------------------------------------------------------ service
  ['folder service and tools', SERVICE, 'function requireAppConnect(ctx) {\n', src['src/folders/service.js'] + 'function requireAppConnect(ctx) {\n'],
  ['folders: list is the tree, for every installation', SERVICE,
    'async function listFolders(ctx, projectId) {\n  requireAppConnect(ctx);\n',
    'async function listFolders(ctx, projectId, q) {\n  return fdList(ctx, projectId, q);\n'],
  ['folders: create by name/parent or path, for every installation', SERVICE,
    'async function createFolder(ctx, projectId, input, key) {\n  requireAppConnect(ctx);\n',
    'async function createFolder(ctx, projectId, input, key) {\n  return fdCreate(ctx, projectId, input, key);\n'],
  ['create: the folder (path or id) resolves to a real folder', SERVICE,
    '  const folder = str(input.folder, "folder", 200, { optional: true });\n  const folderId = await folderCheck(ctx, projectId, input.folder_id);',
    '  const fdDest = await fdResolve(ctx, projectId, input);\n  const folder = fdDest ? fdDest.path : "";\n  const folderId = fdDest ? fdDest.folderId : null;'],
  ['create: folder_id no longer needs App Connect', SERVICE,
    '    if (input.folder_id !== void 0 && input.folder_id !== null) requireAppConnect(ctx);\n', ''],
  ['template copy: the folder (path or id) resolves to a real folder', SERVICE,
    '  const folder = str(input.folder, "folder", 200, { optional: true });\n  const folderId = input.folder_id ?? null;',
    '  const fdDest = await fdResolve(ctx, projectId, input);\n  const folder = fdDest ? fdDest.path : "";\n  const folderId = fdDest ? fdDest.folderId : null;'],
  ['details: folder (path or folder_id) moves the document into a real folder', SERVICE,
    '  const folder = input.folder !== void 0 ? str(input.folder, "folder", 200) : a.folder;',
    '  const fdMove = a.publisher_id ? void 0 : await fdResolve(ctx, projectId, input, { defer: true });\n  const folder = fdMove ? fdMove.path : input.folder !== void 0 ? str(input.folder, "folder", 200) : a.folder;\n  let folderIdNext = fdMove ? fdMove.folderId : a.folder_id ?? null;'],
  // A new folder path is created only once the change is allowed: after the review gate (a proposal keeps the path;
  // approval creates it), never for a refused or conflicting write.
  ['details: a new folder path is created after the review gate', SERVICE,
    '    if (g) return g;\n  }\n  const az0 = authzSql(ctx, projectId), pr = protectSql(ctx, artifactId);\n  const az = { sql: `${az0.sql} AND ${pr.sql}`, params: [...az0.params, ...pr.params] };\n  const next = expected + 1;',
    '    if (g) return g;\n  }\n  if (fdMove?.missing) {\n    if (a.meta_version !== expected) throw new HttpError(409, "metadata_conflict", "Details changed since you loaded them", { current_meta_version: a.meta_version });\n    folderIdNext = (await fdEnsure(ctx, projectId, fdParsePath(fdMove.path))).id;\n  }\n  const az0 = authzSql(ctx, projectId), pr = protectSql(ctx, artifactId);\n  const az = { sql: `${az0.sql} AND ${pr.sql}`, params: [...az0.params, ...pr.params] };\n  const next = expected + 1;'],
  ['details: the folder change is written with the folder id', SERVICE,
    'UPDATE artifacts SET title = ?, folder = ?, tags = ?, trashed_at = ?, template_description = ?, meta_version = ?, meta_request_id = ?, updated_at = ?\n      WHERE id = ? AND project_id = ? AND meta_version = ? AND ${az.sql}`).bind(title, folder, tags, trashed, description, next, ctx.requestId, nowIso(), artifactId, projectId, expected, ...az.params),',
    'UPDATE artifacts SET title = ?, folder = ?, folder_id = ?, tags = ?, trashed_at = ?, template_description = ?, meta_version = ?, meta_request_id = ?, updated_at = ?\n      WHERE id = ? AND project_id = ? AND meta_version = ? AND ${az.sql} AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))`).bind(title, folder, folderIdNext, tags, trashed, description, next, ctx.requestId, nowIso(), artifactId, projectId, expected, ...az.params, folderIdNext, folderIdNext, projectId),'],
  ['details: the response carries the folder id', SERVICE,
    'const body2 = { artifact_id: artifactId, meta_version: next, title, folder, tags: JSON.parse(tags),',
    'const body2 = { artifact_id: artifactId, meta_version: next, title, folder, ...appConnectEnabled(ctx.env) || folderIdNext ? { folder_id: folderIdNext } : {}, tags: JSON.parse(tags),'],
  ['details: a proposed folder change keeps its folder id', SERVICE,
    '{ title, folder, tags }, restoredFrom)', '{ title, folder, folderId: folderIdNext, tags }, restoredFrom)'],
  ['review: proposals carry the folder id', SERVICE,
    'meta: { title: v.title, folder: v.folder, tags: v.tags }', 'meta: { title: v.title, folder: v.folder, folderId: v.folderId, tags: v.tags }'],
  ['review: an approved folder change moves the document', SERVICE,
    'UPDATE artifacts SET title = ?, folder = ?, tags = ?, meta_version = ?, meta_request_id = ?, updated_at = ? WHERE id = ? AND meta_version = ? AND ${RV_OPEN}`)\n        .bind(meta.title, meta.folder, meta.tags, newMeta, ctx.requestId, now, p.artifact_id, guardMeta, ...og),',
    'UPDATE artifacts SET title = ?, folder = ?, folder_id = CASE WHEN ? = 1 THEN ? ELSE folder_id END, tags = ?, meta_version = ?, meta_request_id = ?, updated_at = ? WHERE id = ? AND meta_version = ? AND ${RV_OPEN}`)\n        .bind(meta.title, meta.folder, meta.fdSet ? 1 : 0, meta.folderId ?? null, meta.tags, newMeta, ctx.requestId, now, p.artifact_id, guardMeta, ...og),'],
  ['review: approval uses the proposed folder (or the reviewer\'s edit)', SERVICE,
    '    meta = { title: p.title, folder: p.folder ?? "", tags: p.tags ?? "[]" };\n',
    '    meta = await fdProposalMeta(ctx, projectId, p);\n'],
  ['review: a reviewer\'s folder edit resolves to a real folder', SERVICE,
    '    if (input.folder !== undefined && input.folder !== null) meta.folder = str(input.folder, "folder", 200);',
    '    if (input.folder !== undefined && input.folder !== null) { const fdR = await fdResolve(ctx, projectId, { folder: input.folder }); meta.folder = fdR.path; meta.folderId = fdR.folderId; meta.fdSet = true; }'],
  ['review: a new document approved with an edited folder lands there', SERVICE,
    '      .bind(meta.title, meta.folder, p.folder_id ?? null, meta.tags, now, p.artifact_id, ...og));',
    '      .bind(meta.title, meta.folder, meta.fdSet ? meta.folderId ?? null : p.folder_id ?? null, meta.tags, now, p.artifact_id, ...og));'],
  ['list: folder path / folder_id filter, recursive', SERVICE,
    '  const folder = q.folderId ?? "";\n  if (folder && folder !== "root" && !/^fld_[A-Za-z0-9_-]{1,40}$/.test(folder)) throw new HttpError(400, "invalid_input", "folder_id must be a folder id or root");',
    '  const fdF = await fdListFilter(ctx, projectId, { folder_id: q.folderId, folder: q.folder, recursive: q.recursive === true || q.recursive === "1" || q.recursive === "true" });\n  const folder = "";'],
  ['list: apply the folder filter', SERVICE,
    "       AND (? = '' OR (? = 'root' AND a.folder_id IS NULL) OR a.folder_id = ?)\n",
    "       AND (? = '' OR (? = 'root' AND a.folder_id IS NULL) OR a.folder_id = ?)\n       AND ${fdF ? fdF.sql : \"1\"}\n"],
  ['list: folder filter params', SERVICE,
    'kind, kind, folder, folder, folder, LIMITS.pageSize + 1, offset).all();',
    'kind, kind, folder, folder, folder, ...fdF ? fdF.params : [], LIMITS.pageSize + 1, offset).all();'],
  ['views: folder_id is part of every artifact view (folders are no longer App Connect only)', SERVICE,
    '      } : {},\n      ...rvArtifactReview(a)', '      } : a.folder_id ? { folder_id: a.folder_id } : {},\n      ...rvArtifactReview(a)'],
  // ------------------------------------------------------------------ uploads
  ['upload: the folder (path or id) resolves to a real folder', UPLOADS,
    '    const folder = str(input.folder, "folder", 200, { optional: true });\n    rvMeta = await rvNewGated(ctx, projectId, "binary") ? JSON.stringify({ title, folder }) : null;',
    '    const fdDest = await fdResolve(ctx, projectId, input);\n    const folder = fdDest ? fdDest.path : "", fdId = fdDest ? fdDest.folderId : null;\n    rvMeta = await rvNewGated(ctx, projectId, "binary") ? JSON.stringify({ title, folder, folder_id: fdId }) : null;'],
  ['upload: the placeholder is created in its folder', UPLOADS,
    "INSERT INTO artifacts (id, project_id, kind, title, folder, head_rev, created_at, updated_at, review_mode, pending_review)\n      SELECT ?, ?, 'binary', ?, ?, 0, ?, ?, ?, ? WHERE ${az.sql}`).bind(artifactId, projectId, rvMeta ? RV_PLACEHOLDER : title, rvMeta ? \"\" : folder, nowIso(), nowIso(), rvMeta ? \"required\" : \"off\", rvMeta ? 1 : 0, ...az.params));",
    "INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, head_rev, created_at, updated_at, review_mode, pending_review)\n      SELECT ?, ?, 'binary', ?, ?, ?, 0, ?, ?, ?, ? WHERE ${az.sql}`).bind(artifactId, projectId, rvMeta ? RV_PLACEHOLDER : title, rvMeta ? \"\" : folder, rvMeta ? null : fdId, nowIso(), nowIso(), rvMeta ? \"required\" : \"off\", rvMeta ? 1 : 0, ...az.params));"],
  ['review: a gated new upload keeps its folder', SERVICE,
    '    meta = { title: m.title, folder: m.folder ?? "", tags: "[]" };', '    meta = { title: m.title, folder: m.folder ?? "", folderId: m.folder_id ?? null, tags: "[]" };'],
  ['review: a gated new upload\'s proposal stores the folder id', SERVICE,
    "has_meta, title, folder, tags, author_id, via_kind, via_id, via_label, client_info, change_note, created_at, upload_id)\n      SELECT ?, ?, ?, 'binary', 'pending', 1, 0, ?, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?",
    "has_meta, title, folder, folder_id, tags, author_id, via_kind, via_id, via_label, client_info, change_note, created_at, upload_id)\n      SELECT ?, ?, ?, 'binary', 'pending', 1, 0, ?, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"],
  ['review: gated new upload binds the folder id', SERVICE,
    'c.blobKey, c.size, c.sha256, c.mime, meta.title, meta.folder, meta.tags,', 'c.blobKey, c.size, c.sha256, c.mime, meta.title, meta.folder, meta.folderId ?? null, meta.tags,'],
  // ------------------------------------------------------------------ backup
  ['backup: export folder ids', BACKUP, 'DB.prepare("SELECT id, kind, title, folder, tags, head_rev,', 'DB.prepare("SELECT id, kind, title, folder, folder_id, tags, head_rev,'],
  ['backup: export the folder tree', BACKUP, '    features: ["document_templates/1"],', '    features: ["document_templates/1", "nested_folders/1"],\n    folders: await fdBackupExport(ctx, projectId),'],
  ['backup: restore the folder tree (after artifacts)', BACKUP, '  for (const r of backup.revisions)\n    stmts.push(',
    '  stmts.push(...fdRestoreStatements(DB, backup, pid, ctx.principal.id));\n  for (const r of backup.revisions)\n    stmts.push('],
  // ------------------------------------------------------------------ OAuth MCP
  ['oauth mcp: create_markdown takes a folder path', OMCP,
    'format: { type: "string", enum: ["markdown", "html"], description: "Document format (default markdown)" }, change_note: NOTE, idempotency_key: K }',
    'format: { type: "string", enum: ["markdown", "html"], description: "Document format (default markdown)" }, folder: FD_FOLDER_PROP, change_note: NOTE, idempotency_key: K }'],
  ['oauth mcp: create_markdown passes the folder', OMCP,
    'unwrap(await createMarkdown(c, p, { title: a.title, body: a.body ?? "", change_note: a.change_note }',
    'unwrap(await createMarkdown(c, p, { title: a.title, body: a.body ?? "", folder: a.folder, change_note: a.change_note }'],
  ['oauth mcp: folder tools', OMCP, '    ...tplTools(true),', '    ...tplTools(true),\n      ...fdTools(true),'],
  ['oauth mcp: list_artifacts filters by folder (documents-only connections)', OMCP,
    'inputSchema: S({ project_id: P, query: { type: "string", maxLength: 200 }, cursor: { type: "string", maxLength: 12 } }, []),',
    'inputSchema: S({ project_id: P, query: { type: "string", maxLength: 200 }, cursor: { type: "string", maxLength: 12 }, folder: FD_LIST_PROPS.folder, folder_id: FD_LIST_PROPS.folder_id, recursive: FD_LIST_PROPS.recursive }, []),'],
  ['oauth mcp: list_artifacts folder filter (App Connect on)', OMCP,
    '            const r2 = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: a.folder_id });',
    '            const r2 = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: a.folder_id, folder: a.folder, recursive: a.recursive });'],
  ['oauth mcp: list_artifacts folder filter (App Connect off)', OMCP,
    '          if (a.kind !== void 0 || a.folder_id !== void 0) throw new HttpError(400, "invalid_input", "kind/folder_id filters are not available");\n          const r = await listArtifacts(c, p, { query: a.query, cursor: a.cursor });',
    '          if (a.kind !== void 0) throw new HttpError(400, "invalid_input", "kind filter is not available");\n          const r = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, folderId: a.folder_id, folder: a.folder, recursive: a.recursive });'],
  ['oauth mcp: App Connect list props are the folder props', OMCP,
    "      folder_id: { type: \"string\", maxLength: 64, description: 'Only files in this folder (fld_\\u2026), or \"root\"' }\n",
    "      folder_id: { type: \"string\", maxLength: 64, description: 'Only files in this folder (fld_\\u2026), or \"root\"' },\n      folder: { type: \"string\", maxLength: 200, description: 'Only items in this folder path, e.g. \"Reports/2026\" (\"\" = project root)' },\n      recursive: { type: \"boolean\", description: \"With folder/folder_id: include items in all subfolders\" }\n"],
  ['oauth mcp: file listing filters by folder', OMCP,
    '  const r = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: appConnectEnabled(c.env) ? a.folder_id : void 0 });',
    '  const r = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: a.folder_id, folder: a.folder, recursive: a.recursive });'],
  ['oauth mcp: file listing folder props', OMCP,
    '          ...appConnectEnabled(env) ? { folder_id: AC_LIST_PROPS.folder_id } : {}',
    '          folder: FD_LIST_PROPS.folder, folder_id: FD_LIST_PROPS.folder_id, recursive: FD_LIST_PROPS.recursive'],
  ['oauth mcp: upload_begin and upload_file take folder paths', OMCP,
    '        folder: { type: "string", maxLength: 200 },', '        folder: FD_FOLDER_PROP,', 2],
  // ------------------------------------------------------------------ legacy MCP
  ['legacy mcp: folder tools', LMCP, '  ...tplTools(false),', '  ...tplTools(false),\n  ...fdTools(false),'],
  ['legacy mcp: list_artifacts filters by folder', LMCP,
    '    inputSchema: S2({ project_id: P2, query: { type: "string" }, cursor: { type: "string" } }, ["project_id"]),\n    run: /* @__PURE__ */ __name((c, a) => listArtifacts(c, a.project_id, { query: a.query, cursor: a.cursor }), "run")',
    '    inputSchema: S2({ project_id: P2, query: { type: "string" }, cursor: { type: "string" }, folder: FD_LIST_PROPS.folder, folder_id: FD_LIST_PROPS.folder_id, recursive: FD_LIST_PROPS.recursive }, ["project_id"]),\n    run: /* @__PURE__ */ __name((c, a) => listArtifacts(c, a.project_id, { query: a.query, cursor: a.cursor, folderId: a.folder_id, folder: a.folder, recursive: a.recursive }), "run")'],
  // ------------------------------------------------------------------ /v1
  ['v1: folder routes for every installation', V1,
    '  const known = Object.entries(R2).some(([name, re]) => (ac || name !== "records" && name !== "folders") && re.test(path));',
    '  const known = Object.entries(R2).some(([name, re]) => (ac || name !== "records") && re.test(path));'],
  ['v1: one folder route', V1, '  folders: new RegExp(`^/v1/projects/${SEG}/folders$`)\n};',
    '  folders: new RegExp(`^/v1/projects/${SEG}/folders$`),\n  folder: new RegExp(`^/v1/projects/${SEG}/folders/(fld_[A-Za-z0-9_-]{1,40})$`)\n};'],
  ['v1: list folders (tree, ?parent / ?parent_id)', V1,
    '    if (m === "GET") return json(await listFolders(projectCtx(env, k, requestId, pid), pid));',
    '    if (m === "GET") return json(await listFolders(projectCtx(env, k, requestId, pid), pid, { parent: url.searchParams.get("parent") ?? void 0, parent_id: url.searchParams.get("parent_id") ?? void 0 }));'],
  ['v1: create folder for every installation', V1,
    '      requireAppConnect(projectCtx(env, k, requestId, pid));\n      writeAllowed(k, pid);', '      writeAllowed(k, pid);'],
  ['v1: list files by folder for every installation', V1,
    '      if ((kind !== void 0 || folderId !== void 0) && !appConnectEnabled(env)) throw new HttpError(400, "invalid_input", "Unknown query parameter");\n      const r = await listArtifacts(ctx, pid, { query: url.searchParams.get("query") ?? void 0, cursor, kind, folderId });',
    '      if (kind !== void 0 && !appConnectEnabled(env)) throw new HttpError(400, "invalid_input", "Unknown query parameter");\n      const r = await listArtifacts(ctx, pid, { query: url.searchParams.get("query") ?? void 0, cursor, kind, folderId, folder: url.searchParams.get("folder") ?? void 0, recursive: url.searchParams.get("recursive") ?? void 0 });'],
  // ------------------------------------------------------------------ owner /api
  ['api: folder routes (list, create, rename/move, delete)', INDEX,
    '  if (rest[0] === "folders" && rest.length === 1) {\n    if (m === "GET") return json(await listFolders(ctx, pid));\n    if (m === "POST") return out(await createFolder(ctx, pid, await body(req), key()));\n  }',
    '  if (rest[0] === "folders" && rest.length === 1) {\n    if (m === "GET") return json(await listFolders(ctx, pid, { parent: url.searchParams.get("parent") ?? void 0, parent_id: url.searchParams.get("parent_id") ?? void 0 }));\n    if (m === "POST") return out(await createFolder(ctx, pid, await body(req), key()));\n  }\n  if (rest[0] === "folders" && rest.length === 2) {\n    const fid = str(rest[1], "folder", 64);\n    if (m === "PATCH") return out(await fdUpdate(ctx, pid, fid, await body(req), key()));\n    if (m === "DELETE") return out(await fdDelete(ctx, pid, fid));\n  }'],
  ['api: list by folder for every installation', INDEX,
    '      if (kind !== void 0 || folderId !== void 0) requireAppConnect(ctx);', '      if (kind !== void 0) requireAppConnect(ctx);'],
  ['api: list by folder path, recursive', INDEX,
    'trashed: url.searchParams.get("trashed") === "1", kind, folderId,',
    'trashed: url.searchParams.get("trashed") === "1", kind, folderId, folder: url.searchParams.get("folder") ?? void 0, recursive: url.searchParams.get("recursive") ?? void 0,'],
  // ------------------------------------------------------------------ App Connect consent and publisher
  ['consent: existing folders are shown by path', SERVER,
    'SELECT f.id, f.name, f.project_id FROM folders f JOIN projects p ON p.id = f.project_id WHERE p.owner_id = ? ORDER BY f.name_key LIMIT 500',
    'SELECT f.id, COALESCE(f.path, f.name) AS name, f.project_id FROM folders f JOIN projects p ON p.id = f.project_id WHERE p.owner_id = ? ORDER BY f.name_key LIMIT 500'],
  ['consent: resume cards show the folder path', SERVER, 'p.title AS project_title, f.name AS folder_name FROM publishers pb', 'p.title AS project_title, COALESCE(f.path, f.name) AS folder_name FROM publishers pb'],
  ['publisher: destination shows the folder path', PUB,
    '    const f = p.folder_id ? await env.DB.prepare("SELECT id, name FROM folders WHERE id = ?").bind(p.folder_id).first() : null;',
    '    const f = p.folder_id ? await env.DB.prepare("SELECT id, name, COALESCE(path, name) AS path FROM folders WHERE id = ?").bind(p.folder_id).first() : null;'],
  ['publisher: destination path field', PUB, 'destination: f ? { type: "folder", folder_id: f.id, name: f.name }', 'destination: f ? { type: "folder", folder_id: f.id, name: f.name, path: f.path }'],
  // ------------------------------------------------------------------ browser UI
  ['ui: styles', UI, 'var APP_CSS = `', 'var APP_CSS = `' + src['src/folders/browser.css']],
  ['ui: folder helpers', UI, '// ---------- home: authorized', src['src/folders/browser.js'] + '// ---------- home: authorized'],
  ['ui: folder route', UI, '    return viewList(p[1], false);\n  }', '    if (p[2] === "f" && p[3]) return viewList(p[1], false, p[3]);\n    return viewList(p[1], false);\n  }'],
  ['ui: project view takes a folder', UI, 'async function viewList(pid, trash) {', 'async function viewList(pid, trash, fid) {\n  fid = trash ? null : fid || null;\n  var fd = null;'],
  ['ui: folder panel', UI, '  var cursor = null, seq = 0, qTimer = null;',
    '  var cursor = null, seq = 0, qTimer = null;\n  if (!trash) fd = fdPanel(pid, fid, msg, function () { load(true); });'],
  ['ui: browse one folder (search stays project-wide)', UI, '(trash ? "&trashed=1" : "") + "&include=mime";',
    '(trash ? "&trashed=1" : "") + "&include=mime" + (!trash && !term ? "&folder_id=" + enc(fid || "root") : "");'],
  ['ui: subfolders render with each reload', UI, 'var r = await api("GET", "/api/projects/" + enc(pid) + "/artifacts" + qs);',
    'var fdInfo = fd ? await fd.render(term).catch(function (e) { if (e.status === 404) throw e; return null; }) : null;\n      if (fdInfo && my === seq) setCrumbs(fdCrumbs(pid, fdInfo.all, fid, []));\n      var r = await api("GET", "/api/projects/" + enc(pid) + "/artifacts" + qs);'],
  ['ui: an empty folder with subfolders is not "empty"', UI, 'if (reset && !r.artifacts.length) {',
    'if (reset && !r.artifacts.length && fdInfo && fdInfo.kids.length && !term) { list.hidden = true; }\n      else if (reset && !r.artifacts.length && fid && !term) { list.hidden = true; empty.hidden = false; empty.replaceChildren(stateBox("", "folder", "This folder is empty", "Write a document or upload a file here, or create a subfolder.")); }\n      else if (reset && !r.artifacts.length) {'],
  ['ui: new documents land in the folder being viewed', UI,
    'var req = selectedTemplate ? previewInput() : { title: t, body: kind === "html" ? "<h1>" + escHtml(t) + "</h1>\\n<p></p>\\n" : "# " + t + "\\n\\n", kind: kind };',
    'var req = selectedTemplate ? previewInput() : { title: t, body: kind === "html" ? "<h1>" + escHtml(t) + "</h1>\\n<p></p>\\n" : "# " + t + "\\n\\n", kind: kind };\n        if (fid) req.folder_id = fid;'],
  ['ui: uploads land in the folder being viewed', UI, 'uploadForm(pid, null, function () { load(true); }, "all")', 'uploadForm(pid, null, function () { load(true); }, "all", fid)'],
  ['ui: upload form takes a folder', UI, 'function uploadForm(pid, target, onDone, accept) {', 'function uploadForm(pid, target, onDone, accept, folderId) {'],
  ['ui: upload target carries the folder', UI, 'var t = target ? target() : { title: title.value.trim() || f.name };', 'var t = target ? target() : { title: title.value.trim() || f.name, folder_id: folderId || undefined };'],
  ['ui: binary upload begin sends the folder', UI, '    : { title: target.title || file.name, mime: mime, size: buf.byteLength, sha256: sha };',
    '    : { title: target.title || file.name, folder_id: target.folder_id, mime: mime, size: buf.byteLength, sha256: sha };'],
  ['ui: data file create sends the folder', UI, '{ kind: kind, title: target.title || file.name, content: text }', '{ kind: kind, title: target.title || file.name, folder_id: target.folder_id, content: text }'],
  ['ui: folder panel above the list', UI, 'panel, h("div", { class: "toolbar" }, projectTabs(pid, trash ? "trash" : "list")',
    'panel, fd ? fd.el : null, h("div", { class: "toolbar" }, projectTabs(pid, trash ? "trash" : "list")'],
  ['ui: inside a folder the eyebrow names the project', UI, 'pageHead(titleH1, { eyebrow: trash ? (projectTitles[pid] || "Project") : "Project", actions: actions }),',
    'pageHead(titleH1, { eyebrow: trash || fid ? (projectTitles[pid] || "Project") : "Project", actions: actions }),'],
  ['ui: page title is the folder name inside a folder', UI, '  ensureProjectTitle(pid);\n  if (resumePending', '  if (fid) fdLoad(pid).then(function (all) { var f = all.filter(function (x) { return x.id === fid; })[0]; if (f) { titleH1.textContent = f.name; titleH1.removeAttribute("data-project-title"); } }, function () {});\n  ensureProjectTitle(pid);\n  if (resumePending'],
  ['ui: Details folder field suggests folder paths', UI, 'h("label", null, "Folder", fFolder)', 'h("label", null, "Folder", fFolder, fdDatalist(pid, fFolder))'],
  ['ui: document breadcrumbs include the folder path', UI, 'setCrumbs(projCrumbs(pid, [{ t: A.meta.title }]));', 'setCrumbs(projCrumbs(pid, [{ t: A.meta.title }])); fdArtifactCrumbs(pid, A.meta);'],
];
const jsStart = input.indexOf('var APP_JS = String.raw`'), jsEnd = input.indexOf('`;\n', jsStart);
const spans = [];
for (const [name, mod, find, replace, count = 1] of PATCHES) {
  const at = [];
  for (let i = input.indexOf(find); i >= 0; i = input.indexOf(find, i + 1)) at.push(i);
  if (at.length !== count) throw Error(`${name}: expected ${count} match(es), found ${at.length}`);
  for (const a of at) {
    if (moduleOf(a) !== mod) throw Error(`${name}: anchor is in ${moduleOf(a)}, expected ${mod}`);
    if (mod === UI && name !== 'ui: styles' && !(a > jsStart && a < jsEnd)) throw Error(`${name}: anchor is outside APP_JS`);
    spans.push({ name, a, b: a + find.length, find, replace });
  }
}
spans.sort((x, y) => x.a - y.a);
for (let k = 1; k < spans.length; k++) if (spans[k].a < spans[k - 1].b) throw Error('Overlapping patches: ' + spans[k - 1].name + ' / ' + spans[k].name);
let out = '', pos = 0;
const gaps = [];
for (const s of spans) { gaps.push(input.slice(pos, s.a)); out += input.slice(pos, s.a) + s.replace; pos = s.b; }
gaps.push(input.slice(pos)); out += input.slice(pos);
writeFileSync('src/index.js', out);
const meta = { base_artifact_limits_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')),
  sources_sha256: Object.fromEntries(SOURCES.map((f) => [f, sha(src[f])])),
  patches: spans.map((s) => ({ name: s.name, find_sha256: sha(s.find), replace_sha256: sha(s.replace) })), requires_migration: '0018_nested_folders.sql' };
writeFileSync('folders-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('Nested folders bundle: ' + sha(out));
