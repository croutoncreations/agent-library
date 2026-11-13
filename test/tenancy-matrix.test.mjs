// Isolation matrix (docs/workspaces.md): two workspaces, every credential type, every read/write surface. Another
// workspace's ids are 404 (or an MCP not-found error), search never leaks its content, idempotency replays don't
// outlive a demotion, removal makes every delegated credential inactive, and suspension closes the workspace without
// destroying OAuth connections. Real local runtime, real DCR/consent/token flows, synthetic people and data only.
//
// People: "owner" (the first person; the only one the stand-in IdP can sign in to OAuth consent until phase 3
// identity) owns workspace B; bob owns workspace A. Credentials: owner -> OAuth connection + publisher;
// bob -> session + API key + legacy grant.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { agentHttp, mcpClient, key, sha256, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { makePng } from "./make-fixtures.mjs";
import { SERVER_PORTS } from "./ports.mjs";

let h, owner, bob, ownerId, bobId, WSA, A = {}, B = {}, cred = {};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body ?? r.json)); return r.body ?? r.json; };
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].results;
const png = makePng(8, 8);

// Uniform callers: each returns { status, text } where text is the whole response (for leak checks).
async function http(base, token, method, path, { body, headers = {}, idem } = {}) {
  const hd = { authorization: `Bearer ${token}`, ...headers };
  if (body !== undefined) { hd["content-type"] = "application/json"; hd["idempotency-key"] = idem ?? key("mx"); }
  const r = await fetch(base + path, { method, headers: hd, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
const v1 = (token, method, path, opts) => http(h.issuer, token, method, path, opts);
const api = (token, method, path, opts) => http(h.appUi, token, method, path, opts);
async function session(s, method, path, body, headers) {
  const r = await s.req(method, path, body, { headers });
  return { status: r.status, text: typeof r.body === "string" ? r.body : JSON.stringify(r.body) };
}

// Every read surface for one project/document/file, per credential type. Each entry: [label, () => {status, text}].
function readOps(kind, X, agent = cred.oauth) {
  const p = X.project, d = X.doc, f = X.file;
  if (kind === "session") return [
    ["list", () => session(bob, "GET", `/api/projects/${p}/artifacts`)],
    ["get", () => session(bob, "GET", `/api/projects/${p}/artifacts/${d}`)],
    ["text", () => session(bob, "GET", `/api/projects/${p}/artifacts/${d}/text`)],
    ["history", () => session(bob, "GET", `/api/projects/${p}/artifacts/${d}/history`)],
    ["diff", () => session(bob, "GET", `/api/projects/${p}/artifacts/${d}/diff?from=1&to=2`)],
    ["comments", () => session(bob, "GET", `/api/projects/${p}/artifacts/${d}/comments`)],
    ["content", () => session(bob, "GET", `/api/projects/${p}/artifacts/${f}/content`)],
    ["range", () => session(bob, "GET", `/api/projects/${p}/artifacts/${f}/content`, undefined, { range: "bytes=0-3" })],
    ["changes", () => session(bob, "GET", `/api/projects/${p}/changes`)],
    ["templates", () => session(bob, "GET", `/api/projects/${p}/templates`)],
    ["backup", () => session(bob, "GET", `/api/projects/${p}/backup`)],
  ];
  if (kind === "key") return [
    ["get", () => v1(cred.key, "GET", `/v1/projects/${p}/files/${d}`)],
    ["list", () => v1(cred.key, "GET", `/v1/projects/${p}/files`)],
    ["text", () => v1(cred.key, "GET", `/v1/projects/${p}/files/${d}/text`)],
    ["revisions", () => v1(cred.key, "GET", `/v1/projects/${p}/files/${d}/revisions`)],
    ["diff", () => v1(cred.key, "GET", `/v1/projects/${p}/files/${d}/diff?from=1&to=2`)],
    ["content", () => v1(cred.key, "GET", `/v1/projects/${p}/files/${f}/content`)],
    ["range", () => v1(cred.key, "GET", `/v1/projects/${p}/files/${f}/content`, { headers: { range: "bytes=0-3" } })],
    ["changes", () => v1(cred.key, "GET", `/v1/projects/${p}/changes`)],
    ["templates", () => v1(cred.key, "GET", `/v1/projects/${p}/templates`)],
  ];
  if (kind === "grant") return [
    ["get", () => api(cred.grant, "GET", `/api/projects/${p}/artifacts/${d}`)],
    ["list", () => api(cred.grant, "GET", `/api/projects/${p}/artifacts`)],
    ["history", () => api(cred.grant, "GET", `/api/projects/${p}/artifacts/${d}/history`)],
    ["content", () => api(cred.grant, "GET", `/api/projects/${p}/artifacts/${f}/content`)],
    ["range", () => api(cred.grant, "GET", `/api/projects/${p}/artifacts/${f}/content`, { headers: { range: "bytes=0-3" } })],
    ["mcp read_artifact", async () => mcpCall(cred.grantMcp, "read_artifact", { project_id: p, artifact_id: d })],
    ["mcp artifact_history", async () => mcpCall(cred.grantMcp, "artifact_history", { project_id: p, artifact_id: d })],
  ];
  if (kind === "oauth") return [
    ["read_artifact", () => oc(agent, "read_artifact", { project_id: p, artifact_id: d })],
    ["list_artifacts", () => oc(agent, "list_artifacts", { project_id: p })],
    ["artifact_history", () => oc(agent, "artifact_history", { project_id: p, artifact_id: d })],
    ["diff_revisions", () => oc(agent, "diff_revisions", { project_id: p, artifact_id: d, from: 1, to: 2 })],
    ["read_file", () => oc(agent, "read_file", { project_id: p, artifact_id: f, include_image: false })],
    ["list_changes", () => oc(agent, "list_changes", { project_id: p })],
  ];
  throw new Error(kind);
}
// MCP results map to the tool error's own HTTP status (error.status), never a blanket 404, so a validation error
// can't pass for isolation. Transport-level refusals (401) keep their status.
const toolStatus = (r) => !r.isError ? 200 : (r.data?.error?.status ?? r.data?.status ?? (r.status >= 400 ? r.status : 500));
const mcpCall = async (m, name, args) => { try { const r = await m.call(name, args); return { status: toolStatus(r), text: JSON.stringify(r.data ?? {}) }; } catch (e) { return { status: e.code ?? 500, text: String(e.message) }; } };
const oc = async (agent, name, args) => { const r = await agent.call(name, args); return { status: toolStatus(r), text: JSON.stringify(r.data ?? {}) }; };

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["tenancy-matrix"] });
  owner = await h.owner();
  ownerId = ok(await owner.req("GET", "/api/me")).principal.id;
  // Workspace B = the owner's personal workspace.
  B.project = ok(await owner.req("POST", "/api/projects", { title: "B project" }), 201).id;
  // Link the owner's upstream sign-in while they are the only person (phase 2 limitation), then add bob.
  await h.connectMcpAgent({ [B.project]: "read" }, { clientName: "link" });
  bob = await h.person("bob");
  bobId = ok(await bob.req("GET", "/api/me")).principal.id;
  WSA = ok(await bob.req("POST", "/api/workspaces", { name: "Workspace A" }), 201).id;
  A.project = ok(await bob.req("POST", "/api/projects", { title: "A project", workspace_id: WSA }), 201).id;
  for (const [X, who, marker] of [[A, bob, "zebraAlpha"], [B, owner, "zebraBravo"]]) {
    const d = ok(await who.req("POST", `/api/projects/${X.project}/artifacts`, { title: `${marker} doc`, body: `synthetic ${marker} one` }), 201);
    X.doc = d.artifact_id;
    ok(await who.req("PUT", `/api/projects/${X.project}/artifacts/${X.doc}`, { expected_revision: 1, body: `synthetic ${marker} two` }));
    ok(await who.req("POST", `/api/projects/${X.project}/artifacts/${X.doc}/comments`, { revision: 2, body: `synthetic ${marker} comment` }), 201);
    const b = ok(await who.req("POST", `/api/projects/${X.project}/uploads`, { title: `${marker} image`, mime: "image/png", size: png.length, sha256: sha256(png) }), 201);
    const put = await fetch(h.appUi + b.put_url, { method: "PUT", headers: { cookie: who.cookie, "x-csrf-token": who.csrf, "content-type": "application/octet-stream" }, body: png });
    assert.equal(put.status, 200);
    X.file = ok(await who.req("POST", `/api/projects/${X.project}/uploads/${b.upload_id}/finish`)).artifact_id;
    X.marker = marker;
  }
  // bob: API key (read_write) and legacy grant into A.
  cred.key = ok(await bob.req("POST", "/api/api-keys", { label: "bob key", projects: [{ project_id: A.project, access: "read_write" }] }), 201).secret;
  cred.grant = ok(await bob.req("POST", `/api/projects/${A.project}/grants`, { label: "bob grant", can_write: true }), 201).token;
  cred.grantMcp = await mcpClient(h.appUi, cred.grant, "matrix-grant");
  // owner: OAuth connection (write) and publisher into B.
  cred.oauth = await h.connectMcpAgent({ [B.project]: "write" }, { clientName: "Owner agent" });
  const app = await h.registerApp({ display_name: "Matrix Publisher", redirect_uris: ["http://127.0.0.1:5996/cb"] });
  cred.pub = await h.connectPublisher(app, { project_id: B.project, destination: "root" });
  cred.app = app;
});
after(async () => { await cred.grantMcp?.close(); await h?.stop(); });

test("own workspace: every read surface works for every credential type", async () => {
  for (const kind of ["session", "key", "grant"]) for (const [label, op] of readOps(kind, A)) {
    const r = await op();
    assert.ok(r.status === 200 || r.status === 206, `${kind} ${label} on own workspace: ${r.status} ${r.text.slice(0, 200)}`);
  }
  for (const [label, op] of readOps("oauth", B)) {
    const r = await op();
    assert.equal(r.status, 200, `oauth ${label} on own workspace: ${r.text.slice(0, 200)}`);
  }
  assert.equal((await h.pub(cred.pub.access_token, "GET", "/app")).status, 200);
});

test("other workspace: every read surface is 404 for every credential type, and nothing leaks", async () => {
  for (const kind of ["session", "key", "grant"]) for (const [label, op] of readOps(kind, B)) {
    const r = await op();
    assert.equal(r.status, 404, `${kind} ${label} on another workspace must be 404 (got ${r.status} ${r.text.slice(0, 200)})`);
    assert.doesNotMatch(r.text, /zebraBravo/, `${kind} ${label} leaked B`);
  }
  for (const [label, op] of readOps("oauth", A)) {
    const r = await op();
    assert.equal(r.status, 404, `oauth ${label} on another workspace: ${r.text.slice(0, 200)}`);
    assert.doesNotMatch(r.text, /zebraAlpha/, `oauth ${label} leaked A`);
  }
  // Search: the own marker is found (search works), the other workspace's never appears, even when named.
  const searches = [
    ["session", (q) => session(bob, "GET", `/api/search?query=${q}`), "zebraAlpha", "zebraBravo", B.project],
    ["key", (q, ids) => v1(cred.key, "GET", `/v1/search?query=${q}${ids ? `&project_ids=${ids}` : ""}`), "zebraAlpha", "zebraBravo", B.project],
    ["oauth", (q, ids) => oc(cred.oauth, "search_artifacts", { query: q, ...ids ? { project_ids: [ids] } : {} }), "zebraBravo", "zebraAlpha", A.project],
  ];
  for (const [label, search, own, other, otherProject] of searches) {
    const mine = await search(own);
    assert.equal(mine.status, 200, `${label} search: ${mine.text.slice(0, 200)}`);
    assert.match(mine.text, new RegExp(own), `${label} search must find its own workspace's document`);
    const theirs = await search(other);
    assert.equal(theirs.status, 200);
    assert.doesNotMatch(theirs.text, new RegExp(other), `${label} search leaked the other workspace`);
    if (label !== "session") { const named = await search(other, otherProject); assert.doesNotMatch(named.text, new RegExp(other), `${label} search naming the other project leaked`); }
  }
  // Project lists and connection info: each names its own workspace's project and never the other's.
  for (const [label, r, own, other] of [
    ["key /v1/projects", await v1(cred.key, "GET", "/v1/projects"), A.project, B.project],
    ["key connection-info", await v1(cred.key, "GET", "/v1/connection-info"), A.project, B.project],
    ["grant /api/projects", await api(cred.grant, "GET", "/api/projects"), A.project, B.project],
    ["grant list_projects", await mcpCall(cred.grantMcp, "list_projects", {}), A.project, B.project],
    ["oauth list_projects", await oc(cred.oauth, "list_projects", {}), B.project, A.project],
    ["oauth connection_info", await oc(cred.oauth, "connection_info", {}), B.project, A.project],
  ]) {
    assert.equal(r.status, 200, `${label}: ${r.text.slice(0, 200)}`);
    assert.ok(r.text.includes(own), `${label} must list its own project`);
    assert.ok(!r.text.includes(other), `${label} lists the other workspace's project`);
  }
});

test("other workspace: every write surface is refused for every credential type and changes nothing", async () => {
  const before = ok(await owner.req("GET", `/api/projects/${B.project}/artifacts/${B.doc}`)).revision.rev;
  const aBefore = ok(await bob.req("GET", `/api/projects/${A.project}/artifacts/${A.doc}`)).revision.rev;
  const writes = [
    ["session save", () => session(bob, "PUT", `/api/projects/${B.project}/artifacts/${B.doc}`, { expected_revision: before, body: "pwn" })],
    ["session create", () => session(bob, "POST", `/api/projects/${B.project}/artifacts`, { title: "x", body: "pwn" })],
    ["session comment", () => session(bob, "POST", `/api/projects/${B.project}/artifacts/${B.doc}/comments`, { revision: 1, body: "pwn" })],
    ["session upload", () => session(bob, "POST", `/api/projects/${B.project}/uploads`, { title: "x", mime: "image/png", size: png.length, sha256: sha256(png) })],
    ["session restore", () => session(bob, "POST", `/api/projects/${B.project}/artifacts/${B.doc}/restore`, { revision: 1, expected_revision: before })],
    ["session grant", () => session(bob, "POST", `/api/projects/${B.project}/grants`, { label: "x", can_write: true })],
    ["key save", () => v1(cred.key, "PUT", `/v1/projects/${B.project}/files/${B.doc}`, { body: { expected_revision: before, body: "pwn" } })],
    ["key create", () => v1(cred.key, "POST", `/v1/projects/${B.project}/files`, { body: { title: "x", body: "pwn" } })],
    ["grant save", () => api(cred.grant, "PUT", `/api/projects/${B.project}/artifacts/${B.doc}`, { body: { expected_revision: before, body: "pwn" } })],
    ["grant upload", () => api(cred.grant, "POST", `/api/projects/${B.project}/uploads`, { body: { title: "x", mime: "image/png", size: png.length, sha256: sha256(png) } })],
    ["grant mcp save", () => mcpCall(cred.grantMcp, "save_markdown", { project_id: B.project, artifact_id: B.doc, expected_revision: before, body: "pwn", idempotency_key: key("g") })],
    ["oauth save", () => oc(cred.oauth, "save_markdown", { project_id: A.project, artifact_id: A.doc, expected_revision: aBefore, body: "pwn", idempotency_key: key("o") })],
    ["oauth upload", () => oc(cred.oauth, "upload_file", { project_id: A.project, title: "x", mime: "image/png", content_base64: png.toString("base64"), change_note: "x", idempotency_key: key("o") })],
    ["oauth upload_begin", () => oc(cred.oauth, "upload_begin", { project_id: A.project, title: "x", mime: "image/png", size: png.length, sha256: sha256(png), change_note: "x", idempotency_key: key("o") })],
  ];
  for (const [label, op] of writes) {
    const r = await op();
    assert.equal(r.status, 404, `${label} on another workspace must be 404 (got ${r.status} ${r.text.slice(0, 200)})`);
  }
  assert.equal(ok(await owner.req("GET", `/api/projects/${B.project}/artifacts/${B.doc}`)).revision.rev, before);
  assert.equal(ok(await bob.req("GET", `/api/projects/${A.project}/artifacts/${A.doc}`)).revision.rev, aBefore);
  // Positive controls: the same MCP calls succeed on the credential's own project, so the 404s above were isolation.
  const aRev = ok(await bob.req("GET", `/api/projects/${A.project}/artifacts/${A.doc}`)).revision.rev;
  assert.equal((await mcpCall(cred.grantMcp, "save_markdown", { project_id: A.project, artifact_id: A.doc, expected_revision: aRev, body: "synthetic zebraAlpha three", idempotency_key: key("g") })).status, 200);
  const bRev = ok(await owner.req("GET", `/api/projects/${B.project}/artifacts/${B.doc}`)).revision.rev;
  assert.equal((await oc(cred.oauth, "save_markdown", { project_id: B.project, artifact_id: B.doc, expected_revision: bRev, body: "synthetic zebraBravo three", idempotency_key: key("o") })).status, 200);
  assert.equal((await oc(cred.oauth, "upload_begin", { project_id: B.project, title: "x", mime: "image/png", size: png.length, sha256: sha256(png), change_note: "x", idempotency_key: key("o") })).status, 200);
  // A publisher can't be connected into a project of a workspace its signer doesn't belong to.
  const pa = await h.authorize(cred.app, { project_id: A.project, destination: "root" });
  assert.ok(!pa.code, "publisher consent into another workspace's project must fail");
  assert.equal(pa.error, 400, `publisher consent refusal: ${pa.error}`);
  assert.doesNotMatch(pa.html ?? "", /A project|zebraAlpha/, "the refusal names nothing from the other workspace");
});

test("idempotency replay does not outlive a demotion (API key and OAuth)", async () => {
  // Invite the owner into A so their OAuth agent can write there, then demote and replay.
  const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
  assert.equal(inv.emailed, false, "no mail adapter: the invitation says it wasn't emailed (link only)");
  assert.equal(inv.email_failed, false, "no mail adapter isn't a failure");
  ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  cred.oauthA = await h.connectMcpAgent({ [A.project]: "write" }, { clientName: "Owner agent A" });
  // Key write with K, then bob (the key's creator) is capped to viewer on that project; replaying K must not return
  // the stored success.
  const K = key("replay");
  const w = await v1(cred.key, "POST", `/v1/projects/${A.project}/files`, { body: { title: "replayed", body: "synthetic replay" }, idem: K });
  assert.equal(w.status, 201, w.text);
  sql(`INSERT INTO project_members (project_id, principal_id, role) VALUES ('${A.project}', '${bobId}', 'viewer')`);
  try {
    const again = await v1(cred.key, "POST", `/v1/projects/${A.project}/files`, { body: { title: "replayed", body: "synthetic replay" }, idem: K });
    assert.equal(again.status, 403, `replay after demotion: ${again.status} ${again.text.slice(0, 200)}`);
  } finally { sql(`DELETE FROM project_members WHERE project_id = '${A.project}' AND principal_id = '${bobId}'`); }
  const OK = key("oreplay");
  const ow = await oc(cred.oauthA, "create_markdown", { project_id: A.project, title: "oauth replay", body: "synthetic", idempotency_key: OK });
  assert.equal(ow.status, 200, ow.text);
  ok(await bob.req("PATCH", `/api/workspaces/${WSA}/members/${ownerId}`, { role: "viewer" }));
  const oagain = await oc(cred.oauthA, "create_markdown", { project_id: A.project, title: "oauth replay", body: "synthetic", idempotency_key: OK });
  assert.notEqual(oagain.status, 200, `OAuth replay after demotion must be refused: ${oagain.text.slice(0, 200)}`);
  ok(await bob.req("PATCH", `/api/workspaces/${WSA}/members/${ownerId}`, { role: "member" }));
});

test("suspension makes the workspace read-only for every credential; refresh keeps working; deleting closes it", async () => {
  // Before suspending: an upload begun (bytes sent) but not finished, and a key write whose idempotency key is replayed.
  const ub = ok(await bob.req("POST", `/api/projects/${A.project}/uploads`, { title: "pending", mime: "image/png", size: png.length, sha256: sha256(png) }), 201);
  assert.equal((await fetch(h.appUi + ub.put_url, { method: "PUT", headers: { cookie: bob.cookie, "x-csrf-token": bob.csrf, "content-type": "application/octet-stream" }, body: png })).status, 200);
  cred.pendingUpload = ub.upload_id;
  cred.replayKey = key("rp");
  assert.equal((await v1(cred.key, "POST", `/v1/projects/${A.project}/files`, { body: { title: "replay me", body: "synthetic" }, idem: cred.replayKey })).status, 201);
  // The owner registered cred.app in their personal workspace; move it into A for this check (owner is a member of A).
  sql(`UPDATE app_clients SET workspace_id = '${WSA}' WHERE id = '${cred.app.app_client_id}'`);
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`);
  try {
    // Every read surface keeps working for every credential type (D11 B / D13 A).
    for (const kind of ["session", "key", "grant"]) for (const [label, op] of readOps(kind, A)) {
      const r = await op();
      assert.ok(r.status === 200 || r.status === 206, `${kind} ${label} in a suspended workspace: ${r.status} ${r.text.slice(0, 160)}`);
    }
    for (const [label, op] of readOps("oauth", A, cred.oauthA)) assert.equal((await op()).status, 200, `oauth ${label} in a suspended workspace`);
    // Every write surface is refused with workspace_read_only, and nothing changes.
    const rev = ok(await bob.req("GET", `/api/projects/${A.project}/artifacts/${A.doc}`)).revision.rev;
    for (const [label, op] of [
      ["session save", () => session(bob, "PUT", `/api/projects/${A.project}/artifacts/${A.doc}`, { expected_revision: rev, body: "x" })],
      ["session upload", () => session(bob, "POST", `/api/projects/${A.project}/uploads`, { title: "x", mime: "image/png", size: png.length, sha256: sha256(png) })],
      ["session comment", () => session(bob, "POST", `/api/projects/${A.project}/artifacts/${A.doc}/comments`, { revision: rev, body: "x" })],
      ["key save", () => v1(cred.key, "PUT", `/v1/projects/${A.project}/files/${A.doc}`, { body: { expected_revision: rev, body: "x" } })],
      ["grant save", () => api(cred.grant, "PUT", `/api/projects/${A.project}/artifacts/${A.doc}`, { body: { expected_revision: rev, body: "x" } })],
      ["grant mcp save", () => mcpCall(cred.grantMcp, "save_markdown", { project_id: A.project, artifact_id: A.doc, expected_revision: rev, body: "x", idempotency_key: key("s") })],
      ["oauth save", () => oc(cred.oauthA, "save_markdown", { project_id: A.project, artifact_id: A.doc, expected_revision: rev, body: "x", idempotency_key: key("s") })],
      ["session rename", () => session(bob, "PATCH", `/api/projects/${A.project}/artifacts/${A.doc}`, { expected_meta_version: 1, title: "renamed while suspended" })],
      ["session folder", () => session(bob, "POST", `/api/projects/${A.project}/folders`, { name: "x" })],
      ["session template", () => session(bob, "POST", `/api/projects/${A.project}/templates`, { artifact_id: A.doc, expected_revision: rev, description: "x" })],
      ["session restore", () => session(bob, "POST", `/api/projects/${A.project}/artifacts/${A.doc}/restore`, { from_revision: 1, expected_revision: rev })],
      ["session upload finish", () => session(bob, "POST", `/api/projects/${A.project}/uploads/${cred.pendingUpload}/finish`)],
      ["key replay", () => v1(cred.key, "POST", `/v1/projects/${A.project}/files`, { body: { title: "replay me", body: "synthetic" }, idem: cred.replayKey })],
      ["new key", () => session(bob, "POST", "/api/api-keys", { label: "x", projects: [{ project_id: A.project, access: "read" }] })],
      ["app settings", () => session(owner, "PUT", `/api/app-clients/${cred.app.app_client_id}`, { suggested_project: "x" })],
      ["oauth upload", () => oc(cred.oauthA, "upload_file", { project_id: A.project, title: "x", mime: "image/png", content_base64: png.toString("base64"), change_note: "x", idempotency_key: key("s") })],
    ]) {
      const r = await op();
      assert.equal(r.status, 403, `${label} in a suspended workspace: ${r.status} ${r.text.slice(0, 160)}`);
      assert.match(r.text, /workspace_read_only/, label);
    }
    assert.equal(ok(await bob.req("GET", `/api/projects/${A.project}/artifacts/${A.doc}`)).revision.rev, rev);
    // Refresh keeps working while suspended: connections stay usable for reads.
    const rt = await h.token({ grant_type: "refresh_token", refresh_token: cred.oauthA.refresh_token, client_id: cred.oauthA.client_id, resource: `${h.issuer}/mcp` });
    assert.equal(rt.status, 200, JSON.stringify(rt.body));
    cred.oauthA.refresh_token = rt.body.refresh_token;
    // Deleting: closed for every credential, and refresh is terminal.
    sql(`UPDATE workspaces SET status = 'deleting' WHERE id = '${WSA}'`);
    for (const kind of ["key", "grant"]) for (const [label, op] of readOps(kind, A)) {
      const r = await op();
      assert.ok(r.status === 401 || r.status === 404, `${kind} ${label} in a deleting workspace: ${r.status}`);
      assert.doesNotMatch(r.text, /zebraAlpha/);
    }
    for (const [label, op] of readOps("session", A)) assert.equal((await op()).status, 404, `session ${label} in a deleting workspace`);
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); sql(`UPDATE app_clients SET workspace_id = NULL WHERE id = '${cred.app.app_client_id}'`); }
  assert.equal((await v1(cred.key, "GET", `/v1/projects/${A.project}/files/${A.doc}`)).status, 200, "back to normal once active");
});

test("removal: every credential the person created becomes inactive; refresh is invalid_grant", async () => {
  ok(await bob.req("DELETE", `/api/workspaces/${WSA}/members/${ownerId}`));
  const r = await cred.oauthA.call("read_artifact", { project_id: A.project, artifact_id: A.doc });
  assert.equal(r.status, 401, `removed creator's OAuth token: ${r.status} ${JSON.stringify(r.data)}`);
  const rt = await h.token({ grant_type: "refresh_token", refresh_token: cred.oauthA.refresh_token, client_id: cred.oauthA.client_id, resource: `${h.issuer}/mcp` });
  assert.equal(rt.status, 400, JSON.stringify(rt.body)); assert.equal(rt.body.error, "invalid_grant");
  // Bob's own credentials are unaffected by the owner's removal.
  assert.equal((await v1(cred.key, "GET", `/v1/projects/${A.project}/files/${A.doc}`)).status, 200);
});

test("management: members get 403, outsiders 404; a chosen project id is refused", async () => {
  const carol = await h.person("carol");
  const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "carol@example.test", role: "member" }), 201);
  ok(await carol.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  const dave = await h.person("dave");
  for (const [method, path, body] of [
    ["POST", `/api/projects/${A.project}/grants`, { label: "x", can_write: true }],
    ["GET", `/api/projects/${A.project}/grants`],
    ["GET", `/api/projects/${A.project}/audit`],
    ["GET", `/api/projects/${A.project}/backup`],
    ["POST", `/api/workspaces/${WSA}/invites`, { email: "x@example.test", role: "member" }],
    ["POST", "/api/projects", { title: "x", workspace_id: WSA }],
    ["POST", "/api/app-clients", { display_name: "x", redirect_uris: ["http://127.0.0.1:5995/cb"], workspace_id: WSA }],
  ]) {
    assert.equal((await carol.req(method, path, body)).status, 403, `member ${method} ${path}`);
    assert.equal((await dave.req(method, path, body)).status, 404, `outsider ${method} ${path}`);
  }
  // Chosen ids: refused whether or not the id exists, so the answer reveals nothing.
  const taken = await dave.req("POST", "/api/projects", { id: A.project, title: "x" });
  const free = await dave.req("POST", "/api/projects", { id: "never-used-id", title: "x" });
  assert.equal(taken.status, 400); assert.equal(free.status, 400);
  assert.equal(JSON.stringify(taken.body.error.code), JSON.stringify(free.body.error.code));
  // Admins see and can revoke a publisher a member connected into their workspace's project (the member's own app).
  // Re-invite the owner (removed above) as member, connect their publisher app into A, then bob revokes it.
  const inv2 = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: inv2.accept_url.split("/").pop() }));
  const pubA = await h.connectPublisher(cred.app, { project_id: A.project, destination: "root" });
  const listed = ok(await bob.req("GET", "/api/app-clients")).other_publishers.find((p) => p.publisher_id === pubA.publisher_id);
  assert.ok(listed && listed.project_id === A.project, "the admin sees the member's publisher in other_publishers");
  // An outsider sees nothing of it and can't revoke it; the admin can.
  assert.equal((await dave.req("GET", "/api/app-clients")).body.other_publishers.some((p) => p.publisher_id === pubA.publisher_id), false);
  assert.equal((await dave.req("POST", `/api/publishers/${pubA.publisher_id}/revoke`)).status, 404);
  ok(await bob.req("POST", `/api/publishers/${pubA.publisher_id}/revoke`));
  assert.equal((await h.pub(pubA.access_token, "GET", "/app")).status, 401);
  // The owner's own app listing shows only publishers whose project they can see (the B one, and A while member).
  ok(await bob.req("DELETE", `/api/workspaces/${WSA}/members/${ownerId}`));
  const mineAfter = ok(await owner.req("GET", "/api/app-clients")).app_clients.flatMap((c) => c.publishers);
  assert.ok(mineAfter.some((p) => p.project_id === B.project));
});

test("last owner: two concurrent demotions of the only two owners leave exactly one owner", async () => {
  const eve = await h.person("eve");
  const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "eve@example.test", role: "admin" }), 201);
  ok(await eve.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  const eveId = ok(await eve.req("GET", "/api/me")).principal.id;
  ok(await bob.req("PATCH", `/api/workspaces/${WSA}/members/${eveId}`, { role: "owner" }));
  const [r1, r2] = await Promise.all([
    bob.req("PATCH", `/api/workspaces/${WSA}/members/${eveId}`, { role: "member" }),
    eve.req("PATCH", `/api/workspaces/${WSA}/members/${bobId}`, { role: "member" }),
  ]);
  const owners = sql(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = '${WSA}' AND role = 'owner'`)[0].n;
  assert.ok(owners >= 1, `at least one owner must remain (statuses ${r1.status}, ${r2.status})`);
  // Each success removed one owner: the statuses agree with the final state.
  assert.equal([r1, r2].filter((r) => r.status === 200).length, 2 - owners, `statuses ${r1.status}, ${r2.status}; owners ${owners}`);
});
