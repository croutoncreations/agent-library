// Review gating (docs/review-gating.md; migrations 0017_review_gating.sql and 0033_proposal_text_keys.sql).
// One shared implementation for every transport (OAuth MCP, legacy /mcp, /v1, browser API).
//  - A document's review_mode is off (default), advisory or required. On a required document, edits by agents (OAuth
//    connections, API keys, legacy agent tokens) become proposals; the approved line (artifacts.head_rev) only ever
//    holds approved, human-written or pre-review content. People and App Connect publishers are never gated.
//  - "Reviewed" is a review record bound to one exact version, details version or proposal, never a document flag.
//  - Who reviews: a person with write access to the project (member or above in its active workspace), or an agent
//    connection a workspace admin allowed to review (review_grants). Both are checked live in the same statement as
//    every review write. Self-review is refused for agents (same access path as the author). Admins set review modes
//    and the project default.
//  - The database refuses ungated agent versions of required documents too (triggers in 0017), so a rolled-back
//    Worker fails closed instead of bypassing review.
//  - Proposal text lives in R2 under text/<project>/<artifact>/<proposal id> (staged like version text); approving
//    points the new version's body_key at that object. Proposal files (binary) keep their upload's key.
import { commitTextWrites, deleteBlob, getText, getTextPrefix, readBlob, stageTextWrite, textKey, textWriteComplete } from "../content-store.js";
import { authorizeProject, authzSql, contentWriteSql, protectSql, requireHuman } from "../auth.js";
import { chKinds } from "../changes/service.js";
import { CONTENT_TYPE, checkFile } from "../formats.js";
import { lineDiff, metaBaselineInsert, provenance, whoLabel } from "../history/service.js";
import { explainLimit, projectLimitGuard } from "../limits.js";
import { rtReadAuthzSql } from "../reads/service.js";
import { headIndexInput, indexDocument, repairIfStale } from "../search/indexing.js";
import { audit, db, folderCheck, idemInsert, idemLookup, IMAGE_TYPES, loadArtifact, mdBody, runBatch, VIDEO_TYPES } from "../service.js";
import { tplDenyPublisher } from "../templates/service.js";
import { memberRoleSql, requireProjectRole } from "../tenancy.js";
import { CHANGE_NOTE_MAX, HttpError, int, nowIso, nowMs, randomId, sha256Hex, str } from "../util.js";
import { RV_REVIEWED_SQL } from "./sql.js";

const RV_MODES = ["off", "advisory", "required"];
const RV_KINDS = ["markdown", "html", "json", "csv", "binary"];
const RV_STATUSES = ["pending", "approved", "rejected", "superseded", "withdrawn"];
const RV_PLACEHOLDER = "Pending review";
// Open new-document proposals one author may have in a project (hidden documents do not count toward the limit).
const RV_MAX_NEW = 20;
const RV_PURGE_MS = 30 * 86400000;
const RV_PAGE = 50;
// read_proposal returns at most this many characters of a text proposal inline (the whole text is at content_path).
const RV_INLINE_CHARS = 262144;
// Largest text (bytes) a proposal or version is line-diffed at; above it the diff is summarised (history/service.js).
const RV_DIFF_BYTES = 1048576;
const RV_OPEN = "EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'approving')";
const RV_OPEN_STATUSES = "('pending','approving')";
// A proposal's stored bytes: text in R2 (body_key) or a file (blob_key).
const RV_KEY = "COALESCE(p.body_key, p.blob_key)";

function rvVia(ctx) {
  const p = provenance(ctx, null);
  return { kind: p[0], id: p[1], label: p[2], client: p[3] };
}
// Agents other than App Connect publishers are gated; people and publishers never are.
function rvGatedActor(ctx) { return ctx.principal.kind === "agent" && !ctx.publisher; }
function rvGated(ctx, a) { return rvGatedActor(ctx) && (a.review_mode === "required" || a.pending_review === 1); }
function rvSelf(ctx, row) {
  if (ctx.principal.kind === "human") return false;
  const v = rvVia(ctx);
  // Agents always carry a connection/key/token id; never treat two id-less agents as the same author.
  if (!v.id || !row.via_id) return false;
  return row.via_kind === v.kind && row.via_id === v.id;
}
// Self-review: the same connection, or (API keys) any key this key replaced, directly or through earlier replacements.
// Replacing a key keeps its review permission, so the old key's proposals still count as the caller's own work.
// Two keys are the same author when their replacement chains meet (old ↔ new, and sibling replacements of one key).
const RV_KEY_LINEAGE = `WITH RECURSIVE a(id) AS (SELECT ? UNION SELECT k.replaces_id FROM api_credentials k JOIN a ON k.id = a.id WHERE k.replaces_id IS NOT NULL),
  b(id) AS (SELECT ? UNION SELECT k.replaces_id FROM api_credentials k JOIN b ON k.id = b.id WHERE k.replaces_id IS NOT NULL)`;
async function rvSelfReview(ctx, row) {
  if (rvSelf(ctx, row)) return true;
  if (ctx.principal.kind === "human" || row.via_kind !== "api_key") return false;
  const v = rvVia(ctx);
  if (v.kind !== "api_key" || !v.id || !row.via_id) return false;
  return !!(await db(ctx).prepare(`${RV_KEY_LINEAGE} SELECT 1 AS x FROM a JOIN b ON a.id = b.id LIMIT 1`).bind(v.id, row.via_id).first("x"));
}
// Live review permission for this caller and project, as an SQL predicate (also used inside every review batch).
// A person needs write access (member or above, active workspace); an agent needs read access plus a review grant.
function rvReviewSql(ctx, projectId) {
  if (ctx.principal.kind === "human") return authzSql(ctx, projectId);
  if (ctx.publisher || ctx.principal.kind !== "agent") return { sql: "0", params: [] };
  const v = rvVia(ctx), rd = rtReadAuthzSql(ctx, projectId);
  return { sql: `${rd.sql} AND EXISTS (SELECT 1 FROM review_grants WHERE path_kind = ? AND path_id = ? AND project_id = ?)`, params: [...rd.params, v.kind, v.id, projectId] };
}
// The person is an admin of the project's active workspace (review modes, project default, review permission).
function rvAdminSql(ctx, projectId) {
  return { sql: memberRoleSql("?", "admin"), params: [ctx.principal.id, projectId] };
}
async function rvCanReview(ctx, projectId) {
  ctx.rvCan ??= {};
  if (ctx.rvCan[projectId] !== undefined) return ctx.rvCan[projectId];
  const az = rvReviewSql(ctx, projectId);
  return (ctx.rvCan[projectId] = !!(await db(ctx).prepare(`SELECT 1 AS x WHERE ${az.sql}`).bind(...az.params).first("x")));
}
// Kinds this caller may see (OAuth: files only with file access; JSON/CSV only with App Connect on).
function rvKinds(ctx) { return ctx.principal.kind === "human" ? RV_KINDS : chKinds(ctx); }
// A hidden new document (pending_review = 1) exists only for its proposer until it is approved: once it has a
// proposal, or while its first file upload is still in progress.
async function rvOwnPending(ctx, a) {
  if (!rvGatedActor(ctx)) return false;
  const v = rvVia(ctx);
  return !!(await db(ctx).prepare(`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM proposals WHERE artifact_id = ? AND status = 'pending' AND via_kind = ? AND via_id IS ?)
    OR EXISTS (SELECT 1 FROM uploads WHERE artifact_id = ? AND principal_id = ? AND review_meta IS NOT NULL)`).bind(a.id, v.kind, v.id, a.id, ctx.principal.id).first("x"));
}
async function rvProjectDefault(ctx, projectId, kind) {
  const p = await db(ctx).prepare("SELECT review_default, kinds FROM project_review_settings WHERE project_id = ?").bind(projectId).first();
  if (!p || p.review_default === "off") return "off";
  const kinds = p.kinds ? JSON.parse(p.kinds) : null;
  return !kinds || kinds.includes(kind) ? p.review_default : "off";
}
async function rvNewGated(ctx, projectId, kind) {
  return rvGatedActor(ctx) && (await rvProjectDefault(ctx, projectId, kind)) === "required";
}
async function rvNewCap(ctx, projectId) {
  const v = rvVia(ctx);
  const n = await db(ctx).prepare("SELECT COUNT(*) AS n FROM proposals WHERE project_id = ? AND is_new = 1 AND status = 'pending' AND via_kind = ? AND via_id IS ?").bind(projectId, v.kind, v.id).first("n");
  if ((n ?? 0) >= RV_MAX_NEW) throw new HttpError(429, "too_many_pending", `At most ${RV_MAX_NEW} new documents can wait for review per connection; wait for reviews first`);
}
const rvResult = (p, status) => ({ status, body: { status: "pending_review", proposal_id: p.id, artifact_id: p.artifact_id, base_revision: p.base_rev, base_meta_version: p.base_meta_version, supersedes: p.supersedes_id ?? null } });
function rvTagsJson(tags) {
  if (tags === undefined || tags === null) return "[]";
  if (typeof tags === "string") return tags;
  return JSON.stringify(tags);
}
// Text a proposal brings into the store: staged to R2 under the proposal's own key. Returns the key to record
// (an already-stored key is kept as is) and the keys the batch's publication fence must cover.
async function rvStageText(ctx, projectId, artifactId, proposalId, content) {
  if (!content) return { bodyKey: null, staged: [] };
  if (typeof content.body === "string") {
    const key = await stageTextWrite(ctx.env, projectId, artifactId, proposalId, content.body);
    return { bodyKey: key, staged: [key] };
  }
  return { bodyKey: content.bodyKey ?? null, staged: [] };
}

// Create (or replace) the caller's proposal for an existing or pending new document.
// s: { content?: {body | bodyKey | blobKey, size, sha256, mime, restoredFrom}, meta?: {title, folder, tags}, expectedRev?, expectedMeta?,
//      note, status, fence?, uploadId?, extra?(id, body) => statements }
async function rvPropose(ctx, projectId, a, i, s) {
  const v = rvVia(ctx);
  const note = provenance(ctx, { change_note: s.note })[4];
  const isNew = a.pending_review === 1 ? 1 : 0;
  const prev = await db(ctx).prepare("SELECT * FROM proposals WHERE artifact_id = ? AND status = 'pending' AND via_kind = ? AND via_id IS ?").bind(a.id, v.kind, v.id).first();
  let content = s.content ?? null, meta = s.meta ?? null;
  if (isNew) {
    if (!prev) throw new HttpError(404, "not_found", "Artifact not found");
    // A new document needs both: keep the pending part this save doesn't replace.
    if (!content) content = { bodyKey: prev.body_key ?? void 0, body: prev.body_key ? void 0 : prev.body ?? void 0, blobKey: prev.blob_key ?? void 0, size: prev.size, sha256: prev.sha256, mime: prev.mime, restoredFrom: null };
    if (!meta) meta = { title: prev.title, folder: prev.folder, folderId: prev.folder_id, tags: prev.tags };
    // The shell holds placeholder details: fields the caller omitted keep the pending proposal's values.
    else if (s.metaInput) {
      const m = s.metaInput, sameFolder = m.folder === undefined;
      meta = { title: m.title !== undefined ? meta.title : prev.title, folder: sameFolder ? prev.folder : meta.folder,
        folderId: sameFolder ? prev.folder_id : meta.folderId, tags: m.tags !== undefined ? meta.tags : prev.tags };
    }
    if (s.content && s.expectedRev !== 0) throw new HttpError(409, "revision_conflict", "This document is waiting for review; save it with expected_revision 0", { current_revision: 0, expected_revision: s.expectedRev });
    if (s.meta && s.expectedMeta !== a.meta_version) throw new HttpError(409, "metadata_conflict", "Expected metadata version is stale", { current_meta_version: a.meta_version });
  } else {
    if (content && s.expectedRev !== a.head_rev)
      throw new HttpError(409, "revision_conflict", "Expected revision is stale", { current_revision: a.head_rev, expected_revision: s.expectedRev });
    if (meta && s.expectedMeta !== a.meta_version) throw new HttpError(409, "metadata_conflict", "Expected metadata version is stale", { current_meta_version: a.meta_version });
  }
  const id = randomId("prp");
  // New text bytes count toward workspace storage while the proposal is open (an upload's bytes were reserved at
  // begin and move over when the upload publishes). 
  const fresh = typeof content?.body === "string" && !s.fence;
  const lg = fresh ? await projectLimitGuard(ctx.env, projectId, { storage_bytes: content.size }) : { sql: "1", params: [], limits: {}, workspaceId: null };
  const { bodyKey, staged } = await rvStageText(ctx, projectId, a.id, id, content);
  const p = { id, artifact_id: a.id, base_rev: isNew ? 0 : a.head_rev, base_meta_version: a.meta_version, supersedes_id: prev?.id ?? null };
  const result = rvResult(p, s.status ?? 200);
  const azBase = authzSql(ctx, projectId), cw = content ? contentWriteSql(ctx, a.id) : protectSql(ctx, a.id);
  const az = { sql: `${azBase.sql} AND ${cw.sql} AND ${lg.sql}${s.fence ? " AND " + s.fence.sql : ""}`, params: [...azBase.params, ...cw.params, ...lg.params, ...s.fence?.params ?? []] };
  // Only the parts this proposal changes must still be at its base (a new document: both).
  const checkRev = !!(content && s.content) || !!isNew, checkMeta = !!(meta && s.meta) || !!isNew;
  const guard = { sql: `EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND project_id = ? AND trashed_at IS NULL AND (? = 0 OR head_rev = ?) AND (? = 0 OR meta_version = ?) AND pending_review = ?)`,
    params: [a.id, projectId, checkRev ? 1 : 0, a.head_rev, checkMeta ? 1 : 0, a.meta_version, isNew] };
  const now = nowIso();
  const created = "EXISTS (SELECT 1 FROM proposals WHERE id = ?)";
  const stmts = [];
  if (prev) stmts.push(db(ctx).prepare(`UPDATE proposals SET status = 'superseded', decided_at = ? WHERE id = ? AND status = 'pending' AND ${az.sql} AND ${guard.sql}`).bind(now, prev.id, ...az.params, ...guard.params));
  stmts.push(
    db(ctx).prepare(`INSERT INTO proposals (id, artifact_id, project_id, kind, status, is_new, supersedes_id, base_rev, base_meta_version,
        has_content, body, body_key, blob_key, size, sha256, mime, restored_from, has_meta, title, folder, folder_id, tags, meta_restored_from,
        author_id, via_kind, via_id, via_label, client_info, change_note, created_at, upload_id)
      SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ${Array(20).fill('?').join(', ')} WHERE ${az.sql} AND ${guard.sql}`).bind(
      id, a.id, projectId, a.kind, isNew, prev?.id ?? null, p.base_rev, p.base_meta_version,
      content ? 1 : 0, bodyKey, content?.blobKey ?? null, content ? content.size : null, content?.sha256 ?? null, content?.mime ?? null, content?.restoredFrom ?? null,
      meta ? 1 : 0, meta?.title ?? null, meta ? meta.folder ?? "" : null, meta?.folderId ?? null, meta ? rvTagsJson(meta.tags) : null, s.metaRestoredFrom ?? null,
      ctx.principal.id, v.kind, v.id ?? null, v.label, v.client, note, now, s.uploadId ?? (content?.blobKey && prev?.blob_key === content.blobKey ? prev.upload_id : null),
      ...az.params, ...guard.params),
    idemInsert(ctx, i, result.status, result.body, created, [id]),
    audit(ctx, projectId, "proposal.create", a.id, p.base_rev, "ok", created, [id]),
    ...s.extra ? s.extra(id, result.body) : [],
    ...staged.map((k) => textWriteComplete(ctx.env, k))
  );
  const out = await commitTextWrites(ctx.env, staged, (guarded) => runBatch(ctx, guarded(stmts), i));
  if (!Array.isArray(out)) return out;
  if (!out[prev ? 1 : 0].meta.changes) {
    const replay = await idemLookup(ctx, i);
    if (replay) return replay;
    const cur = await db(ctx).prepare("SELECT head_rev, meta_version, trashed_at FROM artifacts WHERE id = ? AND project_id = ?").bind(a.id, projectId).first();
    if (cur?.trashed_at) throw new HttpError(409, "trashed", "Artifact is in trash");
    if (cur && checkRev && cur.head_rev !== a.head_rev) throw new HttpError(409, "revision_conflict", "Expected revision is stale", { current_revision: cur.head_rev, expected_revision: s.expectedRev });
    if (cur && checkMeta && cur.meta_version !== a.meta_version) throw new HttpError(409, "metadata_conflict", "Expected metadata version is stale", { current_meta_version: cur.meta_version });
    const pub = await db(ctx).prepare("SELECT publisher_id, is_template FROM artifacts WHERE id = ?").bind(a.id).first();
    if (pub?.publisher_id || pub?.is_template) throw new HttpError(403, "protected_source", "This document cannot be modified here");
    if (lg.workspaceId) await explainLimit(ctx.env, lg.workspaceId, { storage_bytes: content.size }, lg.limits, projectId);
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return result;
}
// Content edits (save, data-file save, restore): null when the write goes straight to the version line.
async function rvGateContent(ctx, projectId, a, i, expected, rev) {
  if (!rvGated(ctx, a)) return null;
  return rvPropose(ctx, projectId, a, i, { content: rev, expectedRev: expected, note: rev.change_note, status: 200 });
}
async function rvGateMeta(ctx, projectId, a, i, expected, input, v, restoredFrom) {
  if (!rvGated(ctx, a)) return null;
  if (input.trashed !== undefined) throw new HttpError(403, "review_required", "This document requires review; only a person can move it to or from the trash");
  return rvPropose(ctx, projectId, a, i, { meta: { title: v.title, folder: v.folder, tags: v.tags }, metaInput: input, expectedMeta: expected, note: input.change_note ?? (restoredFrom ? "Restored details from version " + restoredFrom : void 0), metaRestoredFrom: restoredFrom, status: 200 });
}
// upload_finish: the gate is evaluated at finish, so a mode change after upload_begin is honored. rev is the
// verified content: { body, size, sha256, mime } for text or { blobKey, size, sha256, mime } for a file.
async function rvGateUpload(ctx, projectId, u, i, rev, fence, token) {
  if (!rvGatedActor(ctx)) return null;
  const a = await db(ctx).prepare("SELECT * FROM artifacts WHERE id = ? AND project_id = ?").bind(u.artifact_id, projectId).first();
  if (!a || !rvGated(ctx, a)) return null;
  let meta = null;
  if (a.pending_review === 1 && u.base_rev === 0 && u.review_meta) {
    const m = JSON.parse(u.review_meta);
    meta = { title: m.title, folder: m.folder ?? "", folderId: m.folder_id ?? null, tags: "[]" };
  }
  const isFirst = a.pending_review === 1 && !!meta;
  const s = { content: rev, expectedRev: u.base_rev, note: u.change_note ?? void 0, status: 200, fence, uploadId: u.id,
    extra: (id, body) => [db(ctx).prepare(`UPDATE uploads SET state = 'published', result = ?, finalize_token = NULL, finalize_until = NULL
      WHERE id = ? AND state = 'sealed' AND finalize_token = ? AND EXISTS (SELECT 1 FROM proposals WHERE id = ?)`).bind(JSON.stringify({ status: 200, body }), u.id, token, id)] };
  if (isFirst) return rvProposeNewFromUpload(ctx, projectId, a, i, s, meta);
  return rvPropose(ctx, projectId, a, i, s);
}
// The first proposal of a gated new upload: the shell was created by upload_begin (placeholder title).
async function rvProposeNewFromUpload(ctx, projectId, a, i, s, meta) {
  const v = rvVia(ctx);
  const note = provenance(ctx, { change_note: s.note })[4];
  const id = randomId("prp");
  const p = { id, artifact_id: a.id, base_rev: 0, base_meta_version: a.meta_version, supersedes_id: null };
  const result = rvResult(p, 200);
  const azBase = authzSql(ctx, projectId);
  const az = { sql: `${azBase.sql} AND ${s.fence.sql}`, params: [...azBase.params, ...s.fence.params] };
  const created = "EXISTS (SELECT 1 FROM proposals WHERE id = ?)";
  const c = s.content;
  const { bodyKey, staged } = await rvStageText(ctx, projectId, a.id, id, c);
  const out = await commitTextWrites(ctx.env, staged, (guarded) => runBatch(ctx, guarded([
    db(ctx).prepare(`INSERT INTO proposals (id, artifact_id, project_id, kind, status, is_new, base_rev, base_meta_version, has_content, body_key, blob_key, size, sha256, mime,
        has_meta, title, folder, folder_id, tags, author_id, via_kind, via_id, via_label, client_info, change_note, created_at, upload_id)
      SELECT ?, ?, ?, ?, 'pending', 1, 0, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${az.sql} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND head_rev = 0 AND pending_review = 1)`).bind(
      id, a.id, projectId, a.kind, a.meta_version, bodyKey, c.blobKey ?? null, c.size, c.sha256, c.mime, meta.title, meta.folder, meta.folderId, meta.tags,
      ctx.principal.id, v.kind, v.id ?? null, v.label, v.client, note, nowIso(), s.uploadId, ...az.params, a.id),
    idemInsert(ctx, i, 200, result.body, created, [id]),
    audit(ctx, projectId, "proposal.create", a.id, 0, "ok", created, [id]),
    ...s.extra(id, result.body),
    ...staged.map((k) => textWriteComplete(ctx.env, k))
  ]), i));
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) {
    const replay = await idemLookup(ctx, i);
    if (replay) return replay;
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return result;
}
// New documents in a project whose default makes them required: a hidden document plus its first proposal.
// f: { title, folder, folderId, schema, body, mime, sha256, size }; extra: optional artifact columns (templates).
async function rvCreateNew(ctx, projectId, kind, f, i, input, extra = { cols: [], vals: [] }, more = {}) {
  await rvNewCap(ctx, projectId);
  const v = rvVia(ctx);
  const note = provenance(ctx, input)[4];
  const artId = randomId("art"), id = randomId("prp"), now = nowIso();
  const p = { id, artifact_id: artId, base_rev: 0, base_meta_version: 1, supersedes_id: null };
  const result = rvResult(p, 201);
  Object.assign(result.body, more);
  // The hidden document is not counted as an item until approved; its text counts toward storage now.
  const lg = await projectLimitGuard(ctx.env, projectId, { storage_bytes: f.size });
  const az0 = authzSql(ctx, projectId), az = { sql: `${az0.sql} AND ${lg.sql}`, params: [...az0.params, ...lg.params] };
  const { bodyKey, staged } = await rvStageText(ctx, projectId, artId, id, { body: f.body });
  const made = "EXISTS (SELECT 1 FROM artifacts WHERE id = ?)";
  const cols = extra.cols.length ? ", " + extra.cols.join(", ") : "", qs = extra.cols.map(() => ", ?").join("");
  // The per-author cap is re-checked inside the batch, so concurrent creates can't exceed it.
  const cap = `(SELECT COUNT(*) FROM proposals WHERE project_id = ? AND is_new = 1 AND status = 'pending' AND via_kind = ? AND via_id IS ?) < ${RV_MAX_NEW}`;
  const out = await commitTextWrites(ctx.env, staged, (guarded) => runBatch(ctx, guarded([
    db(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, schema_id, head_rev, head_revision_id, created_at, updated_at, review_mode, pending_review${cols})
      SELECT ?, ?, ?, ?, '', NULL, ?, 0, NULL, ?, ?, 'required', 1${qs} WHERE ${az.sql} AND ${cap}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))`).bind(artId, projectId, kind, RV_PLACEHOLDER, f.schema ?? null, now, now, ...extra.vals, ...az.params,
      projectId, v.kind, v.id ?? null, f.folderId ?? null, f.folderId ?? null, projectId),
    db(ctx).prepare(`INSERT INTO proposals (id, artifact_id, project_id, kind, status, is_new, base_rev, base_meta_version, has_content, body_key, size, sha256, mime,
        has_meta, title, folder, folder_id, tags, author_id, via_kind, via_id, via_label, client_info, change_note, created_at)
      SELECT ?, ?, ?, ?, 'pending', 1, 0, 1, 1, ?, ?, ?, ?, 1, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ? WHERE ${made}`).bind(
      id, artId, projectId, kind, bodyKey, f.size, f.sha256, f.mime, f.title, f.folder ?? "", f.folderId ?? null,
      ctx.principal.id, v.kind, v.id ?? null, v.label, v.client, note, now, artId),
    // Stored only when the document was really created: a refused create (cap, folder, access) never replays as 201.
    idemInsert(ctx, i, 201, result.body, made, [artId]),
    audit(ctx, projectId, "proposal.create", artId, 0, "ok", made, [artId]),
    ...staged.map((k) => textWriteComplete(ctx.env, k))
  ]), i));
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) {
    if (f.folderId) await folderCheck(ctx, projectId, f.folderId);
    await rvNewCap(ctx, projectId);
    if (lg.workspaceId) await explainLimit(ctx.env, lg.workspaceId, { storage_bytes: f.size }, lg.limits, projectId);
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return result;
}

// ---------- proposals: list, read, withdraw ----------
async function rvLoadProposal(ctx, projectId, proposalId) {
  str(proposalId, "proposal_id", 64, { min: 1 });
  const p = await db(ctx).prepare(`SELECT p.*, a.title AS doc_title, a.head_rev AS cur_rev, a.meta_version AS cur_meta, a.trashed_at AS doc_trashed, a.review_mode AS doc_mode,
      a.folder AS doc_folder, a.tags AS doc_tags, a.schema_id AS doc_schema, a.pending_review AS doc_pending
    FROM proposals p JOIN artifacts a ON a.id = p.artifact_id AND a.project_id = p.project_id WHERE p.id = ? AND p.project_id = ?`).bind(proposalId, projectId).first();
  if (!p || !rvKinds(ctx).includes(p.kind)) throw new HttpError(404, "not_found", "Proposal not found");
  if (p.doc_trashed && ctx.principal.kind !== "human") throw new HttpError(404, "not_found", "Proposal not found");
  return p;
}
function rvStale(p) {
  if (p.status !== "pending") return false;
  if (p.is_new) return false;
  return !!(p.has_content && p.cur_rev !== p.base_rev || p.has_meta && p.cur_meta !== p.base_meta_version);
}
function rvView(ctx, p, full) {
  const me = ctx.principal.kind === "human" ? ctx.principal.id : null;
  const v = {
    proposal_id: p.id, artifact_id: p.artifact_id, project_id: p.project_id, kind: p.kind, status: p.status, is_new: !!p.is_new,
    // What a proposal changes is the proposer's and reviewers' business: others only learn that an edit is pending.
    ...full ? { changes: [p.has_content ? "content" : null, p.has_meta ? "details" : null].filter(Boolean) } : {},
    base_revision: p.base_rev, base_meta_version: p.base_meta_version, created_at: p.created_at, decided_at: p.decided_at ?? null,
    who: whoLabel(p, me), via: { kind: p.via_kind, id: p.via_id, label: p.via_label }, mine: rvSelf(ctx, p),
    document_title: p.is_new ? null : p.doc_title
  };
  if (!full) return v;
  return { ...v, document_title: p.is_new ? p.title : p.doc_title, client_info: p.client_info, change_note: p.change_note, stale: rvStale(p),
    current_revision: p.cur_rev, current_meta_version: p.cur_meta, supersedes: p.supersedes_id ?? null,
    result_revision: p.result_rev ?? null, result_meta_version: p.result_meta_version ?? null,
    proposed: {
      ...p.has_content ? { size: p.size, sha256: p.sha256, mime: p.mime, restored_from: p.restored_from ?? null } : {},
      ...p.has_meta ? { title: p.title, folder: p.folder, tags: JSON.parse(p.tags ?? "[]") } : {}
    } };
}
async function listProposals(ctx, projectId, q = {}) {
  tplDenyPublisher(ctx);
  await authorizeProject(ctx, projectId, false);
  const reviewer = await rvCanReview(ctx, projectId);
  const status = q.status === undefined || q.status === null || q.status === "" ? "pending" : str(q.status, "status", 20);
  if (status !== "all" && !RV_STATUSES.includes(status)) throw new HttpError(400, "invalid_input", "status must be one of " + RV_STATUSES.join(", ") + " or all");
  const aid = q.artifact_id ? str(q.artifact_id, "artifact_id", 64) : "";
  const offset = q.cursor ? int(Number(q.cursor), "cursor", 0, 1e5) : 0;
  const v = ctx.principal.kind === "human" ? { kind: "browser", id: null } : rvVia(ctx);
  // Reviewers see everything; others see their own proposals in full and only that others' pending edits exist.
  const r = await db(ctx).prepare(`SELECT p.*, a.title AS doc_title, a.head_rev AS cur_rev, a.meta_version AS cur_meta
    FROM proposals p JOIN artifacts a ON a.id = p.artifact_id AND a.project_id = p.project_id
    WHERE p.project_id = ? AND (? = '' OR p.artifact_id = ?) AND (? = 'all' OR p.status = ?) AND p.status <> 'approving'
      AND p.kind IN (SELECT value FROM json_each(?)) AND (? = 1 OR a.trashed_at IS NULL)
      AND (? = 1 OR (p.via_kind = ? AND p.via_id IS ?) OR (p.status = 'pending' AND p.is_new = 0))
    ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`).bind(projectId, aid, aid, status, status, JSON.stringify(rvKinds(ctx)), ctx.principal.kind === "human" ? 1 : 0,
    reviewer ? 1 : 0, v.kind, v.id ?? null, RV_PAGE + 1, offset).all();
  const rows = r.results.slice(0, RV_PAGE);
  return { can_review: reviewer, proposals: rows.map((p) => rvView(ctx, p, reviewer || rvSelf(ctx, p))), next_cursor: r.results.length > RV_PAGE ? String(offset + RV_PAGE) : null };
}
// A person's queue across the projects they can review in (Home "Needs review").
async function reviewQueue(ctx) {
  requireHuman(ctx);
  const gate = memberRoleSql("p.project_id", "member");
  const r = await db(ctx).prepare(`SELECT p.*, a.title AS doc_title, a.head_rev AS cur_rev, a.meta_version AS cur_meta, pj.title AS project_title
    FROM proposals p JOIN artifacts a ON a.id = p.artifact_id JOIN projects pj ON pj.id = p.project_id
    WHERE p.status = 'pending' AND a.trashed_at IS NULL AND ${gate} ORDER BY p.created_at DESC LIMIT 101`).bind(ctx.principal.id).all();
  const rows = r.results.slice(0, 100);
  return { proposals: rows.map((p) => ({ ...rvView(ctx, p, true), project_title: p.project_title })), more: r.results.length > 100 };
}
async function rvRevBody(ctx, projectId, artifactId, revNo) {
  if (!revNo) return null;
  return db(ctx).prepare("SELECT rev_no, body, body_key, blob_key, size, sha256, mime FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?").bind(artifactId, projectId, revNo).first();
}
// The proposal's text, or null when it has none stored (a file, details only, or purged).
function rvHasText(p) {
  return !!p.has_content && p.blob_key === null && !p.blob_purged_at && (p.body_key !== null && p.body_key !== undefined || typeof p.body === "string");
}
// Line diff of the proposal's text against a version's; summarised (no hunks) when either side is over 1 MiB.
async function rvDiff(ctx, from, p, text) {
  if (!from || from.blob_key || (!from.body_key && typeof from.body !== "string")) return null;
  if (from.sha256 === p.sha256) return { from_revision: from.rev_no, identical: true, added: 0, removed: 0, hunks: [], truncated: false };
  if (from.size > RV_DIFF_BYTES || p.size > RV_DIFF_BYTES || text === null) return { from_revision: from.rev_no, identical: false, added: null, removed: null, hunks: [], truncated: true };
  return { from_revision: from.rev_no, identical: false, ...lineDiff(await getText(ctx.env, from), text) };
}
async function readProposal(ctx, projectId, proposalId, opts = {}) {
  tplDenyPublisher(ctx);
  await authorizeProject(ctx, projectId, false);
  const p = await rvLoadProposal(ctx, projectId, proposalId);
  const full = rvSelf(ctx, p) || await rvCanReview(ctx, projectId);
  if (!full) throw new HttpError(404, "not_found", "Proposal not found");
  const out = { proposal: rvView(ctx, p, true), can_review: await rvCanReview(ctx, projectId) && !await rvSelfReview(ctx, p) };
  if (p.has_content) {
    const isText = p.blob_key === null;
    if (p.blob_purged_at) out.body_purged = true;
    let text = null;
    if (rvHasText(p)) {
      const cut = p.size > RV_INLINE_CHARS;
      text = typeof p.body === "string" && !p.body_key ? p.body : cut ? await getTextPrefix(ctx.env, p, RV_INLINE_CHARS) : await getText(ctx.env, p);
      out.body = text;
      if (cut) { out.body_truncated = true; out.content_path = opts.contentPath ?? null; text = null; }
    } else if (!isText) out.content_path = p.blob_purged_at ? null : opts.contentPath ?? null;
    const base = await rvRevBody(ctx, projectId, p.artifact_id, p.base_rev);
    out.diff_from_base = isText ? (p.blob_purged_at ? null : await rvDiff(ctx, base, p, text)) : base ? { from_revision: base.rev_no, binary: true, identical: base.sha256 === p.sha256, from: { size: base.size, sha256: base.sha256, mime: base.mime } } : null;
    if (!p.is_new && p.cur_rev !== p.base_rev) {
      const cur = await rvRevBody(ctx, projectId, p.artifact_id, p.cur_rev);
      out.diff_from_current = isText ? (p.blob_purged_at ? null : await rvDiff(ctx, cur, p, text)) : cur ? { from_revision: cur.rev_no, binary: true, identical: cur.sha256 === p.sha256 } : null;
    }
  }
  if (p.has_meta) out.details = { current: { title: p.is_new ? null : p.doc_title, folder: p.is_new ? null : p.doc_folder, tags: p.is_new ? [] : JSON.parse(p.doc_tags ?? "[]") }, proposed: { title: p.title, folder: p.folder, tags: JSON.parse(p.tags ?? "[]") } };
  const rv = p.review_id ? await db(ctx).prepare("SELECT * FROM reviews WHERE id = ?").bind(p.review_id).first() : null;
  if (rv) out.review = rvReviewView(ctx, rv);
  return out;
}
async function serveProposalContent(ctx, req, projectId, proposalId) {
  tplDenyPublisher(ctx);
  await authorizeProject(ctx, projectId, false);
  const p = await rvLoadProposal(ctx, projectId, proposalId);
  if (!(rvSelf(ctx, p) || await rvCanReview(ctx, projectId)) || !p.has_content) throw new HttpError(404, "not_found", "Proposal not found");
  if (p.blob_purged_at) throw new HttpError(410, "purged", "The content of this closed proposal was removed after 30 days");
  const isText = p.blob_key === null;
  const inline2 = !isText && new URL(req.url).searchParams.get("download") !== "1" && (IMAGE_TYPES.includes(p.mime) || VIDEO_TYPES.includes(p.mime));
  // Text proposals are served as plain text and binaries by their checked type: never rendered as HTML here.
  const headers = {
    "content-type": isText ? "text/plain; charset=utf-8" : CONTENT_TYPE[p.mime] ?? "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; frame-ancestors 'self'; sandbox", "cross-origin-resource-policy": "same-origin",
    etag: `"${p.sha256}"`, "content-disposition": `${inline2 ? "inline" : "attachment"}; filename="proposal-${p.id.slice(4, 16)}"`, "content-length": String(p.size)
  };
  if (req.method === "HEAD") return new Response(null, { status: 200, headers });
  if (isText && !p.body_key) return new Response(new TextEncoder().encode(p.body ?? ""), { status: 200, headers });
  return new Response(await readBlob(ctx.env, p.body_key ?? p.blob_key, null), { status: 200, headers });
}
async function withdrawProposal(ctx, projectId, proposalId, key) {
  tplDenyPublisher(ctx);
  await authorizeProject(ctx, projectId, true);
  const i = { op: "proposal.withdraw:" + proposalId, key, projectId, digest: await sha256Hex(proposalId) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const p = await rvLoadProposal(ctx, projectId, proposalId);
  if (!rvSelf(ctx, p)) throw new HttpError(404, "not_found", "Proposal not found");
  if (p.status !== "pending") throw new HttpError(409, "proposal_closed", "This proposal is already " + p.status, { proposal_status: p.status });
  const az = authzSql(ctx, projectId);
  const body = { proposal_id: p.id, status: "withdrawn" };
  const gate = "EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'withdrawn')";
  const out = await runBatch(ctx, [
    db(ctx).prepare(`UPDATE proposals SET status = 'withdrawn', decided_at = ? WHERE id = ? AND status = 'pending' AND ${az.sql}`).bind(nowIso(), p.id, ...az.params),
    idemInsert(ctx, i, 200, body, gate, [p.id]),
    audit(ctx, projectId, "proposal.withdraw", p.artifact_id, null, "ok", gate, [p.id])
  ], i);
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) {
    const cur = await db(ctx).prepare("SELECT status FROM proposals WHERE id = ?").bind(p.id).first("status");
    if (cur !== "pending") throw new HttpError(409, "proposal_closed", "This proposal is already " + cur, { proposal_status: cur });
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return { status: 200, body };
}

// ---------- review: approve, approve with edits, reject ----------
function rvReviewView(ctx, rv) {
  const me = ctx.principal.kind === "human" ? ctx.principal.id : null;
  return { review_id: rv.id, decision: rv.decision, who: whoLabel(rv, me), via: rv.via_kind ? { kind: rv.via_kind, id: rv.via_id, label: rv.via_label } : null,
    note: rv.note, created_at: rv.created_at, proposal_id: rv.proposal_id ?? null, revision: rv.rev_no ?? null, meta_version: rv.meta_version ?? null };
}
async function rvAssertReviewer(ctx, projectId) {
  if (ctx.publisher) throw new HttpError(404, "not_found", "Not found");
  await authorizeProject(ctx, projectId, false);
  if (!(await rvCanReview(ctx, projectId))) throw new HttpError(403, "review_forbidden", ctx.principal.kind === "human"
    ? "Reviewing needs the member role or above in this workspace" : "This connection cannot review in this project; a workspace admin grants review on the Connections page");
}
function rvNote(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "invalid_input", "note must be a string");
  if (v.length > CHANGE_NOTE_MAX) throw new HttpError(413, "too_large", `note exceeds ${CHANGE_NOTE_MAX} characters`);
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() || null;
}
async function reviewProposal(ctx, projectId, proposalId, input, key) {
  await rvAssertReviewer(ctx, projectId);
  const decision = input?.decision;
  if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "invalid_input", "decision must be approve or reject");
  const note = rvNote(input.note);
  const editBody = input.body !== undefined && input.body !== null;
  const editMeta = ["title", "folder", "tags"].some((k) => input[k] !== undefined && input[k] !== null);
  const expRev = input.expected_revision === undefined || input.expected_revision === null ? null : int(input.expected_revision, "expected_revision", 0);
  const expMeta = input.expected_meta_version === undefined || input.expected_meta_version === null ? null : int(input.expected_meta_version, "expected_meta_version", 1);
  const i = { op: "proposal.review:" + proposalId, key, projectId,
    digest: await sha256Hex(JSON.stringify([decision, note, editBody ? input.body : null, input.title ?? null, input.folder ?? null, input.tags ?? null, expRev, expMeta])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const p = await rvLoadProposal(ctx, projectId, proposalId);
  if (await rvSelfReview(ctx, p)) throw new HttpError(403, "self_review", "A proposal can't be reviewed by the connection that wrote it");
  if (p.status !== "pending") throw new HttpError(409, "proposal_closed", "This proposal is already " + p.status, { proposal_status: p.status });
  if (p.doc_trashed) throw new HttpError(409, "trashed", "Artifact is in trash");
  const rz = rvReviewSql(ctx, projectId);
  const rv = rvVia(ctx);
  const rid = randomId("rvw"), now = nowIso();
  if (decision === "reject") {
    if (editBody || editMeta) throw new HttpError(400, "invalid_input", "A rejection takes only a note");
    const body = { proposal_id: p.id, status: "rejected", decision: "rejected", review_id: rid, artifact_id: p.artifact_id };
    const gate = "EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'rejected' AND review_id = ?)", gp = [p.id, rid];
    const out = await runBatch(ctx, [
      db(ctx).prepare(`UPDATE proposals SET status = 'rejected', decided_at = ?, review_id = ? WHERE id = ? AND status = 'pending' AND ${rz.sql}`).bind(now, rid, p.id, ...rz.params),
      db(ctx).prepare(`INSERT INTO reviews (id, artifact_id, project_id, proposal_id, decision, author_id, via_kind, via_id, via_label, client_info, note, created_at)
        SELECT ?, ?, ?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`).bind(rid, p.artifact_id, projectId, p.id, ctx.principal.id, rv.kind, rv.id ?? null, rv.label, rv.client, note, now, ...gp),
      idemInsert(ctx, i, 200, body, gate, gp),
      audit(ctx, projectId, "proposal.reject", p.artifact_id, null, "ok", gate, gp)
    ], i);
    if (!Array.isArray(out)) return out;
    if (!out[0].meta.changes) return rvExplain(ctx, i, p);
    return { status: 200, body };
  }
  // Approve (optionally with the reviewer's edits).
  const a = await db(ctx).prepare("SELECT * FROM artifacts WHERE id = ? AND project_id = ?").bind(p.artifact_id, projectId).first();
  if (editBody && p.kind === "binary") throw new HttpError(400, "approve_with_edits_unsupported", "Files can be approved or rejected, not edited; reject with a note instead");
  if (editBody && !p.has_content && !p.is_new) throw new HttpError(400, "invalid_input", "This proposal changes details only");
  if (editMeta && !p.has_meta) throw new HttpError(400, "invalid_input", "This proposal changes content only");
  if (p.has_content && p.blob_purged_at) throw new HttpError(410, "purged", "The content of this proposal was removed");
  const edited = editBody || editMeta;
  // content: what the new version holds. A text proposal's own object becomes the version's text (no copy); a
  // reviewer's edited text is a new object, staged before the batch like any version text.
  let content = null, indexText = "";
  const revId = randomId("rev");
  if (p.has_content) {
    if (editBody) {
      let body;
      if (p.kind === "json" || p.kind === "csv") { checkFile(p.kind, input.body, a.schema_id); body = input.body; }
      else body = mdBody(input.body, p.kind);
      content = { body, bodyKey: null, blobKey: null, size: new TextEncoder().encode(body).length, sha256: await sha256Hex(body), mime: p.mime, restoredFrom: null };
      indexText = body;
    } else {
      content = { body: p.body_key ? null : p.body ?? null, bodyKey: p.body_key ?? null, blobKey: p.blob_key, size: p.size, sha256: p.sha256, mime: p.mime, restoredFrom: p.restored_from };
      if (p.blob_key === null) indexText = p.body_key ? await getTextPrefix(ctx.env, { body_key: p.body_key }, 1048576) : p.body ?? "";
    }
  }
  let meta = null;
  if (p.has_meta) {
    meta = { title: p.title, folder: p.folder ?? "", tags: p.tags ?? "[]" };
    if (input.title !== undefined && input.title !== null) meta.title = str(input.title, "title", 200, { min: 1 });
    if (input.folder !== undefined && input.folder !== null) meta.folder = str(input.folder, "folder", 200);
    if (input.tags !== undefined && input.tags !== null) {
      if (!Array.isArray(input.tags) || input.tags.length > 20) throw new HttpError(400, "invalid_input", "tags must be an array (max 20)");
      meta.tags = JSON.stringify(input.tags.map((t) => str(t, "tag", 50, { min: 1 })));
    }
  }
  // Plain approval requires the document to still be at the proposal's base; edits may reconcile onto the current one.
  const guardRev = content ? p.is_new ? 0 : editBody && expRev !== null ? expRev : p.base_rev : null;
  const guardMeta = meta && !p.is_new ? editMeta && expMeta !== null ? expMeta : p.base_meta_version : null;
  if (guardRev !== null && a.head_rev !== guardRev || guardMeta !== null && a.meta_version !== guardMeta)
    throw new HttpError(409, "proposal_stale", "The document changed since this proposal was made; approve with edits against the current version, or reject it", rvStaleExtra(p, a));
  // Who each part is attributed to: the reviewer for the part the reviewer changed, the proposer for the rest.
  const reviewerBy = { author: ctx.principal.id, kind: rv.kind, id: rv.id ?? null, label: rv.label, client: rv.client, note: note ?? p.change_note };
  const proposerBy = { author: p.author_id, kind: p.via_kind, id: p.via_id, label: p.via_label, client: p.client_info, note: p.change_note };
  const byContent = editBody ? reviewerBy : proposerBy, by = editMeta ? reviewerBy : proposerBy;
  const newRev = content ? guardRev + 1 : null;
  const newMeta = meta && !p.is_new ? guardMeta + 1 : null;
  const dec = edited ? "approved_with_edits" : "approved";
  const body = { proposal_id: p.id, status: "approved", decision: dec, review_id: rid, artifact_id: p.artifact_id, revision: newRev ?? a.head_rev, ...newMeta ? { meta_version: newMeta } : {} };
  const og = [p.id];
  const done = "EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'approved' AND review_id = ?)", dp = [p.id, rid];
  // A new document takes an item slot when approved (hidden documents do not count before).
  const lg = await projectLimitGuard(ctx.env, projectId, p.is_new ? { items_per_project: 1 } : {});
  // New text for the version: the reviewer's edit, or a proposal row that still holds its text inline (main's older schema).
  const editKey = content && typeof content.body === "string" ? await stageTextWrite(ctx.env, projectId, p.artifact_id, revId, content.body) : null;
  const stmts = [
    db(ctx).prepare(`UPDATE proposals SET status = 'approving' WHERE id = ? AND status = 'pending' AND ${rz.sql}
      AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND project_id = ? AND trashed_at IS NULL AND (? IS NULL OR head_rev = ?) AND (? IS NULL OR meta_version = ?))
      AND ${lg.sql}`).bind(p.id, ...rz.params, p.artifact_id, projectId, guardRev, guardRev, guardMeta, guardMeta, ...lg.params)
  ];
  if (meta && p.is_new) {
    // Title written while the head is still 0 (no feed or search event), then the head moves: one "created" event.
    stmts.push(db(ctx).prepare(`UPDATE artifacts SET title = ?, folder = ?, folder_id = ?, tags = ?, pending_review = 0, updated_at = ? WHERE id = ? AND head_rev = 0 AND pending_review = 1 AND ${RV_OPEN}`)
      .bind(meta.title, meta.folder, p.folder_id ?? null, meta.tags, now, p.artifact_id, ...og));
  } else if (meta) {
    stmts.push(
      db(ctx).prepare(`UPDATE artifacts SET title = ?, folder = ?, tags = ?, meta_version = ?, meta_request_id = ?, updated_at = ? WHERE id = ? AND meta_version = ? AND ${RV_OPEN}`)
        .bind(meta.title, meta.folder, meta.tags, newMeta, ctx.requestId, now, p.artifact_id, guardMeta, ...og),
      metaBaselineInsert(ctx, a, RV_OPEN, og),
      db(ctx).prepare(`INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, template_description, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, proposal_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${RV_OPEN}`).bind(randomId("mv"), p.artifact_id, projectId, newMeta, meta.title, meta.folder, meta.tags,
        a.template_description ?? "", by.author, by.kind, by.id, by.label, by.client, by.note, editMeta ? null : p.meta_restored_from ?? null, now, p.id, ...og));
  }
  const bodyKey = editKey ?? content?.bodyKey ?? null;
  if (content) stmts.push(
    db(ctx).prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note, proposal_id)
      SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${RV_OPEN} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND head_rev = ?)`).bind(
      revId, p.artifact_id, projectId, newRev, byContent.author, bodyKey, content.blobKey ?? null, content.size, content.sha256, content.mime, content.restoredFrom ?? null, now,
      byContent.kind, byContent.id, byContent.label, byContent.client, byContent.note, p.id, ...og, p.artifact_id, guardRev),
    db(ctx).prepare(`UPDATE artifacts SET head_rev = ?, head_revision_id = ?, updated_at = ? WHERE id = ? AND head_rev = ? AND ${RV_OPEN}`).bind(newRev, revId, now, p.artifact_id, guardRev, ...og),
    // The approved text enters the search index with the version (files by title only); proposals never do.
    ...indexDocument(db(ctx), { artifactId: p.artifact_id, revisionId: revId, sha256: content.sha256, text: indexText }));
  // New title of an existing document: the index follows it (the head's text is read first, as updateMetadata does).
  let retitled = false;
  if (meta && !p.is_new && !content && meta.title !== a.title) {
    const head = await headIndexInput(ctx.env, p.artifact_id);
    if (head && !head.trashed) { retitled = true; stmts.push(...indexDocument(db(ctx), { artifactId: p.artifact_id, ...head })); }
  }
  stmts.push(
    db(ctx).prepare(`INSERT INTO reviews (id, artifact_id, project_id, rev_no, meta_version, proposal_id, decision, author_id, via_kind, via_id, via_label, client_info, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${RV_OPEN}`).bind(rid, p.artifact_id, projectId, newRev, newMeta, p.id, dec, ctx.principal.id, rv.kind, rv.id ?? null, rv.label, rv.client, note, now, ...og),
    db(ctx).prepare("UPDATE proposals SET status = 'approved', decided_at = ?, result_rev = ?, result_meta_version = ?, review_id = ? WHERE id = ? AND status = 'approving'").bind(now, newRev, newMeta, rid, p.id),
    idemInsert(ctx, i, 200, body, done, dp),
    audit(ctx, projectId, edited ? "proposal.approve_with_edits" : "proposal.approve", p.artifact_id, newRev, "ok", done, dp),
    ...editKey ? [textWriteComplete(ctx.env, editKey)] : []);
  const out = await commitTextWrites(ctx.env, editKey ? [editKey] : [], (guarded) => runBatch(ctx, guarded(stmts), i));
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) return rvExplain(ctx, i, p, guardRev, guardMeta, lg);
  if (retitled) await repairIfStale(ctx.env, p.artifact_id);
  return { status: 200, body };
}
function rvStaleExtra(p, a) {
  return { base_revision: p.base_rev, current_revision: a.head_rev, base_meta_version: p.base_meta_version, current_meta_version: a.meta_version };
}
async function rvExplain(ctx, i, p, guardRev = null, guardMeta = null, lg = null) {
  const replay = await idemLookup(ctx, i);
  if (replay) return replay;
  const cur = await db(ctx).prepare("SELECT status FROM proposals WHERE id = ?").bind(p.id).first("status");
  if (cur !== "pending") throw new HttpError(409, "proposal_closed", "This proposal is already " + cur, { proposal_status: cur });
  const a = await db(ctx).prepare("SELECT head_rev, meta_version, trashed_at FROM artifacts WHERE id = ?").bind(p.artifact_id).first();
  if (a?.trashed_at) throw new HttpError(409, "trashed", "Artifact is in trash");
  if (a && (guardRev !== null && a.head_rev !== guardRev || guardMeta !== null && a.meta_version !== guardMeta))
    throw new HttpError(409, "proposal_stale", "The document changed since this proposal was made; approve with edits against the current version, or reject it", rvStaleExtra(p, a));
  if (p.is_new && lg?.workspaceId) await explainLimit(ctx.env, lg.workspaceId, { items_per_project: 1 }, lg.limits, p.project_id);
  throw new HttpError(403, "review_forbidden", "Review permission no longer valid");
}

// ---------- advisory: mark one existing version reviewed ----------
async function reviewRevision(ctx, projectId, artifactId, revNo, input, key) {
  await rvAssertReviewer(ctx, projectId);
  const rev = int(revNo, "revision", 1);
  const decision = input?.decision ?? "approved";
  if (decision !== "approved" && decision !== "rejected") throw new HttpError(400, "invalid_input", "decision must be approved or rejected");
  const note = rvNote(input?.note);
  const i = { op: "revision.review:" + artifactId + ":" + rev, key, projectId, digest: await sha256Hex(JSON.stringify([decision, note])) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const a = await loadArtifact(ctx, projectId, artifactId);
  if (!rvKinds(ctx).includes(a.kind)) throw new HttpError(404, "not_found", "Artifact not found");
  if (a.review_mode !== "advisory") throw new HttpError(409, "review_mode", a.review_mode === "required" ? "Every version of this document is already reviewed (review required)" : "Review is off for this document");
  const r = await db(ctx).prepare("SELECT rev_no, via_kind, via_id FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = ?").bind(artifactId, projectId, rev).first();
  if (!r) throw new HttpError(404, "not_found", "Revision not found");
  if (await rvSelfReview(ctx, r)) throw new HttpError(403, "self_review", "A version can't be reviewed by the connection that wrote it");
  const rz = rvReviewSql(ctx, projectId), v = rvVia(ctx), rid = randomId("rvw");
  const gate = "EXISTS (SELECT 1 FROM reviews WHERE id = ?)";
  const body = { review_id: rid, artifact_id: artifactId, revision: rev, decision };
  const out = await runBatch(ctx, [
    db(ctx).prepare(`INSERT INTO reviews (id, artifact_id, project_id, rev_no, decision, author_id, via_kind, via_id, via_label, client_info, note, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${rz.sql} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND project_id = ? AND review_mode = 'advisory' AND trashed_at IS NULL)`).bind(
      rid, artifactId, projectId, rev, decision, ctx.principal.id, v.kind, v.id ?? null, v.label, v.client, note, nowIso(), ...rz.params, artifactId, projectId),
    idemInsert(ctx, i, 200, body, gate, [rid]),
    audit(ctx, projectId, "revision.review", artifactId, rev, "ok:" + decision, gate, [rid])
  ], i);
  if (!Array.isArray(out)) return out;
  if (!out[0].meta.changes) {
    const replay = await idemLookup(ctx, i);
    if (replay) return replay;
    throw new HttpError(409, "review_mode", "Review settings changed; reload and try again");
  }
  body.reviewed_revision = await rvReviewedOf(ctx, artifactId, "advisory", a.head_rev);
  return { status: 200, body };
}
// Latest version whose latest review is an approval (advisory); in required mode every version is reviewed.
async function rvReviewedOf(ctx, artifactId, mode, head) {
  if (mode === "required") return head;
  return (await db(ctx).prepare(`SELECT ${RV_REVIEWED_SQL} AS n FROM artifacts a WHERE a.id = ?`).bind(artifactId).first("n")) ?? null;
}
// read_artifact {reviewed: true} / ?rev=reviewed
async function rvResolveRev(ctx, a, revNo) {
  if (a.pending_review === 1) throw new HttpError(404, "pending_review", "This document is waiting for review; read your proposal with read_proposal");
  if (revNo !== "reviewed") return revNo ?? a.head_rev;
  const n = await rvReviewedOf(ctx, a.id, a.review_mode, a.head_rev);
  if (!n) throw new HttpError(404, "no_reviewed_version", "No version of this document has been reviewed yet");
  return n;
}
async function rvReviewedRev(ctx, projectId, artifactId) {
  await authorizeProject(ctx, projectId, false);
  return rvResolveRev(ctx, await loadArtifact(ctx, projectId, artifactId), "reviewed");
}
function rvArtifactReview(a) {
  const mode = a.review_mode ?? "off", pending = a.rv_pending ?? 0;
  if (mode === "off" && !pending && (a.rv_reviewed === undefined || a.rv_reviewed === null)) return {};
  return { review: { mode, reviewed_revision: mode === "required" ? a.head_rev : a.rv_reviewed ?? null, pending_proposals: pending } };
}
// History: who reviewed each version and details version (and who proposed an edited approval).
async function rvDecorateHistory(ctx, projectId, artifactId, out) {
  const revs = out.revisions.map((v) => v.rev);
  if (!revs.length && !out.meta_versions?.length) return out;
  const r = await db(ctx).prepare(`SELECT rv.*, p.via_kind AS p_kind, p.via_id AS p_id, p.via_label AS p_label, p.author_id AS p_author FROM reviews rv
    LEFT JOIN proposals p ON p.id = rv.proposal_id WHERE rv.artifact_id = ? AND rv.project_id = ? ORDER BY rv.rowid`).bind(artifactId, projectId).all();
  const me = ctx.principal.kind === "human" ? ctx.principal.id : null;
  const byRev = new Map(), byMeta = new Map();
  for (const rv of r.results) {
    // The latest decision wins: a later rejection withdraws an earlier approval.
    if (rv.decision === "rejected") {
      if (rv.rev_no !== null) byRev.delete(rv.rev_no);
      if (rv.meta_version !== null) byMeta.delete(rv.meta_version);
      continue;
    }
    const view = { ...rvReviewView(ctx, rv), ...rv.decision === "approved_with_edits" && rv.p_kind ? { proposed_by: whoLabel({ via_kind: rv.p_kind, via_id: rv.p_id, via_label: rv.p_label, author_id: rv.p_author }, me) } : {} };
    if (rv.rev_no !== null) byRev.set(rv.rev_no, view);
    if (rv.meta_version !== null) byMeta.set(rv.meta_version, view);
  }
  out.revisions = out.revisions.map((v) => byRev.has(v.rev) ? { ...v, review: byRev.get(v.rev) } : v);
  if (out.meta_versions) out.meta_versions = out.meta_versions.map((m) => byMeta.has(m.version) ? { ...m, review: byMeta.get(m.version) } : m);
  return out;
}

// ---------- settings: document mode, project default (workspace admins), review permission of agent connections ----------
async function setReviewMode(ctx, projectId, artifactId, input) {
  requireHuman(ctx);
  await requireProjectRole(ctx, projectId, "admin");
  const mode = input?.mode;
  if (!RV_MODES.includes(mode)) throw new HttpError(400, "invalid_input", "mode must be off, advisory or required");
  const expected = int(input.expected_revision, "expected_revision", 1);
  const a = await loadArtifact(ctx, projectId, artifactId);
  if (a.publisher_id) throw new HttpError(409, "publisher_file", "Files kept by a publishing app can't require review");
  if (a.head_rev !== expected) throw new HttpError(409, "revision_conflict", "The document changed; review the current version before changing review", { current_revision: a.head_rev, expected_revision: expected });
  if (a.review_mode === mode) return { artifact_id: artifactId, review_mode: mode, reviewed_revision: await rvReviewedOf(ctx, artifactId, mode, a.head_rev) };
  // Turning on required vouches for the version the admin saw; leaving required for advisory keeps it reviewed.
  const vouch = mode === "required" || mode === "advisory" && a.review_mode === "required";
  const az = rvAdminSql(ctx, projectId), rid = randomId("rvw"), now = nowIso();
  const res = await db(ctx).batch([
    db(ctx).prepare(`UPDATE artifacts SET review_mode = ? WHERE id = ? AND project_id = ? AND head_rev = ? AND review_mode = ? AND trashed_at IS NULL AND pending_review = 0 AND ${az.sql}`)
      .bind(mode, artifactId, projectId, expected, a.review_mode, ...az.params),
    ...vouch ? [db(ctx).prepare(`INSERT INTO reviews (id, artifact_id, project_id, rev_no, decision, author_id, via_kind, note, created_at)
      SELECT ?, ?, ?, ?, 'approved', ?, 'browser', ?, ? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND review_mode = ? AND head_rev = ?)`).bind(
      rid, artifactId, projectId, expected, ctx.principal.id, mode === "required" ? "Review required turned on" : "Kept reviewed when review became optional", now, artifactId, mode, expected)] : [],
    audit(ctx, projectId, "artifact.review_mode", artifactId, expected, "ok:" + mode, "EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND review_mode = ?)", [artifactId, mode])
  ]);
  if (!res[0].meta.changes) {
    const cur = await db(ctx).prepare("SELECT head_rev FROM artifacts WHERE id = ?").bind(artifactId).first("head_rev");
    throw new HttpError(409, "revision_conflict", "The document changed; review the current version before changing review", { current_revision: cur, expected_revision: expected });
  }
  return { artifact_id: artifactId, review_mode: mode, reviewed_revision: await rvReviewedOf(ctx, artifactId, mode, expected) };
}
async function getReviewSettings(ctx, projectId) {
  requireHuman(ctx);
  await authorizeProject(ctx, projectId, false);
  const p = await db(ctx).prepare("SELECT review_default, kinds FROM project_review_settings WHERE project_id = ?").bind(projectId).first() ?? { review_default: "off", kinds: null };
  const c = await db(ctx).prepare("SELECT review_mode, COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NULL AND pending_review = 0 AND head_rev > 0 AND trashed_at IS NULL GROUP BY review_mode").bind(projectId).all();
  const pend = await db(ctx).prepare("SELECT COUNT(*) AS n FROM proposals WHERE project_id = ? AND status = 'pending'").bind(projectId).first("n");
  const out = { default: p.review_default, kinds: p.kinds ? JSON.parse(p.kinds) : null,
    documents: Object.fromEntries(RV_MODES.map((m) => [m, c.results.find((r) => r.review_mode === m)?.n ?? 0])), pending_proposals: pend ?? 0 };
  Object.defineProperty(out, "kindsRaw", { value: p.kinds ?? null, enumerable: false });
  return out;
}
async function setReviewSettings(ctx, projectId, input) {
  requireHuman(ctx);
  await requireProjectRole(ctx, projectId, "admin");
  const mode = input?.default;
  if (!RV_MODES.includes(mode)) throw new HttpError(400, "invalid_input", "default must be off, advisory or required");
  let kinds = null;
  if (input.kinds !== undefined && input.kinds !== null) {
    if (!Array.isArray(input.kinds) || !input.kinds.length || input.kinds.some((k) => !RV_KINDS.includes(k))) throw new HttpError(400, "invalid_input", "kinds must list some of " + RV_KINDS.join(", "));
    kinds = JSON.stringify([...new Set(input.kinds)]);
  }
  const az = rvAdminSql(ctx, projectId);
  await db(ctx).batch([
    db(ctx).prepare(`INSERT INTO project_review_settings (project_id, review_default, kinds) SELECT ?, ?, ? WHERE ${az.sql}
      ON CONFLICT (project_id) DO UPDATE SET review_default = excluded.review_default, kinds = excluded.kinds`).bind(projectId, mode, kinds, ...az.params),
    audit(ctx, projectId, "project.review_default", projectId, null, "ok:" + mode)
  ]);
  return getReviewSettings(ctx, projectId);
}
// Apply the project default to existing documents. Returns the exact versions it vouched for.
// input.expected_default (required): the setting the admin saw, so a stale page never applies a different one.
async function applyReviewSettings(ctx, projectId, input) {
  requireHuman(ctx);
  await requireProjectRole(ctx, projectId, "admin");
  const s = await getReviewSettings(ctx, projectId);
  if (!RV_MODES.includes(input?.expected_default)) throw new HttpError(400, "invalid_input", "expected_default must be the saved setting (off, advisory or required)");
  const same = (x, y) => JSON.stringify(x ? [...x].sort() : null) === JSON.stringify(y ? [...y].sort() : null);
  if (input.expected_default !== s.default || input.expected_kinds !== undefined && !same(input.expected_kinds, s.kinds))
    throw new HttpError(409, "settings_changed", "The project review setting changed; reload and check it before applying", { default: s.default, kinds: s.kinds });
  const r = await db(ctx).prepare(`SELECT id, kind, head_rev, review_mode FROM artifacts WHERE project_id = ? AND publisher_id IS NULL AND pending_review = 0 AND head_rev > 0
    AND trashed_at IS NULL AND review_mode <> ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))`).bind(projectId, s.default, s.kinds ? JSON.stringify(s.kinds) : null, s.kinds ? JSON.stringify(s.kinds) : null).all();
  const now = nowIso(), stmts = [], plan = [], az = rvAdminSql(ctx, projectId);
  for (const a of r.results) {
    const vouch = s.default === "required" || s.default === "advisory" && a.review_mode === "required";
    plan.push({ a, idx: stmts.length });
    // Live: admin access, not trashed, and the project setting still the one being applied (default and kinds).
    stmts.push(db(ctx).prepare(`UPDATE artifacts SET review_mode = ? WHERE id = ? AND project_id = ? AND head_rev = ? AND review_mode = ? AND pending_review = 0 AND trashed_at IS NULL AND ${az.sql}
      AND COALESCE((SELECT review_default || '|' || COALESCE(kinds, '') FROM project_review_settings WHERE project_id = ?), 'off|') = ?`)
      .bind(s.default, a.id, projectId, a.head_rev, a.review_mode, ...az.params, projectId, s.default + "|" + (s.kindsRaw ?? "")));
    if (vouch) stmts.push(db(ctx).prepare(`INSERT INTO reviews (id, artifact_id, project_id, rev_no, decision, author_id, via_kind, note, created_at)
      SELECT ?, ?, ?, ?, 'approved', ?, 'browser', ?, ? WHERE changes() = 1`).bind(randomId("rvw"), a.id, projectId, a.head_rev, ctx.principal.id, "Project review setting applied", now));
  }
  const res = stmts.length ? await db(ctx).batch(stmts) : [];
  const updated = [], changed = [];
  for (const { a, idx } of plan) (res[idx].meta.changes ? updated : changed).push({ artifact_id: a.id, revision: a.head_rev });
  await audit(ctx, projectId, "project.review_apply", projectId, null, "ok:" + s.default + ":" + updated.length).run();
  return { mode: s.default, updated, skipped_changed: changed };
}
// Active (not revoked, not expired) connections with this project in scope; the last parameter is "now" (ms).
const RV_PATHS = {
  oauth: `SELECT 1 FROM oauth_connections oc JOIN oauth_connection_projects cp ON cp.connection_id = oc.id WHERE oc.id = ? AND cp.project_id = ? AND oc.revoked_at IS NULL AND oc.expires_at > ?`,
  api_key: `SELECT 1 FROM api_credentials ac JOIN api_credential_projects acp ON acp.credential_id = ac.id WHERE ac.id = ? AND acp.project_id = ? AND ac.revoked_at IS NULL AND ac.expires_at > ?`,
  grant: `SELECT 1 FROM grants g WHERE g.id = ? AND g.project_id = ? AND g.revoked_at IS NULL AND g.expires_at > ?`
};
// Review permissions of the agent connections in projects where this person is an admin.
async function listReviewGrants(ctx) {
  requireHuman(ctx);
  const r = await db(ctx).prepare(`SELECT rg.path_kind, rg.path_id, rg.project_id, rg.created_at FROM review_grants rg WHERE ${memberRoleSql("rg.project_id", "admin")}`).bind(ctx.principal.id).all();
  return { review_grants: r.results };
}
async function setReviewGrant(ctx, input) {
  requireHuman(ctx);
  const kind = input?.path_kind;
  if (!RV_PATHS[kind]) throw new HttpError(400, "invalid_input", "path_kind must be oauth, api_key or grant");
  const pathId = str(input.path_id, "path_id", 80, { min: 1 }), projectId = str(input.project_id, "project_id", 64, { min: 1 });
  if (typeof input.can_review !== "boolean") throw new HttpError(400, "invalid_input", "can_review must be true or false");
  await requireProjectRole(ctx, projectId, "admin");
  // Admin-only, and the path must be active with this project in scope at the moment of the write (one statement).
  const adm = rvAdminSql(ctx, projectId);
  const has = "EXISTS (SELECT 1 FROM review_grants WHERE path_kind = ? AND path_id = ? AND project_id = ?)";
  if (input.can_review) {
    await db(ctx).batch([
      db(ctx).prepare(`INSERT OR IGNORE INTO review_grants (path_kind, path_id, project_id, created_at) SELECT ?, ?, ?, ? WHERE ${adm.sql} AND EXISTS (${RV_PATHS[kind]})`)
        .bind(kind, pathId, projectId, nowIso(), ...adm.params, pathId, projectId, nowMs()),
      audit(ctx, projectId, "review_grant.add", pathId, null, "ok:" + kind, has, [kind, pathId, projectId])
    ]);
    if (!(await db(ctx).prepare(`SELECT 1 AS x WHERE ${has}`).bind(kind, pathId, projectId).first("x")))
      throw new HttpError(404, "not_found", "Active connection with access to this project not found");
  } else await db(ctx).batch([
    db(ctx).prepare(`DELETE FROM review_grants WHERE path_kind = ? AND path_id = ? AND project_id = ? AND ${adm.sql}`).bind(kind, pathId, projectId, ...adm.params),
    audit(ctx, projectId, "review_grant.remove", pathId, null, "ok:" + kind, adm.sql, adm.params)
  ]);
  return { path_kind: kind, path_id: pathId, project_id: projectId, can_review: input.can_review };
}
// Replacing an API key keeps its review permission (the new key has the same scope).
async function rvCarryReview(env, oldId, newId) {
  await env.DB.prepare(`INSERT OR IGNORE INTO review_grants (path_kind, path_id, project_id, created_at)
    SELECT 'api_key', ?, rg.project_id, ? FROM review_grants rg JOIN api_credential_projects acp ON acp.credential_id = ? AND acp.project_id = rg.project_id
    WHERE rg.path_kind = 'api_key' AND rg.path_id = ?`).bind(newId, nowIso(), newId, oldId).run();
}
// Projects where this path may review (MCP tools/list).
async function rvAnyReview(env, kind, id) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM review_grants WHERE path_kind = ? AND path_id = ? LIMIT 1").bind(kind, id).first("x"));
}

// ---------- storage: bytes of closed proposals ----------
// Text (R2 objects under text/<project>/<artifact>/<proposal id>) and files of proposals that were closed without
// becoming a version, 30 days after the decision (owner decision 2026-11). The proposal record (who, when, hash,
// note) stays and read_proposal reports the body purged. Bytes any version references (an approved proposal's text,
// or a restore proposal's history bytes) are never purged. Every proposal that shares the bytes (a details-only
// re-save of a pending new document keeps them) must be closed for 30 days; then all of them are marked purged in one
// statement, re-checking references, before the delete.
const RV_PURGEABLE = `${RV_KEY} IS NOT NULL AND p.blob_purged_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = ${RV_KEY} OR r.body_key = ${RV_KEY})
  AND NOT EXISTS (SELECT 1 FROM proposals q WHERE COALESCE(q.body_key, q.blob_key) = ${RV_KEY} AND (q.status IN ${RV_OPEN_STATUSES} OR q.decided_at IS NULL OR q.decided_at >= ?))`;
async function rvPurge(env, now, limit, projectId) {
  const before = new Date(now - RV_PURGE_MS).toISOString();
  const r = await env.DB.prepare(`SELECT DISTINCT ${RV_KEY} AS key FROM proposals p WHERE ${RV_PURGEABLE} AND (? IS NULL OR p.project_id = ?) LIMIT ?`).bind(before, projectId ?? null, projectId ?? null, limit).all();
  let n = 0;
  for (const { key } of r.results) {
    const c = await env.DB.prepare(`UPDATE proposals AS p SET blob_purged_at = ? WHERE ${RV_KEY} = ? AND ${RV_PURGEABLE}`).bind(new Date(now).toISOString(), key, before).run();
    if (!c.meta.changes) continue;
    try { await deleteBlob(env, key); }
    catch (e) {
      // Not deleted: unmark, so the bytes stay counted and the next run tries again.
      await env.DB.prepare("UPDATE proposals SET blob_purged_at = NULL WHERE (body_key = ? OR blob_key = ?) AND blob_purged_at = ?").bind(key, key, new Date(now).toISOString()).run();
      continue;
    }
    await env.DB.prepare("UPDATE uploads SET final_purged_at = ? WHERE final_key = ? AND final_purged_at IS NULL").bind(now, key).run();
    n++;
  }
  return n;
}

export { RV_PLACEHOLDER, applyReviewSettings, getReviewSettings, listProposals, listReviewGrants, readProposal, reviewProposal, reviewQueue, reviewRevision, rvAnyReview, rvArtifactReview, rvCarryReview,
  rvCreateNew, rvDecorateHistory, rvGateContent, rvGateMeta, rvGateUpload, rvGatedActor, rvNewCap, rvNewGated, rvOwnPending, rvPurge, rvResolveRev, rvReviewedRev, serveProposalContent,
  setReviewGrant, setReviewMode, setReviewSettings, withdrawProposal };
