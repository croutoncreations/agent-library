// Review tools for both MCP endpoints (OAuth MCP: oauth = true, project_id optional; legacy /mcp: project_id required).
// write: withdraw is an edit of the caller's own proposal (needs edit access). review: needs the review permission
// (checked live by the service), not edit access; charged to the write rate bucket.
import { IMAGE_TYPES } from "../service.js";
import { readBlobBytes } from "../content-store.js";
import { HttpError, idemKey, nowIso, nowMs, randomId, sha256Hex } from "../util.js";
import { db } from "../service.js";
import { listProposals, readProposal, reviewProposal, reviewRevision, rvReviewedRev, withdrawProposal } from "./service.js";

export const RV_REVIEWED_ARG = { type: "boolean", description: "Read the latest reviewed version instead of the current one (documents whose review is advisory or required)" };
// An OAuth reviewer gets a proposed file the way read_file gives a version: a short-lived transfer link (re-checked
// live on use) and, for images up to the inline limit, the image itself. Blocks ride on the symbol the OAuth MCP reads.
export async function rvOauthProposalFile(c, projectId, out, { ttlMs, inlineBytes, base64, blocksKey }) {
  const p = out.proposal;
  // A file, or text too long to return inline (body_truncated): the whole content comes through the link.
  const wantsLink = p.kind === "binary" || out.body_truncated === true;
  if (!c.ftConn || c.ftConn.file_access !== 1 || !wantsLink || !p.changes?.includes("content")) return out;
  const row = await db(c).prepare("SELECT COALESCE(blob_key, body_key) AS blob_key, blob_purged_at, mime, size FROM proposals WHERE id = ? AND project_id = ?").bind(p.proposal_id, projectId).first();
  if (!row?.blob_key || row.blob_purged_at) return out;
  const token = randomId("ft", 32), expires = nowMs() + ttlMs;
  await db(c).prepare("INSERT INTO transfer_links (token_hash, kind, connection_id, project_id, artifact_id, rev_no, upload_id, expires_at, created_at, proposal_id) VALUES (?, 'download', ?, ?, ?, NULL, NULL, ?, ?, ?)")
    .bind(await sha256Hex(token), c.ftConn.id, projectId, p.artifact_id, expires, nowIso(), p.proposal_id).run();
  const url = `${c.ftOrigin}/files/d/${token}`;
  const blocks = [];
  if (p.kind === "binary" && IMAGE_TYPES.includes(row.mime) && row.size <= inlineBytes) blocks.push({ type: "image", data: base64(await readBlobBytes(c.env, row.blob_key)), mimeType: row.mime });
  blocks.push({ type: "resource_link", uri: url, name: p.document_title ?? "Proposed content", mimeType: row.mime, size: row.size, description: "Short-lived download link for the proposed content (expires in minutes; not a share link)" });
  const result = { ...out, download_url: url, download_expires_at: new Date(expires).toISOString(), image_inline: blocks.length > 1 };
  Object.defineProperty(result, blocksKey, { value: blocks, enumerable: true });
  return result;
}
export function rvTools(oauth = false, fileOpts = null) {
  const project = { type: "string", maxLength: 110, description: oauth ? "Project ID or path (workspace/project) from list_projects. Optional when the connection has exactly one project." : "Project ID or path (workspace/project)" };
  const id = { type: "string", maxLength: 64 };
  const keyArg = { type: "string", minLength: 8, maxLength: 128, description: "Unique key for this change (8-128 chars, e.g. a UUID). Reuse it only when retrying the same change." };
  const note = { type: "string", maxLength: 280, description: "One line for the author and the reviewers: why you approved, edited or rejected it" };
  const schema = (properties, required) => ({ type: "object", properties: { project_id: project, ...properties }, required: oauth ? required : ["project_id", ...required], additionalProperties: false });
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const call = (fn) => oauth ? fn : (c, a) => fn(c, a.project_id, a);
  const unwrapR = (r) => r && typeof r.status === "number" && "body" in r ? r.body : r;
  return [
    { name: "list_proposals", title: "List proposed edits", write: false, annotations: ro,
      description: "List edits waiting for review (status pending by default; or approved, rejected, superseded, withdrawn, all) in a project, optionally for one document. Documents whose review is required keep agent edits as proposals until a reviewer approves them. You see your own proposals in full and, for other authors, only that an edit is pending. Reviewers see all. can_review says whether you may review here.",
      inputSchema: schema({ artifact_id: id, status: { type: "string", enum: ["pending", "approved", "rejected", "superseded", "withdrawn", "all"] }, cursor: { type: "string", maxLength: 12 } }, []),
      run: call((c, p, a) => listProposals(c, p, a)) },
    { name: "read_proposal", title: "Read a proposed edit", write: false, annotations: ro,
      description: "Read one proposal (your own, or any if you can review): its text or file details, title/folder/tag changes, status, the reviewer's decision and note, and line diffs against the version it started from and the current version (when the document changed since). Long text is cut (body_truncated); the whole text is at content_path. stale=true means the document moved on: a plain approve will fail; approve with edits against the current version, or reject. The text of a closed proposal is removed after 30 days (body_purged).",
      inputSchema: schema({ proposal_id: id }, ["proposal_id"]),
      run: call(async (c, p, a) => oauth ? rvOauthProposalFile(c, p, await readProposal(c, p, a.proposal_id), fileOpts()) : readProposal(c, p, a.proposal_id, { contentPath: `/api/projects/${p}/proposals/${a.proposal_id}/content` })) },
    { name: "withdraw_proposal", title: "Withdraw your proposed edit", write: true, annotations: rw,
      description: "Withdraw one of your own pending proposals. To change it instead, just save again: a new save replaces your pending proposal.",
      inputSchema: schema({ proposal_id: id, idempotency_key: keyArg }, ["proposal_id", "idempotency_key"]),
      run: call(async (c, p, a) => unwrapR(await withdrawProposal(c, p, a.proposal_id, idemKey(a.idempotency_key)))) },
    { name: "review_proposal", title: "Review a proposed edit", write: false, review: true, annotations: rw,
      description: "Approve or reject another author's proposal (needs review permission, granted by a workspace admin). decision approve publishes it as a new version (and/or new title, folder and tags) exactly as proposed; it fails with proposal_stale if the document changed since. To approve with edits, also pass body (text documents only; files can only be approved or rejected) and/or title, folder, tags, with expected_revision / expected_meta_version of the current document: your text becomes the new version, which reconciles a stale proposal. decision reject closes it with your note. Always set note.",
      inputSchema: schema({ proposal_id: id, decision: { type: "string", enum: ["approve", "reject"] }, note,
        body: { type: "string", description: "Approve with edits: the full text to publish instead of the proposed text" },
        title: { type: "string", minLength: 1, maxLength: 200 }, folder: { type: "string", maxLength: 200 }, tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 50 } },
        expected_revision: { type: "integer", minimum: 0, description: "With body: the document's current revision" },
        expected_meta_version: { type: "integer", minimum: 1, description: "With title/folder/tags: the document's current meta_version" },
        idempotency_key: keyArg }, ["proposal_id", "decision", "idempotency_key"]),
      run: call(async (c, p, a) => unwrapR(await reviewProposal(c, p, a.proposal_id, a, idemKey(a.idempotency_key)))) },
    { name: "review_revision", title: "Mark a version reviewed", write: false, review: true, annotations: rw,
      description: "For documents whose review is advisory: record that one exact version was reviewed (decision approved, the default) or rejected. Readers can then ask read_artifact for reviewed=true. A later edit is not reviewed until someone reviews it. Needs review permission; you can't review a version you wrote.",
      inputSchema: schema({ artifact_id: id, revision: { type: "integer", minimum: 1 }, decision: { type: "string", enum: ["approved", "rejected"] }, note, idempotency_key: keyArg }, ["artifact_id", "revision", "idempotency_key"]),
      run: call(async (c, p, a) => unwrapR(await reviewRevision(c, p, a.artifact_id, a.revision, a, idemKey(a.idempotency_key)))) }
  ];
}
// read_artifact {reviewed: true}: resolve to the reviewed revision number (never combined with revision or cursor).
export async function rvReviewedArgs(c, p, a) {
  if (a.reviewed !== true) return a;
  if (a.revision != null || a.cursor != null) throw new HttpError(400, "invalid_input", "Pass reviewed or revision/cursor, not both");
  // Resolved once (the OAuth read_artifact wrapper resolves it before the document/file split; inner tools see a revision).
  const { reviewed: _r, ...rest } = a;
  return { ...rest, revision: await rvReviewedRev(c, p, a.artifact_id) };
}
