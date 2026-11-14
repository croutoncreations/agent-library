// Review data in project backups (docs/review-gating.md#backups): modes, the project default, proposals (their text
// inline, their files with the other blobs), review records and hidden pending documents. A backup that has this
// data (or app files / folders) is schema agent-library-backup/4; restore and import accept /1 to /4 and read
// the review section when it is there (main's /3 carries only this section).
import { getText } from "../content-store.js";
import { HttpError, b64, sha256Hex, unb64 } from "../util.js";

const MODES = ["off", "advisory", "required"];
const KINDS = ["markdown", "html", "json", "csv", "binary"];
const STATUSES = ["pending", "approved", "rejected", "superseded", "withdrawn"];
const DECISIONS = ["approved", "approved_with_edits", "rejected"];
const PROPOSAL_COLS = ["artifact_id", "kind", "status", "is_new", "base_rev", "base_meta_version", "has_content", "size", "sha256", "mime", "restored_from",
  "has_meta", "title", "folder", "tags", "meta_restored_from", "author_id", "via_kind", "via_id", "via_label", "client_info", "change_note", "created_at", "decided_at",
  "result_rev", "result_meta_version", "blob_purged_at"];
const REVIEW_COLS = ["artifact_id", "rev_no", "meta_version", "decision", "author_id", "via_kind", "via_id", "via_label", "client_info", "note", "created_at"];
const INT_COLS = new Set(["is_new", "has_content", "has_meta"]);

/** Artifact ids of hidden new documents (waiting for their first review): they have no version yet. */
export function pendingIds(backup) {
  return new Set((backup.review?.modes ?? []).filter((m) => m.pending_review).map((m) => m.id));
}
/** Export: the review section for a project, or null when the project has no review data. Adds proposal files to `blobs`. */
export async function exportReview(ctx, projectId, blobs, readBytes) {
  const DB = ctx.env.DB;
  const [proj, props, revs, modes] = await DB.batch([
    DB.prepare("SELECT review_default, kinds FROM project_review_settings WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT * FROM proposals WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT * FROM reviews WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, review_mode, pending_review FROM artifacts WHERE project_id = ? AND (review_mode <> 'off' OR pending_review = 1)").bind(projectId)
  ]);
  const p = proj.results[0] ?? { review_default: "off", kinds: null };
  if (!props.results.length && !revs.results.length && !modes.results.length && p.review_default === "off") return null;
  // A version that points at the same text object as its approved proposal is exported once, as the version.
  const revByKey = new Map((await DB.prepare("SELECT id, body_key FROM revisions WHERE project_id = ? AND body_key IS NOT NULL").bind(projectId).all()).results.map((r) => [r.body_key, r.id]));
  const proposals = [];
  for (const x of props.results) {
    const { body_key, body, blob_key, project_id: _p, upload_id: _u, folder_id: _f, ...row } = x;
    const out = { ...row, ...blob_key ? { blob_key } : {} };
    if (x.has_content && !x.blob_purged_at) {
      if (blob_key) {
        if (!blobs[blob_key]) {
          const bytes = await readBytes(blob_key);
          if (await sha256Hex(bytes) !== x.sha256) throw new HttpError(500, "blob_corrupt", "Stored blob hash mismatch");
          blobs[blob_key] = { sha256: x.sha256, data: b64(bytes) };
        }
      } else if (body_key && revByKey.has(body_key)) out.body_revision_id = revByKey.get(body_key);
      else if (body_key) out.body = await getText(ctx.env, { body_key });
      else out.body = body;
    }
    proposals.push(out);
  }
  return { review: { default: p.review_default, kinds: p.kinds, modes: modes.results, proposals, reviews: revs.results } };
}
/** Restore and import: validate the review section (before any write) and add proposal files to the decoded set. */
export async function validateReview(backup, blobs, decoded, pid) {
  const r = backup.review;
  if (r === undefined || r === null) return;
  if (typeof r !== "object" || !Array.isArray(r.modes) || !Array.isArray(r.proposals) || !Array.isArray(r.reviews)) throw new HttpError(400, "bad_backup", "Invalid review section");
  if (!MODES.includes(r.default)) throw new HttpError(400, "bad_backup", "Invalid review default");
  if (r.kinds !== undefined && r.kinds !== null) {
    let k = null; try { k = JSON.parse(r.kinds); } catch {}
    if (!Array.isArray(k) || !k.length || k.some((x) => !KINDS.includes(x))) throw new HttpError(400, "bad_backup", "Invalid review kinds");
  }
  const ids = new Set((backup.artifacts ?? []).map((a) => a.id)), revs = new Map(backup.revisions.map((v) => [v.id, v]));
  for (const m of r.modes) if (!ids.has(m.id) || !MODES.includes(m.review_mode)) throw new HttpError(400, "bad_backup", "Invalid review mode");
  const keyRe = new RegExp(`^blobs/${pid}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$`);
  const seen = new Set();
  for (const x of r.proposals) {
    if (typeof x.id !== "string" || seen.has(x.id)) throw new HttpError(400, "bad_backup", "Invalid proposal");
    seen.add(x.id);
    if (!ids.has(x.artifact_id) || !STATUSES.includes(x.status) && x.status !== "approving" || !KINDS.includes(x.kind)) throw new HttpError(400, "bad_backup", "Invalid proposal");
    // Every stored-bytes key must belong to this project, purged or not; open proposals can't be purged.
    if (x.blob_key !== undefined && x.blob_key !== null && !keyRe.test(x.blob_key)) throw new HttpError(400, "bad_backup", "Bad blob key");
    if (x.blob_purged_at && (x.status === "pending" || x.status === "approving")) throw new HttpError(400, "bad_backup", "A pending proposal can't have purged bytes");
    if (!x.has_content || x.blob_purged_at) continue;
    if (x.blob_key) {
      const b = blobs[x.blob_key];
      if (!b) throw new HttpError(400, "bad_backup", "Missing blob");
      const bytes = decoded.get(x.blob_key) ?? unb64(b.data);
      if (await sha256Hex(bytes) !== x.sha256 || bytes.length !== x.size) throw new HttpError(400, "bad_backup", `Blob for ${x.id} hash/size mismatch`);
      decoded.set(x.blob_key, bytes);
    } else if (x.body_revision_id !== undefined && x.body_revision_id !== null) {
      const v = revs.get(x.body_revision_id);
      if (!v || v.artifact_id !== x.artifact_id || v.blob_key !== null || v.sha256 !== x.sha256) throw new HttpError(400, "bad_backup", `Proposal ${x.id} text reference mismatch`);
    } else if (typeof x.body !== "string" || await sha256Hex(x.body) !== x.sha256 || new TextEncoder().encode(x.body).length !== x.size) throw new HttpError(400, "bad_backup", `Proposal ${x.id} hash mismatch`);
  }
  for (const v of r.reviews) if (!ids.has(v.artifact_id) || !DECISIONS.includes(v.decision)) throw new HttpError(400, "bad_backup", "Invalid review");
}
/** The people a review section names as authors. */
export function reviewAuthors(backup) {
  const r = backup.review;
  return r ? [...r.proposals, ...r.reviews].map((x) => x.author_id) : [];
}
/**
 * Statements that write the review section into project `pid`, and the text objects its proposals need.
 * m: { artifactId(id), proposalId(id), reviewId(id), authorId(id), viaId(id), blobKey(artifactId, key), revisionBodyKey(revId), proposalBodyKey(proposal) }
 * (restore keeps ids; import maps them and drops via ids). Returns { stmts, texts: [{ proposalId, artifactId, text, key }] }.
 */
export function reviewStatements(DB, backup, pid, m) {
  const r = backup.review;
  const out = { stmts: [], texts: [] };
  if (!r) return out;
  if (r.default !== "off") out.stmts.push(DB.prepare("INSERT INTO project_review_settings (project_id, review_default, kinds) VALUES (?, ?, ?)").bind(pid, r.default, r.kinds ?? null));
  for (const x of r.modes) out.stmts.push(DB.prepare("UPDATE artifacts SET review_mode = ?, pending_review = ? WHERE id = ? AND project_id = ?").bind(x.review_mode, x.pending_review ? 1 : 0, m.artifactId(x.id), pid));
  for (const x of r.proposals) {
    let bodyKey = null;
    if (x.has_content && !x.blob_purged_at && !x.blob_key) {
      if (x.body_revision_id !== undefined && x.body_revision_id !== null) bodyKey = m.revisionBodyKey(x.body_revision_id);
      else { bodyKey = m.proposalBodyKey(x); out.texts.push({ proposalId: m.proposalId(x.id), artifactId: m.artifactId(x.artifact_id), text: x.body, key: bodyKey }); }
    }
    const cols = ["id", "project_id", "supersedes_id", "review_id", "body_key", "blob_key", "folder_id", ...PROPOSAL_COLS.filter((c) => c !== "artifact_id"), "artifact_id"];
    const vals = [m.proposalId(x.id), pid, x.supersedes_id ? m.proposalId(x.supersedes_id) : null, x.review_id ? m.reviewId(x.review_id) : null, bodyKey,
      x.blob_key && !x.blob_purged_at ? m.blobKey(x.artifact_id, x.blob_key) : null, null,
      ...PROPOSAL_COLS.filter((c) => c !== "artifact_id").map((c) => c === "author_id" ? m.authorId(x[c]) : c === "via_id" ? m.viaId(x[c] ?? null) : x[c] ?? (INT_COLS.has(c) ? 0 : null)), m.artifactId(x.artifact_id)];
    out.stmts.push(DB.prepare(`INSERT INTO proposals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...vals));
  }
  for (const v of r.reviews) {
    const cols = ["id", "project_id", "proposal_id", ...REVIEW_COLS];
    out.stmts.push(DB.prepare(`INSERT INTO reviews (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(m.reviewId(v.id), pid, v.proposal_id ? m.proposalId(v.proposal_id) : null,
      ...REVIEW_COLS.map((c) => c === "artifact_id" ? m.artifactId(v[c]) : c === "author_id" ? m.authorId(v[c]) : c === "via_id" ? m.viaId(v[c] ?? null) : v[c] ?? null)));
  }
  return out;
}
