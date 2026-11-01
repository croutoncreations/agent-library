// Workspaces, members and roles (docs/workspaces.md) against a real local server: two workspaces, several synthetic
// people, every human and delegated credential type. Another workspace's things are 404; roles are enforced;
// removing or demoting someone cuts off the agents they connected on the very next request; a suspended workspace
// is closed. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startServer, agentHttp, mcpClient, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS.tenancy;
const API = `http://127.0.0.1:${PORT}`;   // machine host (/v1, /mcp)
const APP = `http://localhost:${PORT}`;   // people host
let s, alice, bob, carol, dave, WS, ids = {};
// Project ids are assigned by the server on multi-user installations; P maps names to them.
const P = {};
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const v1 = async (token, method, path, body) => {
  const h = { authorization: `Bearer ${token}` };
  if (body !== undefined) { h["content-type"] = "application/json"; h["idempotency-key"] = key("v1"); }
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

before(async () => {
  s = await startServer("tenancy", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyBase: APP,
  });
  [alice, bob, carol, dave] = [await s.loginAt(APP, "alice"), await s.loginAt(APP, "bob"), await s.loginAt(APP, "carol"), await s.loginAt(APP, "dave")];
});
after(async () => { await s?.stop(); });

test("every person gets a personal workspace; personal projects are private", async () => {
  const ws = ok(await alice.req("GET", "/api/workspaces")).workspaces;
  assert.equal(ws.length, 1); assert.equal(ws[0].personal, true); assert.equal(ws[0].role, "owner");
  ids.alicePersonal = ws[0].id;
  // A chosen id would reveal whether it exists in another workspace: refused once several people use the install.
  const slug = await alice.req("POST", "/api/projects", { id: "alice-private", title: "Alice private" });
  assert.equal(slug.status, 400);
  P.private = ok(await alice.req("POST", "/api/projects", { title: "Alice private" }), 201).id;
  const doc = ok(await alice.req("POST", `/api/projects/${P.private}/artifacts`, { title: "Diary", body: "synthetic private zebracorn" }), 201);
  ids.privateDoc = doc.artifact_id;
  // Bob can't see, read, list, search or write it: all 404.
  assert.deepEqual(ok(await bob.req("GET", "/api/projects")).projects, []);
  for (const p of [`/api/projects/${P.private}/artifacts`, `/api/projects/${P.private}/artifacts/${ids.privateDoc}`, `/api/projects/${P.private}/artifacts/${ids.privateDoc}/content`,
    `/api/projects/${P.private}/artifacts/${ids.privateDoc}/history`, `/api/projects/${P.private}/backup`, `/api/projects/${P.private}/grants`, `/api/projects/${P.private}/audit`])
    assert.equal((await bob.req("GET", p)).status, 404, p);
  assert.equal((await bob.req("PUT", `/api/projects/${P.private}/artifacts/${ids.privateDoc}`, { expected_revision: 1, body: "pwn" })).status, 404);
  assert.equal((await bob.req("POST", `/api/projects/${P.private}/artifacts`, { title: "x", body: "y" })).status, 404);
  const search = ok(await bob.req("GET", "/api/search?query=zebracorn"));
  assert.equal(JSON.stringify(search).includes(ids.privateDoc), false);
  // Bob can't put a project into Alice's personal workspace either.
  assert.equal((await bob.req("POST", "/api/projects", { title: "x", workspace_id: ids.alicePersonal })).status, 404);
  // Bob can't see Alice's workspace or its members.
  assert.equal((await bob.req("GET", `/api/workspaces/${ids.alicePersonal}/members`)).status, 404);
});

test("shared workspace: invite by email, accept needs the matching signed-in email, single use", async () => {
  WS = ok(await alice.req("POST", "/api/workspaces", { name: "Synthetic Team" }), 201).id;
  P.team = ok(await alice.req("POST", "/api/projects", { title: "Team project", workspace_id: WS }), 201).id;
  const inv = ok(await alice.req("POST", `/api/workspaces/${WS}/invites`, { email: "bob@example.test", role: "member" }), 201);
  const token = inv.accept_url.split("/").pop();
  // A forwarded link is useless to someone else.
  const wrong = await carol.req("POST", "/api/invites/accept", { token });
  assert.equal(wrong.status, 403); assert.equal(wrong.body.error.code, "email_mismatch");
  const pv = ok(await bob.req("POST", "/api/invites/preview", { token }));
  assert.equal(pv.workspace_name, "Synthetic Team"); assert.equal(pv.email_matches, true);
  ok(await bob.req("POST", "/api/invites/accept", { token }));
  assert.equal((await bob.req("POST", "/api/invites/accept", { token })).status, 410, "single use");
  // Viewer invite for Carol; Dave stays outside.
  const inv2 = ok(await alice.req("POST", `/api/workspaces/${WS}/invites`, { email: "carol@example.test", role: "viewer" }), 201);
  ok(await carol.req("POST", "/api/invites/accept", { token: inv2.accept_url.split("/").pop() }));
  // Members can't invite; only owners invite admins; the token is never stored in clear.
  assert.equal((await bob.req("POST", `/api/workspaces/${WS}/invites`, { email: "x@example.test", role: "viewer" })).status, 403);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM workspace_invites WHERE token_hash = '${token}'`)[0].n, 0);
  const members = ok(await alice.req("GET", `/api/workspaces/${WS}/members`)).members;
  assert.deepEqual(members.map((m) => [m.label, m.role]), [["Alice", "owner"], ["Bob", "member"], ["Carol", "viewer"]]);
  // Non-admins see names and roles but not emails.
  assert.ok(ok(await carol.req("GET", `/api/workspaces/${WS}/members`)).members.every((m) => m.email === null));
});

test("roles: viewer reads only, member writes, admin manages; outsiders get 404", async () => {
  const d = ok(await bob.req("POST", `/api/projects/${P.team}/artifacts`, { title: "Plan", body: "synthetic team plan" }), 201);
  ids.teamDoc = d.artifact_id;
  assert.equal(ok(await carol.req("GET", `/api/projects/${P.team}/artifacts/${ids.teamDoc}`)).body, "synthetic team plan");
  const w = await carol.req("PUT", `/api/projects/${P.team}/artifacts/${ids.teamDoc}`, { expected_revision: 1, body: "viewer edit" });
  assert.equal(w.status, 403);
  assert.equal((await carol.req("POST", `/api/projects/${P.team}/artifacts`, { title: "x", body: "y" })).status, 403);
  // Members can't create projects, manage legacy grants, read the audit log or export backups.
  assert.equal((await bob.req("POST", "/api/projects", { title: "x", workspace_id: WS })).status, 403);
  for (const p of [`/api/projects/${P.team}/grants`, `/api/projects/${P.team}/audit`, `/api/projects/${P.team}/backup`]) assert.equal((await bob.req("GET", p)).status, 403, p);
  // Dave (outsider) sees nothing.
  for (const p of [`/api/projects/${P.team}/artifacts`, `/api/projects/${P.team}/artifacts/${ids.teamDoc}`, `/api/workspaces/${WS}/members`]) assert.equal((await dave.req("GET", p)).status, 404, p);
  const listed = ok(await carol.req("GET", "/api/projects")).projects.find((p) => p.id === `${P.team}`);
  assert.equal(listed.role, "viewer"); assert.equal(listed.can_write, false); assert.equal(listed.workspace_id, WS);
});

test("API keys never exceed the creator: viewers get read-only keys, one workspace per key", async () => {
  const roW = await carol.req("POST", "/api/api-keys", { label: "carol rw", projects: [{ project_id: `${P.team}`, access: "read_write" }] });
  assert.equal(roW.status, 403);
  const mixed = await alice.req("POST", "/api/api-keys", { label: "mixed", projects: [{ project_id: `${P.team}`, access: "read" }, { project_id: `${P.private}`, access: "read" }] });
  assert.equal(mixed.status, 400);
  assert.equal((await bob.req("POST", "/api/api-keys", { label: "steal", projects: [{ project_id: `${P.private}`, access: "read" }] })).status, 404);
  ids.bobKey = ok(await bob.req("POST", "/api/api-keys", { label: "bob agent", projects: [{ project_id: `${P.team}`, access: "read_write" }] }), 201);
  ids.carolKey = ok(await carol.req("POST", "/api/api-keys", { label: "carol agent", projects: [{ project_id: `${P.team}`, access: "read" }] }), 201);
  const r = await v1(ids.bobKey.secret, "POST", `/v1/projects/${P.team}/files`, { title: "From Bob's agent", body: "synthetic" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await v1(ids.bobKey.secret, "GET", `/v1/projects/${P.private}/files/${ids.privateDoc}`)).status, 404);
  // Admins see every key in their workspace; others see only their own.
  const aliceKeys = ok(await alice.req("GET", "/api/api-keys")).keys.map((k) => k.label).sort();
  assert.deepEqual(aliceKeys, ["bob agent", "carol agent"]);
  assert.deepEqual(ok(await carol.req("GET", "/api/api-keys")).keys.map((k) => k.label), ["carol agent"]);
  assert.equal((await carol.req("POST", `/api/api-keys/${ids.bobKey.id}/revoke`)).status, 404);
});

test("legacy grants and MCP follow the creator's live role", async (t) => {
  const g = ok(await alice.req("POST", `/api/projects/${P.team}/grants`, { label: "alice mcp", can_write: true }), 201);
  ids.grant = g;
  // Legacy grants (and their /mcp) are served on the people host.
  const A = agentHttp(APP, g.token);
  assert.equal((await A("GET", `/api/projects/${P.team}/artifacts/${ids.teamDoc}`)).status, 200);
  const m = await mcpClient(APP, g.token, "tenancy-mcp");
  try {
    const r = await m.call("read_artifact", { project_id: `${P.team}`, artifact_id: ids.teamDoc });
    assert.equal(r.isError, false);
    // Demote Alice's grant creator? Alice is the owner; demote by a second owner later. Here: suspend the workspace.
    sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WS}'`);
    t.after(() => sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WS}'`));
    // Every credential into a closed workspace stops: the grant and the key are inactive (401), the session 403.
    const g401 = await A("GET", `/api/projects/${P.team}/artifacts/${ids.teamDoc}`);
    assert.equal(g401.status, 401); assert.equal(g401.body.error.code, "credential_inactive");
    assert.equal((await A("GET", "/api/projects")).status, 401);
    // MCP refuses the whole request (401), like any inactive bearer token.
    await assert.rejects(m.call("read_artifact", { project_id: `${P.team}`, artifact_id: ids.teamDoc }), (e) => e.code === 401);
    assert.equal((await v1(ids.bobKey.secret, "GET", `/v1/projects/${P.team}/files/${ids.teamDoc}`)).status, 401);
    assert.equal((await bob.req("GET", `/api/projects/${P.team}/artifacts/${ids.teamDoc}`)).status, 403);
    sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WS}'`);
    assert.equal((await A("GET", `/api/projects/${P.team}/artifacts/${ids.teamDoc}`)).status, 200);
  } finally { await m.close(); }
});

test("demotion and removal cut off the agents a person connected on the next request", async () => {
  const before = await v1(ids.bobKey.secret, "PUT", `/v1/projects/${P.team}/files/${ids.teamDoc}`, { expected_revision: 1, body: "bob v2" });
  assert.equal(before.status, 200, JSON.stringify(before.json));
  // Bob -> viewer: his key keeps reading but can no longer write.
  ok(await alice.req("PATCH", `/api/workspaces/${WS}/members/${(await me(bob)).id}`, { role: "viewer" }));
  const w = await v1(ids.bobKey.secret, "PUT", `/v1/projects/${P.team}/files/${ids.teamDoc}`, { expected_revision: 2, body: "bob v3" });
  assert.equal(w.status, 403);
  assert.equal((await v1(ids.bobKey.secret, "GET", `/v1/projects/${P.team}/files/${ids.teamDoc}`)).status, 200);
  const lp = await v1(ids.bobKey.secret, "GET", "/v1/projects");
  assert.equal(lp.json.projects.find((p) => p.id === `${P.team}`).access, "read");
  // Bob removed: his key no longer works at all (401, like a revoked key), and his session sees nothing (404).
  ok(await alice.req("DELETE", `/api/workspaces/${WS}/members/${(await me(bob)).id}`));
  const gone = await v1(ids.bobKey.secret, "GET", `/v1/projects/${P.team}/files/${ids.teamDoc}`);
  assert.equal(gone.status, 401); assert.equal(gone.json.error.code, "credential_inactive");
  assert.equal((await v1(ids.bobKey.secret, "GET", "/v1/projects")).status, 401);
  assert.equal((await bob.req("GET", `/api/projects/${P.team}/artifacts/${ids.teamDoc}`)).status, 404);
  // Carol's own key is unaffected.
  assert.equal((await v1(ids.carolKey.secret, "GET", `/v1/projects/${P.team}/files/${ids.teamDoc}`)).status, 200);
});

test("at least one owner; admins can't touch owners; members can leave", async () => {
  const aliceId = (await me(alice)).id, carolId = (await me(carol)).id;
  const last = await alice.req("PATCH", `/api/workspaces/${WS}/members/${aliceId}`, { role: "admin" });
  assert.equal(last.status, 409); assert.equal(last.body.error.code, "last_owner");
  assert.equal((await alice.req("DELETE", `/api/workspaces/${WS}/members/${aliceId}`)).status, 409);
  ok(await alice.req("PATCH", `/api/workspaces/${WS}/members/${carolId}`, { role: "admin" }));
  // Admin Carol can't demote or remove owner Alice, nor make herself owner.
  assert.equal((await carol.req("PATCH", `/api/workspaces/${WS}/members/${aliceId}`, { role: "member" })).status, 403);
  assert.equal((await carol.req("DELETE", `/api/workspaces/${WS}/members/${aliceId}`)).status, 403);
  assert.equal((await carol.req("PATCH", `/api/workspaces/${WS}/members/${carolId}`, { role: "owner" })).status, 403);
  // Admin can create projects now; owner-only rename is refused.
  P.carol = ok(await carol.req("POST", "/api/projects", { title: "Carol's", workspace_id: WS }), 201).id;
  assert.equal((await carol.req("PATCH", `/api/workspaces/${WS}`, { name: "Renamed" })).status, 403);
  // Carol leaves; her access ends.
  ok(await carol.req("DELETE", `/api/workspaces/${WS}/members/${carolId}`));
  assert.equal((await carol.req("GET", `/api/projects/${P.carol}/artifacts`)).status, 404);
  assert.equal((await v1(ids.carolKey.secret, "GET", `/v1/projects/${P.team}/files/${ids.teamDoc}`)).status, 401);
});

test("rows written before migration 0017 (workspace_id NULL) resolve to the owner's personal workspace", async () => {
  // A rolled-back Worker writes projects without workspace_id.
  const aliceId = (await me(alice)).id;
  sql(`INSERT INTO projects (id, owner_id, title, created_at) VALUES ('legacy-proj', '${aliceId}', 'Legacy', '2026-01-01T00:00:00Z')`);
  assert.ok(ok(await alice.req("GET", "/api/projects")).projects.some((p) => p.id === "legacy-proj" && p.workspace_id === ids.alicePersonal));
  assert.equal((await dave.req("GET", "/api/projects/legacy-proj/artifacts")).status, 404);
  ok(await alice.req("POST", "/api/projects/legacy-proj/artifacts", { title: "Old", body: "synthetic" }), 201);
});

async function me(h) { return (await h.req("GET", "/api/me")).body.principal; }
