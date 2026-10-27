// Shared business logic for HTTP API and MCP. Every operation: authenticate (caller) ->
// authorize project -> validate -> guarded atomic mutation -> audit -> serialize.
import { authorizeProject, authzSql, contentWriteSql, protectSql, requireHuman, type Ctx } from "./auth";
import { HttpError, int, nowIso, nowMs, randomId, sha256Hex, str } from "./util";
import { checkFile, isCalendarDate, MEASUREMENTS, MIME } from "./formats";

/** App Connect (Phase 2/3) is enabled only where the deploy-time var says so (local tests). */
export const appConnectEnabled = (env: any) => env?.APP_CONNECT_ENABLED === "1";
export function requireAppConnect(ctx: Ctx) {
  if (!appConnectEnabled(ctx.env)) throw new HttpError(404, "not_found", "Not found");
}
/** Refuse writes to publisher-owned files: content for everyone but the publisher, metadata/comments for agents. */
export function assertWritable(ctx: Ctx, a: any, what: "content" | "meta") {
  if (!a?.publisher_id || ctx.publisher) return;
  if (what === "content" || ctx.principal.kind === "agent")
    throw new HttpError(403, "protected_source", "This file is a source export owned by a connected app and cannot be modified here");
}

export const LIMITS = {
  markdownBytes: 1024 * 1024,
  binaryBytes: 5 * 1024 * 1024, // owner envelope: <= 5 MiB synthetic fixtures
  projectBinaryBytes: 100 * 1024 * 1024,
  artifactsPerProject: 100,
  pageSize: 50,
  uploadTtlMs: 15 * 60 * 1000,
  commentChars: 10_000,
};

export const BINARY_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "application/pdf": (b) => b.length > 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-",
  "video/mp4": (b) => b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === "ftyp",
  "application/octet-stream": () => true, // download-only, never rendered inline
};

type Stmt = D1PreparedStatement;
const db = (ctx: Ctx) => ctx.env.DB;

function audit(ctx: Ctx, projectId: string | null, action: string, objectId: string | null, rev: number | null, result: string, gate?: string, gateParams: unknown[] = []): Stmt {
  const where = gate ? ` WHERE ${gate}` : "";
  return db(ctx).prepare(
    `INSERT INTO audits (at, actor_id, project_id, action, object_id, rev_no, result, request_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?${where}`,
  ).bind(nowIso(), ctx.principal.id, projectId, action, objectId, rev, result, ctx.requestId, ...gateParams);
}

export async function auditDenied(ctx: Ctx, projectId: string | null, action: string, code: string) {
  await audit(ctx, projectId, action, null, null, "denied:" + code).run();
}

// ---------- idempotency ----------
type Idem = { op: string; key: string; digest: string; projectId: string };

async function idemLookup(ctx: Ctx, i: Idem): Promise<{ status: number; body: any } | null> {
  const row = await db(ctx).prepare(
    "SELECT digest, status, response FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = ? AND key = ?",
  ).bind(ctx.principal.id, i.projectId, i.op, i.key).first<any>();
  if (!row) return null;
  if (row.digest !== i.digest)
    throw new HttpError(422, "idempotency_key_reused", "Idempotency key was used with a different request");
  return { status: row.status, body: { ...JSON.parse(row.response), idempotent_replay: true } };
}

function idemInsert(ctx: Ctx, i: Idem, status: number, body: unknown, gate: string, gateParams: unknown[]): Stmt {
  return db(ctx).prepare(
    `INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`,
  ).bind(ctx.principal.id, i.projectId, i.op, i.key, i.digest, status, JSON.stringify(body), nowIso(), ...gateParams);
}

/** Run a batch; if a concurrent identical retry raced us on the idempotency PK, return its stored result. */
async function runBatch(ctx: Ctx, stmts: Stmt[], i: Idem): Promise<D1Result[] | { status: number; body: any }> {
  try {
    return await db(ctx).batch(stmts);
  } catch (e: any) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e))) {
      const prior = await idemLookup(ctx, i);
      if (prior) return prior;
      throw new HttpError(409, "conflict", "Concurrent modification");
    }
    throw e;
  }
}

// ---------- projects & grants (human-only administration) ----------
export async function listProjects(ctx: Ctx) {
  if (ctx.principal.kind === "agent") {
    const p = await db(ctx).prepare("SELECT id, title FROM projects WHERE id = ?").bind(ctx.grant!.project_id).first();
    return { projects: p ? [{ ...p, can_write: !!ctx.grant!.can_write }] : [] };
  }
  const r = await db(ctx).prepare("SELECT id, title FROM projects WHERE owner_id = ? ORDER BY created_at").bind(ctx.principal.id).all();
  return { projects: r.results.map((p) => ({ ...p, can_write: true })) };
}

export async function createProject(ctx: Ctx, input: any) {
  requireHuman(ctx);
  const id = input.id ? str(input.id, "id", 64) : randomId("prj");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$|^prj_[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, "invalid_input", "Bad project id");
  const title = str(input.title, "title", 200, { min: 1 });
  await db(ctx).batch([
    db(ctx).prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)").bind(id, ctx.principal.id, title, nowIso()),
    audit(ctx, id, "project.create", id, null, "ok"),
  ]).catch((e) => {
    if (/UNIQUE|constraint/i.test(String(e))) throw new HttpError(409, "exists", "Project already exists");
    throw e;
  });
  return { id, title };
}

/** Human-only: issue a distinct agent principal + revocable, expiring, hash-stored project grant. Token is returned once. */
export async function createGrant(ctx: Ctx, projectId: string, input: any) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, true);
  const label = str(input.label, "label", 80, { min: 1 });
  const canWrite = input.can_write === true ? 1 : 0;
  const ttlHours = input.ttl_hours === undefined ? 24 : int(input.ttl_hours, "ttl_hours", 1, 24 * 30);
  const token = randomId("alt", 32);
  const principalId = randomId("agt");
  const grantId = randomId("grt");
  const expires = nowMs() + ttlHours * 3600_000;
  await db(ctx).batch([
    db(ctx).prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'agent-library', ?, ?, ?)")
      .bind(principalId, principalId, label, nowIso()),
    db(ctx).prepare(
      "INSERT INTO grants (id, project_id, principal_id, token_hash, can_write, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(grantId, projectId, principalId, await sha256Hex(token), canWrite, expires, ctx.principal.id, nowIso()),
    audit(ctx, projectId, "grant.create", grantId, null, "ok"),
  ]);
  return { grant_id: grantId, principal_id: principalId, label, can_write: !!canWrite, expires_at: new Date(expires).toISOString(), token };
}

export async function listGrants(ctx: Ctx, projectId: string) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await db(ctx).prepare(
    `SELECT g.id, p.label, g.can_write, g.expires_at, g.revoked_at FROM grants g JOIN principals p ON p.id = g.principal_id
     WHERE g.project_id = ? ORDER BY g.created_at`,
  ).bind(projectId).all<any>();
  return {
    grants: r.results.map((g) => ({
      id: g.id, label: g.label, can_write: !!g.can_write,
      expires_at: new Date(g.expires_at).toISOString(), revoked: g.revoked_at !== null,
    })),
  };
}

export async function updateGrant(ctx: Ctx, projectId: string, grantId: string, input: any) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, true);
  let res;
  if (input.revoke === true) {
    res = await db(ctx).prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(nowMs(), grantId, projectId).run();
  } else if (typeof input.can_write === "boolean") {
    res = await db(ctx).prepare("UPDATE grants SET can_write = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(input.can_write ? 1 : 0, grantId, projectId).run();
  } else throw new HttpError(400, "invalid_input", "Specify revoke:true or can_write");
  if (!res.meta.changes) throw new HttpError(404, "not_found", "Active grant not found");
  await audit(ctx, projectId, input.revoke ? "grant.revoke" : "grant.update", grantId, null, "ok").run();
  return { ok: true };
}

// ---------- artifacts ----------
async function loadArtifact(ctx: Ctx, projectId: string, artifactId: string, opts: { allowTrashed?: boolean } = {}) {
  const a = await db(ctx).prepare(`SELECT ${ART_COLS} FROM artifacts a WHERE a.id = ? AND a.project_id = ?`).bind(artifactId, projectId).first<any>();
  if (!a || (a.head_rev === 0 && a.kind === "binary" && !opts.allowTrashed)) throw new HttpError(404, "not_found", "Artifact not found");
  if (a.trashed_at && !opts.allowTrashed) throw new HttpError(404, "not_found", "Artifact not found");
  return a;
}

const artifactView = (a: any, appConnect = true) => ({
  id: a.id, project_id: a.project_id, kind: a.kind, title: a.title, folder: a.folder, tags: JSON.parse(a.tags),
  revision: a.head_rev, meta_version: a.meta_version, trashed: !!a.trashed_at, updated_at: a.updated_at,
  // App Connect fields appear only with the flag on, so flag-off responses keep their exact Phase 1 shape (§0).
  ...(appConnect ? {
    folder_id: a.folder_id ?? null, schema: a.schema_id ?? null,
    publisher: a.publisher_id ? { id: a.publisher_id, display_name: a.pub_name ?? null, protected: true } : null,
  } : {}),
});
const ART_COLS = "a.*, (SELECT display_name FROM publishers WHERE id = a.publisher_id) AS pub_name";

export async function listArtifacts(ctx: Ctx, projectId: string, q: { query?: string; cursor?: string; trashed?: boolean; kind?: string; folderId?: string }) {
  await authorizeProject(ctx, projectId, false);
  const offset = q.cursor ? int(Number(q.cursor), "cursor", 0, 100000) : 0;
  const term = q.query ? str(q.query, "query", 200) : "";
  const like = "%" + term.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const kind = q.kind ?? "";
  if (kind && !["markdown", "json", "csv", "binary"].includes(kind)) throw new HttpError(400, "invalid_input", "kind must be markdown, json, csv or binary");
  const folder = q.folderId ?? "";
  if (folder && folder !== "root" && !/^fld_[A-Za-z0-9_-]{1,40}$/.test(folder)) throw new HttpError(400, "invalid_input", "folder_id must be a folder id or root");
  const r = await db(ctx).prepare(
    `SELECT ${ART_COLS} FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id
     WHERE a.project_id = ? AND a.head_rev > 0 AND (a.trashed_at IS NOT NULL) = ?
       AND (? = '' OR a.title LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\')
       AND (? = '' OR a.kind = ?)
       AND (? = '' OR (? = 'root' AND a.folder_id IS NULL) OR a.folder_id = ?)
     ORDER BY a.updated_at DESC, a.id LIMIT ? OFFSET ?`,
  ).bind(projectId, q.trashed ? 1 : 0, term, like, like, kind, kind, folder, folder, folder, LIMITS.pageSize + 1, offset).all<any>();
  const rows = r.results.slice(0, LIMITS.pageSize);
  return {
    artifacts: rows.map((a: any) => artifactView(a, appConnectEnabled(ctx.env))),
    next_cursor: r.results.length > LIMITS.pageSize ? String(offset + LIMITS.pageSize) : null,
  };
}

export async function getArtifact(ctx: Ctx, projectId: string, artifactId: string, revNo?: number) {
  await authorizeProject(ctx, projectId, false);
  const a = await loadArtifact(ctx, projectId, artifactId);
  const rev = await db(ctx).prepare("SELECT * FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?")
    .bind(artifactId, projectId, revNo ?? a.head_rev).first<any>();
  if (!rev) throw new HttpError(404, "not_found", "Revision not found");
  return {
    artifact: artifactView(a, appConnectEnabled(ctx.env)),
    revision: { rev: rev.rev_no, id: rev.id, size: rev.size, sha256: rev.sha256, mime: rev.mime, created_at: rev.created_at, author_id: rev.author_id },
    ...(a.kind === "markdown" ? { body: rev.body }
      : a.kind === "json" || a.kind === "csv" ? { content: rev.body, content_url: `/api/projects/${projectId}/artifacts/${artifactId}/content?rev=${rev.rev_no}` }
      : { content_url: `/api/projects/${projectId}/artifacts/${artifactId}/content?rev=${rev.rev_no}` }),
  };
}

export async function history(ctx: Ctx, projectId: string, artifactId: string) {
  await authorizeProject(ctx, projectId, false);
  await loadArtifact(ctx, projectId, artifactId);
  const r = await db(ctx).prepare(
    "SELECT rev_no AS rev, id, size, sha256, mime, author_id, restored_from, created_at FROM revisions WHERE artifact_id = ? AND project_id = ? ORDER BY rev_no DESC LIMIT 200",
  ).bind(artifactId, projectId).all();
  return { revisions: r.results };
}

function mdBody(v: unknown): string {
  const body = str(v, "body", LIMITS.markdownBytes);
  if (new TextEncoder().encode(body).length > LIMITS.markdownBytes) throw new HttpError(413, "too_large", "Markdown exceeds 1 MiB");
  return body;
}

/** Create a file of kind markdown (default), json or csv (json/csv require App Connect). */
export async function createFile(ctx: Ctx, projectId: string, input: any, key: string) {
  const kind = input.kind === undefined || input.kind === null ? "markdown" : input.kind;
  if (kind === "markdown") {
    if (input.schema !== undefined && input.schema !== null) throw new HttpError(400, "invalid_input", "schema is only allowed for json or csv files");
    if (input.folder_id !== undefined && input.folder_id !== null) requireAppConnect(ctx);
    return createMarkdown(ctx, projectId, { ...input, body: input.body ?? input.content ?? "" }, key);
  }
  if (kind !== "json" && kind !== "csv") throw new HttpError(422, "unsupported_kind", "kind must be markdown, json or csv");
  requireAppConnect(ctx);
  return createMarkdown(ctx, projectId, input, key, kind);
}

async function folderCheck(ctx: Ctx, projectId: string, folderId: unknown): Promise<string | null> {
  if (folderId === undefined || folderId === null) return null;
  const id = str(folderId, "folder_id", 64);
  const f = await db(ctx).prepare("SELECT id FROM folders WHERE id = ? AND project_id = ?").bind(id, projectId).first();
  if (!f) throw new HttpError(404, "not_found", "Folder not found");
  return id;
}

export async function createMarkdown(ctx: Ctx, projectId: string, input: any, key: string, kind: "markdown" | "json" | "csv" = "markdown") {
  await authorizeProject(ctx, projectId, true);
  const title = str(input.title, "title", 200, { min: 1 });
  let body: string, schema: string | null = null, mime = "text/markdown";
  if (kind === "markdown") body = mdBody(input.body ?? "");
  else {
    const c = checkFile(kind, input.content, input.schema);
    body = input.content; schema = c.schema; mime = MIME[kind];
  }
  const folder = str(input.folder, "folder", 200, { optional: true });
  const folderId = await folderCheck(ctx, projectId, input.folder_id);
  const digestParts = kind === "markdown" && folderId === null ? ["md", title, body, folder] : [kind, title, body, folder, folderId, schema];
  const i: Idem = { op: "artifact.create", key, projectId, digest: await sha256Hex(JSON.stringify(digestParts)) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  // App exports have their own per-publisher quota and don't use up the project's artifact quota.
  const count = await db(ctx).prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NULL").bind(projectId).first<number>("n");
  if ((count ?? 0) >= LIMITS.artifactsPerProject) throw new HttpError(413, "quota_exceeded", "Artifact limit reached");

  const artId = randomId("art");
  const revId = randomId("rev");
  const sha = await sha256Hex(body);
  const az = authzSql(ctx, projectId);
  const now = nowIso();
  const result = { status: 201, body: kind === "markdown" && folderId === null
    ? { artifact_id: artId, revision: 1, revision_id: revId, sha256: sha }
    : { artifact_id: artId, kind, folder_id: folderId, schema, revision: 1, revision_id: revId, sha256: sha } };
  const out = await runBatch(ctx, [
    // Idempotency row first: a duplicate concurrent retry fails here and rolls back the whole batch.
    idemInsert(ctx, i, 201, result.body, az.sql, az.params),
    db(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, head_rev, head_revision_id, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${az.sql}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))`)
      .bind(artId, projectId, kind, title, folder, folderId, schema, revId, now, now, ...az.params, folderId, folderId, projectId),
    db(ctx).prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at)
      SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ?)`)
      .bind(revId, artId, projectId, ctx.principal.id, body, new TextEncoder().encode(body).length, sha, mime, now, artId),
    audit(ctx, projectId, "artifact.create", artId, 1, "ok", "EXISTS (SELECT 1 FROM artifacts WHERE id = ?)", [artId]),
  ], i);
  if (!Array.isArray(out)) return out;
  if (!out[1].meta.changes) throw new HttpError(403, "forbidden", "Grant no longer valid");
  return result;
}

/**
 * Revision-guarded publication. The revision INSERT is conditional on the expected head (and on
 * current authorization); UNIQUE(artifact_id, rev_no) independently guarantees a single winner.
 * Every dependent write (head move, idempotency result, success audit) is gated on the new
 * revision row existing, so a stale writer commits nothing.
 */
async function publishRevision(
  ctx: Ctx, projectId: string, artifactId: string, expected: number, i: Idem,
  rev: { body?: string; blobKey?: string; size: number; sha256: string; mime: string; restoredFrom?: number; revId?: string },
  extra: Stmt[] = [], action = "artifact.save",
) {
  const revId = rev.revId ?? randomId("rev");
  const next = expected + 1;
  const azBase = authzSql(ctx, projectId);
  const cw = contentWriteSql(ctx, artifactId);
  const az = { sql: `${azBase.sql} AND ${cw.sql}`, params: [...azBase.params, ...cw.params] };
  const now = nowIso();
  const gate = "EXISTS (SELECT 1 FROM revisions WHERE id = ?)";
  const body = { artifact_id: artifactId, revision: next, revision_id: revId, sha256: rev.sha256 };
  const out = await runBatch(ctx, [
    db(ctx).prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND project_id = ? AND head_rev = ? AND trashed_at IS NULL) AND ${az.sql}`)
      .bind(revId, artifactId, projectId, next, ctx.principal.id, rev.body ?? null, rev.blobKey ?? null, rev.size, rev.sha256, rev.mime,
        rev.restoredFrom ?? null, now, artifactId, projectId, expected, ...az.params),
    db(ctx).prepare(`UPDATE artifacts SET head_rev = ?, head_revision_id = ?, updated_at = ? WHERE id = ? AND project_id = ? AND head_rev = ? AND ${gate}`)
      .bind(next, revId, now, artifactId, projectId, expected, revId),
    idemInsert(ctx, i, 200, body, gate, [revId]),
    audit(ctx, projectId, action, artifactId, next, "ok", gate, [revId]),
    ...extra.map((s) => s), // callers gate their own extra statements on the same predicate
  ], i);
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) {
    const cur = await db(ctx).prepare("SELECT head_rev, trashed_at FROM artifacts WHERE id = ? AND project_id = ?").bind(artifactId, projectId).first<any>();
    await audit(ctx, projectId, action, artifactId, expected, "conflict").run();
    if (cur?.trashed_at) throw new HttpError(409, "trashed", "Artifact is in trash");
    if (cur && cur.head_rev !== expected)
      throw new HttpError(409, "revision_conflict", "Expected revision is stale", { current_revision: cur.head_rev, expected_revision: expected });
    const pub = await db(ctx).prepare("SELECT publisher_id FROM artifacts WHERE id = ?").bind(artifactId).first<string>("publisher_id");
    if (pub && !ctx.publisher) throw new HttpError(403, "protected_source", "This file is a source export owned by a connected app and cannot be modified here");
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 200, body };
}

export async function saveMarkdown(ctx: Ctx, projectId: string, artifactId: string, input: any, key: string) {
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_revision, "expected_revision", 1);
  const body = mdBody(input.body);
  const i: Idem = { op: "artifact.save:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, body])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const a = await loadArtifact(ctx, projectId, artifactId);
  if (a.kind !== "markdown") throw new HttpError(400, "invalid_input", "Not a Markdown artifact");
  assertWritable(ctx, a, "content");
  return publishRevision(ctx, projectId, artifactId, expected, i,
    { body, size: new TextEncoder().encode(body).length, sha256: await sha256Hex(body), mime: "text/markdown" });
}

/** Save a new revision of a markdown, json or csv file (content validated for its kind/schema). */
export async function saveFile(ctx: Ctx, projectId: string, artifactId: string, input: any, key: string) {
  if (!appConnectEnabled(ctx.env)) return saveMarkdown(ctx, projectId, artifactId, input, key);
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_revision, "expected_revision", 1);
  const text = input.body ?? input.content;
  // Idempotency first (same digest as saveMarkdown), so a retry after a later trash still replays (Phase 1 semantics).
  if (typeof text === "string") {
    const prior = await idemLookup(ctx, { op: "artifact.save:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, text])) });
    if (prior) return prior;
  }
  const a = await loadArtifact(ctx, projectId, artifactId);
  assertWritable(ctx, a, "content");
  if (a.kind === "markdown") return saveMarkdown(ctx, projectId, artifactId, { expected_revision: input.expected_revision, body: text }, key);
  if (a.kind !== "json" && a.kind !== "csv") throw new HttpError(422, "unsupported_kind", "Binary files are replaced through uploads");
  const c = checkFile(a.kind, input.content, a.schema_id);
  const body: string = input.content;
  const i: Idem = { op: "artifact.save:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, body])) };
  const r = await publishRevision(ctx, projectId, artifactId, expected, i,
    { body, size: new TextEncoder().encode(body).length, sha256: await sha256Hex(body), mime: MIME[a.kind] });
  return r.body?.idempotent_replay ? r : { status: r.status, body: { ...r.body, kind: a.kind, folder_id: a.folder_id ?? null, schema: c.schema } };
}

export async function restoreRevision(ctx: Ctx, projectId: string, artifactId: string, input: any, key: string) {
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_revision, "expected_revision", 1);
  const from = int(input.from_revision, "from_revision", 1);
  const i: Idem = { op: "artifact.restore:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([expected, from])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  assertWritable(ctx, await loadArtifact(ctx, projectId, artifactId), "content");
  const old = await db(ctx).prepare("SELECT * FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?").bind(artifactId, projectId, from).first<any>();
  if (!old) throw new HttpError(404, "not_found", "Revision not found");
  return publishRevision(ctx, projectId, artifactId, expected, i,
    { body: old.body ?? undefined, blobKey: old.blob_key ?? undefined, size: old.size, sha256: old.sha256, mime: old.mime, restoredFrom: from },
    [], "artifact.restore_revision");
}

/** Metadata changes (rename/move/tags/trash/restore) guarded by meta_version. Never touches revisions. */
export async function updateMetadata(ctx: Ctx, projectId: string, artifactId: string, input: any, key: string) {
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_meta_version, "expected_meta_version", 1);
  const i: Idem = { op: "artifact.meta:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify(input)) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const a = await loadArtifact(ctx, projectId, artifactId, { allowTrashed: true });
  assertWritable(ctx, a, "meta");
  const title = input.title !== undefined ? str(input.title, "title", 200, { min: 1 }) : a.title;
  const folder = input.folder !== undefined ? str(input.folder, "folder", 200) : a.folder;
  let tags = a.tags;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) throw new HttpError(400, "invalid_input", "tags must be an array (max 20)");
    tags = JSON.stringify(input.tags.map((t: unknown) => str(t, "tag", 40, { min: 1 })));
  }
  let trashed = a.trashed_at;
  if (input.trashed === true) trashed = trashed ?? nowIso();
  if (input.trashed === false) trashed = null;
  const az0 = authzSql(ctx, projectId), pr = protectSql(ctx, artifactId);
  const az = { sql: `${az0.sql} AND ${pr.sql}`, params: [...az0.params, ...pr.params] };
  const next = expected + 1;
  // Gate dependents on *this request's* update having landed (request IDs are unique per request).
  const gate = "EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND meta_version = ? AND meta_request_id = ?)";
  const gp = [artifactId, next, ctx.requestId];
  const body = { artifact_id: artifactId, meta_version: next, title, folder, tags: JSON.parse(tags), trashed: !!trashed };
  const out = await runBatch(ctx, [
    db(ctx).prepare(`UPDATE artifacts SET title = ?, folder = ?, tags = ?, trashed_at = ?, meta_version = ?, meta_request_id = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND meta_version = ? AND ${az.sql}`)
      .bind(title, folder, tags, trashed, next, ctx.requestId, nowIso(), artifactId, projectId, expected, ...az.params),
    idemInsert(ctx, i, 200, body, gate, gp),
    audit(ctx, projectId, input.trashed === true ? "artifact.trash" : input.trashed === false ? "artifact.untrash" : "artifact.meta",
      artifactId, null, "ok", gate, gp),
  ], i);
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) {
    const cur = await db(ctx).prepare("SELECT meta_version FROM artifacts WHERE id = ? AND project_id = ?").bind(artifactId, projectId).first<number>("meta_version");
    if (cur === expected) throw new HttpError(403, "forbidden", "Grant no longer valid");
    throw new HttpError(409, "metadata_conflict", "Expected metadata version is stale", { current_meta_version: cur });
  }
  return { status: 200, body };
}

// ---------- folders (App Connect Phase 2) ----------
export function folderName(v: unknown): { name: string; key: string } {
  const raw = str(v, "name", 200, { min: 1 }).trim();
  if (raw.length < 1 || raw.length > 80) throw new HttpError(400, "invalid_input", "Folder name must be 1-80 characters");
  if (/[\/\u0000-\u001f\u007f]/.test(raw)) throw new HttpError(400, "invalid_input", "Folder name cannot contain / or control characters");
  return { name: raw, key: raw.toLowerCase() };
}

export async function listFolders(ctx: Ctx, projectId: string) {
  requireAppConnect(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await db(ctx).prepare("SELECT id, name, publisher_id, created_at FROM folders WHERE project_id = ? ORDER BY name_key LIMIT 500").bind(projectId).all();
  return { folders: r.results };
}

export async function createFolder(ctx: Ctx, projectId: string, input: any, key: string) {
  requireAppConnect(ctx);
  await authorizeProject(ctx, projectId, true);
  if (ctx.publisher) throw new HttpError(403, "forbidden", "Publishers cannot create folders");
  const { name, key: nameKey } = folderName(input?.name);
  const i: Idem = { op: "folder.create", key, projectId, digest: await sha256Hex(JSON.stringify([nameKey])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const existing = await db(ctx).prepare("SELECT id FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, nameKey).first<string>("id");
  if (existing) throw new HttpError(409, "folder_exists", "A folder with this name already exists", { folder_id: existing });
  const id = randomId("fld");
  const az = authzSql(ctx, projectId);
  const body = { id, name };
  const gate = "EXISTS (SELECT 1 FROM folders WHERE id = ?)";
  let out;
  try {
    out = await runBatch(ctx, [
      db(ctx).prepare(`INSERT INTO folders (id, project_id, name, name_key, created_at, created_by) SELECT ?, ?, ?, ?, ?, ? WHERE ${az.sql}`)
        .bind(id, projectId, name, nameKey, nowIso(), ctx.principal.id, ...az.params),
      idemInsert(ctx, i, 201, body, gate, [id]),
      audit(ctx, projectId, "folder.create", id, null, "ok", gate, [id]),
    ], i);
  } catch (e) {
    if (e instanceof HttpError && e.code === "conflict") {
      const ex = await db(ctx).prepare("SELECT id FROM folders WHERE project_id = ? AND name_key = ?").bind(projectId, nameKey).first<string>("id");
      if (ex) throw new HttpError(409, "folder_exists", "A folder with this name already exists", { folder_id: ex });
    }
    throw e;
  }
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) throw new HttpError(403, "forbidden", "Grant no longer valid");
  return { status: 201, body };
}

// ---------- records query (agentlib.measurements/1, authoritative JSON only) ----------
export async function readRecords(ctx: Ctx, projectId: string, artifactId: string, q: { from?: string | null; to?: string | null; metric?: string | null; limit?: string | number | null; cursor?: string | null }) {
  requireAppConnect(ctx);
  await authorizeProject(ctx, projectId, false);
  const a = await loadArtifact(ctx, projectId, artifactId);
  if (a.kind !== "json" || a.schema_id !== MEASUREMENTS)
    throw new HttpError(422, "schema_not_queryable", "Records can be queried only on JSON files with schema agentlib.measurements/1");
  const rev = await db(ctx).prepare("SELECT rev_no, body FROM revisions WHERE id = ?").bind(a.head_revision_id).first<any>();
  const from = q.from ?? null, to = q.to ?? null;
  if (from !== null && !isCalendarDate(from)) throw new HttpError(400, "invalid_input", "from must be a real calendar date YYYY-MM-DD");
  if (to !== null && !isCalendarDate(to)) throw new HttpError(400, "invalid_input", "to must be a real calendar date YYYY-MM-DD");
  if (from !== null && to !== null && from > to) throw new HttpError(400, "invalid_input", "from must not be after to");
  const metric = q.metric ?? null;
  const limit = q.limit === undefined || q.limit === null || q.limit === "" ? 100 : int(Number(q.limit), "limit", 1, 500);
  const offset = q.cursor ? int(Number(q.cursor), "cursor", 0, 10_000_000) : 0;
  const all: any[] = JSON.parse(rev.body).records;
  let undated = 0;
  const ranged = from !== null || to !== null;
  const hits: any[] = [];
  for (const r of all) {
    if (metric !== null && r.metric !== metric) continue;
    if (ranged) {
      if (typeof r.date !== "string") { undated++; continue; }
      if (from !== null && r.date < from) continue;
      if (to !== null && r.date > to) continue;
    }
    hits.push(r);
  }
  const page = hits.slice(offset, offset + limit);
  return { schema: MEASUREMENTS, file_id: artifactId, revision: rev.rev_no, records: page, undated_excluded: undated,
    next_cursor: offset + limit < hits.length ? String(offset + limit) : null };
}

// ---------- comments ----------
export async function addComment(ctx: Ctx, projectId: string, artifactId: string, input: any, key: string) {
  await authorizeProject(ctx, projectId, true);
  const rev = int(input.revision, "revision", 1);
  const text = str(input.body, "body", LIMITS.commentChars, { min: 1 });
  const i: Idem = { op: "comment.add:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify([rev, text])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  assertWritable(ctx, await loadArtifact(ctx, projectId, artifactId), "meta");
  const id = randomId("cmt");
  const az0 = authzSql(ctx, projectId), pr = protectSql(ctx, artifactId);
  const az = { sql: `${az0.sql} AND ${pr.sql}`, params: [...az0.params, ...pr.params] };
  const gate = "EXISTS (SELECT 1 FROM comments WHERE id = ?)";
  const body = { comment_id: id, revision: rev };
  const out = await runBatch(ctx, [
    db(ctx).prepare(`INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?) AND ${az.sql}`)
      .bind(id, projectId, artifactId, rev, ctx.principal.id, text, nowIso(), artifactId, projectId, rev, ...az.params),
    idemInsert(ctx, i, 201, body, gate, [id]),
    audit(ctx, projectId, "comment.add", artifactId, rev, "ok", gate, [id]),
  ], i);
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) throw new HttpError(404, "not_found", "Revision not found");
  return { status: 201, body };
}

export async function listComments(ctx: Ctx, projectId: string, artifactId: string) {
  await authorizeProject(ctx, projectId, false);
  await loadArtifact(ctx, projectId, artifactId);
  const r = await db(ctx).prepare(
    `SELECT c.id, c.rev_no AS revision, c.body, c.created_at, p.label AS author FROM comments c JOIN principals p ON p.id = c.author_id
     WHERE c.artifact_id = ? AND c.project_id = ? ORDER BY c.created_at LIMIT 200`,
  ).bind(artifactId, projectId).all();
  return { comments: r.results };
}

export async function listAudit(ctx: Ctx, projectId: string) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  const r = await db(ctx).prepare(
    "SELECT seq, at, actor_id, action, object_id, rev_no, result, request_id FROM audits WHERE project_id = ? ORDER BY seq DESC LIMIT 200",
  ).bind(projectId).all();
  return { audits: r.results };
}

export { audit, idemLookup, runBatch, publishRevision, loadArtifact, artifactView, type Idem };
