import { TEXT_MAX_BYTES } from "./text-limits.js";
import { commitTextWrites, fenceRefusal, getText, isTextWriteFenceError, keyFence, mapContent, stageTextWrite, textWriteComplete } from "./content-store.js";
import { authorizeProject, authzSql, contentWriteSql, credentialGate, protectSql, requireHuman } from "./auth.js";
import { chQuery, cleanupChanges, listChanges } from "./changes/service.js";
import { MEASUREMENTS, MIME, checkFile, isCalendarDate, measurementRecords } from "./formats.js";
import { diffRevisions, historyPage, lineDiff, metaBaselineInsert, metaHistory, metaVersionInsert, provenance, restoreMetadata } from "./history/service.js";
import { RT_ID_TOO_LONG, RT_KINDS_ALL, RT_KINDS_DOCS, readTextChunk, rtChunkLimit, rtFit, rtIdBytes, rtQuery, rtReadAuthzSql } from "./reads/service.js";
import { __name } from "./runtime.js";
import { RS_SCHEMA, refreshTextSearch, rsQuery, rsReady, rsToolReady, searchArtifacts, textSearchBridge } from "./search/service.js";
import { createFromTemplate, listTemplates, previewTemplate, saveAsTemplate, tplAssertMaintenance, tplDate, tplProvenance, tplTools } from "./templates/service.js";
import { ROLE_RANK, memberRoleSql, personalWorkspaceId, projectRole, workspaceRoleSql, requireProjectRole, requireWorkspaceRole, visibleProjects } from "./tenancy.js";
import { HttpError, b64url, cutLists, int, nowIso, nowMs, randomId, sha256Hex, str } from "./util.js";
import { checkSlug, ensureHandle, ensureSlug, projectPaths, slugify } from "./paths.js";
import { explainLimit, limitGuard, projectLimitGuard, projectWorkspaceId } from "./limits.js";

function requireAppConnect(ctx) {
  if (!appConnectEnabled(ctx.env)) throw new HttpError(404, "not_found", "Not found");
}
function assertWritable(ctx, a, what) {
  tplAssertMaintenance(ctx, a);
  if (!a?.publisher_id || ctx.publisher) return;
  if (what === "content" || ctx.principal.kind === "agent")
    throw new HttpError(403, "protected_source", "This file is a source export owned by a connected app and cannot be modified here");
}
function audit(ctx, projectId, action, objectId, rev, result, gate, gateParams = []) {
  const where = gate ? ` WHERE ${gate}` : "";
  return db(ctx).prepare(
    `INSERT INTO audits (at, actor_id, project_id, action, object_id, rev_no, result, request_id, workspace_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(workspace_id, 'wsp_' || owner_id) FROM projects WHERE id = ?)${where}`
  ).bind(nowIso(), ctx.principal.id, projectId, action, objectId, rev, result, ctx.requestId, projectId, ...gateParams);
}
async function auditDenied(ctx, projectId, action, code) {
  await audit(ctx, projectId, action, null, null, "denied:" + code).run();
}
async function idemLookup(ctx, i) {
  const row = await db(ctx).prepare(
    "SELECT digest, status, response FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = ? AND key = ?"
  ).bind(ctx.principal.id, i.projectId, i.op, i.key).first();
  if (!row) return null;
  if (row.digest !== i.digest)
    throw new HttpError(422, "idempotency_key_reused", "Idempotency key was used with a different request");
  return { status: row.status, body: { ...JSON.parse(row.response), idempotent_replay: true } };
}
function idemInsert(ctx, i, status, body2, gate, gateParams) {
  return db(ctx).prepare(
    `INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`
  ).bind(ctx.principal.id, i.projectId, i.op, i.key, i.digest, status, JSON.stringify(body2), nowIso(), ...gateParams);
}
async function runBatch(ctx, stmts, i) {
  try {
    return await db(ctx).batch(stmts);
  } catch (e) {
    if (isTextWriteFenceError(e)) throw e;
    const refusal = fenceRefusal(e);
    if (refusal) {
      // A retry racing its own first attempt: if that attempt already stored a response, the request succeeded.
      const prior = await idemLookup(ctx, i);
      if (prior) return prior;
      throw refusal;
    }
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e))) {
      const prior = await idemLookup(ctx, i);
      if (prior) return prior;
      throw new HttpError(409, "conflict", "Concurrent modification");
    }
    throw e;
  }
}
// Inputs come only from existing authenticated, live scope evaluators. Never serialize a credential row.
function connectionInfo(type, id, label, projects, expires, activity, extra = {}) {
  const iso = (v) => v == null ? null : new Date(v).toISOString();
  return {
    connection: { type, id, display_label: String(label).slice(0, 200), label_source: type === "oauth" || type === "publisher" ? "registered app name (self-reported; not proof of caller identity)" : "owner-assigned label" },
    checked_at: nowIso(), expires_at: iso(expires), last_activity_at: iso(activity),
    successful_operations: "not measured",
    projects: projects.map((p) => ({ id: p.id, title: p.title, can_read: true, can_write: !!p.can_write })),
    restrictions: ["Editing remains subject to file ownership, supported kinds, quotas and expected revisions.", "This check authenticates this request and evaluates current access. It does not test document rendering, binary transfers or writes."],
    next_action: "Compare this connection ID in Connections. If a project is missing, check its selection or reconnect from the intended client. Expired or revoked credentials require owner inspection and cannot diagnose themselves.",
    ...extra
  };
}
async function legacyConnectionInfo(ctx) {
  if (ctx.principal.kind !== "agent" || !ctx.grant) throw new HttpError(403, "forbidden", "Use an agent connection");
  const row = await db(ctx).prepare("SELECT expires_at, revoked_at FROM grants WHERE id = ?").bind(ctx.grant.id).first();
  if (!row || row.revoked_at !== null || row.expires_at <= nowMs()) throw new HttpError(401, "grant_expired", "Grant revoked or expired");
  const { projects } = await listProjects(ctx);
  return connectionInfo("legacy_grant", ctx.grant.id, ctx.principal.label, projects, row.expires_at, null);
}
async function listProjects(ctx) {
  if (ctx.principal.kind === "agent") {
    // Same live gate as every operation: a credential whose creator lost access (or whose workspace is closed)
    // sees no project here either.
    const r = credentialGate(ctx, ctx.grant.project_id, "read"), w = credentialGate(ctx, ctx.grant.project_id, "write");
    const p = await db(ctx).prepare(`SELECT id, title, ${w.sql} AS can_write FROM projects WHERE id = ? AND ${r.sql}`).bind(...w.params, ctx.grant.project_id, ...r.params).first();
    const paths = p ? await projectPaths(ctx.env, [p.id]) : new Map();
    return { projects: p ? [{ id: p.id, title: p.title, ...paths.has(p.id) ? { path: paths.get(p.id) } : {}, can_write: !!p.can_write && !!ctx.grant.can_write }] : [], truncated: [] };
  }
  // Every project in every active workspace I belong to (minus per-project 'none'), with my effective role.
  const ps = await visibleProjects(ctx.env, ctx.principal.id);
  // Addresses: assigned on first use for projects and workspaces that predate them (only where something is missing).
  const missing = ps.filter((p) => !p.slug || !p.workspace_handle).map((p) => p.id);
  const fill = missing.length ? await projectPaths(ctx.env, missing) : new Map();
  const pathOf = (p) => p.slug && p.workspace_handle ? `${p.workspace_handle}/${p.slug}` : fill.get(p.id);
  return { projects: ps.map((p) => ({ id: p.id, title: p.title, path: pathOf(p), workspace_id: p.workspace_id, role: p.role, can_write: ROLE_RANK[p.role] >= ROLE_RANK.member && p.workspace_status === "active",
    ...p.workspace_status !== "active" ? { read_only_reason: "workspace_suspended" } : {} })), truncated: cutLists({ projects: ps.truncated }) };
}
async function createProject(ctx, input) {
  requireHuman(ctx);
  // A chosen id (slug) is allowed only where one person owns the installation: on a shared installation a
  // "Project already exists" answer would reveal another workspace's project id.
  if (input.id && (ctx.env.MULTI_USER === "1" || (await db(ctx).prepare("SELECT COUNT(*) AS n FROM principals WHERE kind = 'human' AND issuer <> 'restored'").first("n") > 1)))
    throw new HttpError(400, "invalid_input", "Project ids are assigned by the server on this installation");
  const id = input.id ? str(input.id, "id", 64) : randomId("prj");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$|^prj_[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, "invalid_input", "Bad project id");
  const title = str(input.title, "title", 200, { min: 1 });
  const wsId = input.workspace_id === void 0 ? personalWorkspaceId(ctx.principal.id) : str(input.workspace_id, "workspace_id", 80);
  const ws = await requireWorkspaceRole(ctx, wsId, "admin");
  // Address inside the workspace: chosen (slug) or derived from the title; a derived one gets -2, -3 … when taken.
  const chosen = input.slug === void 0 || input.slug === "" ? null : checkSlug(input.slug);
  // owner_id stays the workspace's creator so a rolled-back Worker (owner-only model) still finds it.
  const ownerId = await db(ctx).prepare("SELECT created_by FROM workspaces WHERE id = ?").bind(ws.id).first("created_by");
  const base = chosen ?? (slugify(title, 58) || "project");
  let slug = base;
  for (let i = 2; !chosen && i < 50 && await db(ctx).prepare("SELECT 1 FROM projects WHERE workspace_id = ? AND slug = ?").bind(ws.id, slug).first(); i++) slug = `${base}-${i}`;
  const lg = await limitGuard(ctx.env, ws.id, { projects: 1 });
  const [ins] = await db(ctx).batch([
    db(ctx).prepare(`INSERT INTO projects (id, owner_id, title, created_at, workspace_id, slug) SELECT ?, ?, ?, ?, ?, ?
      WHERE ${workspaceRoleSql("?", "admin")} AND ${lg.sql}`).bind(id, ownerId, title, nowIso(), ws.id, slug, ctx.principal.id, ws.id, ...lg.params),
    db(ctx).prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, rev_no, result, request_id, workspace_id) SELECT ?, ?, ?, 'project.create', ?, NULL, 'ok', ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?)")
      .bind(nowIso(), ctx.principal.id, id, id, ctx.requestId, ws.id, id, ws.id)
  ]).catch((e) => {
    if (/projects\.slug|projects_workspace_slug/i.test(String(e))) throw new HttpError(409, "slug_taken", "That project address is already used in this workspace; choose another");
    if (/UNIQUE|constraint/i.test(String(e))) throw new HttpError(409, "exists", "Project already exists");
    throw e;
  });
  if (!ins.meta.changes) {
    await explainLimit(ctx.env, ws.id, { projects: 1 }, lg.limits);
    throw new HttpError(403, "forbidden", "Needs the admin role in this workspace");
  }
  const handle = await ensureHandle(ctx.env, ws);
  return { id, title, slug, path: `${handle}/${slug}`, workspace_id: ws.id };
}
/** Rename a project and/or change its address (slug). Workspace admins only; old address links stop working. */
async function updateProject(ctx, projectId, input) {
  requireHuman(ctx);
  const r = await requireProjectRole(ctx, projectId, "admin");
  const title = input?.title === void 0 ? null : str(input.title, "title", 200, { min: 1 });
  const slug = input?.slug === void 0 ? null : checkSlug(input.slug);
  if (title === null && slug === null) throw new HttpError(400, "invalid_input", "Pass title and/or slug");
  const [u] = await db(ctx).batch([
    db(ctx).prepare(`UPDATE projects SET title = COALESCE(?, title), slug = COALESCE(?, slug), workspace_id = COALESCE(workspace_id, 'wsp_' || owner_id)
      WHERE id = ? AND ${memberRoleSql("?", "admin")}`).bind(title, slug, projectId, ctx.principal.id, projectId),
    audit(ctx, projectId, slug !== null ? "project.address" : "project.rename", projectId, null, "ok", "changes() = 1")
  ]).catch((e) => {
    if (/UNIQUE|constraint/i.test(String(e))) throw new HttpError(409, "slug_taken", "That project address is already used in this workspace; choose another");
    throw e;
  });
  if (!u.meta.changes) throw new HttpError(403, "forbidden", "Needs the admin role");
  const p = await db(ctx).prepare("SELECT id, title, slug FROM projects WHERE id = ?").bind(projectId).first();
  const path = (await projectPaths(ctx.env, [projectId])).get(projectId);
  return { id: p.id, title: p.title, slug: path ? path.split("/")[1] : p.slug, path, workspace_id: r.workspace_id };
}
async function createGrant(ctx, projectId, input) {
  requireHuman(ctx);
  await requireProjectRole(ctx, projectId, "admin");
  const label = str(input.label, "label", 80, { min: 1 });
  const canWrite = input.can_write === true ? 1 : 0;
  const ttlHours = input.ttl_hours === void 0 ? 24 : int(input.ttl_hours, "ttl_hours", 1, 24 * 30);
  const token = randomId("alt", 32);
  const principalId = randomId("agt");
  const grantId = randomId("grt");
  const expires = nowMs() + ttlHours * 36e5;
  // Connected-agents limit (Phase 4): live grant tokens count. Checked in the principal INSERT; a refused principal
  // fails the grant row's foreign key and rolls the batch back.
  const lg = await projectLimitGuard(ctx.env, projectId, { agents: 1 });
  try { await db(ctx).batch([
    db(ctx).prepare(`INSERT INTO principals (id, kind, issuer, subject, label, created_at) SELECT ?, 'agent', 'agent-library', ?, ?, ? WHERE ${lg.sql}`).bind(principalId, principalId, label, nowIso(), ...lg.params),
    db(ctx).prepare(
      "INSERT INTO grants (id, project_id, principal_id, token_hash, can_write, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(grantId, projectId, principalId, await sha256Hex(token), canWrite, expires, ctx.principal.id, nowIso()),
    audit(ctx, projectId, "grant.create", grantId, null, "ok")
  ]); } catch (e) {
    if (lg.workspaceId && /FOREIGN KEY/i.test(String(e?.message ?? e))) await explainLimit(ctx.env, lg.workspaceId, { agents: 1 }, lg.limits);
    throw e;
  }
  return { grant_id: grantId, principal_id: principalId, label, can_write: !!canWrite, expires_at: new Date(expires).toISOString(), token };
}
async function listGrants(ctx, projectId) {
  requireHuman(ctx);
  await requireProjectRole(ctx, projectId, "admin", true);
  const r = await db(ctx).prepare(
    `SELECT g.id, p.label, g.can_write, g.expires_at, g.revoked_at FROM grants g JOIN principals p ON p.id = g.principal_id
     WHERE g.project_id = ? ORDER BY g.created_at`
  ).bind(projectId).all();
  return {
    grants: r.results.map((g) => ({
      id: g.id,
      label: g.label,
      can_write: !!g.can_write,
      expires_at: new Date(g.expires_at).toISOString(),
      revoked: g.revoked_at !== null
    }))
  };
}
async function updateGrant(ctx, projectId, grantId, input) {
  requireHuman(ctx);
  // Revoking still works in a suspended (read-only) workspace; widening access doesn't.
  await requireProjectRole(ctx, projectId, "admin", input?.revoke === true);
  let res;
  if (input.revoke === true) {
    res = await db(ctx).prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL").bind(nowMs(), grantId, projectId).run();
  } else if (typeof input.can_write === "boolean") {
    res = await db(ctx).prepare("UPDATE grants SET can_write = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL").bind(input.can_write ? 1 : 0, grantId, projectId).run();
  } else throw new HttpError(400, "invalid_input", "Specify revoke:true or can_write");
  if (!res.meta.changes) throw new HttpError(404, "not_found", "Active grant not found");
  await audit(ctx, projectId, input.revoke ? "grant.revoke" : "grant.update", grantId, null, "ok").run();
  return { ok: true };
}
async function loadArtifact(ctx, projectId, artifactId, opts = {}) {
  const a = await db(ctx).prepare(`SELECT ${ART_COLS} FROM artifacts a WHERE a.id = ? AND a.project_id = ?`).bind(artifactId, projectId).first();
  if (!a || a.head_rev === 0 && !opts.allowUnpublished) throw new HttpError(404, "not_found", "Artifact not found");
  if (a.trashed_at && !opts.allowTrashed) throw new HttpError(404, "not_found", "Artifact not found");
  return a;
}
async function listArtifacts(ctx, projectId, q) {
  await authorizeProject(ctx, projectId, false);
  const offset = q.cursor ? int(Number(q.cursor), "cursor", 0, 1e5) : 0;
  const term = q.query ? str(q.query, "query", 200) : "";
  const kind = q.kind ?? "";
  if (kind && !["markdown", "html", "json", "csv", "binary"].includes(kind)) throw new HttpError(400, "invalid_input", "kind must be markdown, html, json, csv or binary");
  const folder = q.folderId ?? "";
  if (folder && folder !== "root" && !/^fld_[A-Za-z0-9_-]{1,40}$/.test(folder)) throw new HttpError(400, "invalid_input", "folder_id must be a folder id or root");
  const r = await db(ctx).prepare(
    `SELECT ${ART_COLS}, r.mime AS head_mime FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id
     WHERE a.project_id = ? AND a.head_rev > 0 AND (a.trashed_at IS NOT NULL) = ?
       AND (? = '' OR instr(lower(a.title), lower(?)) > 0) -- same as LIKE with ESCAPE, without D1's 50-byte pattern limit
       AND (? = '' OR a.kind = ?)
       AND (? = '' OR (? = 'root' AND a.folder_id IS NULL) OR a.folder_id = ?)
     ORDER BY a.updated_at DESC, a.id LIMIT ? OFFSET ?`
  ).bind(projectId, q.trashed ? 1 : 0, term, term, kind, kind, folder, folder, folder, LIMITS.pageSize + 1, offset).all();
  const rows = r.results.slice(0, LIMITS.pageSize);
  return {
    artifacts: rows.map((a) => q.withMime ? { ...artifactView(a, appConnectEnabled(ctx.env)), mime: a.head_mime ?? null } : artifactView(a, appConnectEnabled(ctx.env))),
    next_cursor: r.results.length > LIMITS.pageSize ? String(offset + LIMITS.pageSize) : null
  };
}
async function getArtifact(ctx, projectId, artifactId, revNo) {
  await authorizeProject(ctx, projectId, false);
  // People get their effective access with the document, so the UI never renders write controls it must take back.
  const access = ctx.principal.kind === "human" ? await projectRole(ctx.env, ctx.principal.id, projectId) : null;
  const a = await loadArtifact(ctx, projectId, artifactId);
  const rev = await db(ctx).prepare("SELECT * FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?").bind(artifactId, projectId, revNo ?? a.head_rev).first();
  if (!rev) throw new HttpError(404, "not_found", "Revision not found");
  return {
    artifact: { ...artifactView(a, appConnectEnabled(ctx.env)), ...await tplProvenance(ctx, projectId, a) },
    revision: { rev: rev.rev_no, id: rev.id, size: rev.size, sha256: rev.sha256, mime: rev.mime, created_at: rev.created_at, author_id: rev.author_id },
    ...access ? { access: { role: access.role, can_write: ROLE_RANK[access.role] >= ROLE_RANK.member && access.status === "active", ...access.status !== "active" ? { read_only_reason: "workspace_suspended" } : {} } } : {},
    ...a.kind === "markdown" || a.kind === "html" ? { body: await getText(ctx.env, rev) } : a.kind === "json" || a.kind === "csv" ? { content: await getText(ctx.env, rev), content_url: `/api/projects/${projectId}/artifacts/${artifactId}/content?rev=${rev.rev_no}` } : { content_url: `/api/projects/${projectId}/artifacts/${artifactId}/content?rev=${rev.rev_no}` }
  };
}
async function history(ctx, projectId, artifactId, opts = {}) {
  await authorizeProject(ctx, projectId, false);
  await loadArtifact(ctx, projectId, artifactId, { allowTrashed: ctx.principal.kind === "human" });
  return historyPage(ctx, projectId, artifactId, opts);
}
function mdBody(v, kind = "markdown") {
  const body2 = typeof v === "string" ? v : str(v, "body", LIMITS.markdownBytes);
  if (body2.length > LIMITS.markdownBytes || new TextEncoder().encode(body2).length > LIMITS.markdownBytes) throw new HttpError(413, "too_large", (kind === "html" ? "HTML" : "Markdown") + " exceeds 10 MiB");
  return body2;
}
async function createFile(ctx, projectId, input, key) {
  const kind = input.kind === void 0 || input.kind === null ? "markdown" : input.kind;
  if (kind === "markdown" || kind === "html") {
    if (input.schema !== void 0 && input.schema !== null) throw new HttpError(400, "invalid_input", "schema is only allowed for json or csv files");
    if (input.folder_id !== void 0 && input.folder_id !== null) requireAppConnect(ctx);
    return createMarkdown(ctx, projectId, { ...input, body: input.body ?? input.content ?? "" }, key, kind);
  }
  if (kind !== "json" && kind !== "csv") throw new HttpError(422, "unsupported_kind", "kind must be markdown, html, json or csv");
  requireAppConnect(ctx);
  return createMarkdown(ctx, projectId, input, key, kind);
}
async function folderCheck(ctx, projectId, folderId) {
  if (folderId === void 0 || folderId === null) return null;
  const id = str(folderId, "folder_id", 64);
  const f = await db(ctx).prepare("SELECT id FROM folders WHERE id = ? AND project_id = ?").bind(id, projectId).first();
  if (!f) throw new HttpError(404, "not_found", "Folder not found");
  return id;
}
// Upload create metadata. JSON-route callers retain their own checks and error order; tags default to [].
async function textCreateMetadata(ctx, projectId, input, kind) {
  if (kind === "json" || kind === "csv" || input.folder_id != null) requireAppConnect(ctx);
  const schema = input.schema == null ? null : String(input.schema);
  if (kind === "markdown" || kind === "html") {
    if (schema !== null) throw new HttpError(400, "invalid_input", "schema is only allowed for json or csv files");
  } else if (schema !== null && schema !== MEASUREMENTS) {
    throw new HttpError(400, "invalid_input", `unknown schema (supported: ${MEASUREMENTS})`);
  }
  return { title: str(input.title, "title", 200, { min: 1 }), folder: str(input.folder, "folder", 200, { optional: true }), folderId: await folderCheck(ctx, projectId, input.folder_id), schema };
}
/**
 * Create a text artifact. `internal` (App Files only) makes it a publisher's file: { publisherId, exportName, idem,
 * revId, fence: { sql, params }, extra: [statements gated on the revision existing] }. It is accepted only from the
 * publisher's own context, and its idempotency record, fence and revision id are the caller's.
 */
async function createMarkdown(ctx, projectId, input, key, kind = "markdown", internal = null) {
  if (internal && !(ctx.publisher && internal.publisherId === ctx.grant?.id && internal.fence && internal.revId && internal.idem))
    throw new HttpError(500, "internal", "Invalid internal create");
  await authorizeProject(ctx, projectId, true);
  const title = str(input.title, "title", 200, { min: 1 });
  let body2, schema = null, mime = TEXT_MIME[kind] ?? "text/markdown";
  if (kind === "markdown" || kind === "html") body2 = mdBody(input.body ?? "", kind);
  else {
    const c = checkFile(kind, input.content, input.schema);
    body2 = input.content;
    schema = c.schema;
    mime = MIME[kind];
  }
  const folder = str(input.folder, "folder", 200, { optional: true });
  const folderId = await folderCheck(ctx, projectId, input.folder_id);
  const digestParts = kind === "markdown" && folderId === null ? ["md", title, body2, folder] : [kind, title, body2, folder, folderId, schema];
  const i = internal ? internal.idem : { op: "artifact.create", key, projectId, digest: await sha256Hex(JSON.stringify(digestParts)) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const artId = randomId("art");
  const revId = internal ? internal.revId : randomId("rev");
  const sha2 = await sha256Hex(body2);
  const bytes = new TextEncoder().encode(body2).length;
  // App Files rows are a publisher's (items_per_project counts only owner files), as for snapshot files.
  const adds = internal ? { storage_bytes: bytes } : { storage_bytes: bytes, items_per_project: 1 };
  const lg = await projectLimitGuard(ctx.env, projectId, adds);
  const az0 = authzSql(ctx, projectId);
  const az = internal
    ? { sql: `${az0.sql} AND ${lg.sql} AND ${internal.fence.sql}`, params: [...az0.params, ...lg.params, ...internal.fence.params] }
    : { sql: `${az0.sql} AND ${lg.sql}`, params: [...az0.params, ...lg.params] };
  const now = nowIso();
  const result = internal ? { status: 201, body: internal.body({ artId, revId, sha256: sha2, size: bytes }) } : { status: 201, body: kind === "markdown" && folderId === null ? { artifact_id: artId, revision: 1, revision_id: revId, sha256: sha2 } : { artifact_id: artId, kind, folder_id: folderId, schema, revision: 1, revision_id: revId, sha256: sha2 } };
  const bodyKey = await stageTextWrite(ctx.env, projectId, artId, revId, body2);
  const out2 = await commitTextWrites(ctx.env, [bodyKey], (guarded) => runBatch(ctx, guarded([
    // Idempotency row first: a duplicate concurrent retry fails here and rolls back the whole batch.
    idemInsert(ctx, i, 201, result.body, az.sql, az.params),
    db(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, publisher_id, export_name, head_rev, head_revision_id, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${az.sql}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))`).bind(artId, projectId, kind, title, folder, folderId, schema, internal?.publisherId ?? null, internal?.exportName ?? null, revId, now, now, ...az.params, folderId, folderId, projectId),
    db(ctx).prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, size, sha256, mime, created_at, via_kind, via_id, via_label, client_info, change_note)
      SELECT ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ?)`).bind(revId, artId, projectId, ctx.principal.id, bodyKey, new TextEncoder().encode(body2).length, sha2, mime, now, ...provenance(ctx, input), artId),
    audit(ctx, projectId, "artifact.create", artId, 1, "ok", "EXISTS (SELECT 1 FROM artifacts WHERE id = ?)", [artId]),
    ...internal?.extra ?? [],
    textSearchBridge(ctx.env, artId, revId, body2), textWriteComplete(ctx.env, bodyKey)
  ]), i));
  if (!Array.isArray(out2)) return out2;
  if (!out2[1].meta.changes) {
    if (lg.workspaceId) await explainLimit(ctx.env, lg.workspaceId, adds, lg.limits, projectId);
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return result;
}
async function publishRevision(ctx, projectId, artifactId, expected, i, rev, extra = [], action = "artifact.save") {
  const revId = rev.revId ?? randomId("rev");
  const next = expected + 1;
  const azBase = authzSql(ctx, projectId);
  const cw = contentWriteSql(ctx, artifactId);
  // Text revisions count against storage here; new file revisions were reserved (and counted) when the upload began.
  // A restored file version adds a revision row of its size (counted in usage), so it is checked here too.
  const reserved = rev.reservedUpload;
  const addBytes = reserved || rev.blobKey && !rev.restoredFrom ? 0 : rev.size ?? 0;
  // A text reservation is exchanged for its revision in this batch. Check today's plan even at zero increment.
  const lg = addBytes || reserved ? await projectLimitGuard(ctx.env, projectId, { storage_bytes: addBytes }) : { sql: "1", params: [], limits: {} };
  const reservation = reserved ? {
    sql: `EXISTS (SELECT 1 FROM uploads u JOIN artifacts a ON a.id = u.artifact_id
      WHERE u.id = ? AND u.project_id = ? AND u.artifact_id = ? AND u.state = 'sealed' AND u.finalize_token = ?
        AND u.expected_size = ? AND u.expected_sha256 = ? AND u.mime = ?
        AND (a.folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id = a.folder_id AND f.project_id = u.project_id)))`,
    params: [reserved.id, projectId, artifactId, reserved.token, rev.size, rev.sha256, rev.mime]
  } : { sql: "1", params: [] };
  const az = { sql: `${azBase.sql} AND ${cw.sql} AND ${lg.sql} AND ${reservation.sql}${rev.fence ? " AND " + rev.fence.sql : ""}`, params: [...azBase.params, ...cw.params, ...lg.params, ...reservation.params, ...rev.fence?.params ?? []] };
  const now = nowIso();
  const gate = "EXISTS (SELECT 1 FROM revisions WHERE id = ?)";
  const body2 = { artifact_id: artifactId, revision: next, revision_id: revId, sha256: rev.sha256, ...reserved ? { size: rev.size } : {} };
  const bodyKey = rev.body == null ? null : await stageTextWrite(ctx.env, projectId, artifactId, revId, rev.body);
  const out2 = await commitTextWrites(ctx.env, [bodyKey], (guarded) => runBatch(ctx, guarded([
    db(ctx).prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, blob_key_id, blob_header, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND project_id = ? AND head_rev = ? AND trashed_at IS NULL) AND ${az.sql}`).bind(
      revId,
      artifactId,
      projectId,
      next,
      ctx.principal.id,
      bodyKey,
      rev.blobKey ?? null,
      rev.blobKeyId ?? null,
      rev.blobHeader ?? null,
      rev.size,
      rev.sha256,
      rev.mime,
      rev.restoredFrom ?? null,
      now,
      ...provenance(ctx, rev),
      artifactId,
      projectId,
      expected,
      ...az.params
    ),
    db(ctx).prepare(`UPDATE artifacts SET head_rev = ?, head_revision_id = ?, updated_at = ? WHERE id = ? AND project_id = ? AND head_rev = ? AND ${gate}`).bind(next, revId, now, artifactId, projectId, expected, revId),
    idemInsert(ctx, i, 200, body2, gate, [revId]),
    audit(ctx, projectId, action, artifactId, next, "ok", gate, [revId]),
    ...extra.map((s) => s),
    ...bodyKey ? [textSearchBridge(ctx.env, artifactId, revId, rev.body), textWriteComplete(ctx.env, bodyKey)] : [],
    // callers gate their own extra statements on the same predicate
    // Publication fences (keyFence / plaintextFence) go LAST: out2[0] stays the revision INSERT.
    ...rev.contentFences ?? []
  ]), i));
  if (!Array.isArray(out2)) return out2;
  if (!out2[0].meta.changes) {
    // A concurrent retry with the same idempotency key may have won: replay its stored result.
    const replay = await idemLookup(ctx, i);
    if (replay) return replay;
    const cur = await db(ctx).prepare("SELECT head_rev, trashed_at FROM artifacts WHERE id = ? AND project_id = ?").bind(artifactId, projectId).first();
    await audit(ctx, projectId, action, artifactId, expected, "conflict").run();
    if (cur?.trashed_at) throw new HttpError(409, "trashed", "Artifact is in trash");
    if (cur && cur.head_rev !== expected)
      throw new HttpError(409, "revision_conflict", "Expected revision is stale", { current_revision: cur.head_rev, expected_revision: expected });
    if ((addBytes || reserved) && lg.workspaceId) await explainLimit(ctx.env, lg.workspaceId, { storage_bytes: addBytes }, lg.limits);
    const pub = await db(ctx).prepare("SELECT publisher_id FROM artifacts WHERE id = ?").bind(artifactId).first("publisher_id");
    if (pub && !ctx.publisher) throw new HttpError(403, "protected_source", "This file is a source export owned by a connected app and cannot be modified here");
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 200, body: body2 };
}
async function saveMarkdown(ctx, projectId, artifactId, input, key) {
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_revision, "expected_revision", 1);
  const body2 = mdBody(input.body);
  const i = { op: "artifact.save:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, body2])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const a = await loadArtifact(ctx, projectId, artifactId);
  if (a.kind !== "markdown" && a.kind !== "html") throw new HttpError(400, "invalid_input", "Not a Markdown or HTML document");
  assertWritable(ctx, a, "content");
  if (a.kind === "html") mdBody(body2, "html");
  return publishRevision(
    ctx,
    projectId,
    artifactId,
    expected,
    i,
    { body: body2, size: new TextEncoder().encode(body2).length, sha256: await sha256Hex(body2), mime: TEXT_MIME[a.kind], change_note: input.change_note }
  );
}
async function saveFile(ctx, projectId, artifactId, input, key) {
  if (!appConnectEnabled(ctx.env)) return saveMarkdown(ctx, projectId, artifactId, input, key);
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_revision, "expected_revision", 1);
  const text = input.body ?? input.content;
  if (typeof text === "string") {
    const prior = await idemLookup(ctx, { op: "artifact.save:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, text])) });
    if (prior) return prior;
  }
  const a = await loadArtifact(ctx, projectId, artifactId);
  assertWritable(ctx, a, "content");
  if (a.kind === "markdown" || a.kind === "html") return saveMarkdown(ctx, projectId, artifactId, { expected_revision: input.expected_revision, body: text, change_note: input.change_note }, key);
  if (a.kind !== "json" && a.kind !== "csv") throw new HttpError(422, "unsupported_kind", "Binary files are replaced through uploads");
  const c = checkFile(a.kind, input.content, a.schema_id);
  const body2 = input.content;
  const i = { op: "artifact.save:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, body2])) };
  const r = await publishRevision(
    ctx,
    projectId,
    artifactId,
    expected,
    i,
    { body: body2, size: new TextEncoder().encode(body2).length, sha256: await sha256Hex(body2), mime: MIME[a.kind], change_note: input.change_note }
  );
  return r.body?.idempotent_replay ? r : { status: r.status, body: { ...r.body, kind: a.kind, folder_id: a.folder_id ?? null, schema: c.schema } };
}
async function restoreRevision(ctx, projectId, artifactId, input, key) {
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_revision, "expected_revision", 1);
  const from = int(input.from_revision, "from_revision", 1);
  const i = { op: "artifact.restore:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, from])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  assertWritable(ctx, await loadArtifact(ctx, projectId, artifactId), "content");
  const old = await db(ctx).prepare("SELECT * FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?").bind(artifactId, projectId, from).first();
  if (!old) throw new HttpError(404, "not_found", "Revision not found");
  // An encrypted file version is republished under its key only while that key is active. A legacy plaintext version
  // refers to an existing plaintext object (nothing is written) and carries no fence (docs/encryption.md).
  const contentFences = old.blob_key && old.blob_key_id ? [keyFence(ctx.env, { keyId: old.blob_key_id, workspaceId: await projectWorkspaceId(ctx.env, projectId) })] : [];
  return publishRevision(
    ctx,
    projectId,
    artifactId,
    expected,
    i,
    { body: old.blob_key ? void 0 : await getText(ctx.env, old), blobKey: old.blob_key ?? void 0, blobKeyId: old.blob_key ? old.blob_key_id ?? null : null, blobHeader: old.blob_key ? old.blob_header ?? null : null, contentFences, size: old.size, sha256: old.sha256, mime: old.mime, restoredFrom: from, change_note: input.change_note ?? "Restored version " + from },
    [],
    "artifact.restore_revision"
  );
}
async function updateMetadata(ctx, projectId, artifactId, input, key, internal) {
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_meta_version, "expected_meta_version", 1);
  // restoredFrom is internal-only (set by restoreMetadata); request bodies can never claim a change is a restore.
  const restoredFrom = Number.isInteger(internal?.restoredFrom) ? internal.restoredFrom : null;
  const { change_note: _note, ...digestInput } = input;
  const i = { op: restoredFrom ? "artifact.meta_restore:" + artifactId : "artifact.meta:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify(restoredFrom ? [expected, restoredFrom] : digestInput)) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const a = await loadArtifact(ctx, projectId, artifactId, { allowTrashed: true });
  // Agents can't restore a trashed document's details (the trash takes it away from them). Checked after the
  // idempotency lookup, so a same-key retry of a restore that already succeeded still replays.
  if (restoredFrom && ctx.principal.kind !== "human" && a.trashed_at) throw new HttpError(404, "not_found", "Artifact not found");
  assertWritable(ctx, a, "meta");
  const title = input.title !== void 0 ? str(input.title, "title", 200, { min: 1 }) : a.title;
  const folder = input.folder !== void 0 ? str(input.folder, "folder", 200) : a.folder;
  if (input.template_description !== undefined && !a.is_template) throw new HttpError(400, "invalid_input", "Not a template");
  const description = input.template_description !== undefined ? str(input.template_description, "template_description", 280) : a.template_description;
  let tags = a.tags;
  if (input.tags !== void 0) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) throw new HttpError(400, "invalid_input", "tags must be an array (max 20)");
    tags = JSON.stringify(input.tags.map((t) => str(t, "tag", 50, { min: 1 })));
  }
  let trashed = a.trashed_at;
  if (input.trashed === true) trashed = trashed ?? nowIso();
  if (input.trashed === false) trashed = null;
  const az0 = authzSql(ctx, projectId), pr = protectSql(ctx, artifactId);
  const az = { sql: `${az0.sql} AND ${pr.sql}`, params: [...az0.params, ...pr.params] };
  const next = expected + 1;
  const gate = "EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND meta_version = ? AND meta_request_id = ?)";
  const gp = [artifactId, next, ctx.requestId];
  const body2 = { artifact_id: artifactId, meta_version: next, title, folder, tags: JSON.parse(tags), trashed: !!trashed, ...a.is_template ? { template_description: description } : {} };
  const out2 = await runBatch(ctx, [
    db(ctx).prepare(`UPDATE artifacts SET title = ?, folder = ?, tags = ?, trashed_at = ?, template_description = ?, meta_version = ?, meta_request_id = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND meta_version = ? AND ${az.sql}`).bind(title, folder, tags, trashed, description, next, ctx.requestId, nowIso(), artifactId, projectId, expected, ...az.params),
    metaBaselineInsert(ctx, a, gate, gp),
    metaVersionInsert(ctx, a, next, { title, folder, tags, trashed: !!trashed, description, restoredFrom }, input, gate, gp),
    idemInsert(ctx, i, 200, body2, gate, gp),
    audit(
      ctx,
      projectId,
      restoredFrom ? "artifact.meta_restore" : input.trashed === true ? "artifact.trash" : input.trashed === false ? "artifact.untrash" : "artifact.meta",
      artifactId,
      null,
      "ok",
      gate,
      gp
    )
  ], i);
  if (!Array.isArray(out2)) return out2;
  if (!out2[0].meta.changes) {
    // A concurrent retry with the same idempotency key may have won: replay its stored result.
    const replay = await idemLookup(ctx, i);
    if (replay) return replay;
    const cur = await db(ctx).prepare("SELECT meta_version FROM artifacts WHERE id = ? AND project_id = ?").bind(artifactId, projectId).first("meta_version");
    if (cur === expected) throw new HttpError(403, "forbidden", "Grant no longer valid");
    throw new HttpError(409, "metadata_conflict", "Expected metadata version is stale", { current_meta_version: cur });
  }
  await refreshTextSearch(ctx.env, artifactId);
  return { status: 200, body: body2 };
}
// Folders per project: checked inside the INSERT (FOLDER_ROOM_SQL binds the project id, then the cap) on every path
// that creates one (createFolder here, the publishing consent page in oauth/server.js). Lists show them all.
var FOLDERS_PER_PROJECT = 1000;
var FOLDER_ROOM_SQL = "(SELECT COUNT(*) FROM folders WHERE project_id = ?) < ?";
var tooManyFolders = () => new HttpError(409, "too_many_folders", "A project can have up to 1,000 folders", { limit: FOLDERS_PER_PROJECT });
function folderName(v) {
  const raw = str(v, "name", 200, { min: 1 }).trim();
  if (raw.length < 1 || raw.length > 80) throw new HttpError(400, "invalid_input", "Folder name must be 1-80 characters");
  if (/[\/\u0000-\u001f\u007f]/.test(raw)) throw new HttpError(400, "invalid_input", "Folder name cannot contain / or control characters");
  return { name: raw, key: raw.toLowerCase() };
}
async function listFolders(ctx, projectId) {
  requireAppConnect(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await db(ctx).prepare("SELECT id, name, publisher_id, created_at FROM folders WHERE project_id = ? ORDER BY name_key LIMIT ?").bind(projectId, FOLDERS_PER_PROJECT).all();
  return { folders: r.results };
}
async function createFolder(ctx, projectId, input, key) {
  requireAppConnect(ctx);
  await authorizeProject(ctx, projectId, true);
  if (ctx.publisher) throw new HttpError(403, "forbidden", "Publishers cannot create folders");
  const { name, key: nameKey } = folderName(input?.name);
  const i = { op: "folder.create", key, projectId, digest: await sha256Hex(JSON.stringify([nameKey])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const existing = await db(ctx).prepare("SELECT id FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, nameKey).first("id");
  if (existing) throw new HttpError(409, "folder_exists", "A folder with this name already exists", { folder_id: existing });
  const id = randomId("fld");
  const az = authzSql(ctx, projectId);
  const body2 = { id, name };
  const gate = "EXISTS (SELECT 1 FROM folders WHERE id = ?)";
  let out2;
  try {
    out2 = await runBatch(ctx, [
      db(ctx).prepare(`INSERT INTO folders (id, project_id, name, name_key, created_at, created_by) SELECT ?, ?, ?, ?, ?, ? WHERE ${az.sql} AND ${FOLDER_ROOM_SQL}`).bind(id, projectId, name, nameKey, nowIso(), ctx.principal.id, ...az.params, projectId, FOLDERS_PER_PROJECT),
      idemInsert(ctx, i, 201, body2, gate, [id]),
      audit(ctx, projectId, "folder.create", id, null, "ok", gate, [id])
    ], i);
  } catch (e) {
    if (e instanceof HttpError && e.code === "conflict") {
      const ex = await db(ctx).prepare("SELECT id FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, nameKey).first("id");
      if (ex) throw new HttpError(409, "folder_exists", "A folder with this name already exists", { folder_id: ex });
    }
    throw e;
  }
  if (!Array.isArray(out2)) return out2;
  if (!out2[0].meta.changes) {
    const n = await db(ctx).prepare("SELECT COUNT(*) AS n FROM folders WHERE project_id = ?").bind(projectId).first("n");
    if (n >= FOLDERS_PER_PROJECT) throw tooManyFolders();
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 201, body: body2 };
}
async function readRecords(ctx, projectId, artifactId, q) {
  requireAppConnect(ctx);
  await authorizeProject(ctx, projectId, false);
  const a = await loadArtifact(ctx, projectId, artifactId);
  if (a.kind !== "json" || a.schema_id !== MEASUREMENTS)
    throw new HttpError(422, "schema_not_queryable", "Records can be queried only on JSON files with schema agentlib.measurements/1");
  const rev = await db(ctx).prepare("SELECT rev_no, body, body_key FROM revisions WHERE id = ?").bind(a.head_revision_id).first();
  const from = q.from ?? null, to = q.to ?? null;
  if (from !== null && !isCalendarDate(from)) throw new HttpError(400, "invalid_input", "from must be a real calendar date YYYY-MM-DD");
  if (to !== null && !isCalendarDate(to)) throw new HttpError(400, "invalid_input", "to must be a real calendar date YYYY-MM-DD");
  if (from !== null && to !== null && from > to) throw new HttpError(400, "invalid_input", "from must not be after to");
  const metric = q.metric ?? null;
  const limit = q.limit === void 0 || q.limit === null || q.limit === "" ? 100 : int(Number(q.limit), "limit", 1, 500);
  const offset = q.cursor ? int(Number(q.cursor), "cursor", 0, 1e7) : 0;
  return {
    schema: MEASUREMENTS,
    file_id: artifactId,
    revision: rev.rev_no,
    ...readRecordsPage(await getText(ctx.env, rev), { from, to, metric, limit, offset })
  };
}
function readRecordsPage(text, { from = null, to = null, metric = null, limit = 100, offset = 0 } = {}) {
  let undated = 0, hits = 0;
  const ranged = from !== null || to !== null;
  const page2 = [];
  for (const record of measurementRecords(text)) {
    const r = JSON.parse(record);
    if (metric !== null && r.metric !== metric) continue;
    if (ranged) {
      if (typeof r.date !== "string") {
        undated++;
        continue;
      }
      if (from !== null && r.date < from) continue;
      if (to !== null && r.date > to) continue;
    }
    if (hits >= offset && page2.length < limit) page2.push(r);
    hits++;
  }
  return {
    records: page2,
    undated_excluded: undated,
    next_cursor: offset + limit < hits ? String(offset + limit) : null
  };
}
async function addComment(ctx, projectId, artifactId, input, key) {
  await authorizeProject(ctx, projectId, true);
  const rev = int(input.revision, "revision", 1);
  const text = str(input.body, "body", LIMITS.commentChars, { min: 1 });
  const i = { op: "comment.add:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([rev, text])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  assertWritable(ctx, await loadArtifact(ctx, projectId, artifactId), "meta");
  const id = randomId("cmt");
  const az0 = authzSql(ctx, projectId), pr = protectSql(ctx, artifactId);
  const az = { sql: `${az0.sql} AND ${pr.sql}`, params: [...az0.params, ...pr.params] };
  const gate = "EXISTS (SELECT 1 FROM comments WHERE id = ?)";
  const body2 = { comment_id: id, revision: rev };
  const bodyKey = await stageTextWrite(ctx.env, projectId, artifactId, id, text);
  const out2 = await commitTextWrites(ctx.env, [bodyKey], (guarded) => runBatch(ctx, guarded([
    db(ctx).prepare(`INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, body_key, created_at)
      SELECT ?, ?, ?, ?, ?, '', ?, ? WHERE EXISTS (SELECT 1 FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?) AND ${az.sql}`).bind(id, projectId, artifactId, rev, ctx.principal.id, bodyKey, nowIso(), artifactId, projectId, rev, ...az.params),
    idemInsert(ctx, i, 201, body2, gate, [id]),
    audit(ctx, projectId, "comment.add", artifactId, rev, "ok", gate, [id]),
    textWriteComplete(ctx.env, bodyKey)
  ]), i));
  if (!Array.isArray(out2)) return out2;
  if (!out2[0].meta.changes) throw new HttpError(404, "not_found", "Revision not found");
  return { status: 201, body: body2 };
}
// Comments page newest-first, COMMENTS_PAGE at a time (order created_at, id); each page is returned oldest first.
// next_cursor names the oldest comment returned; passing it returns the page of comments before that one.
var COMMENTS_PAGE = 200;
function commentCursor(c) {
  return b64url(new TextEncoder().encode(JSON.stringify([c.created_at, c.id])));
}
function parseCommentCursor(v) {
  const bad = () => new HttpError(400, "invalid_cursor", "Malformed comments cursor");
  if (typeof v !== "string" || v.length > 512 || !/^[A-Za-z0-9_-]+$/.test(v)) throw bad();
  let at, id;
  try {
    [at, id] = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0))));
  } catch {
    throw bad();
  }
  if (typeof at !== "string" || typeof id !== "string") throw bad();
  return { at, id };
}
async function listComments(ctx, projectId, artifactId, cursor) {
  await authorizeProject(ctx, projectId, false);
  await loadArtifact(ctx, projectId, artifactId);
  const before = cursor === void 0 || cursor === null || cursor === "" ? null : parseCommentCursor(cursor);
  const r = await db(ctx).prepare(
    `SELECT c.id, c.rev_no AS revision, c.body, c.body_key, c.created_at, p.label AS author FROM comments c JOIN principals p ON p.id = c.author_id
     WHERE c.artifact_id = ? AND c.project_id = ?${before ? " AND (c.created_at, c.id) < (?, ?)" : ""}
     ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
  ).bind(artifactId, projectId, ...before ? [before.at, before.id] : [], COMMENTS_PAGE + 1).all();
  const page = r.results.slice(0, COMMENTS_PAGE).reverse();
  return {
    comments: await mapContent(page, async ({ body_key, ...c }) => ({ ...c, body: await getText(ctx.env, { ...c, body_key }) })),
    next_cursor: r.results.length > COMMENTS_PAGE ? commentCursor(page[0]) : null
  };
}
async function listAudit(ctx, projectId) {
  requireHuman(ctx);
  await requireProjectRole(ctx, projectId, "admin", true);
  const r = await db(ctx).prepare(
    "SELECT seq, at, actor_id, action, object_id, rev_no, result, request_id FROM audits WHERE project_id = ? ORDER BY seq DESC LIMIT 201"
  ).bind(projectId).all();
  return { audits: r.results.slice(0, 200), truncated: r.results.length > 200 ? ["audits"] : [] };
}
var appConnectEnabled, LIMITS, ascii, BINARY_TYPES, IMAGE_TYPES, VIDEO_TYPES, TEXT_MIME, db, artifactView, ART_COLS;
appConnectEnabled = (env) => env?.APP_CONNECT_ENABLED === "1";
LIMITS = {
  markdownBytes: TEXT_MAX_BYTES,
  // File size and documents per project are workspace limits (limits.js: file_bytes, items_per_project).
  pageSize: 50,
  commentChars: 1e4
};
ascii = (b, from, to) => String.fromCharCode(...b.slice(from, to));
BINARY_TYPES = {
  "image/png": (b) => b.length > 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71,
  "image/jpeg": (b) => b.length > 3 && b[0] === 255 && b[1] === 216 && b[2] === 255,
  "image/webp": (b) => b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  "image/gif": (b) => b.length > 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a"),
  "application/pdf": (b) => b.length > 5 && ascii(b, 0, 5) === "%PDF-",
  "video/mp4": (b) => b.length > 12 && ascii(b, 4, 8) === "ftyp",
  "video/webm": (b) => b.length > 4 && b[0] === 26 && b[1] === 69 && b[2] === 223 && b[3] === 163,
  "application/octet-stream": () => true
  // download-only, never rendered inline
};
IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
VIDEO_TYPES = ["video/mp4", "video/webm"];
TEXT_MIME = { markdown: "text/markdown", html: "text/html" };
db = (ctx) => ctx.env.DB;
artifactView = (a, appConnect = true) => ({
  id: a.id,
  project_id: a.project_id,
  kind: a.kind,
  title: a.title,
  ...a.is_template ? { is_template: true, template_description: a.template_description } : {},
  folder: a.folder,
  tags: JSON.parse(a.tags),
  revision: a.head_rev,
  meta_version: a.meta_version,
  trashed: !!a.trashed_at,
  updated_at: a.updated_at,
  // App Connect fields appear only with the flag on, so flag-off responses keep their exact Phase 1 shape (§0).
  ...appConnect ? {
    folder_id: a.folder_id ?? null,
    schema: a.schema_id ?? null,
    publisher: a.publisher_id ? { id: a.publisher_id, display_name: a.pub_name ?? null, protected: true } : null
  } : {}
});
ART_COLS = "a.*, (SELECT display_name FROM publishers WHERE id = a.publisher_id) AS pub_name";

export { BINARY_TYPES, FOLDERS_PER_PROJECT, FOLDER_ROOM_SQL, IMAGE_TYPES, LIMITS, RS_SCHEMA, RT_ID_TOO_LONG, RT_KINDS_ALL, RT_KINDS_DOCS, VIDEO_TYPES, addComment, appConnectEnabled, assertWritable, audit, auditDenied, chQuery, cleanupChanges, connectionInfo, createFile, createFolder, createFromTemplate, createGrant, createMarkdown, createProject, updateProject, db, diffRevisions, folderCheck, folderName, getArtifact, history, idemInsert, idemLookup, legacyConnectionInfo, listArtifacts, listAudit, listChanges, listComments, listFolders, listGrants, listProjects, listTemplates, loadArtifact, textCreateMetadata, mdBody, metaHistory, previewTemplate, provenance, publishRevision, readRecords, readRecordsPage, readTextChunk, requireAppConnect, restoreMetadata, restoreRevision, rsQuery, rsReady, rsToolReady, rtChunkLimit, rtFit, rtIdBytes, rtQuery, rtReadAuthzSql, runBatch, saveAsTemplate, saveFile, saveMarkdown, searchArtifacts, tplDate, tplTools, tooManyFolders, updateGrant, updateMetadata };
