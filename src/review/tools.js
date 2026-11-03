// Review tools for both MCP endpoints (OAuth MCP: oauth = true, project_id optional; legacy /mcp: project_id required).
// write: withdraw is an edit of the caller's own proposal (needs edit access). review: needs the owner-granted
// review permission (checked live by the service), not edit access; charged to the write rate bucket.
const RV_REVIEWED_ARG = { type: "boolean", description: "Read the latest reviewed version instead of the current one (documents whose review is advisory or required)" };
function rvTools(oauth = false) {
  const project = { type: "string", maxLength: 64, description: oauth ? "Project ID from list_projects. Optional when the connection has exactly one project." : "Project ID" };
  const id = { type: "string", maxLength: 64 };
  const keyArg = { type: "string", minLength: 8, maxLength: 128, description: "Unique key for this change (8-128 chars, e.g. a UUID). Reuse it only when retrying the same change." };
  const note = { type: "string", maxLength: 280, description: "One line for the author and the owner: why you approved, edited or rejected it" };
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
      description: "Read one proposal (your own, or any if you can review): its text or file details, title/folder/tag changes, status, the reviewer's decision and note, and line diffs against the version it started from and the current version (when the document changed since). stale=true means the document moved on: a plain approve will fail; approve with edits against the current version, or reject.",
      inputSchema: schema({ proposal_id: id }, ["proposal_id"]),
      run: call(async (c, p, a) => oauth ? rvOauthProposalFile(c, p, await readProposal(c, p, a.proposal_id)) : readProposal(c, p, a.proposal_id, { contentPath: `/api/projects/${p}/proposals/${a.proposal_id}/content` })) },
    { name: "withdraw_proposal", title: "Withdraw your proposed edit", write: true, annotations: rw,
      description: "Withdraw one of your own pending proposals. To change it instead, just save again: a new save replaces your pending proposal.",
      inputSchema: schema({ proposal_id: id, idempotency_key: keyArg }, ["proposal_id", "idempotency_key"]),
      run: call(async (c, p, a) => unwrapR(await withdrawProposal(c, p, a.proposal_id, idemKey(a.idempotency_key)))) },
    { name: "review_proposal", title: "Review a proposed edit", write: false, review: true, annotations: rw,
      description: "Approve or reject another author's proposal (needs review permission, granted by the owner). decision approve publishes it as a new version (and/or new title, folder and tags) exactly as proposed; it fails with proposal_stale if the document changed since. To approve with edits, also pass body (text documents only; files can only be approved or rejected) and/or title, folder, tags, with expected_revision / expected_meta_version of the current document: your text becomes the new version, which reconciles a stale proposal. decision reject closes it with your note. Always set note.",
      inputSchema: schema({ proposal_id: id, decision: { type: "string", enum: ["approve", "reject"] }, note,
        body: { type: "string", description: "Approve with edits: the full text to publish instead of the proposed text" },
        title: { type: "string", minLength: 1, maxLength: 200 }, folder: { type: "string", maxLength: 200 }, tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
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
async function rvReviewedArgs(c, p, a) {
  if (a.reviewed !== true) return a;
  if (a.revision != null || a.cursor != null) throw new HttpError(400, "invalid_input", "Pass reviewed or revision/cursor, not both");
  // Resolved once (the OAuth read_artifact wrapper resolves it before the document/file split; inner tools see a revision).
  const { reviewed: _r, ...rest } = a;
  return { ...rest, revision: await rvReviewedRev(c, p, a.artifact_id) };
}
