// Review gating (docs/review-gating.md): required and advisory modes, proposals, review permission, visibility on every
// read path, files, quotas, backups, the changes feed and search, templates, JSON files, legacy /mcp, publishers, and
// the database triggers (checked with direct SQL that simulates a rolled-back Worker's writes). Real Worker (wrangler dev, local D1/R2), real OAuth consent flow, the official MCP SDK client,
// legacy agent tokens and API keys. Synthetic fixtures only; tokens stay in memory and are never printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { key, grant, mcpClient, agentHttp, ROOT, LOCAL_CONFIG, sha256, barrier } from "./helpers.mjs";
import { makePng } from "./make-fixtures.mjs";

const P = "rvw", Q = "rvw-other";
const base = `/api/projects/${P}`;
const art = (id) => `${base}/artifacts/${id}`;
let h, owner, writer, writer2, reviewer, reader, legacy, legacyGrant, apiKey, apiKeyId, reviewerConn;
const sql = (command) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", command],
  { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
// A statement the database refuses: wrangler reports the error as JSON on stdout.
const sqlRefused = (command) => {
  try { sql(command); } catch (e) { return JSON.parse(e.stdout).error.text; }
  assert.fail("statement was accepted: " + command.slice(0, 80));
};
async function api(method, path, body, token = apiKey, idem = key("api")) {
  const r = await fetch(h.api + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idem }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}
const ok = (r, msg) => { assert.equal(r.isError, false, (msg ? msg + ": " : "") + JSON.stringify(r.data)); return r.data; };
const err = (r) => { assert.equal(r.isError, true, JSON.stringify(r.data)); return r.data?.error ?? r.data; };
async function ownerDoc(title, body = "# " + title) {
  const r = await owner.req("POST", base + "/artifacts", { title, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.artifact_id;
}
async function setMode(id, mode) {
  const cur = (await owner.req("GET", art(id))).body;
  const r = await owner.req("PUT", art(id) + "/review-mode", { mode, expected_revision: cur.revision.rev });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const connId = async (clientName) => (await owner.req("GET", "/api/access")).body.connections.find((c) => c.client_name === clientName).id;
const allowReview = (path_kind, path_id, project_id = P, can_review = true) => owner.req("PUT", "/api/review-grants", { path_kind, path_id, project_id, can_review });

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["review-gating"], vars: { PROJECT_BINARY_BYTES: String(1024 * 1024) } });
  owner = await h.owner();
  for (const [id, title] of [[P, "Review"], [Q, "Other"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
  writer = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Writer" });
  writer2 = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Writer Two" });
  reviewer = await h.connectMcpAgent({ [P]: "read" }, { clientName: "Reviewer" });
  reader = await h.connectMcpAgent({ [P]: "read", [Q]: "read" }, { clientName: "Reader" });
  reviewerConn = await connId("Reviewer");
  assert.equal((await allowReview("oauth", reviewerConn)).status, 200);
  legacyGrant = await grant(owner, P, "Legacy writer", true);
  legacy = await mcpClient(h.appUi, legacyGrant.token);
  const k = await owner.req("POST", "/api/api-keys", { label: "Script", lifetime_days: 1, projects: [{ project_id: P, access: "read_write" }] });
  assert.equal(k.status, 201); apiKey = k.body.secret; apiKeyId = k.body.id;
});
after(async () => { await legacy?.close(); await h?.stop(); });

test("review off (default): nothing changes; document views keep their exact shape", async () => {
  const id = await ownerDoc("Plain");
  const r = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "agent edit", change_note: "edit", idempotency_key: key() }));
  assert.equal(r.revision, 2);
  const read = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id }));
  assert.equal(read.body, "agent edit");
  assert.equal(read.artifact.review, undefined, "no review field when review is off");
  assert.equal(err(await reader.call("read_artifact", { project_id: P, artifact_id: id, reviewed: true })).code, "no_reviewed_version");
});

test("required: agent saves become proposals; readers keep the approved version; reviewer approves; one feed event", async () => {
  const id = await ownerDoc("Gated", "v1 approved");
  const mode = await setMode(id, "required");
  assert.equal(mode.reviewed_revision, 1, "turning required on vouches for the version the owner saw");
  const cp = ok(await reader.call("list_changes", { project_id: P })).next_cursor;
  const s = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "half-finished draft", change_note: "draft edit", idempotency_key: key() }));
  assert.equal(s.status, "pending_review"); assert.match(s.proposal_id, /^prp_/); assert.equal(s.base_revision, 1);
  // Nobody but the author and reviewers can read the draft, by any path.
  for (const c of [reader, writer2, legacy]) {
    const r = ok(await c.call("read_artifact", { project_id: P, artifact_id: id }));
    assert.equal(r.body, "v1 approved");
    assert.equal(r.revision.rev, 1);
  }
  const rd = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id }));
  assert.deepEqual(rd.artifact.review, { mode: "required", reviewed_revision: 1, pending_proposals: 1 });
  assert.equal(err(await reader.call("read_proposal", { project_id: P, proposal_id: s.proposal_id })).code, "not_found");
  const other = ok(await writer2.call("list_proposals", { project_id: P, artifact_id: id }));
  assert.equal(other.proposals.length, 1, "others see that an edit exists");
  assert.equal(other.proposals[0].change_note, undefined, "but not its note");
  assert.equal(other.proposals[0].proposed, undefined, "nor its content");
  assert.equal(err(await reader.call("diff_revisions", { project_id: P, artifact_id: id, from: 1, to: 2 })).code, "not_found");
  assert.equal(ok(await reader.call("artifact_history", { project_id: P, artifact_id: id })).revisions.length, 1);
  assert.equal((await api("GET", `/projects/${P}/files/${id}/text`)).body.text, "v1 approved");
  assert.equal((await api("GET", `/projects/${P}/files/${id}/content`)).status, 200);
  assert.equal(ok(await reader.call("list_changes", { project_id: P, cursor: cp })).changes.length, 0, "a proposal emits no feed event");
  // The author sees it in full.
  const mine = ok(await writer.call("read_proposal", { project_id: P, proposal_id: s.proposal_id }));
  assert.equal(mine.body, "half-finished draft"); assert.equal(mine.proposal.status, "pending"); assert.equal(mine.can_review, false);
  // Reviewer approves; the author is credited, the reviewer recorded.
  const rp = ok(await reviewer.call("read_proposal", { project_id: P, proposal_id: s.proposal_id }));
  assert.equal(rp.can_review, true); assert.equal(rp.diff_from_base.added, 1);
  const ap = ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: s.proposal_id, decision: "approve", note: "Looks right", idempotency_key: key() }));
  assert.equal(ap.decision, "approved"); assert.equal(ap.revision, 2);
  const now = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id }));
  assert.equal(now.body, "half-finished draft");
  const hist = ok(await reader.call("artifact_history", { project_id: P, artifact_id: id }));
  assert.equal(hist.revisions[0].who, "Writer"); assert.equal(hist.revisions[0].review.who, "Reviewer"); assert.equal(hist.revisions[0].review.note, "Looks right");
  const ev = ok(await reader.call("list_changes", { project_id: P, cursor: cp })).changes;
  assert.deepEqual(ev.map((e) => e.type), ["artifact.content_updated"]);
  assert.equal(ev[0].revision, 2);
});

test("proposal lifecycle: supersede, withdraw, reject, stale approve, approve with edits (reconcile), self-review refused", async () => {
  const id = await ownerDoc("Lifecycle", "line one\n");
  await setMode(id, "required");
  const a1 = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "line one\nA\n", change_note: "first", idempotency_key: key() }));
  const a2 = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "line one\nA2\n", change_note: "second", idempotency_key: key() }));
  assert.equal(a2.supersedes, a1.proposal_id);
  assert.equal(ok(await writer.call("read_proposal", { project_id: P, proposal_id: a1.proposal_id })).proposal.status, "superseded");
  assert.equal(err(await reviewer.call("review_proposal", { project_id: P, proposal_id: a1.proposal_id, decision: "approve", idempotency_key: key() })).code, "proposal_closed");
  // Writer Two proposes too; the owner edits; both proposals become stale.
  const b = ok(await writer2.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "line one\nB\n", change_note: "b", idempotency_key: key() }));
  assert.equal((await owner.req("PUT", art(id), { expected_revision: 1, body: "line zero\nline one\n" })).status, 200);
  assert.equal(ok(await reviewer.call("read_proposal", { project_id: P, proposal_id: a2.proposal_id })).proposal.stale, true);
  const stale = err(await reviewer.call("review_proposal", { project_id: P, proposal_id: a2.proposal_id, decision: "approve", idempotency_key: key() }));
  assert.equal(stale.code, "proposal_stale"); assert.equal(stale.current_revision, 2); assert.equal(stale.base_revision, 1);
  // Reconcile: approve with edits against the current version. The reviewer is the author; the proposer is credited.
  const ed = ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: a2.proposal_id, decision: "approve", body: "line zero\nline one\nA2\n", expected_revision: 2, note: "Merged onto the owner's edit", idempotency_key: key() }));
  assert.equal(ed.decision, "approved_with_edits"); assert.equal(ed.revision, 3);
  const hist = ok(await reader.call("artifact_history", { project_id: P, artifact_id: id }));
  assert.equal(hist.revisions[0].who, "Reviewer"); assert.equal(hist.revisions[0].review.proposed_by, "Writer");
  // Reject with a note; the author sees the decision and the note.
  ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: b.proposal_id, decision: "reject", note: "Duplicate of A", idempotency_key: key() }));
  const rb = ok(await writer2.call("read_proposal", { project_id: P, proposal_id: b.proposal_id }));
  assert.equal(rb.proposal.status, "rejected"); assert.equal(rb.review.note, "Duplicate of A");
  // Withdraw; only the author can.
  const c = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 3, body: "x", change_note: "c", idempotency_key: key() }));
  assert.equal(err(await writer2.call("withdraw_proposal", { project_id: P, proposal_id: c.proposal_id, idempotency_key: key() })).code, "not_found");
  ok(await writer.call("withdraw_proposal", { project_id: P, proposal_id: c.proposal_id, idempotency_key: key() }));
  // Self-review: a reviewer can't approve its own edit (and a reader with review but no edit can't propose at all).
  assert.equal((await allowReview("oauth", await connId("Writer"))).status, 200);
  const own = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 3, body: "self", change_note: "self", idempotency_key: key() }));
  assert.equal(err(await writer.call("review_proposal", { project_id: P, proposal_id: own.proposal_id, decision: "approve", idempotency_key: key() })).code, "self_review");
  assert.equal((await allowReview("oauth", await connId("Writer"), P, false)).status, 200);
  ok(await writer.call("withdraw_proposal", { project_id: P, proposal_id: own.proposal_id, idempotency_key: key() }));
  // Self-review survives key rotation: a replacement key (which keeps review) can't approve what the old key proposed.
  const k = await owner.req("POST", "/api/api-keys", { label: "Rotating", lifetime_days: 1, projects: [{ project_id: P, access: "read_write" }] });
  assert.equal((await allowReview("api_key", k.body.id)).status, 200);
  const kp = await api("PUT", `/projects/${P}/files/${id}`, { expected_revision: 3, body: "by old key", change_note: "k" }, k.body.secret);
  assert.equal(kp.body.status, "pending_review", JSON.stringify(kp.body));
  const r1 = await owner.req("POST", `/api/api-keys/${k.body.id}/replace`, {});
  const r2 = await owner.req("POST", `/api/api-keys/${r1.body.id}/replace`, {});
  for (const s of [r1.body.secret, r2.body.secret]) {
    const rv = await api("POST", `/projects/${P}/proposals/${kp.body.proposal_id}/review`, { decision: "approve" }, s);
    assert.equal(rv.status, 403); assert.equal(rv.body.error.code, "self_review");
  }
  // ...and the other way round: while both are live, the old key can't approve what its replacement proposed.
  const np = await api("PUT", `/projects/${P}/files/${id}`, { expected_revision: 3, body: "by new key", change_note: "k2" }, r2.body.secret);
  assert.equal(np.body.status, "pending_review", JSON.stringify(np.body));
  for (const s of [k.body.secret, r1.body.secret]) {
    const rv = await api("POST", `/projects/${P}/proposals/${np.body.proposal_id}/review`, { decision: "approve" }, s);
    assert.equal(rv.status, 403, JSON.stringify(rv.body)); assert.equal(rv.body.error.code, "self_review");
  }
});

test("concurrent approvals and approve vs. owner save: exactly one wins, nothing half-applied", async () => {
  const id = await ownerDoc("Race", "base");
  await setMode(id, "required");
  const p = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "race", change_note: "r", idempotency_key: key() }));
  const results = await barrier([1, 2, 3].map(() => () => reviewer.call("review_proposal", { project_id: P, proposal_id: p.proposal_id, decision: "approve", idempotency_key: key() })));
  assert.equal(results.filter((r) => !r.isError).length, 1, JSON.stringify(results.map((r) => r.data)));
  assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${id}'`)[0].n, 2);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM reviews WHERE proposal_id = '${p.proposal_id}'`)[0].n, 1);
  const q = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 2, body: "race 2", change_note: "r2", idempotency_key: key() }));
  const [ownerSave, approve] = await barrier([
    () => owner.req("PUT", art(id), { expected_revision: 2, body: "owner wins?" }),
    () => reviewer.call("review_proposal", { project_id: P, proposal_id: q.proposal_id, decision: "approve", idempotency_key: key() })]);
  assert.equal((ownerSave.status === 200) + (!approve.isError), 1, "exactly one of the two lands on revision 3");
  assert.equal(sql(`SELECT MAX(rev_no) AS n FROM revisions WHERE artifact_id = '${id}'`)[0].n, 3);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'approving'`)[0].n, 0);
});

test("details and trash: title/folder/tag changes are proposals; agent trash is refused", async () => {
  const id = await ownerDoc("Details");
  await setMode(id, "required");
  const r = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id }));
  const mv = r.artifact.meta_version;
  const ag = agentHttp(h.appUi, legacyGrant.token);
  const patch = await ag("PATCH", art(id), { expected_meta_version: mv, title: "Renamed by agent", change_note: "rename" });
  assert.equal(patch.status, 200, JSON.stringify(patch.body)); assert.equal(patch.body.status, "pending_review");
  assert.equal(ok(await reader.call("read_artifact", { project_id: P, artifact_id: id })).artifact.title, "Details");
  assert.equal((await ag("PATCH", art(id), { expected_meta_version: mv, trashed: true })).body.error.code, "review_required");
  assert.equal(err(await legacy.call("trash_artifact", { project_id: P, artifact_id: id, expected_meta_version: mv, idempotency_key: key() })).code, "review_required");
  ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: patch.body.proposal_id, decision: "approve", title: "Renamed by reviewer", expected_meta_version: mv, idempotency_key: key() }));
  const after2 = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id }));
  assert.equal(after2.artifact.title, "Renamed by reviewer"); assert.equal(after2.artifact.meta_version, mv + 1);
  const restore = ok(await legacy.call("restore_metadata", { project_id: P, artifact_id: id, expected_meta_version: mv + 1, from_version: mv, idempotency_key: key() }));
  assert.equal(restore.status, "pending_review", "details restores are proposals too");
  const rr = ok(await legacy.call("restore_revision", { project_id: P, artifact_id: id, expected_revision: 1, from_revision: 1, idempotency_key: key() }));
  assert.equal(rr.status, "pending_review", "content restores are proposals too");
});

test("new documents in a required project are hidden until approved; the author can revise them at revision 0; limits", async () => {
  assert.equal((await owner.req("PUT", base + "/review-settings", { default: "required", kinds: ["markdown", "json", "binary"] })).status, 200);
  try {
    const c = ok(await writer.call("create_markdown", { project_id: P, title: "Secret plan", body: "draft one", change_note: "new", idempotency_key: key() }));
    assert.equal(c.status, "pending_review"); const id = c.artifact_id;
    for (const cl of [reader, writer2]) {
      assert.equal(err(await cl.call("read_artifact", { project_id: P, artifact_id: id })).code, "not_found");
      assert.ok(!ok(await cl.call("list_artifacts", { project_id: P })).artifacts.some((a) => a.id === id));
      assert.equal(ok(await cl.call("list_proposals", { project_id: P })).proposals.filter((x) => x.artifact_id === id).length, 0, "hidden new documents are not even listed");
      assert.equal(err(await cl.call("artifact_history", { project_id: P, artifact_id: id })).code, "not_found");
    }
    assert.equal((await api("GET", `/projects/${P}/files/${id}`)).status, 404);
    // The author revises it at revision 0 (and can't read it as a document either).
    assert.equal(err(await writer.call("read_artifact", { project_id: P, artifact_id: id })).code, "not_found");
    const c2 = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 0, body: "draft two", change_note: "rev", idempotency_key: key() }));
    assert.equal(c2.supersedes, c.proposal_id);
    const rp = ok(await reviewer.call("read_proposal", { project_id: P, proposal_id: c2.proposal_id }));
    assert.equal(rp.body, "draft two"); assert.equal(rp.details.proposed.title, "Secret plan");
    const cp = ok(await reader.call("list_changes", { project_id: P })).next_cursor;
    // The reviewer edits only the title: the content keeps its proposer as author.
    ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: c2.proposal_id, decision: "approve", title: "Secret plan (final)", idempotency_key: key() }));
    const now = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id }));
    assert.equal(now.body, "draft two"); assert.equal(now.artifact.title, "Secret plan (final)");
    assert.equal(ok(await reader.call("artifact_history", { project_id: P, artifact_id: id })).revisions[0].who, "Writer", "content keeps its author when only the title was edited"); assert.equal(now.revision.rev, 1);
    assert.equal(now.artifact.review.mode, "required");
    const ev = ok(await reader.call("list_changes", { project_id: P, cursor: cp })).changes;
    assert.deepEqual(ev.map((e) => e.type), ["artifact.created"], "approving a new document is exactly one created event");
    // Template copies and /v1 creates are gated too; API key creates count against the per-author cap, not the document limit.
    const v1 = await api("POST", `/projects/${P}/files`, { title: "From script", body: "x", change_note: "script" });
    assert.equal(v1.status, 201); assert.equal(v1.body.status, "pending_review");
    const before = sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${P}' AND pending_review = 0`)[0].n;
    assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${P}' AND pending_review = 1`)[0].n >= 1, true);
    for (let i = 0; i < 19; i++) assert.equal((await api("POST", `/projects/${P}/files`, { title: "Spam " + i, body: "x" })).status, 201);
    const ck = key("cap");
    const capped = await api("POST", `/projects/${P}/files`, { title: "Spam 20", body: "x" }, apiKey, ck);
    assert.equal(capped.status, 429); assert.equal(capped.body.error.code, "too_many_pending");
    const again = await api("POST", `/projects/${P}/files`, { title: "Spam 20", body: "x" }, apiKey, ck);
    assert.equal(again.status, 429, "a refused create never replays as created");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${P}' AND pending_review = 0`)[0].n, before);
    // Owner documents are never gated; publisher files keep review off.
    const mine = await owner.req("POST", base + "/artifacts", { title: "Owner new", body: "x" });
    assert.equal(mine.body.revision, 1); assert.equal(sql(`SELECT review_mode FROM artifacts WHERE id = '${mine.body.artifact_id}'`)[0].review_mode, "required");
  } finally {
    await sql(`UPDATE proposals SET status = 'withdrawn', decided_at = '2000-01-01T00:00:00Z' WHERE status = 'pending' AND is_new = 1 AND via_kind = 'api_key'`);
    assert.equal((await owner.req("PUT", base + "/review-settings", { default: "off" })).status, 200);
  }
});

test("files: gated uploads are proposals, approve/reject only, reviewer download, quota counted once, purge after 30 days", async () => {
  const png1 = makePng(8, 8), png2 = makePng(12, 12);
  const b = await owner.req("POST", base + "/uploads", { title: "Chart.png", mime: "image/png", size: png1.length, sha256: sha256(png1) });
  await owner.req("PUT", b.body.put_url, undefined, { raw: png1, idem: false });
  const id = (await owner.req("POST", `${base}/uploads/${b.body.upload_id}/finish`, {})).body.artifact_id;
  await setMode(id, "required");
  const k2 = await owner.req("POST", "/api/api-keys", { label: "Uploader", lifetime_days: 1, projects: [{ project_id: P, access: "read_write" }] });
  const ag = agentHttp(h.appUi, legacyGrant.token);
  const bg = await ag("POST", base + "/uploads", { artifact_id: id, expected_revision: 1, mime: "image/png", size: png2.length, sha256: sha256(png2) });
  assert.equal(bg.status, 201, JSON.stringify(bg.body));
  assert.equal((await ag("PUT", bg.body.put_url, undefined, { raw: png2, idem: false })).status, 200);
  const fin = await ag("POST", `${base}/uploads/${bg.body.upload_id}/finish`, {});
  assert.equal(fin.status, 200, JSON.stringify(fin.body)); assert.equal(fin.body.status, "pending_review");
  const prp = fin.body.proposal_id;
  // Readers still get the approved bytes; the reviewer can download the proposed ones.
  const cur = await fetch(h.appUi + art(id) + "/content", { headers: { cookie: owner.cookie } });
  assert.equal(sha256(Buffer.from(await cur.arrayBuffer())), sha256(png1));
  const pr = await api("GET", `/projects/${P}/proposals/${prp}/content`, undefined, k2.body.secret);
  assert.equal(pr.status, 404, "a key without review can't download another author's proposal");
  const oc = await owner.req("GET", `${base}/proposals/${prp}/content`, undefined, { binary: true });
  assert.equal(oc.status, 200); assert.equal(sha256(oc.body), sha256(png2));
  // Quota: proposal bytes count once; approving moves them to the version without double counting.
  assert.equal(err(await reviewer.call("review_proposal", { project_id: P, proposal_id: prp, decision: "approve", body: "x", expected_revision: 1, idempotency_key: key() })).code, "approve_with_edits_unsupported");
  ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: prp, decision: "approve", idempotency_key: key() }));
  const v2 = await owner.req("GET", art(id) + "/content", undefined, { binary: true });
  assert.equal(sha256(v2.body), sha256(png2));
  assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${id}' AND blob_key = (SELECT blob_key FROM proposals WHERE id = '${prp}')`)[0].n, 1, "approval copies nothing");
  // Rejected upload bytes are purged after 30 days; a restore proposal that reuses history bytes never is.
  const bg2 = await ag("POST", base + "/uploads", { artifact_id: id, expected_revision: 2, mime: "image/png", size: png1.length, sha256: sha256(png1) });
  await ag("PUT", bg2.body.put_url, undefined, { raw: png1, idem: false });
  const rej = (await ag("POST", `${base}/uploads/${bg2.body.upload_id}/finish`, {})).body.proposal_id;
  ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: rej, decision: "reject", note: "wrong chart", idempotency_key: key() }));
  const rs = ok(await legacy.call("restore_revision", { project_id: P, artifact_id: id, expected_revision: 2, from_revision: 1, idempotency_key: key() }));
  ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: rs.proposal_id, decision: "reject", idempotency_key: key() }));
  await sql(`UPDATE proposals SET decided_at = '2000-01-01T00:00:00Z' WHERE id IN ('${rej}', '${rs.proposal_id}')`);
  assert.equal((await owner.req("POST", `${base}/maintenance/reconcile-uploads`)).status, 200);
  assert.ok(sql(`SELECT blob_purged_at FROM proposals WHERE id = '${rej}'`)[0].blob_purged_at, "rejected upload bytes purged");
  assert.equal(sql(`SELECT blob_purged_at FROM proposals WHERE id = '${rs.proposal_id}'`)[0].blob_purged_at, null, "restore proposals reuse history bytes and are never purged");
  assert.equal((await owner.req("GET", art(id) + "/content?rev=1", undefined, { binary: true })).status, 200, "history bytes survive");
  assert.equal((await owner.req("GET", `${base}/proposals/${rej}/content`)).status, 410);
  // An OAuth reviewer sees the proposed bytes before deciding: inline image plus a short-lived link, checked live.
  const bg3 = await ag("POST", base + "/uploads", { artifact_id: id, expected_revision: 2, mime: "image/png", size: png1.length, sha256: sha256(png1) });
  await ag("PUT", bg3.body.put_url, undefined, { raw: png1, idem: false });
  const p3 = (await ag("POST", `${base}/uploads/${bg3.body.upload_id}/finish`, {})).body.proposal_id;
  const rp = ok(await reviewer.call("read_proposal", { project_id: P, proposal_id: p3 }));
  assert.equal(rp.image_inline, true); assert.match(rp.download_url, /\/files\/d\/ft_/);
  const dl = await fetch(rp.download_url);
  assert.equal(dl.status, 200); assert.equal(sha256(Buffer.from(await dl.arrayBuffer())), sha256(png1));
  const other = await reader.call("read_proposal", { project_id: P, proposal_id: p3 });
  assert.equal(other.isError, true, "others get no proposal content"); assert.equal(other.data?.download_url, undefined);
  assert.equal((await allowReview("oauth", reviewerConn, P, false)).status, 200);
  assert.equal((await fetch(rp.download_url)).status, 404, "the link re-checks review permission on use");
  assert.equal((await allowReview("oauth", reviewerConn)).status, 200);
  ok(await reviewer.call("review_proposal", { project_id: P, proposal_id: p3, decision: "reject", idempotency_key: key() }));
  // reviewed=true on a file (advisory) returns the reviewed version's bytes, not the head: a new agent version (v3)
  // goes live unreviewed; the reviewed one is still v2 (approved above).
  await setMode(id, "off"); await setMode(id, "advisory");
  const png3 = makePng(16, 16);
  const bg4 = await ag("POST", base + "/uploads", { artifact_id: id, expected_revision: 2, mime: "image/png", size: png3.length, sha256: sha256(png3) });
  await ag("PUT", bg4.body.put_url, undefined, { raw: png3, idem: false });
  assert.equal((await ag("POST", `${base}/uploads/${bg4.body.upload_id}/finish`, {})).body.revision, 3);
  const rf = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id, reviewed: true }));
  assert.equal(rf.revision.rev, 2, "file read honours reviewed");
  const bytes = await owner.req("GET", art(id) + "/content?rev=reviewed", undefined, { binary: true });
  assert.equal(bytes.status, 200); assert.equal(sha256(bytes.body), sha256(png2));
});

test("review permission: owner-only grant, live revocation, publisher never, tools listed only where granted", async () => {
  const names = (await reviewer.list()).map((t) => t.name);
  assert.ok(names.includes("review_proposal") && names.includes("review_revision"));
  assert.ok(!(await reader.list()).map((t) => t.name).includes("review_proposal"), "review tools are listed only where review was granted");
  const ag = agentHttp(h.appUi, legacyGrant.token);
  assert.equal((await ag("PUT", "/api/review-grants", { path_kind: "grant", path_id: legacyGrant.grant_id, project_id: P, can_review: true })).status, 403, "agents can't grant review");
  assert.equal((await allowReview("oauth", await connId("Reader"), Q)).status, 200);
  const id = await ownerDoc("Perm"); await setMode(id, "required");
  const p = ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "p", change_note: "p", idempotency_key: key() }));
  assert.equal(err(await reader.call("review_proposal", { project_id: P, proposal_id: p.proposal_id, decision: "approve", idempotency_key: key() })).code, "review_forbidden", "review in another project grants nothing here");
  assert.equal((await allowReview("oauth", reviewerConn, P, false)).status, 200);
  assert.equal(err(await reviewer.call("review_proposal", { project_id: P, proposal_id: p.proposal_id, decision: "approve", idempotency_key: key() })).code, "review_forbidden");
  assert.equal((await allowReview("oauth", reviewerConn)).status, 200);
  // API key: review granted, carried over on replace, removed with the project.
  assert.equal((await allowReview("api_key", apiKeyId)).status, 200);
  const rep = await owner.req("POST", `/api/api-keys/${apiKeyId}/replace`, {});
  assert.equal(rep.status, 201);
  const lp = await api("GET", `/projects/${P}/proposals`, undefined, rep.body.secret);
  assert.equal(lp.body.can_review, true, "replacing a key keeps its review permission");
  apiKey = rep.body.secret; apiKeyId = rep.body.id;
  // Live: revoking the reviewer's connection ends review at once.
  const extra = await h.connectMcpAgent({ [P]: "read" }, { clientName: "Temp reviewer" });
  const tid = await connId("Temp reviewer");
  assert.equal((await allowReview("oauth", tid)).status, 200);
  assert.equal((await owner.req("POST", `/api/connections/${tid}/revoke`)).status, 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM review_grants WHERE path_id = '${tid}'`)[0].n, 0, "revoking drops review permission");
  assert.equal((await allowReview("oauth", tid)).status, 404, "no review permission for a revoked connection");
  assert.equal((await extra.call("review_proposal", { project_id: P, proposal_id: p.proposal_id, decision: "approve", idempotency_key: key() })).isError, true);
  assert.equal(sql(`SELECT status FROM proposals WHERE id = '${p.proposal_id}'`)[0].status, "pending");
});

test("advisory: reviews bind to one version; later edits are unreviewed; reviewed=true reads it; owner saves are not auto-reviewed", async () => {
  const id = await ownerDoc("Advisory", "v1");
  const m = await setMode(id, "advisory");
  assert.equal(m.reviewed_revision, null);
  ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "v2 by agent", change_note: "e", idempotency_key: key() }));
  assert.equal(err(await writer.call("review_revision", { project_id: P, artifact_id: id, revision: 2, idempotency_key: key() })).code, "review_forbidden");
  ok(await reviewer.call("review_revision", { project_id: P, artifact_id: id, revision: 2, note: "checked", idempotency_key: key() }));
  ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 2, body: "v3 unreviewed", change_note: "e", idempotency_key: key() }));
  assert.equal((await owner.req("PUT", art(id), { expected_revision: 3, body: "v4 owner autosave" })).status, 200);
  const cur = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id }));
  assert.equal(cur.body, "v4 owner autosave"); assert.equal(cur.artifact.review.reviewed_revision, 2);
  const rv = ok(await reader.call("read_artifact", { project_id: P, artifact_id: id, reviewed: true }));
  assert.equal(rv.body, "v2 by agent"); assert.equal(rv.revision.rev, 2);
  assert.equal((await api("GET", `/projects/${P}/files/${id}?revision=reviewed`)).body.body, "v2 by agent");
  // A later rejection of the same version withdraws it from "reviewed".
  ok(await reviewer.call("review_revision", { project_id: P, artifact_id: id, revision: 2, decision: "rejected", note: "on second look", idempotency_key: key() }));
  assert.equal(ok(await reader.call("read_artifact", { project_id: P, artifact_id: id })).artifact.review.reviewed_revision, null);
  // Owner marks the current version reviewed; switching to required keeps exactly that state.
  assert.equal((await owner.req("POST", art(id) + "/revisions/4/review", { decision: "approved" })).status, 200);
  assert.equal((await setMode(id, "required")).reviewed_revision, 4);
});

test("owner settings: mode change is revision-guarded; apply-to-existing refuses a stale setting and reports what it changed", async () => {
  const id = await ownerDoc("Guarded");
  ok(await writer.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "agent slipped in", change_note: "x", idempotency_key: key() }));
  const stale = await owner.req("PUT", art(id) + "/review-mode", { mode: "required", expected_revision: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.current_revision, 2);
  const ag = agentHttp(h.appUi, legacyGrant.token);
  assert.equal((await ag("PUT", art(id) + "/review-mode", { mode: "off", expected_revision: 2 })).status, 403);
  assert.equal((await owner.req("PUT", base + "/review-settings", { default: "advisory", kinds: ["html"] })).status, 200);
  const wrong = await owner.req("POST", base + "/review-settings/apply", { expected_default: "off" });
  assert.equal(wrong.status, 409, "a page showing a different setting never applies the saved one"); assert.equal(wrong.body.error.code, "settings_changed");
  const ap = await owner.req("POST", base + "/review-settings/apply", { expected_default: "advisory" });
  assert.equal(ap.status, 200); assert.ok(Array.isArray(ap.body.updated));
  assert.equal((await owner.req("PUT", base + "/review-settings", { default: "off" })).status, 200);
});

test("every agent write path is gated: templates, JSON data files, legacy /mcp; search shows only approved text; publishers exempt", async () => {
  // Fresh connections: the earlier tests use up the shared ones' per-minute budgets (fixed 60 reads/min per OAuth connection).
  const rv2 = await h.connectMcpAgent({ [P]: "read" }, { clientName: "Reviewer Two" });
  assert.equal((await allowReview("oauth", await connId("Reviewer Two"))).status, 200);
  const rd2 = await h.connectMcpAgent({ [P]: "read" }, { clientName: "Reader Two" });
  const wr2 = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Writer Three" });
  // Template copies in a required project become hidden new documents too.
  const src = await ownerDoc("Template source", "# Weekly\n\nNotes:");
  const t = await owner.req("POST", base + "/templates", { source_artifact_id: src, source_revision: 1, title: "Weekly", description: "d" });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal((await owner.req("PUT", base + "/review-settings", { default: "required" })).status, 200);
  try {
    const c = ok(await wr2.call("create_from_template", { project_id: P, template_id: t.body.artifact_id, template_revision: 1, title: "Week 1", date: "2026-10-27", change_note: "w", idempotency_key: key() }));
    assert.equal(c.status, "pending_review", JSON.stringify(c));
    assert.equal(err(await rd2.call("read_artifact", { project_id: P, artifact_id: c.artifact_id })).code, "not_found");
    ok(await wr2.call("withdraw_proposal", { project_id: P, proposal_id: c.proposal_id, idempotency_key: key() }));
  } finally { assert.equal((await owner.req("PUT", base + "/review-settings", { default: "off" })).status, 200); }
  // JSON data files (App Connect on): /v1 saves become proposals.
  const j = await owner.req("POST", base + "/artifacts", { kind: "json", title: "Data", content: "{\"a\":1}" });
  assert.equal(j.status, 201, JSON.stringify(j.body)); await setMode(j.body.artifact_id, "required");
  const js = await api("PUT", `/projects/${P}/files/${j.body.artifact_id}`, { expected_revision: 1, content: "{\"a\":2}", change_note: "j" });
  assert.equal(js.body.status, "pending_review", JSON.stringify(js.body));
  assert.equal((await api("GET", `/projects/${P}/files/${j.body.artifact_id}`)).body.content, "{\"a\":1}");
  // Approve with edits on JSON validates the reviewer's text like any save.
  assert.equal(err(await rv2.call("review_proposal", { project_id: P, proposal_id: js.body.proposal_id, decision: "approve", body: "{not json", expected_revision: 1, idempotency_key: key() })).code, "invalid_content");
  ok(await rv2.call("review_proposal", { project_id: P, proposal_id: js.body.proposal_id, decision: "approve", body: "{\"a\":3}", expected_revision: 1, idempotency_key: key() }));
  assert.equal((await api("GET", `/projects/${P}/files/${j.body.artifact_id}`)).body.content, "{\"a\":3}");
  // Legacy /mcp (agent token): saves are proposals, reviewed reads work, review tools only with permission.
  const id = await ownerDoc("Legacy", "legacy v1 zebraword"); await setMode(id, "required");
  const lp = ok(await legacy.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 1, body: "legacy draft quokkaword", change_note: "l", idempotency_key: key() }));
  assert.equal(lp.status, "pending_review");
  assert.equal(ok(await legacy.call("read_artifact", { project_id: P, artifact_id: id, reviewed: true })).body, "legacy v1 zebraword");
  const names = (await legacy.client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes("list_proposals") && !names.includes("review_proposal"), "legacy lists review tools only with permission");
  // Search never sees pending text.
  for (const c of [rd2, wr2]) {
    const hits = ok(await c.call("search_artifacts", { query: "quokkaword" }));
    assert.equal((hits.results ?? []).length, 0, "pending text is not searchable");
  }
  assert.ok((ok(await rd2.call("search_artifacts", { query: "zebraword" })).results ?? []).some((r) => r.artifact_id === id), "approved text is");
  // Publishers (App Connect) are never gated, even with a required project default. (Own project: projects with
  // App Connect files can't be backed up yet, and the backup test below exports P.)
  const PP = "rvw-pub";
  assert.equal((await owner.req("POST", "/api/projects", { id: PP, title: "Exports" })).status, 201);
  assert.equal((await owner.req("PUT", `/api/projects/${PP}/review-settings`, { default: "required" })).status, 200);
  {
    const app = await h.registerApp({ display_name: "Synthetic exporter", redirect_uris: ["http://localhost:5175/cb"], origins: [] });
    const pub = await h.connectPublisher(app, { project_id: PP, destination: "new", new_folder_name: "Exports" });
    const json = JSON.stringify({ schema: "agentlib.measurements/1", meta: { source_app: "synthetic" }, records: [] });
    const r = await h.pub(pub.access_token, "POST", "/publisher/snapshots", { idem: key("snap"), body: { source_revision: 1, exported_at: "2026-10-03T00:00:12-07:00", coverage: { from: null, to: null },
      files: [{ name: "export.json", kind: "json", role: "authoritative", schema: "agentlib.measurements/1", content: json }] } });
    assert.equal(r.status, 201, r.text.slice(0, 300));
    const rows = sql(`SELECT review_mode, pending_review, head_rev FROM artifacts WHERE publisher_id = '${pub.publisher_id}'`);
    assert.ok(rows.length >= 1); for (const x of rows) { assert.equal(x.review_mode, "off"); assert.equal(x.pending_review, 0); assert.ok(x.head_rev >= 1); }
  }
});

test("database gate: a rolled-back Worker's agent writes to required documents fail closed; owner and publisher writes don't", async () => {
  const id = await ownerDoc("Rollback"); await setMode(id, "required");
  // Simulate the previous Worker: a direct agent revision insert with no proposal.
  for (const via of ["oauth", "api_key", "grant"]) assert.match(sqlRefused(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind, via_id)
    SELECT 'rev_rollback_${via}', id, project_id, 2, (SELECT owner_id FROM projects WHERE id = project_id), 'bypass', 6, 'h', 'text/markdown', '2026', '${via}', 'x' FROM artifacts WHERE id = '${id}'`), /review_required/);
  assert.match(sqlRefused(`INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, created_at)
    SELECT 'mv_rollback', id, project_id, 9, 't', '', '[]', 0, (SELECT owner_id FROM projects WHERE id = project_id), 'grant', '2026' FROM artifacts WHERE id = '${id}'`), /review_required/);
  // A proposal id alone is not enough: it must be an approval in progress for this document.
  assert.match(sqlRefused(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind, via_id, proposal_id)
    SELECT 'rev_forged', id, project_id, 2, (SELECT owner_id FROM projects WHERE id = project_id), 'bypass', 6, 'h', 'text/markdown', '2026', 'oauth', 'x', (SELECT id FROM proposals LIMIT 1) FROM artifacts WHERE id = '${id}'`), /review_required/);
  // Owner and publisher versions are never gated (the author is a real principal: foreign keys are enforced).
  for (const [n, via] of [[98, "publisher"], [99, "browser"]]) sql(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind)
    SELECT 'rev_${via}_ok', a.id, a.project_id, ${n}, p.owner_id, 'ok', 2, 'h', 'text/markdown', '2026', '${via}' FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE a.id = '${id}'`);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${id}' AND id LIKE 'rev_%_ok'`)[0].n, 2);
  sql(`DELETE FROM revisions WHERE id LIKE 'rev_%_ok'`); // synthetic hashes; keep the later backup round trip honest
  // A mode flip between a gate check and the write surfaces as a conflict, never a 500.
  const off = await ownerDoc("Flip");
  sql(`UPDATE artifacts SET review_mode = 'required' WHERE id = '${off}'`);
  const r = await legacy.call("save_markdown", { project_id: P, artifact_id: off, expected_revision: 1, body: "x", idempotency_key: key() });
  assert.equal(r.isError, false, "the service re-reads the mode and proposes");
});

test("backup /3 round trip keeps modes, proposals, reviews and pre-review agent history", async () => {
  const ex = await owner.req("GET", base + "/backup");
  assert.equal(ex.status, 200, JSON.stringify(ex.body).slice(0, 300));
  assert.equal(ex.body.schema, "agent-library-backup/3");
  assert.ok(ex.body.review.proposals.length > 0 && ex.body.review.reviews.length > 0);
  const fresh = await startAppConnectServer({ port: SERVER_PORTS["review-gating-restore"] });
  try {
    const o2 = await fresh.owner();
    // Crafted backups are refused before anything is written: a purged proposal can't point at another project's
    // bytes, a pending one can't be "purged", and the project default's kinds must be valid.
    const bad = (mut) => { const b = structuredClone(ex.body); mut(b); return o2.req("POST", "/api/restore", b); };
    const anyProp = (b) => b.review.proposals[0];
    for (const [why, mut] of [
      ["foreign key on a purged proposal", (b) => Object.assign(anyProp(b), { blob_key: "blobs/other-project/x/y", blob_purged_at: "2000-01-01T00:00:00Z", status: "rejected" })],
      ["pending with purged bytes", (b) => Object.assign(anyProp(b), { blob_key: `blobs/${P}/x/y`, blob_purged_at: "2000-01-01T00:00:00Z", status: "pending" })],
      ["malformed kinds", (b) => { b.review.kinds = "not json"; }]
    ]) { const r = await bad(mut); assert.equal(r.status, 400, why + ": " + JSON.stringify(r.body)); assert.equal(r.body.error.code, "bad_backup", why); }
    const r = await o2.req("POST", "/api/restore", ex.body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const q = JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", fresh.dir, "--json", "--command",
      "SELECT (SELECT COUNT(*) FROM proposals) AS p, (SELECT COUNT(*) FROM reviews) AS r, (SELECT COUNT(*) FROM artifacts WHERE review_mode = 'required') AS m, (SELECT COUNT(*) FROM review_restore_context) AS c"],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results[0];
    assert.equal(q.p, ex.body.review.proposals.length); assert.equal(q.r, ex.body.review.reviews.length);
    assert.equal(q.m, ex.body.review.modes.filter((m) => m.review_mode === "required").length); assert.equal(q.c, 0, "restore context removed");
  } finally { await fresh.stop(); }
});
