// OAuth (MCP) connections and App Connect publishers follow the live role of the person who connected them
// (docs/workspaces.md rule 2). Real local runtime, real DCR + consent + token flow, synthetic people only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { execFileSync } from "node:child_process";
import { ROOT, LOCAL_CONFIG } from "./helpers.mjs";

let h, owner, bob, WS, ownerId, agent, pubApp, pub, OWN, BOBP;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["tenancy-oauth"] });
  owner = await h.owner();
  OWN = ok(await owner.req("POST", "/api/projects", { title: "Own project" }), 201).id;
  // Link the upstream sign-in to the owner while they are the only person (first-connection rule), then add Bob.
  await h.connectMcpAgent({ [OWN]: "read" }, { clientName: "link" });
  bob = await h.person("bob");
  ownerId = (await owner.req("GET", "/api/me")).body.principal.id;
  WS = ok(await bob.req("POST", "/api/workspaces", { name: "Bob's team" }), 201).id;
  BOBP = ok(await bob.req("POST", "/api/projects", { title: "Bob project", workspace_id: WS }), 201).id;
  const doc = ok(await bob.req("POST", `/api/projects/${BOBP}/artifacts`, { title: "Shared", body: "synthetic shared" }), 201);
  h.doc = doc.artifact_id;
  // Bob invites the owner (owner@example.invalid is their verified sign-in email at Access login; dev login uses
  // owner@example.test).
  const inv = ok(await bob.req("POST", `/api/workspaces/${WS}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
});
after(async () => { await h?.stop(); });

test("consent lists projects from every workspace; one connection covers one workspace", async () => {
  let page = "";
  agent = await h.connectMcpAgent({ [BOBP]: "write" }, { clientName: "Team agent", onConsent: (html) => { page = html; } });
  assert.match(page, /Bob project/); assert.match(page, /Own project/);
  const r = await agent.call("read_artifact", { project_id: BOBP, artifact_id: h.doc });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  const w = await agent.call("save_markdown", { project_id: BOBP, artifact_id: h.doc, expected_revision: 1, body: "agent v2", idempotency_key: "ten-oa-1" });
  assert.equal(w.isError, false, JSON.stringify(w.data));
  // Project paths (workspace/project) work as project_id, list_projects shows them, and links use them.
  const lp = await agent.call("list_projects", {});
  const path = lp.data.projects.find((p) => p.id === BOBP).path;
  assert.match(path, /^bob-s-team\/bob-project$|^bobs-team\/bob-project$|^[a-z0-9-]+\/bob-project$/);
  assert.ok(lp.data.projects.find((p) => p.id === BOBP).web_url.endsWith("/" + path));
  const byPath = await agent.call("read_artifact", { project_id: path, artifact_id: h.doc });
  assert.equal(byPath.isError, false, JSON.stringify(byPath.data));
  assert.ok(byPath.data.artifact.web_url.endsWith(`/${path}/a/${h.doc}`));
  // A path outside the connection answers like an unknown project.
  const own = (await owner.req("GET", "/api/projects")).body.projects.find((p) => p.id === OWN).path;
  const outside = await agent.call("read_artifact", { project_id: own, artifact_id: h.doc });
  const unknown = await agent.call("read_artifact", { project_id: "nope/nope", artifact_id: h.doc });
  assert.equal(outside.isError, true); assert.deepEqual(outside.data, unknown.data);
  // Mixed workspaces in one connection are refused with a fixable message.
  await assert.rejects(h.connectMcpAgent({ [BOBP]: "read", [OWN]: "read" }, { clientName: "Mixed" }), /no interstitial redirect/);
  assert.equal(ok(await owner.req("GET", "/api/access")).connections.some((c) => c.client_name === "Mixed"), false, "nothing created");
  // Each half alone works, so the refusal above was the workspace rule (not a broken flow).
  await h.connectMcpAgent({ [OWN]: "read" }, { clientName: "Own only" });
});

test("demoting the person who connected an agent removes its write access on the next call; removal removes all", async () => {
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "viewer" }));
  const w = await agent.call("save_markdown", { project_id: BOBP, artifact_id: h.doc, expected_revision: 2, body: "agent v3", idempotency_key: "ten-oa-2" });
  assert.equal(w.isError, true);
  const r = await agent.call("read_artifact", { project_id: BOBP, artifact_id: h.doc });
  assert.equal(r.isError, false);
  // A viewer can't grant edit access on the consent page.
  await assert.rejects(h.connectMcpAgent({ [BOBP]: "write" }, { clientName: "Viewer edit" }), /no interstitial redirect/);
  const viewerRead = await h.connectMcpAgent({ [BOBP]: "read" }, { clientName: "Viewer read" });
  assert.equal((await viewerRead.call("read_artifact", { project_id: BOBP, artifact_id: h.doc })).isError, false);
  assert.equal(ok(await owner.req("GET", "/api/access")).connections.some((c) => c.client_name === "Viewer edit"), false);
  ok(await bob.req("DELETE", `/api/workspaces/${WS}/members/${ownerId}`));
  const gone = await agent.call("read_artifact", { project_id: BOBP, artifact_id: h.doc });
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
    ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  }
  pubApp = await h.registerApp({ display_name: "Synthetic Publisher", redirect_uris: ["http://127.0.0.1:5997/cb"] });
  pub = await h.connectPublisher(pubApp, { project_id: BOBP, destination: "root" });
  assert.equal((await h.pub(pub.access_token, "GET", "/publisher/me")).status, 200);
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "viewer" }));
  const me = await h.pub(pub.access_token, "GET", "/publisher/me");
  assert.ok(me.status === 401 || me.status === 403, `publisher must stop when its creator can no longer write (got ${me.status})`);
});

test("consent: a new project goes only into an active workspace where the signer is admin", async () => {
  // Make the owner an admin of Bob's workspace, so it is offered under "New projects go in".
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "admin" }));
  let page = "";
  const made = await h.connectMcpAgent({}, { clientName: "New in team", extra: { new_workspace: WS, new_title: "Made at consent", new_access: "write" }, onConsent: (html) => { page = html; } });
  assert.match(page, /New projects go in/);
  assert.match(page, /<h3 class="wsh" id="wsh-\d+">Bob&#39;s team|<h3 class="wsh" id="wsh-\d+">Bob's team/);
  const created = ok(await bob.req("GET", "/api/projects")).projects.find((p) => p.title === "Made at consent");
  assert.ok(created && created.workspace_id === WS, "created in the chosen workspace");
  assert.equal((await made.call("list_projects", {})).isError, false);
  // Suspended: the same choice is refused and nothing is created.
  const sqlRun = (q) => execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--command", q], { cwd: ROOT, stdio: "ignore" });
  sqlRun(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WS}'`);
  try {
    await assert.rejects(h.connectMcpAgent({}, { clientName: "Into suspended", extra: { new_workspace: WS, new_title: "Should not exist", new_access: "read" } }), /no interstitial redirect/);
  } finally { sqlRun(`UPDATE workspaces SET status = 'active' WHERE id = '${WS}'`); }
  assert.equal(ok(await bob.req("GET", "/api/projects")).projects.some((p) => p.title === "Should not exist"), false);
  // A plain member can't pick the workspace either.
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "member" }));
  await assert.rejects(h.connectMcpAgent({}, { clientName: "Member new", extra: { new_workspace: WS, new_title: "Member made", new_access: "read" } }), /no interstitial redirect/);
  assert.equal(ok(await bob.req("GET", "/api/projects")).projects.some((p) => p.title === "Member made"), false);
});
