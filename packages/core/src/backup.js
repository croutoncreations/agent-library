import { TEXT_MAX_BYTES } from "./text-limits.js";
import { personalWorkspaceId } from "./tenancy.js";
import { blobKeyFits, blobPrefix, blobRef, commitTextWrites, deleteBlobs, dropUnreferencedBlobs, fenceRefusal, getText, isTextWriteFenceError, keyFence, mapContent, plaintextFence, readBlobBytes, stageTextWrites, storedText, textKey, textWriteComplete, writeBlobBytes } from "./content-store.js";
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
// Pre-write checks shared by import and restore: every value that binds into a statement after the first object
// is written must be bindable, and every row must name a document of the backup. Restore gains only these (and the
// key-length check), and they accept exactly what today's restore could store (design Addendum 2: restore must refuse
// nothing it accepted before):
//  - bindable is what D1's bind accepts: null, a string, any number (a JSON 1e999 is Infinity, which D1 binds as
//    NULL), a boolean, or a list of byte values (bound as a BLOB); anything else (an object, a list of other values)
//    made today's restore fail when its statement was built, before the batch. undefined passes here because the
//    statements that bind a field raw fail on it as they did before, and the others bind `?? null`.
//  - each check is on the value as it WILL be used: meta_versions.trashed is bound as `trashed ? 1 : 0` and a
//    comment's body is only ever encoded to text (TextEncoder makes any value its string form), so restore checks
//    neither.
//  - document references match as the database's foreign keys match them: docKey maps a value to its stored form
//    (storedDocumentIds), so a number and a string match exactly when the database would store them the same.
// strict (import only) adds import's own rules: finite numbers and no byte lists, restored_from an integer, trashed
// and comment bodies scalars, and references by plain equality (import requires string ids).
// What D1's bind accepts as a BLOB: a list of numbers each >= 0 and < 256 (workerd's D1 shim; probed: [65.1] binds
// as 0x41, [255.9] as 0xFF, [-0] as 0x00; [-1], [256], [NaN], [Infinity], ["1"], [null], [true], [[1]] throw).
// The stored bytes are Uint8Array.from(list) (fractions truncated), so byte lists compare by those bytes.
const isByteList = (v) => Array.isArray(v) && v.every((b) => typeof b === "number" && b >= 0 && b < 256);
const scalar = (v) => v === null || v === void 0 || typeof v === "string" || typeof v === "boolean" || typeof v === "number";
function checkBindable(backup, { strict = false, docKey = (v) => v } = {}) {
  const bad = (m) => { throw new HttpError(400, "bad_backup", m); };
  const bindable = (v) => strict ? scalar(v) && (typeof v !== "number" || Number.isFinite(v)) : scalar(v) || isByteList(v);
  const fields = (row, names, what) => { for (const n of names) if (!bindable(row?.[n])) bad(`Invalid ${what} field ${n}`); };
  const intOrNull = (v, what) => {
    if (!bindable(v)) bad(`Invalid ${what} field restored_from`);
    if (strict && v != null && !Number.isSafeInteger(v)) bad(`Invalid ${what} restored_from`);
  };
  if (typeof backup.project !== "object" || backup.project === null) bad("Missing project");
  fields(backup.project, ["title", "created_at"], "project");
  const ids = new Set();
  for (const a of backup.artifacts) {
    fields(a, ["id", "kind", "title", "folder", "tags", "head_rev", "head_revision_id", "meta_version", "trashed_at", "created_at", "updated_at"], "document");
    ids.add(docKey(a.id));
  }
  for (const r of backup.revisions) {
    fields(r, ["id", "artifact_id", "rev_no", "author_id", "size", "sha256", "mime", "created_at", "via_kind", "via_id", "via_label", "client_info", "change_note"], "version");
    intOrNull(r.restored_from, "version");
    if (!ids.has(docKey(r.artifact_id))) bad("Revision for an unknown document");
  }
  for (const v of backup.meta_versions ?? []) {
    fields(v, ["id", "artifact_id", "version", "title", "folder", "tags", ...strict ? ["trashed"] : [], "author_id", "via_kind", "via_id", "via_label", "client_info", "change_note", "created_at", "template_description"], "details version");
    intOrNull(v.restored_from, "details version");
    if (!ids.has(docKey(v.artifact_id))) bad("Details version for an unknown document");
  }
  for (const c of backup.comments) {
    fields(c, ["id", "artifact_id", "rev_no", "author_id", ...strict ? ["body"] : [], "created_at"], "comment");
    if (!ids.has(docKey(c.artifact_id))) bad("Comment on an unknown document");
  }
}
/**
 * Restore: the form each document id and reference will be stored in. artifacts.id and every artifact_id are TEXT
 * columns, so the database keeps a string as it is and turns a number or boolean into its own text form (D1 binds
 * every JS number as REAL, so 7 is stored "7.0" and never equals "7"); a byte list stays a BLOB, equal only to the
 * same bytes; a string is stored with each lone surrogate as U+FFFD (storedText, shared with blobPrefix). The foreign
 * keys compare those stored forms. The database is asked for the numbers and booleans, in batches of at most 100
 * statements and only when there are any; each distinct value comes from a row restore's own batch inserts, so the
 * lookup issues at most one statement per such row. Returns Map(value -> stored text, or a tagged key for a BLOB).
 */
async function storedDocumentIds(DB, backup) {
  const values = new Set([...backup.artifacts.map((a) => a?.id), ...[...backup.revisions, ...backup.meta_versions ?? [], ...backup.comments].map((x) => x?.artifact_id)]);
  const stored = new Map();
  const ask = [];
  for (const v of values) {
    if (typeof v === "string") stored.set(v, storedText(v));
    else if (isByteList(v)) stored.set(v, "\u0000blob:" + Uint8Array.from(v).join(","));
    else if (v != null && scalar(v)) ask.push(v);
  }
  for (let i = 0; i < ask.length; i += 100) {
    const chunk = ask.slice(i, i + 100);
    const res = await DB.batch(chunk.map((v) => DB.prepare("SELECT CAST(? AS TEXT) AS t").bind(v)));
    chunk.forEach((v, j) => stored.set(v, res[j].results[0]?.t ?? null));
  }
  return stored;
}
/** Every storage key an attempt will write must fit the encrypted format's object-key limit (checked before any put). */
function checkKeysFit(keys) {
  for (const k of keys) if (!blobKeyFits(k)) throw new HttpError(400, "bad_backup", "A file key is too long");
}
const CONSTRAINT = /FOREIGN KEY|UNIQUE|PRIMARY KEY|NOT NULL constraint|CHECK constraint/;
/**
 * Write a backup's file objects, then publish them in ONE batch with the fences last (docs/encryption.md), and clean
 * up by phase and source of a failure, never by a later exception's text:
 *  - failure before the batch is sent (an object write, a statement build, a fence): delete every object written;
 *  - the batch call itself rejected with a fence refusal, the text deadline or a constraint error (D1 rolled it
 *    back), or the caller reports it resolved without publishing: delete only the written keys no revision refers to;
 *  - anything else may have committed (a lost acknowledgement): delete nothing, log backup_cleanup_skipped.
 * objects: [[key, bytes, contentType]] with explicit workspaceId; build(descriptors) returns the statements (the revision
 * INSERTs bind descriptors.get(key).keyId/header). Returns { res } or { error, batchError, cleanup(published) }.
 */
async function publishBackup(env, { objects, workspaceId, textKeys, build }) {
  const written = [], descriptors = new Map();
  let sent = false, batchError = null;
  const log = (reason, count) => console.error(JSON.stringify({ event: "backup_cleanup_skipped", count, reason }));
  // Outcome 2: settled as not published. dropUnreferencedBlobs never throws (it logs and deletes nothing on failure).
  const dropSettled = () => dropUnreferencedBlobs(env, written);
  try {
    for (const [key, bytes, contentType] of objects) {
      descriptors.set(key, await writeBlobBytes(env, { key, bytes, contentType, workspaceId }));
      written.push(key);
    }
    const pairs = new Set(), fences = [];
    let plain = false;
    for (const d of descriptors.values()) {
      if (d.keyId === null) plain = true;
      else if (!pairs.has(d.keyId)) { pairs.add(d.keyId); fences.push(keyFence(env, { keyId: d.keyId, workspaceId })); }
    }
    if (plain) fences.push(plaintextFence(env));
    const all = [...build(descriptors), ...fences];
    const res = await commitTextWrites(env, textKeys, (guarded) => {
      // Addendum: build the guarded statements, THEN mark the batch as sent, then send it.
      const guardedStmts = guarded(all);
      sent = true;
      return env.DB.batch(guardedStmts).catch((e) => { batchError = e; throw e; });
    });
    return { res, settledNotPublished: dropSettled };
  } catch (error) {
    if (!sent) {
      // Only file objects are deleted here. Text staged before this call (stageTextWrites) stays with its
      // content_writes intents: unreferenced, it is reclaimed by the content-writes sweep (cleanup.js
      // sweepContentWrites) once older than TEXT_WRITE_STALE_MS. Pinned by test/encrypted-backup.test.mjs.
      try { await deleteBlobs(env, written); } catch { log("delete_failed", written.length); }
    } else if (batchError && (fenceRefusal(batchError) || isTextWriteFenceError(batchError) || CONSTRAINT.test(String(batchError?.message ?? batchError)))) {
      await dropSettled();
    } else if (written.length) {
      log("outcome_unknown", written.length);
    }
    return { error, batchError };
  }
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
  const storedIds = await storedDocumentIds(DB, backup);
  checkBindable(backup, { docKey: (v) => storedIds.has(v) ? storedIds.get(v) : v });
  // IDs stay stable, but each attempt owns fresh immutable objects, even after a lost acknowledgement: text keys carry
  // the attempt segment, file keys end in _<attempt> (not stripped: stripping could make x and x_restore_… collide).
  const attempt = randomId("restore");
  // Each file object is written under the revision's OWN document (blobs/<project>/<document>/…), which every read
  // checks before decrypting (blobPrefix: the document id as stored, URI-encoded). Export never pairs a revision with
  // another document's key, but restore accepted such a hand-made pair before (its plaintext read did not check the
  // prefix), and accepted any document id, so it must keep restoring both: when the key's document segment is the
  // revision's stored document id (always a [A-Za-z0-9_-] segment, which encoding leaves unchanged) the key keeps
  // today's name (`<key>_<attempt>`); otherwise the object is copied to a fresh name under the revision's own
  // document's prefix, once per (source key, document).
  const targets = new Map();
  const restoreKey = (r) => {
    // The id as the document's row will hold it (a byte list's segment is its text form; it never matches a key).
    const doc = typeof storedIds.get(r.artifact_id) === "string" && !storedIds.get(r.artifact_id).startsWith("\u0000") ? storedIds.get(r.artifact_id) : String(r.artifact_id);
    const pair = doc + "\n" + r.blob_key;
    if (!targets.has(pair)) targets.set(pair, r.blob_key.startsWith(blobPrefix(pid, doc)) ? `${r.blob_key}_${attempt}` : `${blobPrefix(pid, doc)}${randomId("rx")}_${attempt}`);
    return targets.get(pair);
  };
  const fileRevisions = backup.revisions.filter((r) => r.blob_key);
  for (const r of fileRevisions) restoreKey(r);
  // Validate every resulting key, including the attempt segment, before writing any bytes or intents.
  for (const r of backup.revisions) if (r.blob_key === null) textKey(pid, r.artifact_id, r.id, attempt);
  for (const c of backup.comments) textKey(pid, c.artifact_id, c.id, attempt);
  checkKeysFit(new Set(targets.values()));
  // The restored project is the principal's personal workspace's, so its files go under that workspace's key.
  const workspaceId = personalWorkspaceId(ctx.principal.id);
  const authors = new Set([...backup.revisions, ...backup.comments, ...backup.meta_versions ?? []].map((x) => x.author_id));
  const head = [];
  for (const a of authors) if (a !== ctx.principal.id)
    head.push(DB.prepare("INSERT OR IGNORE INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'restored', ?, ?, ?)").bind(a, a, "restored " + a, nowIso()));
  head.push(DB.prepare("INSERT INTO projects (id, owner_id, title, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)").bind(pid, ctx.principal.id, backup.project.title, backup.project.created_at, workspaceId));
  for (const a of backup.artifacts)
    head.push(DB.prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(a.id, pid, a.kind, a.title, a.folder, a.tags, a.head_rev, a.head_revision_id, a.meta_version, a.trashed_at, a.created_at, a.updated_at, a.is_template ?? 0, a.template_description ?? "", a.source_artifact_id ?? null, a.source_revision ?? null, a.source_role ?? null, a.template_date ?? null));
  // Split revision loop, part 1: text keys, text writes and bridges before stageTextWrites. Only the revision INSERTs
  // wait for the file writes (they bind each object's key id and header).
  const textKeys = [], textWrites = [], bridges = [], bodyKeys = new Map();
  for (const r of backup.revisions) {
    if (r.blob_key) continue;
    const bodyKey = textKey(pid, r.artifact_id, r.id, attempt);
    bodyKeys.set(r.id, bodyKey);
    textWrites.push({ projectId: pid, artifactId: r.artifact_id, revisionId: r.id, text: r.body, attempt });
    textKeys.push(bodyKey); bridges.push(textSearchBridge(ctx.env, r.artifact_id, r.id, r.body), textWriteComplete(ctx.env, bodyKey));
  }
  const tail = [];
  for (const v of backup.meta_versions ?? [])
    tail.push(DB.prepare(`INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(v.id, v.artifact_id, pid, v.version, v.title, v.folder, v.tags, v.trashed ? 1 : 0, v.author_id, v.via_kind ?? null, v.via_id ?? null, v.via_label ?? null, v.client_info ?? null, v.change_note ?? null, v.restored_from ?? null, v.created_at, v.template_description ?? ""));
  for (const c of backup.comments) {
    const bodyKey = textKey(pid, c.artifact_id, c.id, attempt);
    textWrites.push({ projectId: pid, artifactId: c.artifact_id, revisionId: c.id, text: c.body, attempt });
    textKeys.push(bodyKey); bridges.push(textWriteComplete(ctx.env, bodyKey));
    tail.push(DB.prepare("INSERT INTO comments (id, project_id, artifact_id, rev_no, author_id, body, body_key, created_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)").bind(c.id, pid, c.artifact_id, c.rev_no, c.author_id, bodyKey, c.created_at));
  }
  tail.push(DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.restore', ?, 'ok', ?)").bind(nowIso(), ctx.principal.id, pid, pid, ctx.requestId));
  await stageTextWrites(ctx.env, textWrites);
  const objects = new Map();
  for (const r of fileRevisions) if (!objects.has(restoreKey(r))) objects.set(restoreKey(r), [restoreKey(r), decoded.get(r.blob_key), r.mime]);
  const out = await publishBackup(ctx.env, {
    objects: [...objects.values()], workspaceId, textKeys,
    // Split revision loop, part 2: the revision INSERTs, binding each object's descriptor (never the backup's fields).
    build: (descriptors) => [...head, ...backup.revisions.map((r) => {
      const d = r.blob_key ? descriptors.get(restoreKey(r)) : null;
      return DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, blob_key_id, blob_header, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.id, r.artifact_id, pid, r.rev_no, r.author_id, bodyKeys.get(r.id) ?? null, r.blob_key ? restoreKey(r) : null, d?.keyId ?? null, d?.header ?? null, r.size, r.sha256, r.mime, r.restored_from ?? null, r.created_at, r.via_kind ?? null, r.via_id ?? null, r.via_label ?? null, r.client_info ?? null, r.change_note ?? null);
    }), ...tail, ...bridges],
  });
  if (out.error) {
    // A lost race, or a commit whose acknowledgement was lost: either way the store now holds a project. In the second
    // case the restore may in fact have succeeded (docs/self-hosting.md: reload before retrying).
    if (await DB.prepare("SELECT COUNT(*) AS n FROM projects").first("n")) throw new HttpError(409, "store_not_empty", "Restore targets an empty isolated store only");
    throw out.error;
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
    // Import's content rules for details versions, as for versions and documents (restore keeps only checkBindable).
    str(v.via_label ?? "", "via_label", 200); str(v.client_info ?? "", "client_info", 500); str(v.change_note ?? "", "change_note", 280);
    let vtags; try { vtags = JSON.parse(v.tags ?? "[]"); } catch { bad("tags must be a JSON list"); }
    if (!Array.isArray(vtags) || vtags.some((x) => typeof x !== "string" || x.length > 50) || vtags.length > 20) bad("tags must be a list of short strings");
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
  checkBindable(backup, { strict: true });
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
  // A file version's key must lie in its own document (reads check that prefix before decrypting). Export never
  // produces another pairing; a hand-made backup that does is refused before anything is written.
  for (const r of backup.revisions) if (r.blob_key !== null && !keyMap.get(r.blob_key).startsWith(blobPrefix(pid, artId.get(r.artifact_id))))
    throw new HttpError(400, "bad_backup", "A file key does not match its document");
  checkKeysFit(keyMap.values());
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
  // Split revision loop, part 1: text keys, text writes and bridges are computed before stageTextWrites (moving the
  // whole loop after the file writes would leave text intents unstaged). Only the revision INSERTs are built later.
  const textKeys = [], textWrites = [];
  const bridges = [], bodyKeys = new Map();
  for (const r of backup.revisions) {
    if (r.blob_key) continue;
    const aid = artId.get(r.artifact_id), rid = revId.get(r.id);
    const bodyKey = textKey(pid, aid, rid);
    bodyKeys.set(r.id, bodyKey);
    textWrites.push({ projectId: pid, artifactId: aid, revisionId: rid, text: r.body });
    textKeys.push(bodyKey); bridges.push(textSearchBridge(ctx.env, aid, rid, r.body), textWriteComplete(ctx.env, bodyKey));
  }
  const revisionStmt = (r, d) => DB.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, blob_key_id, blob_header, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(revId.get(r.id), artId.get(r.artifact_id), pid, r.rev_no, me, bodyKeys.get(r.id) ?? null, r.blob_key === null ? null : keyMap.get(r.blob_key), d?.keyId ?? null, d?.header ?? null, r.size, r.sha256, r.mime, r.restored_from ?? null, r.created_at, r.via_kind ?? null, null, r.via_label ? `${r.via_label} (imported)` : "imported", r.client_info ?? null, r.change_note ?? null);
  const head = stmts.splice(0);
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
  await stageTextWrites(ctx.env, textWrites);
  // The file bytes go under the authorized target workspace's key (never anything named in the backup).
  const mimeOf = new Map(backup.revisions.filter((r) => r.blob_key).map((r) => [r.blob_key, r.mime]));
  const out = await publishBackup(ctx.env, {
    objects: [...decoded].map(([k, bytes]) => [keyMap.get(k), bytes, mimeOf.get(k)]), workspaceId, textKeys,
    // res[0] stays the project INSERT: head[0] is it, and the fences go last.
    build: (descriptors) => [...head, ...backup.revisions.map((r) => revisionStmt(r, r.blob_key === null ? null : descriptors.get(keyMap.get(r.blob_key)))), ...stmts, ...bridges],
  });
  if (out.error) {
    const m = String(out.batchError?.message ?? out.batchError ?? "");
    // The admin check lost a race (no project row): the dependent rows fail their foreign key and nothing is written.
    if (/FOREIGN KEY/i.test(m)) {
      await explainLimit(ctx.env, workspaceId, { projects: 1, storage_bytes: addBytes }, lg.limits);
      throw new HttpError(403, "forbidden", "Needs the admin role in an active workspace");
    }
    if (/UNIQUE|PRIMARY KEY/i.test(m) && idemKeyValue) { const prior = await replay(); if (prior) return prior; }
    throw out.error;
  }
  // Empty backup and a lost race: no dependent row failed, but no project was created either (settled: no revision
  // row can exist without the project, so nothing this attempt wrote is referenced).
  if (!out.res[0].meta.changes) {
    await out.settledNotPublished();
    await explainLimit(ctx.env, workspaceId, { projects: 1, storage_bytes: addBytes }, lg.limits);
    throw new HttpError(403, "forbidden", "Needs the admin role in an active workspace");
  }
  return result;
}

export { IMPORT_MAX_ROWS, checkImportRows, exportBackup, importBackup, restoreBackup };

