// Workspace limits (Phase 4, docs/limits.md) against a real local server built with the PLAN_LIMITS entitlements:
// every limit refuses with 402 limit_reached and writes nothing; concurrent requests can't overshoot (the check is in
// the INSERT); an over-limit workspace keeps its data; a paid plan lifts the limit; self-host (no PLAN_LIMITS) is
// unlimited. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startServer, agentHttp, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { buildWorker } from "../scripts/build.mjs";

const PORT = SERVER_PORTS["plan-limits"];
const APP = `http://localhost:${PORT}`, API = `http://127.0.0.1:${PORT}`;
const PLANS = {
  free: { storage_bytes: 4000, projects: 3, members: 3, pending_invites: 2, agents: 2, owned_workspaces: 1, items_per_project: 6, file_bytes: 3000, max_key_lifetime_days: 90 },
  // file_bytes above core's 90 MiB ceiling is capped; rate_multiplier doubles the agent rate limits.
  pro: { storage_bytes: 1000000, projects: 50, members: 20, pending_invites: 20, agents: 20, owned_workspaces: 3, items_per_project: 1000, file_bytes: 200 * 1024 * 1024, rate_multiplier: 2 }
};
let s, alice, bob;
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const refused = (r, limit) => {
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "limit_reached"); assert.equal(r.body.error.limit, limit);
  assert.ok(Number.isInteger(r.body.error.allowed));
  assert.ok(limit === "max_key_lifetime_days" || Number.isInteger(r.body.error.used));
  return r.body.error;
};
const W = {};

before(async () => {
  const out = join(ROOT, "tmp", "test-worker-limits", "index.js");
  await buildWorker({ entry: join(ROOT, "test/fixtures/limits-worker.js"), outfile: out });
  s = await startServer("plan-limits", PORT, { worker: out, readyBase: APP, vars: {
    // Default rate limits (agents 240 reads / 60 writes a minute, people 3×): the rate test measures them.
    // PROJECT_BINARY_BYTES "0" (as hosted): no per-project file cap, so uploads here are governed by storage_bytes.
    MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, PLAN_LIMITS: JSON.stringify(PLANS), RATE_AUTHFAIL_PER_MIN: "100000", PROJECT_BINARY_BYTES: "0" } });
  alice = await s.loginAt(APP, "alice"); bob = await s.loginAt(APP, "bob");
});
after(async () => { await s?.stop(); });

test("projects: the limit refuses the next one (402) and writes nothing; usage endpoint reports it", async () => {
  W.team = ok(await alice.req("POST", "/api/workspaces", { name: "Team" }), 201).id;
  for (let i = 0; i < 3; i++) ok(await alice.req("POST", "/api/projects", { title: `P${i}`, workspace_id: W.team }), 201);
  const before = sql(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = '${W.team}'`)[0].n;
  const e = refused(await alice.req("POST", "/api/projects", { title: "P3", workspace_id: W.team }), "projects");
  assert.deepEqual([e.used, e.allowed], [3, 3]);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = '${W.team}'`)[0].n, before);
  const u = ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`));
  assert.deepEqual(u.projects, { used: 3, limit: 3 });
  assert.equal(u.storage_bytes.limit, 4000);
  assert.deepEqual(u.file_bytes, { limit: 3000 });
  assert.deepEqual(u.max_key_lifetime_days, { limit: 90 });
  assert.deepEqual(u.pending_invites, { used: 0, limit: 2 });
  // Bob isn't a member: no usage for him.
  assert.equal((await bob.req("GET", `/api/workspaces/${W.team}/usage`)).status, 404);
});

test("projects: deleting one frees its slot at once; restoring needs a free slot (D21)", async () => {
  const e = refused(await alice.req("POST", "/api/projects", { title: "P3", workspace_id: W.team }), "projects");
  assert.match(e.message, /Delete a project you no longer need \(Project settings\)/);
  const list = ok(await alice.req("GET", "/api/projects")).projects.filter((p) => p.workspace_id === W.team);
  const victim = list[0];
  ok(await alice.req("DELETE", `/api/projects/${victim.id}`, { confirm_title: victim.title }));
  assert.deepEqual(ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`)).projects, { used: 2, limit: 3 });
  const fresh = ok(await alice.req("POST", "/api/projects", { title: "P3", workspace_id: W.team }), 201);
  // Full again: the deleted one can't come back until there's room.
  const r = refused(await alice.req("POST", `/api/projects/${victim.id}/restore`), "projects");
  assert.deepEqual([r.used, r.allowed], [3, 3]);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM projects WHERE id = '${victim.id}' AND deleted_at IS NOT NULL`)[0].n, 1, "still deleted");
  ok(await alice.req("DELETE", `/api/projects/${fresh.id}`, { confirm_title: "P3" }));
  ok(await alice.req("POST", `/api/projects/${victim.id}/restore`));
  assert.deepEqual(ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`)).projects, { used: 3, limit: 3 });
});

test("concurrent creates can't overshoot (the check is inside the INSERT)", async () => {
  const ws = (await alice.req("GET", "/api/workspaces")).body.workspaces.find((w) => w.personal).id;
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => alice.req("POST", "/api/projects", { title: `Race ${i}` })));
  const made = rs.filter((r) => r.status === 201).length;
  assert.equal(made, 3, rs.map((r) => r.status).join(","));
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 402));
  assert.equal(sql(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = '${ws}'`)[0].n, 3);
});

test("storage: text saves count; the save that would exceed it is refused; the document keeps its last revision", async () => {
  const p = ok(await alice.req("GET", "/api/projects")).projects.find((x) => x.workspace_id === W.team).id;
  W.p = p;
  const doc = ok(await alice.req("POST", `/api/projects/${p}/artifacts`, { title: "Notes", body: "x".repeat(1500) }), 201);
  ok(await alice.req("PUT", `/api/projects/${p}/artifacts/${doc.artifact_id}`, { expected_revision: 1, body: "y".repeat(1500) }));
  // 3000 used of 4000: a 1500-byte save doesn't fit (every revision is kept, so it counts).
  refused(await alice.req("PUT", `/api/projects/${p}/artifacts/${doc.artifact_id}`, { expected_revision: 2, body: "z".repeat(1500) }), "storage_bytes");
  const cur = ok(await alice.req("GET", `/api/projects/${p}/artifacts/${doc.artifact_id}`));
  assert.equal(cur.revision.rev, 2);
  refused(await alice.req("POST", `/api/projects/${p}/artifacts`, { title: "More", body: "w".repeat(1500) }), "storage_bytes");
  // A small one still fits.
  ok(await alice.req("POST", `/api/projects/${p}/artifacts`, { title: "Small", body: "tiny" }), 201);
  // Files: an upload reserves its size when it begins, so a second upload (another identity) sees that reservation.
  const used = ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`)).storage_bytes.used;
  const room = 4000 - used;
  const png = (n) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(n - 8)]);
  const begin = (who, buf) => who.req("POST", `/api/projects/${p}/uploads`, { title: "img.png", mime: "image/png", size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") }, { headers: { "idempotency-key": key("u") } });
  const big = png(room + 1);
  refused(await begin(alice, big), "storage_bytes");
  const half = png(Math.floor(room / 2) + 10);
  const g = ok(await alice.req("POST", `/api/projects/${p}/grants`, { label: "uploader", can_write: true }), 201);
  const agent = agentHttp(APP, g.token);
  const up = await agent("POST", `/api/projects/${p}/uploads`, { title: "a.png", mime: "image/png", size: half.length, sha256: createHash("sha256").update(half).digest("hex") });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const second = await begin(alice, half);
  refused(second, "storage_bytes");
  // Finish the first upload; restoring that file version adds another revision of its size, which doesn't fit.
  assert.equal((await agent("PUT", up.body.put_url, undefined, { raw: half })).status, 200);
  const fin = await agent("POST", `/api/projects/${p}/uploads/${up.body.upload_id}/finish`, {});
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const rs = await agent("POST", `/api/projects/${p}/artifacts/${fin.body.artifact_id}/restore`, { expected_revision: 1, from_revision: 1 });
  refused(rs, "storage_bytes");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${fin.body.artifact_id}'`)[0].n, 1);
  ok(await alice.req("PATCH", `/api/projects/${p}/grants/${g.grant_id}`, { revoke: true }));
});

test("file size: a file over the plan's file_bytes is refused at begin (413) with the limit; nothing is left behind", async () => {
  const r = await alice.req("POST", `/api/projects/${W.p}/uploads`, { title: "huge.bin", mime: "application/octet-stream", size: 3001, sha256: "a".repeat(64) }, { headers: { "idempotency-key": key("u") } });
  assert.equal(r.status, 413, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "too_large");
  assert.deepEqual([r.body.error.limit, r.body.error.allowed], ["file_bytes", 3000]);
  assert.match(r.body.error.message, /^Files can be up to 2\.9 KB on this plan/);
  assert.equal(sql("SELECT COUNT(*) AS n FROM artifacts WHERE title = 'huge.bin'")[0].n, 0);
});

test("items per project: documents and new files count (trashed too); the next one is refused (402) and writes nothing", async () => {
  const count = () => sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${W.p}' AND publisher_id IS NULL`)[0].n;
  while (count() < 5) ok(await alice.req("POST", `/api/projects/${W.p}/artifacts`, { title: `Item ${count()}`, body: "i" }), 201);
  const last = ok(await alice.req("POST", `/api/projects/${W.p}/artifacts`, { title: "Item last", body: "i" }), 201);
  // Trashed documents still count until they're removed from the trash.
  ok(await alice.req("PATCH", `/api/projects/${W.p}/artifacts/${last.artifact_id}`, { expected_meta_version: 1, trashed: true }));
  const e = refused(await alice.req("POST", `/api/projects/${W.p}/artifacts`, { title: "One too many", body: "i" }), "items_per_project");
  assert.deepEqual([e.used, e.allowed], [6, 6]);
  assert.match(e.message, /documents and files in one project \(6\)\. Delete or empty the trash/);
  // A new file is a new item: refused at begin, no placeholder or reservation left.
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)]);
  const up = { mime: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex") };
  refused(await alice.req("POST", `/api/projects/${W.p}/uploads`, { title: "new.png", ...up }, { headers: { "idempotency-key": key("u") } }), "items_per_project");
  assert.equal(count(), 6);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM uploads WHERE project_id = '${W.p}' AND state = 'pending'`)[0].n, 0);
  // A new version of an existing file isn't a new item.
  const file = sql(`SELECT id, head_rev FROM artifacts WHERE project_id = '${W.p}' AND kind = 'binary' AND head_rev > 0 LIMIT 1`)[0];
  const b = ok(await alice.req("POST", `/api/projects/${W.p}/uploads`, { artifact_id: file.id, expected_revision: file.head_rev, ...up }, { headers: { "idempotency-key": key("u") } }), 201);
  assert.equal((await alice.req("PUT", b.put_url, undefined, { raw: png })).status, 200);
  ok(await alice.req("POST", `/api/projects/${W.p}/uploads/${b.upload_id}/finish`, {}));
  // Concurrent creates can't overshoot: another project with 5 of 6, four at once.
  const q = ok(await alice.req("GET", "/api/projects")).projects.find((x) => x.workspace_id === W.team && x.id !== W.p).id;
  const n = () => sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = '${q}'`)[0].n;
  while (n() < 5) ok(await alice.req("POST", `/api/projects/${q}/artifacts`, { title: `Q ${n()}`, body: "q" }), 201);
  const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => alice.req("POST", `/api/projects/${q}/artifacts`, { title: `Race item ${i}`, body: "r" })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 402, 402, 402], JSON.stringify(rs.map((r) => r.body)));
  assert.equal(n(), 6);
});

test("import: a backup with more documents than the plan's items_per_project is refused with that number", async () => {
  // W.p holds 6 items (the free plan's maximum); import into a workspace on a plan allowing fewer.
  const bk = ok(await alice.req("GET", `/api/projects/${W.p}/backup`));
  assert.ok(bk.artifacts.length >= 6);
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  // The free plan allows 6: add a seventh (a synthetic copy of the first document).
  const extra = { ...bk.artifacts[0], id: "art_synthetic_extra" };
  const head = bk.revisions.find((r) => r.id === extra.head_revision_id);
  const big = { ...bk, artifacts: [...bk.artifacts, extra], revisions: [...bk.revisions, { ...head, id: "rev_synthetic_extra", artifact_id: "art_synthetic_extra" }] };
  big.artifacts[big.artifacts.length - 1].head_revision_id = "rev_synthetic_extra";
  const r = await alice.req("POST", `/api/workspaces/${W.team}/import`, { backup: big, title: "Too many" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "bad_backup");
  assert.match(r.body.error.message, /at most 6 documents and files on this plan/);
});

test("import: a file larger than the plan's file_bytes is refused", async () => {
  // A real, correctly hashed 3,001-byte PNG in a backup of W.p's file; the free plan allows 3,000-byte files.
  const bk = ok(await alice.req("GET", `/api/projects/${W.p}/backup`));
  const file = bk.revisions.find((r) => r.blob_key !== null);
  assert.ok(file, "W.p holds a file");
  const big = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3001 - 8)]);
  const rev = { ...file, size: big.length, sha256: createHash("sha256").update(big).digest("hex") };
  const art = { ...bk.artifacts.find((a) => a.id === file.artifact_id), head_rev: file.rev_no, head_revision_id: file.id };
  const one = { ...bk, artifacts: [art], revisions: [rev], comments: [], meta_versions: (bk.meta_versions ?? []).filter((m) => m.artifact_id === art.id),
    blobs: { [file.blob_key]: { sha256: rev.sha256, data: big.toString("base64") } } };
  sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${W.team}'`);
  const fits = await alice.req("POST", `/api/workspaces/${W.team}/import`, { backup: one, title: "Big file ok" });
  assert.equal(fits.status, 201, "the same backup imports on a plan that allows the file: " + JSON.stringify(fits.body));
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  const r = await alice.req("POST", `/api/workspaces/${W.team}/import`, { backup: one, title: "Big file" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /A file is larger than this plan allows \(2\.9 KB\)/);
  ok(await alice.req("DELETE", `/api/projects/${fits.body.project_id ?? fits.body.id}`, { confirm_title: "Big file ok" }));
});

test("members: only accepted members count; pending invitations have their own limit; accepting needs a free member slot", async () => {
  ok(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "bob@example.test", role: "member" }), 201);
  ok(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "carol@example.test", role: "viewer" }), 201);
  const u = ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`));
  assert.deepEqual([u.members, u.pending_invites], [{ used: 1, limit: 3 }, { used: 2, limit: 2 }]);
  const e = refused(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "dave@example.test", role: "viewer" }), "pending_invites");
  assert.match(e.message, /pending invitations \(2\)\. Cancel a pending invitation/);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM workspace_invites WHERE workspace_id = '${W.team}' AND email = 'dave@example.test'`)[0].n, 0);
  // Revoking one frees a slot.
  const pending = ok(await alice.req("GET", `/api/workspaces/${W.team}/members`)).invites;
  ok(await alice.req("POST", `/api/workspaces/${W.team}/invites/${pending.find((i) => i.email === "carol@example.test").id}/revoke`, {}));
  const dave = ok(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "dave@example.test", role: "viewer" }), 201);
  // A second member (added directly): two of three.
  await s.loginAt(APP, "erin");
  sql(`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) SELECT '${W.team}', id, 'viewer', '2026-01-01T00:00:00Z' FROM principals WHERE email = 'erin@example.test'`);
  const daveP = await s.loginAt(APP, "dave");
  const token = dave.accept_url.split("/").pop();
  // Two members of three: dave can join; then the workspace is full.
  ok(await daveP.req("POST", "/api/invites/accept", { token }));
  assert.deepEqual(ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`)).members, { used: 3, limit: 3 });
  // Full: a new invitation is refused up front (courtesy), and an existing one can't be accepted (402, nothing changes).
  refused(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "frank@example.test", role: "viewer" }), "members");
  // Over the limit, re-inviting a pending address is refused and leaves the pending invitation working.
  const bobInvite = sql(`SELECT id, token_hash FROM workspace_invites WHERE workspace_id = '${W.team}' AND email = 'bob@example.test' AND revoked_at IS NULL`)[0];
  refused(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "bob@example.test", role: "member" }), "members");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM workspace_invites WHERE id = '${bobInvite.id}' AND revoked_at IS NULL`)[0].n, 1);
  // With room, re-inviting bob replaces his pending invitation; then the workspace fills up before he accepts.
  sql(`DELETE FROM workspace_members WHERE workspace_id = '${W.team}' AND principal_id = (SELECT id FROM principals WHERE email = 'dave@example.test')`);
  const bobNew = ok(await alice.req("POST", `/api/workspaces/${W.team}/invites`, { email: "bob@example.test", role: "member" }), 201);
  sql(`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at) SELECT '${W.team}', id, 'viewer', '2026-01-01T00:00:00Z' FROM principals WHERE email = 'dave@example.test'`);
  const full = await bob.req("POST", "/api/invites/accept", { token: bobNew.accept_url.split("/").pop() });
  const fe = refused(full, "members");
  assert.match(fe.message, /^This workspace is full: its plan allows 3 members\. Ask the person who invited you to free up a spot or upgrade the plan, then open this invitation again\.$/);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = '${W.team}' AND principal_id = (SELECT id FROM principals WHERE email = 'bob@example.test')`)[0].n, 0);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM workspace_invites WHERE id = '${bobNew.id}' AND accepted_at IS NULL AND revoked_at IS NULL`)[0].n, 1, "the invitation still works once there's room");
  // Room again: the same link works.
  sql(`DELETE FROM workspace_members WHERE workspace_id = '${W.team}' AND principal_id = (SELECT id FROM principals WHERE email = 'dave@example.test')`);
  ok(await bob.req("POST", "/api/invites/accept", { token: bobNew.accept_url.split("/").pop() }));
});

test("connected agents: API keys and grant tokens count; replacing a key needs a slot; revoking frees one", async () => {
  const mk = (label) => alice.req("POST", "/api/api-keys", { label, projects: [{ project_id: W.p, access: "read" }] });
  const k1 = ok(await mk("one"), 201);
  const g = ok(await alice.req("POST", `/api/projects/${W.p}/grants`, { label: "grant-two" }), 201);
  refused(await alice.req("POST", `/api/projects/${W.p}/grants`, { label: "grant-three" }), "agents");
  assert.equal(sql("SELECT COUNT(*) AS n FROM principals WHERE label = 'grant-three'")[0].n, 0, "refused grant wrote nothing");
  ok(await alice.req("PATCH", `/api/projects/${W.p}/grants/${g.grant_id}`, { revoke: true }));
  const k2 = ok(await mk("two"), 201);
  refused(await mk("three"), "agents");
  // The old key keeps working until it's revoked, so a replacement needs a free slot too.
  refused(await alice.req("POST", `/api/api-keys/${k1.id}/replace`, {}), "agents");
  assert.equal(sql("SELECT COUNT(*) AS n FROM api_credentials WHERE label = 'three'")[0].n, 0);
  assert.equal(sql("SELECT COUNT(*) AS n FROM principals WHERE label = 'three'")[0].n, 0, "no orphan agent principal");
  // The refused key's would-be secret is useless; existing keys still work.
  const A = agentHttp(API, k1.secret);
  assert.equal((await fetch(`${API}/v1/projects`, { headers: { authorization: `Bearer ${k1.secret}` } })).status, 200); void A;
  ok(await alice.req("POST", `/api/api-keys/${k2.id}/revoke`, {}));
  ok(await mk("three"), 201);
});

test("shared workspaces per person; a paid plan lifts the limits; over-limit keeps data (downgrade)", async () => {
  refused(await alice.req("POST", "/api/workspaces", { name: "Second" }), "owned_workspaces");
  // The person's limit follows their personal workspace's plan: on pro (3), a second and third fit, a fourth doesn't.
  const personal = ok(await alice.req("GET", "/api/workspaces")).workspaces.find((w) => w.personal).id;
  sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${personal}'`);
  ok(await alice.req("POST", "/api/workspaces", { name: "Second" }), 201);
  ok(await alice.req("POST", "/api/workspaces", { name: "Third" }), 201);
  refused(await alice.req("POST", "/api/workspaces", { name: "Fourth" }), "owned_workspaces");
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${personal}'`);
  refused(await alice.req("POST", "/api/workspaces", { name: "Fourth" }), "owned_workspaces");
  // Billing moves Team to pro: more projects fit.
  sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${W.team}'`);
  ok(await alice.req("POST", "/api/projects", { title: "P4", workspace_id: W.team }), 201);
  ok(await alice.req("POST", "/api/projects", { title: "P5", workspace_id: W.team }), 201);
  // Downgrade: 5 projects on a 3-project plan. Everything stays readable; new projects are refused.
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  const list = ok(await alice.req("GET", "/api/projects")).projects.filter((p) => p.workspace_id === W.team);
  assert.equal(list.length, 5);
  for (const p of list) ok(await alice.req("GET", `/api/projects/${p.id}/artifacts`));
  refused(await alice.req("POST", "/api/projects", { title: "P6", workspace_id: W.team }), "projects");
  // An unknown plan is unlimited (fail-open on plan data, never on access).
  sql(`UPDATE workspaces SET plan = 'legacy-unlisted' WHERE id = '${W.team}'`);
  ok(await alice.req("POST", "/api/projects", { title: "P6", workspace_id: W.team }), 201);
});

test("API key lifetimes: the plan's max_key_lifetime_days refuses longer keys (402); no maximum allows never", async () => {
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  const mk = (lifetime_days) => alice.req("POST", "/api/api-keys", { label: "life", lifetime_days, projects: [{ project_id: W.p, access: "read" }] });
  for (const d of [365, "never"]) {
    const e = refused(await mk(d), "max_key_lifetime_days");
    assert.equal(e.allowed, 90); assert.match(e.message, /^Keys on this plan can last up to 90 days/);
  }
  assert.equal(sql("SELECT COUNT(*) AS n FROM api_credentials WHERE label = 'life'")[0].n, 0);
  assert.equal((await mk(45)).status, 400, "only the listed lifetimes");
  sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${W.team}'`);
  const k = ok(await mk("never"), 201);
  assert.equal(k.expires_at, "9999-01-01T00:00:00.000Z");
  assert.equal(ok(await alice.req("GET", "/api/api-keys")).keys.find((x) => x.id === k.id).status, "active");
  assert.equal((await fetch(`${API}/v1/projects`, { headers: { authorization: `Bearer ${k.secret}` } })).status, 200);
  ok(await alice.req("POST", `/api/api-keys/${k.id}/revoke`, {}));
  // A plan lowered after a key was made: the key lasts at most max_key_lifetime_days from its creation.
  const old = ok(await mk("never"), 201);
  sql(`UPDATE api_credentials SET created_at = '${new Date(Date.now() - 91 * 864e5).toISOString()}' WHERE id = '${old.id}'`);
  assert.equal((await fetch(`${API}/v1/projects`, { headers: { authorization: `Bearer ${old.secret}` } })).status, 200, "pro: no maximum");
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  const exp = await fetch(`${API}/v1/projects`, { headers: { authorization: `Bearer ${old.secret}` } });
  assert.equal(exp.status, 401);
  assert.equal((await exp.json()).error.code, "credential_expired");
  sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${W.team}'`);
  assert.equal((await fetch(`${API}/v1/projects`, { headers: { authorization: `Bearer ${old.secret}` } })).status, 200, "back on pro, it works again");
  ok(await alice.req("POST", `/api/api-keys/${old.id}/revoke`, {}));
  // file_bytes above core's ceiling is capped at 90 MiB.
  assert.deepEqual(ok(await alice.req("GET", `/api/workspaces/${W.team}/usage`)).file_bytes, { limit: 90 * 1024 * 1024 });
  sql(`UPDATE workspaces SET plan = 'legacy-unlisted' WHERE id = '${W.team}'`);
});

test("agent rate limits: 60 writes a minute by default; the plan's rate_multiplier doubles it", async () => {
  // A fresh minute so the whole burst shares one window.
  const left = 60_000 - (Date.now() % 60_000); if (left < 25_000) await new Promise((r) => setTimeout(r, left + 200));
  sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${W.team}'`); // room for the two grant tokens
  const grants = { free: ok(await alice.req("POST", `/api/projects/${W.p}/grants`, { label: "rate-free", can_write: true }), 201),
    pro: ok(await alice.req("POST", `/api/projects/${W.p}/grants`, { label: "rate-pro", can_write: true }), 201) };
  const burst = async (plan) => {
    sql(`UPDATE workspaces SET plan = '${plan}' WHERE id = '${W.team}'`);
    const g = grants[plan];
    const agent = agentHttp(APP, g.token);
    const codes = [];
    for (let i = 0; i < 125; i++) {
      const r = await agent("POST", `/api/projects/${W.p}/uploads/upl_none/finish`, {});
      codes.push(r.status); if (r.status === 429) break;
    }
    ok(await alice.req("PATCH", `/api/projects/${W.p}/grants/${g.grant_id}`, { revoke: true }));
    return codes.filter((c) => c !== 429).length;
  };
  assert.equal(await burst("free"), 60);
  assert.equal(await burst("pro"), 120);
  sql(`UPDATE workspaces SET plan = 'legacy-unlisted' WHERE id = '${W.team}'`);
});

test("browser: the workspace page shows plan usage; a refused project says why", async (t) => {
  const { createRequire } = await import("node:module");
  const { existsSync, mkdirSync } = await import("node:fs");
  const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const PUP = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
  if (!existsSync(CHROME) || !existsSync(PUP)) return t.skip("Chrome/puppeteer not installed");
  mkdirSync("tmp/test-evidence", { recursive: true });
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${W.team}'`);
  const browser = await createRequire(import.meta.url)(PUP).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    for (const [w, name] of [[1280, "limits-usage"], [390, "limits-usage-mobile"]]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: 1000 });
      await page.goto(APP + "/");
      await page.evaluate(async (passphrase) => fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user: "alice" }) }), s.passphrase());
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.goto(`${APP}/#/workspaces/${W.team}`); await page.reload();
      await page.waitForSelector(".usage");
      const txt = await page.$eval(".usage", (e) => e.innerText);
      assert.match(txt, /Storage\s+[\d.]+ KB of [\d.]+ KB/);
      assert.match(txt, /Projects\s+6 of 3 · over the limit/);
      assert.match(txt, /Members\s+\d+ of 3/);
      assert.match(txt, /Pending invitations\s+\d+ of 2/);
      if (w === 1280) {
        await page.type("input[aria-label='New project name']", "One too many");
        await (await page.waitForSelector("xpath/.//button[normalize-space()='Create project']")).click();
        await page.waitForFunction(() => /reached its limit for projects \(3\)\. Delete a project/.test(document.body.innerText), { timeout: 10000 });
        assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /402|limit_reached|upgrade/);
      }
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: `tmp/test-evidence/${name}.png`, fullPage: true });
      await (await page.$(".usage")).screenshot({ path: `tmp/test-evidence/${name}-members.png` });
      await page.close();
    }
  } finally { await browser.close(); }
});

test("browser: the API key form explains the plan's lifetime maximum; a never-expiring key says so", async (t) => {
  const { createRequire } = await import("node:module");
  const { existsSync, mkdirSync } = await import("node:fs");
  const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const PUP = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
  if (!existsSync(CHROME) || !existsSync(PUP)) return t.skip("Chrome/puppeteer not installed");
  mkdirSync("tmp/test-evidence", { recursive: true });
  // The form's workspace picker starts on Personal (listed first), so the hint follows the personal workspace's plan.
  const personal = ok(await alice.req("GET", "/api/workspaces")).workspaces.find((w) => w.personal).id;
  sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${personal}'`);
  const browser = await createRequire(import.meta.url)(PUP).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  const openForm = async (page) => {
    await page.goto(`${APP}/#/settings/api-keys`); await page.reload();
    await page.waitForSelector("details summary");
    await page.evaluate(() => { const d = [...document.querySelectorAll("details")].find((x) => /Create an API key/.test(x.textContent)); d.open = true; d.scrollIntoView({ block: "start" }); });
  };
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(APP + "/");
    await page.evaluate(async (passphrase) => fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, user: "alice" }) }), s.passphrase());
    const callout = await (async () => { await openForm(page); return page.$eval(".callout", (e) => e.textContent); })();
    assert.match(callout, /lasts as long as you choose \(the workspace's plan may set a maximum\) and can be replaced or revoked at any time/);
    for (const [w, name] of [[1280, "desktop"], [390, "mobile"]]) {
      await page.setViewport({ width: w, height: 900 });
      await openForm(page);
      await page.waitForFunction(() => { const e = document.querySelector(".life-hint"); return e && !e.hidden; }, { timeout: 10000 });
      assert.equal(await page.$eval(".life-hint", (e) => e.textContent), "This workspace's plan allows keys up to 90 days.");
      assert.deepEqual(await page.$$eval("select[aria-label=Lifetime] option", (os) => os.map((o) => o.textContent)), ["1 day", "7 days", "30 days", "90 days"]);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll at ${w}`);
      await (await page.$("details .card")).screenshot({ path: `tmp/test-evidence/limits-key-lifetime-cap-${name}.png` });
    }
    // No maximum: no hint, and a "Never expires" key's note says so (not "expires 1/1/9999").
    sql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${personal}'`);
    await page.setViewport({ width: 1280, height: 900 });
    await openForm(page);
    await page.waitForFunction(() => [...document.querySelectorAll("select[aria-label=Lifetime] option")].some((o) => o.value === "never"), { timeout: 10000 });
    assert.equal(await page.$eval(".life-hint", (e) => e.hidden), true);
    await page.type("input[aria-label='Key label']", "Forever key");
    await page.select("select[aria-label=Lifetime]", "never");
    await page.waitForSelector("details .scope select[aria-label^='Access to ']");
    await page.select("details .scope select[aria-label^='Access to ']", "read");
    // Submit the open create form (a click can land while the settings page re-renders after the plan change).
    await page.waitForSelector("xpath/.//button[normalize-space()='Create key']", { visible: true });
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Create key" && b.offsetParent).form.requestSubmit());
    await page.waitForFunction(() => /API key for Forever key/.test(document.body.innerText), { timeout: 10000 });
    const note = await page.evaluate(() => document.body.innerText);
    assert.match(note, /· never expires\./);
    assert.doesNotMatch(note, /9999/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "tmp/test-evidence/limits-key-never-expires.png" });
    const k = ok(await alice.req("GET", "/api/api-keys")).keys.find((x) => x.label === "Forever key");
    ok(await alice.req("POST", `/api/api-keys/${k.id}/revoke`, {}));
  } finally { await browser.close(); sql(`UPDATE workspaces SET plan = 'free' WHERE id = '${personal}'`); }
});
