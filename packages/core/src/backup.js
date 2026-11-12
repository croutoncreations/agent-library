import { TEXT_MAX_BYTES } from "./text-limits.js";
import { personalWorkspaceId } from "./tenancy.js";
import { blobRef, commitTextWrites, deleteBlob, putBlob, getText, readBlobBytes, mapContent, stageTextWrites, textKey, textWriteComplete } from "./content-store.js";
import { textSearchBridge } from "./search/service.js";
import { limitsFor, requireHuman } from "./auth.js";
import { BINARY_TYPES, LIMITS, tplDate } from "./service.js";
import { requireProjectRole, requireWorkspaceRole, workspaceRoleSql } from "./tenancy.js";
import { HttpError, int, nowIso, randomId, sha256Hex, str } from "./util.js";
import { explainLimit, fmtBytes, limitGuard, workspaceLimits } from "./limits.js";


var SCHEMA = "agent-library-backup/1";
/** Largest total of distinct file bytes a project export holds (exports above it refuse with 413 backup_too_large). */
var BACKUP_EXPORT_FILE_BYTES = 16 * 1024 * 1024;
var BACKUP_EXPORT_TEXT_BYTES = 32 * 1024 * 1024;
var b64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return btoa(s);
};
var unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function exportBackup(ctx, projectId) {
  requireHuman(ctx);
  let metaVersionsExport = [];
  const DB = ctx.env.DB;
  // Exporting a whole project is an admin action in its workspace.
  await requireProjectRole(ctx, projectId, "admin", true); // export works while suspended (read-only)
  const p = await DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  const pubFiles = await DB.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NOT NULL").bind(projectId).first("n").catch(() => 0);
  if (pubFiles) throw new HttpError(409, "backup_unsupported", "This project contains app exports; backup of App Connect projects is not supported yet");
  // The backup is one JSON response with every file inline (base64), built in Worker memory (128 MB), so it is capped
  // before any file is read. Streamed backups are a follow-up.
  const fileBytes = await DB.prepare("SELECT COALESCE(SUM(size),0) AS n FROM (SELECT DISTINCT blob_key, size FROM revisions WHERE project_id = ? AND blob_key IS NOT NULL)").bind(projectId).first("n");
  if (fileBytes > BACKUP_EXPORT_FILE_BYTES) throw new HttpError(413, "backup_too_large", "This project's files are too large for a single backup file (over 16 MB). Download large files individually.");
  const textBytes = await DB.prepare("SELECT COALESCE(SUM(size),0) AS n FROM revisions WHERE project_id = ? AND blob_key IS NULL").bind(projectId).first("n");
  if (textBytes > BACKUP_EXPORT_TEXT_BYTES) throw new HttpError(413, "backup_too_large", "This project's text versions exceed 32 MiB for a single backup. Download documents individually or export a smaller project.");
  const [arts, revs, comments] = await DB.batch([
    DB.prepare("SELECT id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date FROM artifacts WHERE project_id = ? AND head_rev > 0").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, body_key, blob_key, blob_key_id, blob_header, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note FROM revisions WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, body_key, created_at FROM comments WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description FROM meta_versions WHERE project_id = ?").bind(projectId)
  ]).then(([a, r, c, mv]) => (metaVersionsExport = mv.results, [a, r, c]));
  const blobs = {};
  for (const r of revs.results) {
    if (!r.blob_key || blobs[r.blob_key]) continue;
    const bytes = await readBlobBytes(ctx.env, await blobRef(ctx.env, r, { projectId, artifactId: r.artifact_id }));
    const sha2 = await sha256Hex(bytes);
    if (sha2 !== r.sha256) throw new HttpError(500, "blob_corrupt", "Stored blob hash mismatch");
    blobs[r.blob_key] = { sha256: sha2, data: b64(bytes) };
  }
  await DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.export', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, projectId, projectId, ctx.requestId).run();
  return {
    schema: arts.results.some(a => a.is_template || a.source_artifact_id) ? "agent-library-backup/2" : SCHEMA,
    features: ["document_templates/1"],
    exported_at: nowIso(),
    project: { id: p.id, title: p.title, created_at: p.created_at },
    artifacts: arts.results,
    // The format is unchanged: blobs are plaintext, and the encryption columns stay in this database.
    revisions: await mapContent(revs.results, async ({ body_key, blob_key_id, blob_header, ...r }) => ({ ...r, body: r.blob_key ? null : await getText(ctx.env, { ...r, body_key }) })),
    comments: await mapContent(comments.results, async ({ body_key, ...c }) => ({ ...c, body: await getText(ctx.env, { ...c, body_key }) })),
    meta_versions: metaVersionsExport,
    blobs
  };
}
// Checks a backup's shape, ids and every hash; returns its project id and decoded blobs (nothing is written).
async function validateBackup(backup) {
  if (backup?.schema !== SCHEMA && backup?.schema !== "agent-library-backup/2") throw new HttpError(400, "bad_backup", "Unsupported backup schema");
  for (const k of ["artifacts", "revisions", "comments"]) if (!Array.isArray(backup[k])) throw new HttpError(400, "bad_backup", `${k} must be a list`);
  if (backup.meta_versions !== void 0 && !Array.isArray(backup.meta_versions)) throw new HttpError(400, "bad_backup", "meta_versions must be a list");
  const pid = String(backup.project?.id ?? "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(pid)) throw new HttpError(400, "bad_backup", "Bad project id");
  for (const a of backup.artifacts ?? []) {
    if (a.is_template != null && a.is_template !== 0 && a.is_template !== 1) throw new HttpError(400, "bad_backup", "Invalid template identity");
    if (a.is_template && (a.kind !== "markdown" || a.publisher_id)) throw new HttpError(400, "bad_backup", "Invalid template kind");
    str(a.template_description ?? "", "template_description", 280);
    if (a.source_artifact_id != null) {
      str(a.source_artifact_id, "source_artifact_id", 64, { min: 1 });
      int(a.source_revision, "source_revision", 1);
      if (!["document", "template"].includes(a.source_role)) throw new HttpError(400, "bad_backup", "Invalid source role");
    }
    if (a.template_date != null) tplDate(a.template_date, true);
  }
  for (const v of Array.isArray(backup.meta_versions) ? backup.meta_versions : []) str(v.template_description ?? "", "template_description", 280);
  const blobs = backup.blobs ?? {};
  const decoded = /* @__PURE__ */ new Map();
  for (const r of backup.revisions) {
    if (r.blob_key === null) {
      if (typeof r.body !== "string" || new TextEncoder().encode(r.body).length > TEXT_MAX_BYTES) throw new HttpError(400, "bad_backup", "Text revision exceeds 10 MiB or is not a string");
      if (await sha256Hex(r.body) !== r.sha256) throw new HttpError(400, "bad_backup", `Revision ${r.id} hash mismatch`);
      continue;
    }
    if (!new RegExp(`^blobs/${pid}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$`).test(r.blob_key)) throw new HttpError(400, "bad_backup", "Bad blob key");
    const b = blobs[r.blob_key];
    if (!b) throw new HttpError(400, "bad_backup", "Missing blob");
    const bytes = decoded.get(r.blob_key) ?? unb64(b.data);
    if (await sha256Hex(bytes) !== r.sha256 || bytes.length !== r.size) throw new HttpError(400, "bad_backup", `Blob for ${r.id} hash/size mismatch`);
    decoded.set(r.blob_key, bytes);
  }
  return { pid, decoded };
}
async function restoreBackup(ctx, backup) {
  requireHuman(ctx);
  const DB = ctx.env.DB;
  // Restore is for moving a whole single-owner store: it needs an installation with no projects at all. On a shared
  // (hosted) installation that is never true, so restore is unavailable there by construction.
  // Shared installations (MULTI_USER=1, or several people) refuse restore outright: a restored project id is global
  // and would squat on, or reveal, another workspace's id (decision D8 B: use workspace import instead).
  if (ctx.env.MULTI_USER === "1") throw new HttpError(403, "restore_unavailable", "Restore is only available on a single-owner installation");
  if (await DB.prepare("SELECT COUNT(*) AS n FROM principals WHERE kind = 'human'").first("n") > 1) throw new HttpError(403, "restore_unavailable", "Restore is only available on a single-owner installation");
  const existing = await DB.prepare("SELECT COUNT(*) AS n FROM projects").first("n");
  if (existing) throw new HttpError(409, "store_not_empty", "Restore targets an empty isolated store only");
  const { pid, decoded } = await validateBackup(backup);
  // IDs stay stable, but each attempt owns fresh immutable objects, even after a lost acknowledgement.
  const attempt = randomId("restore");
  // Validate every resulting key, including the attempt segment, before writing any bytes or intents.
  for (const r of backup.revisions) if (r.blob_key === null) textKey(pid, r.artifact_id, r.id, attempt);
  for (const c of backup.comments) textKey(pid, c.artifact_id, c.id, attempt);
  for (const [k, bytes] of decoded) await putBlob(ctx.env, k, bytes);
  const authors = new Set([...backup.revisions, ...backup.comments, ...backup.meta_versions ?? []].map((x) => x.author_id));
  const stmts = [];
  for (const a of authors) if (a !== ctx.principal.id)
    stmts.push(DB.prepare("INSERT OR IGNORE INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'restored', ?, ?, ?)").bind(a, a, "restored " + a, nowIso()));
  stmts.push(DB.prepare("INSERT INTO projects (id, owner_id, title, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)").bind(pid, ctx.principal.id, backup.project.title, backup.project.created_at, personalWorkspaceId(ctx.principal.id)));
  for (const a of backup.artifacts)
    stmts.push(DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(a.id, pid, a.kind, a.title, a.folder, a.tags, a.head_rev, a.head_revision_id, a.meta_version, a.trashed_at, a.created_at, a.updated_at, a.is_template ?? 0, a.template_description ?? "", a.source_artifact_id ?? null, a.source_revision ?? null, a.source_role ?? null, a.template_date ?? null));
  const textKeys = [], textWrites = [];
  const bridges = [];
  for (const r of backup.revisions) {
    const bodyKey = r.blob_key ? null : textKey(pid, r.artifact_id, r.id, attempt);
    if (bodyKey) textWrites.push({ projectId: pid, artifactId: r.artifact_id, revisionId: r.id, text: r.body, attempt });
    if (bodyKey) { textKeys.push(bodyKey); bridges.push(textSearchBridge(ctx.env, r.artifact_id, r.id, r.body), textWriteComplete(ctx.env, bodyKey)); }
    stmts.push(DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.id, r.artifact_id, pid, r.rev_no, r.author_id, bodyKey, r.blob_key, r.size, r.sha256, r.mime, r.restored_from, r.created_at, r.via_kind ?? null, r.via_id ?? null, r.via_label ?? null, r.client_info ?? null, r.change_note ?? null));
  }
  for (const v of backup.meta_versions ?? [])
    stmts.push(DB.prepare(`INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(v.id, v.artifact_id, pid, v.version, v.title, v.folder, v.tags, v.trashed ? 1 : 0, v.author_id, v.via_kind ?? null, v.via_id ?? null, v.via_label ?? null, v.client_info ?? null, v.change_note ?? null, v.restored_from ?? null, v.created_at, v.template_description ?? ""));
  for (const c of backup.comments) {
    const bodyKey = textKey(pid, c.artifact_id, c.id, attempt);
    textWrites.push({ projectId: pid, artifactId: c.artifact_id, revisionId: c.id, text: c.body, attempt });
    textKeys.push(bodyKey); bridges.push(textWriteComplete(ctx.env, bodyKey));
    stmts.push(DB.prepare("INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, body_key, created_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)").bind(c.id, pid, c.artifact_id, c.rev_no, c.author_id, bodyKey, c.created_at));
  }
  stmts.push(DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.restore', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, pid, pid, ctx.requestId));
  await stageTextWrites(ctx.env, textWrites);
  try {
    await commitTextWrites(ctx.env, textKeys, (guarded) => DB.batch(guarded([...stmts, ...bridges])));
  } catch (error) {
    if (await DB.prepare("SELECT COUNT(*) AS n FROM projects").first("n")) throw new HttpError(409, "store_not_empty", "Restore targets an empty isolated store only");
    throw error;
  }
  return { restored_project: pid, artifacts: backup.artifacts.length, revisions: backup.revisions.length, blobs: decoded.size, grants: 0 };
}

// Import a backup into a workspace as a NEW project (D8 B): every id is new (project, documents, versions,
// comments, file keys), so nothing can collide with or reveal another workspace's ids. Authors inside the backup are
// not trusted as principals: every version and comment is attributed to the importing person, and the original
// labels stay in the provenance fields. Admin of an active workspace; works on single-owner installs too.
// Field checks import adds on top of validateBackup, so every row is valid before anything is written (no orphaned
// file bytes from a batch that fails on a constraint) and the project stays within normal per-project limits.
const IMPORT_KINDS = new Set(["markdown", "html", "json", "csv", "binary"]);
// The via_kind values the code writes (history/service.js viaFields); null for versions from before 0010.
const VIA_KINDS = new Set(["browser", "oauth", "api_key", "grant", "publisher"]);
// One import is one D1 batch: at most this many documents and files, versions, comments or details versions each
// (documents and files are also capped by the plan's items_per_project).
var IMPORT_MAX_ROWS = 2000;
function checkImportRows(env, backup, decoded, limits) {
  const bad = (m) => { throw new HttpError(400, "bad_backup", m); };
  if (backup.artifacts.length > limits.items_per_project) bad(`A project holds at most ${limits.items_per_project} documents and files on this plan`);
  if (backup.artifacts.length > IMPORT_MAX_ROWS) bad(`One import can bring in at most ${IMPORT_MAX_ROWS.toLocaleString("en-US")} documents and files`);
  if (backup.revisions.length > IMPORT_MAX_ROWS || backup.comments.length > IMPORT_MAX_ROWS || (backup.meta_versions ?? []).length > IMPORT_MAX_ROWS) bad("Too many versions or comments to import at once");
  const ids = new Set(), revKeys = new Set(), revIds = new Set();
  for (const a of backup.artifacts) {
    if (typeof a.id !== "string" || ids.has(a.id)) bad("Duplicate or missing document id");
    ids.add(a.id);
    if (!IMPORT_KINDS.has(a.kind)) bad("Unsupported document kind");
    str(a.title, "title", 200, { min: 1 }); str(a.folder ?? "", "folder", 200);
    let tags; try { tags = JSON.parse(a.tags ?? "[]"); } catch { bad("tags must be a JSON list"); }
    if (!Array.isArray(tags) || tags.some((x) => typeof x !== "string" || x.length > 50) || tags.length > 20) bad("tags must be a list of short strings");
    if (!Number.isInteger(a.head_rev) || a.head_rev < 1 || !Number.isInteger(a.meta_version) || a.meta_version < 1) bad("Bad document revision numbers");
    if (typeof a.created_at !== "string" || typeof a.updated_at !== "string") bad("Bad document timestamps");
  }
  let binBytes = 0;
  for (const r of backup.revisions) {
    if (typeof r.id !== "string" || revIds.has(r.id)) bad("Duplicate or missing version id");
    revIds.add(r.id);
    const k = r.artifact_id + ":" + r.rev_no;
    if (!Number.isInteger(r.rev_no) || r.rev_no < 1 || revKeys.has(k)) bad("Duplicate or bad version number");
    revKeys.add(k);
    if (r.via_kind != null && !VIA_KINDS.has(r.via_kind)) bad("Bad version provenance");
    str(r.via_label ?? "", "via_label", 200); str(r.change_note ?? "", "change_note", 280); str(r.client_info ?? "", "client_info", 500);
    if (typeof r.created_at !== "string" || typeof r.mime !== "string" || /[\u0000-\u001f\u007f]/.test(r.mime) || r.mime.length > 100) bad("Bad version fields");
    if (!Number.isInteger(r.size) || r.size < 0) bad("Bad version size");
    if (r.blob_key === null && r.size !== new TextEncoder().encode(r.body).length) bad("A version's size doesn't match its text");
    if (r.blob_key !== null) {
      const art = backup.artifacts.find((a) => a.id === r.artifact_id);
      if (!art || art.kind !== "binary") bad("A file version belongs to a document that isn't a file");
      const sniff = Object.hasOwn(BINARY_TYPES, r.mime) ? BINARY_TYPES[r.mime] : null;
      if (!sniff && r.mime !== "application/octet-stream") bad("Unsupported file type");
      if (sniff && !sniff(decoded.get(r.blob_key))) bad("A file's contents don't match its type");
      if (limits?.file_bytes !== undefined && r.size > limits.file_bytes) bad(`A file is larger than this plan allows (${fmtBytes(limits.file_bytes)})`);
      binBytes += r.size;
    }
  }
  const cap = limitsFor(env).projectBinaryBytes; // "0" = no per-project file cap
  if (cap > 0 && binBytes > cap) bad("Files exceed the per-project storage limit");
  for (const a of backup.artifacts) {
    const head = backup.revisions.find((r) => r.id === a.head_revision_id);
    if (!head || head.artifact_id !== a.id || head.rev_no !== a.head_rev) bad("A document's current version is missing or inconsistent");
    if (a.trashed_at != null && typeof a.trashed_at !== "string") bad("Bad trash timestamp");
  }
  for (const c of backup.comments) {
    if (typeof c.body !== "string" || c.body.length > LIMITS.commentChars || !Number.isInteger(c.rev_no) || typeof c.created_at !== "string") bad("Bad comment");
  }
  for (const v of backup.meta_versions ?? []) {
    if (!Number.isInteger(v.version) || v.version < 1 || typeof v.created_at !== "string") bad("Bad details version");
    str(v.title ?? "", "title", 200); str(v.folder ?? "", "folder", 200);
    if (v.via_kind != null && !VIA_KINDS.has(v.via_kind)) bad("Bad details provenance");
  }
}

async function importBackup(ctx, workspaceId, input, idemKeyValue, digest = "") {
  requireHuman(ctx);
  const backup = input?.backup ?? input;
  await requireWorkspaceRole(ctx, workspaceId, "admin");
  // Retried import (same Idempotency-Key): return the project created the first time instead of a duplicate.
  const replay = async () => {
    const prior = await ctx.env.DB.prepare("SELECT digest, response FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = 'backup.import' AND key = ?").bind(ctx.principal.id, workspaceId, idemKeyValue).first();
    if (!prior) return null;
    if (prior.digest !== digest) throw new HttpError(422, "idempotency_key_reused", "Idempotency key was used with a different request");
    return { ...JSON.parse(prior.response), idempotent_replay: true };
  };
  if (idemKeyValue) { const prior = await replay(); if (prior) return prior; }
  const { pid: oldPid, decoded } = await validateBackup(backup);
  checkImportRows(ctx.env, backup, decoded, await workspaceLimits(ctx.env, workspaceId));
  const DB = ctx.env.DB, me = ctx.principal.id, at = nowIso();
  const title = input?.title !== void 0 ? str(input.title, "title", 200, { min: 1 }) : str(String(backup.project?.title ?? "Imported project"), "title", 200, { min: 1 });
  const pid = randomId("prj");
  const artId = new Map(backup.artifacts.map((a) => [a.id, randomId("art")]));
  const revId = new Map(backup.revisions.map((r) => [r.id, randomId("rev")]));
  for (const r of backup.revisions) if (!artId.has(r.artifact_id)) throw new HttpError(400, "bad_backup", "Revision for an unknown document");
  for (const c of backup.comments) if (!artId.has(c.artifact_id)) throw new HttpError(400, "bad_backup", "Comment on an unknown document");
  for (const v of backup.meta_versions ?? []) if (!artId.has(v.artifact_id)) throw new HttpError(400, "bad_backup", "Details version for an unknown document");
  // File keys move under the new project and document ids: blobs/<old project>/<old document>/<name>.
  const newKey = (k) => {
    const m = /^blobs\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(k);
    if (!m || m[1] !== oldPid || !artId.has(m[2])) throw new HttpError(400, "bad_backup", "Bad blob key");
    return `blobs/${pid}/${artId.get(m[2])}/${m[3]}`;
  };
  const keyMap = new Map([...decoded.keys()].map((k) => [k, newKey(k)]));
  // Every check is done; re-check the role right before writing bytes (also checked inside the project INSERT).
  if (!await DB.prepare(`SELECT ${workspaceRoleSql("?", "admin")} AS ok`).bind(me, workspaceId).first("ok")) throw new HttpError(403, "forbidden", "Needs the admin role in an active workspace");
  // Workspace limits (Phase 4): one more project, and every version's bytes, checked in the project INSERT (the rest
  // of the batch depends on that row). Checked first too, so nothing is uploaded for a refused import.
  const addBytes = backup.revisions.reduce((n, r) => n + r.size, 0);
  const lg = await limitGuard(ctx.env, workspaceId, { projects: 1, storage_bytes: addBytes });
  if (lg.sql !== "1" && !await DB.prepare(`SELECT ${lg.sql} AS ok`).bind(...lg.params).first("ok")) {
    await explainLimit(ctx.env, workspaceId, { projects: 1, storage_bytes: addBytes }, lg.limits);
  }
  const stmts = [
    // Gated in-statement: the importer must still be an admin of the active workspace, within its limits.
    DB.prepare(`INSERT INTO projects (id, owner_id, title, created_at, workspace_id) SELECT ?, COALESCE((SELECT created_by FROM workspaces WHERE id = ?), ?), ?, ?, ? WHERE ${workspaceRoleSql("?", "admin")} AND ${lg.sql}`)
      .bind(pid, workspaceId, me, title, at, workspaceId, me, workspaceId, ...lg.params)
  ];
  for (const a of backup.artifacts) {
    const src = a.source_artifact_id != null && artId.has(a.source_artifact_id);
    stmts.push(DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(artId.get(a.id), pid, a.kind, a.title, a.folder ?? "", a.tags ?? "[]", a.head_rev, revId.get(a.head_revision_id) ?? null, a.meta_version, a.trashed_at ?? null, a.created_at, a.updated_at, a.is_template ?? 0, a.template_description ?? "", src ? artId.get(a.source_artifact_id) : null, src ? a.source_revision : null, src ? a.source_role : null, a.template_date ?? null));
  }
  const textKeys = [], textWrites = [];
  const bridges = [];
  for (const r of backup.revisions) {
    const aid = artId.get(r.artifact_id), rid = revId.get(r.id);
    const bodyKey = r.blob_key ? null : textKey(pid, aid, rid);
    if (bodyKey) textWrites.push({ projectId: pid, artifactId: aid, revisionId: rid, text: r.body });
    if (bodyKey) { textKeys.push(bodyKey); bridges.push(textSearchBridge(ctx.env, aid, rid, r.body), textWriteComplete(ctx.env, bodyKey)); }
    stmts.push(DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(rid, aid, pid, r.rev_no, me, bodyKey, r.blob_key === null ? null : keyMap.get(r.blob_key), r.size, r.sha256, r.mime, r.restored_from ?? null, r.created_at, r.via_kind ?? null, null, r.via_label ? `${r.via_label} (imported)` : "imported", r.client_info ?? null, r.change_note ?? null));
  }
  for (const v of backup.meta_versions ?? [])
    stmts.push(DB.prepare(`INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(randomId("mv"), artId.get(v.artifact_id), pid, v.version, v.title ?? "", v.folder ?? "", v.tags ?? "[]", v.trashed ? 1 : 0, me, v.via_kind ?? null, null, v.via_label ?? null, v.client_info ?? null, v.change_note ?? null, v.restored_from ?? null, v.created_at, v.template_description ?? ""));
  for (const c of backup.comments) {
    const aid = artId.get(c.artifact_id), cid = randomId("cmt"), bodyKey = textKey(pid, aid, cid);
    textWrites.push({ projectId: pid, artifactId: aid, revisionId: cid, text: c.body });
    textKeys.push(bodyKey); bridges.push(textWriteComplete(ctx.env, bodyKey));
    stmts.push(DB.prepare("INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, body_key, created_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)").bind(cid, pid, aid, c.rev_no, me, bodyKey, c.created_at));
  }
  const result = { project_id: pid, workspace_id: workspaceId, title, artifacts: backup.artifacts.length, revisions: backup.revisions.length, comments: backup.comments.length, blobs: decoded.size };
  const exists = "EXISTS (SELECT 1 FROM projects WHERE id = ?)";
  stmts.push(DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id) SELECT ?, ?, ?, 'backup.import', ?, 'ok', ?, ? WHERE ${exists}`).bind(at, me, pid, pid, ctx.requestId, workspaceId, pid));
  if (idemKeyValue) stmts.push(DB.prepare(`INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at) SELECT ?, ?, 'backup.import', ?, ?, 201, ?, ? WHERE ${exists}`)
    .bind(me, workspaceId, idemKeyValue, digest, JSON.stringify(result), at, pid));
  // Statements are fully built (any bind error happens above, before bytes exist). Now write the bytes.
  await stageTextWrites(ctx.env, textWrites);
  const written = [];
  const dropBlobs = async () => { for (const k of written) await deleteBlob(ctx.env, k).catch(() => {}); };
  try { for (const [k, bytes] of decoded) { await putBlob(ctx.env, keyMap.get(k), bytes); written.push(keyMap.get(k)); } }
  catch (e) { await dropBlobs(); throw e; }
  let res;
  try { res = await commitTextWrites(ctx.env, textKeys, (guarded) => DB.batch(guarded([...stmts, ...bridges]))); }
  catch (e) {
    await dropBlobs();
    // The admin check lost a race (no project row): the dependent rows fail their foreign key and nothing is written.
    if (/FOREIGN KEY/i.test(String(e?.message ?? e))) {
      await explainLimit(ctx.env, workspaceId, { projects: 1, storage_bytes: addBytes }, lg.limits);
      throw new HttpError(403, "forbidden", "Needs the admin role in an active workspace");
    }
    if (/UNIQUE|PRIMARY KEY/i.test(String(e?.message ?? e)) && idemKeyValue) { const prior = await replay(); if (prior) return prior; }
    throw e;
  }
  // Empty backup and a lost race: no dependent row failed, but no project was created either.
  if (!res[0].meta.changes) {
    await dropBlobs();
    await explainLimit(ctx.env, workspaceId, { projects: 1, storage_bytes: addBytes }, lg.limits);
    throw new HttpError(403, "forbidden", "Needs the admin role in an active workspace");
  }
  return result;
}

export { IMPORT_MAX_ROWS, checkImportRows, exportBackup, importBackup, restoreBackup };

