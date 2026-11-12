// App Files API (/v1/app/files, slice 5a) and the publisher liveness rule it relies on (docs/app-connect.md).
// Real local wrangler dev, the official App Connect flows (owner consent, code exchange) and real HTTP; synthetic
// people and data only. Raw request paths are sent with node:http so nothing normalizes them on the way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS["app-files"];
const sha = (s) => createHash("sha256").update(s).digest("hex");
let h, owner, bob, ownerId, WSA, n = 0;
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body ?? r.json)); return r.body ?? r.json; };
const uniq = (p) => `${p}-${++n}`;

/** A one-part generation begin body (staged only; never committed here). */
const beginBody = (gid) => ({ generation_id: gid, source_revision: 1, expected_current_snapshot_id: null, root_name: `${gid}-root.json`,
  root_sha256: sha(gid), part_count: 1, total_bytes: 64 });
const genState = (gid) => sql(`SELECT state FROM publisher_generations WHERE id = '${gid}'`)[0]?.state;

/** A fresh app + publisher into project `pid` (the owner consents). */
async function connect(pid, label = uniq("app")) {
  const app = await h.registerApp({ display_name: `Files ${label}`, redirect_uris: [`https://${label}.example.test/cb`], origins: [] });
  const P = await h.connectPublisher(app, { project_id: pid, destination: "root" });
  return { app, P, tok: P.access_token };
}
/** A publisher with one staged generation. */
async function staged(pid) {
  const c = await connect(pid);
  const gid = "g_" + uniq("abandon").replace(/-/g, "_");
  const b = await h.pub(c.tok, "POST", "/publisher/generations", { body: beginBody(gid), idem: uniq("begin-key") });
  assert.equal(b.status, 201, b.text);
  return { ...c, gid };
}
const abandon = (tok, gid, headers = {}) => h.pub(tok, "DELETE", `/publisher/generations/${gid}`, { headers });
const pause = { "x-test-pause-before-batch-ms": "2000" };
const during = async (pending, act) => { await new Promise((r) => setTimeout(r, 500)); await act(); return pending; };

before(async () => {
  h = await startAppConnectServer({ port: PORT });
  owner = await h.owner();
  ownerId = ok(await owner.req("GET", "/api/me")).principal.id;
  ok(await owner.req("POST", "/api/projects", { id: "files-own", title: "Files own" }), 201);
  // Link the owner's upstream sign-in while they are the only person, then add bob and his shared workspace.
  await connect("files-own");
  bob = await h.person("bob");
  WSA = ok(await bob.req("POST", "/api/workspaces", { name: "Shared files" }), 201).id;
  const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
});
after(async () => { await h?.stop(); });

// Design test 13 (abandon): generation abandon is a fenced write; every refusal leaves the generation staged.
test("abandon: disabled client and revoked publisher are refused (401); the generation stays staged", async () => {
  const d = await staged("files-own");
  ok(await owner.req("POST", `/api/app-clients/${d.app.app_client_id}/disable`, {}));
  const r1 = await abandon(d.tok, d.gid);
  assert.equal(r1.status, 401, r1.text); assert.equal(genState(d.gid), "staged");
  const v = await staged("files-own");
  ok(await owner.req("POST", `/api/publishers/${v.P.publisher_id}/revoke`, {}));
  const r2 = await abandon(v.tok, v.gid);
  assert.equal(r2.status, 401, r2.text); assert.equal(r2.json.error.code, "publisher_revoked"); assert.equal(genState(v.gid), "staged");
});

test("abandon: an app client disabled or a publisher revoked mid-request abandons nothing (401)", async () => {
  const d = await staged("files-own");
  const r1 = await during(abandon(d.tok, d.gid, pause), async () => ok(await owner.req("POST", `/api/app-clients/${d.app.app_client_id}/disable`, {})));
  assert.equal(r1.status, 401, r1.text); assert.equal(genState(d.gid), "staged");
  const v = await staged("files-own");
  const r2 = await during(abandon(v.tok, v.gid, pause), async () => ok(await owner.req("POST", `/api/publishers/${v.P.publisher_id}/revoke`, {})));
  assert.equal(r2.status, 401, r2.text); assert.equal(genState(v.gid), "staged");
});

test("abandon in a suspended workspace: 403 workspace_read_only, the generation stays staged; works again once active", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Suspended"), workspace_id: WSA }), 201).id;
  const s = await staged(pid);
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`);
  try {
    const r = await abandon(s.tok, s.gid);
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, "workspace_read_only"); assert.equal(genState(s.gid), "staged");
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
  const again = await abandon(s.tok, s.gid);
  assert.equal(again.status, 200, again.text); assert.equal(again.json.state, "abandoned");
  // Suspended mid-request: the fenced UPDATE changes nothing.
  const s2 = await staged(pid);
  try {
    const r = await during(abandon(s2.tok, s2.gid, pause), async () => sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`));
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, "workspace_read_only"); assert.equal(genState(s2.gid), "staged");
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
});

test("snapshot commit in a suspended workspace: 403 workspace_read_only from the pre-check; nothing written", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Suspended snapshot"), workspace_id: WSA }), 201).id;
  const c = await connect(pid);
  const body = { source_revision: 1, files: [{ name: "export.json", kind: "json", content: JSON.stringify({ synthetic: true }) }] };
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`);
  try {
    const r = await h.pub(c.tok, "POST", "/publisher/snapshots", { body, idem: uniq("snapshot-key") });
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, "workspace_read_only");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}'`)[0].n, 0);
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
});

test("abandon after the creator loses membership, before or during the request: refused, the generation stays staged", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Membership"), workspace_id: WSA }), 201).id;
  const a = await staged(pid);
  const b = await staged(pid);
  const r1 = await during(abandon(b.tok, b.gid, pause), async () => ok(await bob.req("DELETE", `/api/workspaces/${WSA}/members/${ownerId}`)));
  // Observed (design Unverified 13): the post-change re-check answers 403 scope_mismatch mid-request.
  assert.equal(r1.status, 403, r1.text); assert.equal(r1.json.error.code, "scope_mismatch"); assert.equal(genState(b.gid), "staged");
  // Afterwards livePublisher requires membership, so the token is no longer valid at all.
  const r2 = await abandon(a.tok, a.gid);
  assert.equal(r2.status, 401, r2.text); assert.equal(genState(a.gid), "staged");
  const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
});

test("abandon after the project is deleted, before or during the request: refused, the generation stays staged", async () => {
  for (const mid of [false, true]) {
    const title = uniq("Deleted");
    const pid = ok(await owner.req("POST", "/api/projects", { title }), 201).id;
    const s = await staged(pid);
    const del = async () => ok(await owner.req("DELETE", `/api/projects/${pid}`, { confirm_title: title }));
    const r = mid ? await during(abandon(s.tok, s.gid, pause), del) : (await del(), await abandon(s.tok, s.gid));
    // Before: livePublisher's membership gate excludes deleted projects (401). During: the re-check finds no valid
    // destination for the creator (403 scope_mismatch).
    assert.equal(r.status, mid ? 403 : 401, `${mid ? "mid" : "before"}: ${r.text}`);
    assert.equal(genState(s.gid), "staged");
  }
});
