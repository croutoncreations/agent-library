// Agent access managed in the app (docs/architecture.md#agent-access): an OAuth-connected agent can have zero
// projects, the owner names it at consent, and later edits its projects, renames it or disconnects it in Connections
// without the agent reconnecting. Real local runtime (wrangler dev), real DCR + consent + token flow, the MCP
// endpoint, the owner's browser API and Chrome for the Connections page. Synthetic people and documents only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { ROOT, LOCAL_CONFIG, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);

let h, owner, bob, ownerId, WS, BOBP, BOBDOC, A, B, DOCA, DOCB;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
const errorCode = (r) => r.data?.error?.code ?? r.data?.code ?? null;
const access = async () => ok(await owner.req("GET", "/api/access")).connections;
const connection = async (name) => (await access()).filter((c) => c.display_name === name && c.status === "active").at(0);
const putProjects = (id, projects, who = owner) => who.req("PUT", `/api/connections/${id}/projects`, { projects });
const mcp = async (token, method, params = {}) => {
  const res = await fetch(`${h.issuer}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};
const save = (agent, project, artifact, rev, body) => agent.call("save_markdown", { project_id: project, artifact_id: artifact, expected_revision: rev, body, idempotency_key: key("aa") });
const read = (agent, project, artifact) => agent.call("read_artifact", { project_id: project, artifact_id: artifact });

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["agent-access"] });
  owner = await h.owner();
  for (const [id, title] of [["acc-a", "Alpha"], ["acc-b", "Beta"]]) ok(await owner.req("POST", "/api/projects", { id, title }), 201);
  A = "acc-a"; B = "acc-b";
  DOCA = ok(await owner.req("POST", `/api/projects/${A}/artifacts`, { title: "Alpha note", body: "alpha one" }), 201).artifact_id;
  DOCB = ok(await owner.req("POST", `/api/projects/${B}/artifacts`, { title: "Beta note", body: "beta one" }), 201).artifact_id;
  // Link the upstream sign-in to the owner while they are the only person (first-connection rule), then add Bob.
  await h.connectMcpAgent({ [A]: "read" }, { clientName: "link" });
  bob = await h.person("bob");
  ownerId = ok(await owner.req("GET", "/api/me")).principal.id;
  WS = ok(await bob.req("POST", "/api/workspaces", { name: "Bob's team" }), 201).id;
  BOBP = ok(await bob.req("POST", "/api/projects", { title: "Bob project", workspace_id: WS }), 201).id;
  BOBDOC = ok(await bob.req("POST", `/api/projects/${BOBP}/artifacts`, { title: "Shared", body: "bob one" }), 201).artifact_id;
  const inv = ok(await bob.req("POST", `/api/workspaces/${WS}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
});
after(async () => { await h?.stop(); });

test("consent with no projects: connect now, the token works, list_projects is empty with a note, refresh keeps working", async () => {
  let page = "";
  const agent = await h.connectMcpAgent({}, { clientName: "Zero Claude", onConsent: (html) => { page = html; } });
  const text = page.replace(/<[^>]+>/g, " ");
  assert.match(text, /No projects yet \u2014 you can share projects later in Connections/);
  assert.doesNotMatch(text, /Pick at least one project/);
  assert.match(page, /name="label"[^>]*value="Zero Claude"/, "the name is prefilled with the app's own name");
  assert.match(text, /Name in Agent Library/);
  assert.match(page, /Returns to <code class="url">http:\/\/127\.0\.0\.1:5998\/cb<\/code>/, "the full redirect URL is shown");
  assert.match(text, /reports itself as \u201CZero Claude\u201D/);
  // The token always carries write: the per-project can_write is the gate, so edit access can be granted later.
  assert.deepEqual(agent.scope.split(" ").sort(), ["agentlib:read", "agentlib:write", "offline_access"]);
  const c = await connection("Zero Claude");
  assert.ok(c, "listed under its name");
  assert.deepEqual([c.projects, c.status, c.workspace_id], [[], "active", `wsp_${ownerId}`]);
  assert.equal(sql(`SELECT project_id, can_write FROM oauth_connections WHERE id = '${c.id}'`)[0].project_id, null, "legacy project_id column is NULL");
  const init = await mcp(agent.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zero-sim", version: "1" } });
  assert.equal(init.status, 200); assert.equal(init.body.result.serverInfo.name, "agent-library");
  const tools = (await agent.list()).map((t) => t.name);
  assert.ok(tools.includes("list_projects") && tools.includes("connection_info") && !tools.includes("save_markdown"), tools.join());
  const lp = await agent.call("list_projects", {});
  assert.equal(lp.isError, false, JSON.stringify(lp.data));
  assert.deepEqual(lp.data.projects, []);
  assert.match(lp.data.note, /hasn't shared any projects .* Agent Library \u2192 Connections/);
  const info = await agent.call("connection_info", {});
  assert.deepEqual([info.data.projects, info.data.connection.display_label], [[], "Zero Claude"]);
  // Project-scoped tools fail with the normal not-found.
  for (const r of [await read(agent, A, DOCA), await agent.call("list_artifacts", {}), await agent.call("list_artifacts", { project_id: A })]) {
    assert.equal(r.isError, true); assert.equal(errorCode(r), "not_found");
  }
  // Refresh works with zero projects and the new access token is accepted.
  const t = await h.token({ grant_type: "refresh_token", refresh_token: agent.refresh_token, client_id: agent.client_id });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal((await mcp(t.body.access_token, "tools/list")).status, 200);
  assert.deepEqual((await mcp(t.body.access_token, "tools/call", { name: "list_projects", arguments: {} })).body.result.structuredContent.projects, []);
});

test("consent: the owner's name is used in the list, in connection_info and in the provenance of new versions; renaming does not rewrite history", async () => {
  const agent = await h.connectMcpAgent({ [A]: "write" }, { clientName: "Claude", extra: { label: "  Jon's Claude on laptop  " } });
  const c = await connection("Jon's Claude on laptop");
  assert.ok(c, "trimmed name");
  assert.deepEqual([c.label, c.client_name, c.redirect_host, c.redirect_uri], ["Jon's Claude on laptop", "Claude", "127.0.0.1:5998", "http://127.0.0.1:5998/cb"]);
  const info = await agent.call("connection_info", {});
  assert.equal(info.data.connection.display_label, "Jon's Claude on laptop");
  assert.match(info.data.connection.label_source, /owner-assigned/);
  ok(await owner.req("GET", `/api/projects/${A}/connections`)).connections.forEach((x) => assert.ok(x.display_name));
  let rev = (await read(agent, A, DOCA)).data.artifact.revision;
  const w1 = await save(agent, A, DOCA, rev, "alpha two");
  assert.equal(w1.isError, false, JSON.stringify(w1.data));
  const history = async () => ok(await owner.req("GET", `/api/projects/${A}/artifacts/${DOCA}/history`)).revisions;
  assert.deepEqual([(await history())[0].via.kind, (await history())[0].via.label, (await history())[0].who], ["oauth", "Jon's Claude on laptop", "Jon's Claude on laptop"]);
  // Rename.
  const r = ok(await owner.req("PATCH", `/api/connections/${c.id}`, { label: "Writing assistant" }));
  assert.deepEqual([r.label, r.display_name, r.client_name], ["Writing assistant", "Writing assistant", "Claude"]);
  assert.equal((await connection("Writing assistant")).id, c.id);
  assert.equal((await agent.call("connection_info", {})).data.connection.display_label, "Writing assistant");
  const w2 = await save(agent, A, DOCA, w1.data.revision, "alpha three");
  assert.equal(w2.isError, false, JSON.stringify(w2.data));
  const after = await history();
  assert.equal(after[0].via.label, "Writing assistant", "new writes carry the new name");
  assert.equal(after[1].via.label, "Jon's Claude on laptop", "history is not rewritten");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM audits WHERE action = 'oauth.rename' AND object_id = '${c.id}'`)[0].n, 1);
  // Names: trimmed 1-80 characters, no control characters; nothing changes on a refusal.
  for (const bad of ["", "   ", "x".repeat(81), "tab\there", "line\nbreak", "bell\u0007", undefined, 5, null]) {
    const e = await owner.req("PATCH", `/api/connections/${c.id}`, { label: bad });
    assert.equal(e.status, 400, JSON.stringify(bad));
  }
  assert.equal((await owner.req("PATCH", `/api/connections/${c.id}`, { label: "x".repeat(80) })).status, 200);
  assert.equal((await owner.req("PATCH", `/api/connections/${c.id}`, { label: "Writing assistant" })).status, 200);
  assert.equal(sql(`SELECT client_name FROM oauth_connections WHERE id = '${c.id}'`)[0].client_name, "Claude", "the app's own name is never changed");
});

test("consent requires a valid name; a refused form is shown again with the owner's name and projects kept", async () => {
  const long = "n".repeat(81);
  let seen = null;
  await assert.rejects(h.connectMcpAgent({ [A]: "read" }, { clientName: "Name check", extra: { label: long }, onGrant: (status, html) => { seen = { status, html }; } }), /no interstitial redirect/);
  assert.equal(seen.status, 400);
  assert.match(seen.html, /The name can be at most 80 characters/);
  assert.ok(seen.html.includes(`value="${long}"`), "the typed name is kept");
  assert.equal(await connection("Name check"), undefined);
  await assert.rejects(h.connectMcpAgent({}, { clientName: "Blank", extra: { label: "  " }, onGrant: (status, html) => { seen = { status, html }; } }), /no interstitial redirect/);
  assert.match(seen.html, /A name is required/);
  // A form without the field (a page rendered before the field existed) takes the app's name.
  await h.connectMcpAgent({}, { clientName: "Old page" });
  assert.ok(await connection("Old page"));
});

test("consent replace: the earlier connection's name is prefilled, and replacing keeps one live connection", async () => {
  const first = await h.connectMcpAgent({ [A]: "read" }, { clientName: "Replaceable", extra: { label: "Kitchen laptop" } });
  const prev = await connection("Kitchen laptop");
  let page = "";
  const second = await h.connectMcpAgent({}, { client: first, onConsent: (html) => { page = html; }, extra: { replace: prev.id, label: "Kitchen laptop (new)" } });
  assert.match(page, /Welcome back/);
  assert.match(page, /name="label"[^>]*value="Kitchen laptop"/, "prefilled with the earlier name");
  assert.equal((await connection("Kitchen laptop (new)")).projects.length, 0);
  assert.equal(await connection("Kitchen laptop"), undefined, "the earlier connection is revoked");
  assert.equal((await mcp(first.access_token, "tools/list")).status, 401);
  assert.equal((await second.call("list_projects", {})).isError, false);
});

test("consent workspace picker: shown to people in more than one workspace; zero-project connections go where chosen", async () => {
  let page = "";
  await h.connectMcpAgent({}, { clientName: "Team home", onConsent: (html) => { page = html; }, extra: { label: "Team home", connect_workspace: WS } });
  assert.match(page, /Workspace for this connection/);
  assert.match(page, new RegExp(`<option value="wsp_${ownerId}" selected>Personal</option>`), "Personal is the default");
  assert.equal((await connection("Team home")).workspace_id, WS);
  // Picking projects decides the workspace; the picker is ignored.
  await h.connectMcpAgent({ [A]: "read" }, { clientName: "Picked wins", extra: { label: "Picked wins", connect_workspace: WS } });
  assert.equal((await connection("Picked wins")).workspace_id, `wsp_${ownerId}`);
  // Not a workspace the signer belongs to: refused, nothing created.
  await assert.rejects(h.connectMcpAgent({}, { clientName: "Stranger", extra: { label: "Stranger", connect_workspace: "wsp_not_mine" } }), /no interstitial redirect/);
  assert.equal(await connection("Stranger"), undefined);
  // A viewer can't connect an agent to a workspace (member needed), and the picker doesn't offer it.
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "viewer" }));
  try {
    await assert.rejects(h.connectMcpAgent({}, { clientName: "Viewer home", onConsent: (html) => { page = html; }, extra: { label: "Viewer home", connect_workspace: WS } }), /no interstitial redirect/);
    assert.doesNotMatch(page, /Workspace for this connection/, "one eligible workspace: no picker");
    assert.equal(await connection("Viewer home"), undefined);
  } finally { ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "member" })); }
});

test("editing projects takes effect on the agent's next request: add, upgrade to edit, downgrade, remove all", async () => {
  const agent = await h.connectMcpAgent({}, { clientName: "Grower", extra: { label: "Grower" } });
  const c = await connection("Grower");
  assert.equal((await read(agent, A, DOCA)).isError, true);
  // Add A as read: the same token reads it, cannot write, and has no write tools yet.
  let r = ok(await putProjects(c.id, [{ project_id: A, access: "read" }]));
  assert.deepEqual([r.can_write, r.projects], [false, [{ project_id: A, access: "read" }]]);
  const doc = await read(agent, A, DOCA);
  assert.equal(doc.isError, false, JSON.stringify(doc.data));
  assert.equal(errorCode(await save(agent, A, DOCA, doc.data.artifact.revision, "no")), "forbidden");
  assert.ok(!(await agent.list()).some((t) => t.name === "save_markdown"));
  assert.deepEqual((await agent.call("list_projects", {})).data.projects.map((p) => [p.id, p.can_write]), [[A, false]]);
  // Upgrade to read & edit: write works without reconnecting; the connection-level flag follows.
  r = ok(await putProjects(c.id, [{ project_id: A, access: "read_write" }]));
  assert.equal(r.can_write, true);
  assert.equal(sql(`SELECT can_write, project_id FROM oauth_connections WHERE id = '${c.id}'`)[0].can_write, 1);
  const rev = (await read(agent, A, DOCA)).data.artifact.revision;
  const w = await save(agent, A, DOCA, rev, "grower wrote this");
  assert.equal(w.isError, false, JSON.stringify(w.data));
  assert.ok((await agent.list()).some((t) => t.name === "save_markdown"));
  const via = ok(await owner.req("GET", `/api/projects/${A}/artifacts/${DOCA}/history`)).revisions[0].via;
  assert.deepEqual([via.kind, via.label], ["oauth", "Grower"]);
  // Add B as read, keep A with edit: both work, only A writes.
  ok(await putProjects(c.id, [{ project_id: A, access: "read_write" }, { project_id: B, access: "read" }]));
  assert.equal((await read(agent, B, DOCB)).isError, false);
  assert.equal(errorCode(await save(agent, B, DOCB, 1, "no")), "forbidden");
  // Downgrade A to read: write stops on the next call, and the connection can't write anywhere.
  r = ok(await putProjects(c.id, [{ project_id: A, access: "read" }, { project_id: B, access: "read" }]));
  assert.equal(r.can_write, false);
  assert.equal(sql(`SELECT can_write FROM oauth_connections WHERE id = '${c.id}'`)[0].can_write, 0);
  assert.equal(errorCode(await save(agent, A, DOCA, (await read(agent, A, DOCA)).data.artifact.revision, "no")), "forbidden");
  assert.equal((await read(agent, A, DOCA)).isError, false);
  // Remove A: forbidden on the next call; B stays.
  ok(await putProjects(c.id, [{ project_id: B, access: "read" }]));
  assert.equal(errorCode(await read(agent, A, DOCA)), "not_found");
  assert.equal((await read(agent, B, DOCB)).isError, false);
  assert.equal(sql(`SELECT project_id FROM oauth_connections WHERE id = '${c.id}'`)[0].project_id, B, "legacy project_id follows the first project");
  // Remove everything: allowed, and the connection is still connected (not revoked).
  r = ok(await putProjects(c.id, []));
  assert.deepEqual(r.projects, []);
  assert.equal((await read(agent, B, DOCB)).isError, true);
  assert.deepEqual((await agent.call("list_projects", {})).data.projects, []);
  const listed = await connection("Grower");
  assert.deepEqual([listed.status, listed.projects], ["active", []]);
  assert.equal(sql(`SELECT project_id, revoked_at FROM oauth_connections WHERE id = '${c.id}'`)[0].project_id, null);
  const t = await h.token({ grant_type: "refresh_token", refresh_token: agent.refresh_token, client_id: agent.client_id });
  assert.equal(t.status, 200, "refresh still works with no projects");
  // And it can be given projects again.
  ok(await putProjects(c.id, [{ project_id: B, access: "read_write" }]));
  assert.equal((await read(agent, B, DOCB)).isError, false);
  // Audits: one oauth.scope row per project and change.
  const audits = sql(`SELECT project_id, result FROM audits WHERE action = 'oauth.scope' AND object_id = '${c.id}' ORDER BY seq`).map((a) => `${a.project_id}:${a.result}`);
  assert.deepEqual(audits, [`${A}:ok:added:read`, `${A}:ok:changed:read_write`, `${B}:ok:added:read`, `${A}:ok:changed:read`, `${A}:ok:removed`, `${B}:ok:removed`, `${B}:ok:added:read_write`]);
});

test("scope edit is refused for: other workspaces, projects the editor can't reach, non-managers, agents, bad input, read-only roles", async () => {
  const agent = await h.connectMcpAgent({ [A]: "read" }, { clientName: "Guarded", extra: { label: "Guarded" } });
  const c = await connection("Guarded");
  const unchanged = async () => assert.deepEqual((await connection("Guarded")).projects.map((p) => [p.id, p.access]), [[A, "read"]], "nothing changed");
  // The connection lives in the owner's personal workspace: a project of Bob's team is refused.
  const cross = await putProjects(c.id, [{ project_id: A, access: "read" }, { project_id: BOBP, access: "read" }]);
  assert.equal(cross.status, 400); assert.match(cross.body.error.message, /one workspace/);
  await unchanged();
  assert.equal((await putProjects(c.id, [{ project_id: "prj_nope", access: "read" }])).status, 404);
  assert.equal((await putProjects(c.id, [{ project_id: A, access: "read" }, { project_id: A, access: "read_write" }])).status, 400, "duplicate");
  assert.equal((await putProjects(c.id, [{ project_id: A, access: "write" }])).status, 400, "unknown access value");
  assert.equal((await putProjects(c.id, [{ project_id: A }])).status, 400);
  assert.equal((await owner.req("PUT", `/api/connections/${c.id}/projects`, {})).status, 400, "projects is required (an empty list is explicit)");
  assert.equal((await owner.req("PUT", `/api/connections/${c.id}/projects`, { projects: "all" })).status, 400);
  const many = Array.from({ length: 51 }, (_, i) => ({ project_id: `p${i}`, access: "read" }));
  assert.equal((await putProjects(c.id, many)).status, 400, "at most 50 projects");
  await unchanged();
  // Someone who didn't create the connection and isn't an admin of its workspace can't manage it: 404, like unknown.
  assert.equal((await putProjects(c.id, [], bob)).status, 404);
  assert.equal((await bob.req("PATCH", `/api/connections/${c.id}`, { label: "Mine now" })).status, 404);
  assert.equal((await bob.req("POST", `/api/connections/${c.id}/revoke`, {})).status, 404);
  await unchanged();
  // Agents (an API key, a grant token, the OAuth agent itself) can't change scope or name.
  const keyed = ok(await owner.req("POST", "/api/api-keys", { label: "aa key", projects: [{ project_id: A, access: "read_write" }] }), 201).secret;
  const grantTok = ok(await owner.req("POST", `/api/projects/${A}/grants`, { label: "aa grant", can_write: true }), 201).token;
  for (const [token, base] of [[keyed, h.issuer + "/v1"], [grantTok, h.appUi + "/api"], [agent.access_token, h.appUi + "/api"]]) {
    for (const [method, path, body] of [["PUT", `/connections/${c.id}/projects`, { projects: [] }], ["PATCH", `/connections/${c.id}`, { label: "Hijack" }]]) {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key("aa") }, body: JSON.stringify(body) });
      assert.ok([401, 403, 404].includes(res.status), `${method} ${path} as agent: ${res.status}`);
    }
  }
  await unchanged();
  assert.equal((await connection("Guarded")).display_name, "Guarded");
  // A workspace admin may manage a connection made into their workspace (the MANAGE rule shared with Disconnect).
  const team = await h.connectMcpAgent({ [BOBP]: "read" }, { clientName: "Team bot", extra: { label: "Team bot" } });
  const tc = (await ok(await bob.req("GET", "/api/access")).connections).find((x) => x.display_name === "Team bot");
  assert.ok(tc, "Bob sees it as workspace admin");
  ok(await putProjects(tc.id, [{ project_id: BOBP, access: "read_write" }], bob));
  assert.equal(errorCode(await save(team, BOBP, BOBDOC, 1, "team edit")), null, "Bob's change took effect for the owner's agent");
  ok(await bob.req("PATCH", `/api/connections/${tc.id}`, { label: "Team bot (renamed by Bob)" }));
  // Bob can't give it a project he can't reach himself (the editor must reach every project), nor edit access without his own member role.
  ok(await bob.req("POST", "/api/projects", { title: "Hidden", workspace_id: WS }), 201);
  // The owner's role in Bob's team is member, so the owner may grant edit there.
  ok(await putProjects(tc.id, [{ project_id: BOBP, access: "read_write" }]));
});

test("read-only roles can't be granted edit access; deleted and unreachable projects are refused", async () => {
  ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "viewer" }));
  try {
    const c0 = await h.connectMcpAgent({ [BOBP]: "read" }, { clientName: "Viewer reader", extra: { label: "Viewer reader" } });
    const c = await connection("Viewer reader");
    const e = await putProjects(c.id, [{ project_id: BOBP, access: "read_write" }]);
    assert.equal(e.status, 403); assert.match(e.body.error.message, /read-only/);
    assert.equal(errorCode(await save(c0, BOBP, BOBDOC, 1, "no")), "forbidden");
    ok(await putProjects(c.id, [{ project_id: BOBP, access: "read" }]));
    ok(await putProjects(c.id, []));
  } finally { ok(await bob.req("PATCH", `/api/workspaces/${WS}/members/${ownerId}`, { role: "member" })); }
  // A project in Recently deleted can't be granted.
  const gone = ok(await owner.req("POST", "/api/projects", { title: "Short lived" }), 201).id;
  const agent = await h.connectMcpAgent({}, { clientName: "Deleted target", extra: { label: "Deleted target" } });
  const c = await connection("Deleted target");
  ok(await owner.req("DELETE", `/api/projects/${gone}`, { confirm_title: "Short lived" }));
  assert.equal((await putProjects(c.id, [{ project_id: gone, access: "read" }])).status, 404);
  assert.equal((await agent.call("list_projects", {})).data.projects.length, 0);
});

test("a suspended workspace can't be given more access, but access can be reduced", async () => {
  const agent = await h.connectMcpAgent({ [BOBP]: "write" }, { clientName: "Suspend check", extra: { label: "Suspend check" } });
  const c = await connection("Suspend check");
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WS}'`);
  try {
    assert.equal((await putProjects(c.id, [{ project_id: BOBP, access: "read_write" }, ...[]])).status, 200, "unchanged list is a no-op");
    const widen = await owner.req("POST", "/api/projects", { title: "Not here", workspace_id: WS });
    assert.notEqual(widen.status, 201);
    ok(await putProjects(c.id, [{ project_id: BOBP, access: "read" }]));
    assert.equal((await read(agent, BOBP, BOBDOC)).isError, false, "suspended workspaces stay readable");
    ok(await putProjects(c.id, []));
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WS}'`); }
});

test("disconnect still revokes the whole connection, with or without projects; revoked connections can't be edited", async () => {
  const withProject = await h.connectMcpAgent({ [A]: "read" }, { clientName: "Goner", extra: { label: "Goner" } });
  const empty = await h.connectMcpAgent({}, { clientName: "Goner empty", extra: { label: "Goner empty" } });
  for (const [agent, name] of [[withProject, "Goner"], [empty, "Goner empty"]]) {
    const c = await connection(name);
    assert.equal((await mcp(agent.access_token, "tools/list")).status, 200);
    ok(await owner.req("POST", `/api/connections/${c.id}/revoke`, {}));
    assert.equal((await mcp(agent.access_token, "tools/list")).status, 401, `${name}: token refused`);
    assert.equal((await h.token({ grant_type: "refresh_token", refresh_token: agent.refresh_token, client_id: agent.client_id })).status, 400, `${name}: refresh refused`);
    assert.equal((await owner.req("POST", `/api/connections/${c.id}/revoke`, {})).status, 404, "already revoked");
    assert.equal((await putProjects(c.id, [{ project_id: A, access: "read" }])).status, 409);
    assert.equal((await owner.req("PATCH", `/api/connections/${c.id}`, { label: "Back" })).status, 409);
    const listed = (await access()).find((x) => x.id === c.id);
    assert.equal(listed.status, "revoked");
  }
  assert.equal(sql("SELECT COUNT(*) AS n FROM audits WHERE action = 'oauth.revoke'")[0].n >= 1, true);
});

test("Connections page: name, host, project chips, Edit projects, Rename and Disconnect work in the browser", { skip: !haveChrome && "Chrome not installed" }, async () => {
  const agent = await h.connectMcpAgent({}, { clientName: "Browser agent", extra: { label: "Browser agent" } });
  const c = await connection("Browser agent");
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const [cn, cv] = owner.cookie.split("=");
    await page.setCookie({ name: cn, value: cv, url: h.appUi });
    page.on("dialog", (d) => d.accept());
    await page.goto(`${h.appUi}/#/settings/apps`);
    const card = `article.conn[aria-label="Browser agent"]`;
    await page.waitForSelector(card);
    const text = () => page.$eval(card, (e) => e.innerText);
    const buttons = await page.$eval(card, (e) => [...e.querySelectorAll(".conn-head button")].map((b) => b.textContent));
    assert.deepEqual(buttons, ["Edit projects", "Rename", "Disconnect"]);
    assert.match(await text(), /returns to 127\.0\.0\.1:5998/);
    assert.match(await text(), /No projects shared yet/);
    assert.match(await page.$eval(card, (e) => e.querySelector("details.conn-details").innerHTML), /http:\/\/127\.0\.0\.1:5998\/cb/, "full redirect URL in the details");
    const click = (label) => page.evaluate((sel, l) => [...document.querySelector(sel).querySelectorAll("button")].find((b) => b.textContent === l).click(), card, label);
    // Edit projects: only projects of the connection's workspace; Read & edit on Alpha, Read on Beta.
    await click("Edit projects");
    await page.waitForSelector(`${card} .scope-row`);
    const rows = await page.$$eval(`${card} .scope-row .scope-name`, (els) => els.map((e) => e.textContent));
    assert.ok(rows.includes("Alpha") && rows.includes("Beta") && !rows.includes("Bob project"), rows.join());
    const offLabels = await page.$$eval(`${card} .scope-row select`, (els) => els[0].options[0].textContent);
    assert.equal(offLabels, "Off");
    await page.evaluate((sel) => {
      for (const s of document.querySelector(sel).querySelectorAll(".scope-row select")) {
        const name = s.getAttribute("aria-label");
        if (name === "Access to Alpha") s.value = "read_write"; else if (name === "Access to Beta") s.value = "read"; else continue;
        s.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, card);
    await click("Save projects");
    await page.waitForFunction((sel) => /Alpha\s*read & edit/.test(document.querySelector(sel).innerText) && /Beta\s*read/.test(document.querySelector(sel).innerText), {}, card)
      .catch(async (e) => { throw new Error(`${e.message}: ${await page.evaluate(() => document.body.innerText.slice(0, 1500))}`); });
    assert.deepEqual((await connection("Browser agent")).projects.map((p) => [p.id, p.access]).sort(), [[A, "read+write"], [B, "read"]]);
    assert.equal((await read(agent, A, DOCA)).isError, false, "the agent reads without reconnecting");
    // Rename.
    await click("Rename");
    await page.waitForSelector(`${card} input[aria-label="Name in Agent Library"]`);
    await page.$eval(`${card} input[aria-label="Name in Agent Library"]`, (i) => { i.value = ""; });
    await page.type(`${card} input[aria-label="Name in Agent Library"]`, "Renamed in UI");
    await click("Save name");
    await page.waitForSelector(`article.conn[aria-label="Renamed in UI"]`);
    assert.match(await page.$eval(`article.conn[aria-label="Renamed in UI"]`, (e) => e.innerText), /app calls itself \u201CBrowser agent\u201D/);
    assert.equal((await connection("Renamed in UI")).id, c.id);
    // Remove every project: allowed, shown as such, still active.
    const card2 = `article.conn[aria-label="Renamed in UI"]`;
    await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll("button")].find((b) => b.textContent === "Edit projects").click(), card2);
    await page.waitForSelector(`${card2} .scope-row`);
    await page.evaluate((sel) => { for (const s of document.querySelector(sel).querySelectorAll(".scope-row select")) { s.value = ""; s.dispatchEvent(new Event("change", { bubbles: true })); } }, card2);
    await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll("button")].find((b) => b.textContent === "Save projects").click(), card2);
    await page.waitForFunction((sel) => /No projects shared yet/.test(document.querySelector(sel).innerText), {}, card2);
    assert.equal((await connection("Renamed in UI")).projects.length, 0);
    assert.equal((await read(agent, A, DOCA)).isError, true);
    // Disconnect is a separate button and revokes the connection.
    await page.evaluate((sel) => [...document.querySelector(sel).querySelectorAll("button")].find((b) => b.textContent === "Disconnect").click(), card2);
    await page.waitForFunction((sel) => !document.querySelector(sel), {}, card2);
    assert.equal((await access()).find((x) => x.id === c.id).status, "revoked");
    assert.equal((await mcp(agent.access_token, "tools/list")).status, 401);
    await page.screenshot({ path: new URL("../tmp/test-evidence/agent-access-connections.png", import.meta.url).pathname, fullPage: true });
  } finally { await browser.close(); }
});
