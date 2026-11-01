// OAuth (MCP) connections and App Connect publishers follow the live role of the person who connected them
// (docs/workspaces.md rule 2). Real local runtime, real DCR + consent + token flow, synthetic people only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";

let h, owner, bob, WS, ownerId, agent, pubApp, pub;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["tenancy-oauth"] });
  owner = await h.owner();
  ok(await owner.req("POST", "/api/projects", { id: "own-proj", title: "Own project" }), 201);
  // Link the upstream sign-in to the owner while they are the only person (first-connection rule), then add Bob.
  await h.connectMcpAgent({ "own-proj": "read" }, { clientName: "link" });
  bob = await h.person("bob");
  ownerId = (await owner.req("GET", "/api/me")).body.principal.id;
  WS = ok(await bob.req("POST", "/api/workspaces", { name: "Bob's team" }), 201).id;
  ok(await bob.req("POST", "/api/projects", { id: "bob-proj", title: "Bob project", workspace_id: WS }), 201);
  const doc = ok(await bob.req("POST", "/api/projects/bob-proj/artifacts", { title: "Shared", body: "synthetic shared" }), 201);
  h.doc = doc.artifact_id;
  // Bob invites the owner (owner@example.invalid is their verified sign-in email at Access login; dev login uses
  // owner@example.test).
  const inv = ok(await bob.req("POST", `/api/workspaces/${WS}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: new URL(inv.accept_url).hash.slice(1) }));
});
after(async () => { await h?.stop(); });

test("consent lists projects from every workspace; one connection covers one workspace", async () => {
  let page = "";
  agent = await h.connectMcpAgent({ "bob-proj": "write" }, { clientName: "Team agent", onConsent: (html) => { page = html; } });
  assert.match(page, /Bob project/); assert.match(page, /Own project/);
  const r = await agent.call("read_artifact", { project_id: "bob-proj", artifact_id: h.doc });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  const w = await agent.call("save_markdown", { project_id: "bob-proj", artifact_id: h.doc, expected_revision: 1, body: "agent v2", idempotency_key: "ten-oa-1" });
  assert.equal(w.isError, false, JSON.stringify(w.data));
  // Mixed workspaces in one connection are refused with a fixable message.
  await assert.rejects(h.connectMcpAgent({ "bob-proj": "read", "own-proj": "read" }, { clientName: "Mixed" }), /no interstitial redirect/);
  assert.equal(ok(await owner.req("GET", "/api/access")).connections.some((c) => c.client_name === "Mixed"), false, "nothing created");
  // Each half alone works, so the refusal above was the workspace rule (not a broken flow).
  await h.connectMcpAgent({ "own-proj": "read" }, { clientName: "Own only" });
});

test("demoting the person who connected an agent removes its write access on the next call; removal removes all", async () => {
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "viewer" }));
  const w = await agent.call("save_markdown", { project_id: "bob-proj", artifact_id: h.doc, expected_revision: 2, body: "agent v3", idempotency_key: "ten-oa-2" });
  assert.equal(w.isError, true);
  const r = await agent.call("read_artifact", { project_id: "bob-proj", artifact_id: h.doc });
  assert.equal(r.isError, false);
  // A viewer can't grant edit access on the consent page.
  await assert.rejects(h.connectMcpAgent({ "bob-proj": "write" }, { clientName: "Viewer edit" }), /no interstitial redirect/);
  const viewerRead = await h.connectMcpAgent({ "bob-proj": "read" }, { clientName: "Viewer read" });
  assert.equal((await viewerRead.call("read_artifact", { project_id: "bob-proj", artifact_id: h.doc })).isError, false);
  assert.equal(ok(await owner.req("GET", "/api/access")).connections.some((c) => c.client_name === "Viewer edit"), false);
  ok(await bob.req("DELETE", `/api/workspaces/${WS}/members/${ownerId}`));
  const gone = await agent.call("read_artifact", { project_id: "bob-proj", artifact_id: h.doc });
  assert.equal(gone.isError, true);
  // Bob, a workspace admin, sees the connection the owner made into his workspace and can revoke it.
  const access = ok(await bob.req("GET", "/api/access")).connections;
  assert.ok(access.some((c) => c.client_name === "Team agent" && c.workspace_id === WS));
  assert.equal(access.some((c) => c.client_name === "link"), false, "personal-workspace connections stay private");
});

test("App Connect publisher follows its creator's role", async () => {
  // Re-add the owner as member so they can connect a publisher into Bob's project.
  const members = ok(await bob.req("GET", `/api/workspaces/${WS}/members`)).members;
  if (members.some((m) => m.principal_id === ownerId)) ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "member" }));
  else {
    const inv = ok(await bob.req("POST", `/api/workspaces/${WS}/invites`, { email: "owner@example.test", role: "member" }), 201);
    ok(await owner.req("POST", "/api/invites/accept", { token: new URL(inv.accept_url).hash.slice(1) }));
  }
  pubApp = await h.registerApp({ display_name: "Synthetic Publisher", redirect_uris: ["http://127.0.0.1:5997/cb"] });
  pub = await h.connectPublisher(pubApp, { project_id: "bob-proj", destination: "root" });
  assert.equal((await h.pub(pub.access_token, "GET", "/publisher/me")).status, 200);
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "viewer" }));
  const me = await h.pub(pub.access_token, "GET", "/publisher/me");
  assert.ok(me.status === 401 || me.status === 403, `publisher must stop when its creator can no longer write (got ${me.status})`);
});
