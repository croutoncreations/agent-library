// A2: cross-project isolation, read-only grants, foreign IDs -> 404, search scoping (HTTP + MCP).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, agentHttp, mcpClient, setupProject, grant } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

let s, h, A, R, mA, mR, foreignId, ownId;
before(async () => {
  s = await startServer("a2", SERVER_PORTS.a2);
  h = await s.login();
  await setupProject(h, "proj-one");
  await setupProject(h, "proj-two");
  const gA = await grant(h, "proj-one", "agent A", true);
  const gR = await grant(h, "proj-one", "reader R", false);
  A = agentHttp(s.base, gA.token);
  R = agentHttp(s.base, gR.token);
  mA = await mcpClient(s.base, gA.token, "A");
  mR = await mcpClient(s.base, gR.token, "R");
  const f = await h.req("POST", "/api/projects/proj-two/artifacts", { title: "Foreign secret", body: "zebracorn foreign text" });
  assert.equal(f.status, 201);
  foreignId = f.body.artifact_id;
  const o = await A("POST", "/api/projects/proj-one/artifacts", { title: "Own doc", body: "plain own text" });
  assert.equal(o.status, 201);
  ownId = o.body.artifact_id;
});
after(async () => { await mA?.close(); await mR?.close(); await s?.stop(); });

test("agent cannot list, read or write a project it has no grant for (404, not 403)", async () => {
  assert.equal((await A("GET", "/api/projects/proj-two/artifacts")).status, 404);
  assert.equal((await A("GET", `/api/projects/proj-two/artifacts/${foreignId}`)).status, 404);
  assert.equal((await A("GET", `/api/projects/proj-two/artifacts/${foreignId}/content`)).status, 404);
  assert.equal((await A("POST", "/api/projects/proj-two/artifacts", { title: "x", body: "y" })).status, 404);
  const pl = await A("GET", "/api/projects");
  assert.deepEqual(pl.body.projects.map((p) => p.id), ["proj-one"]);
});

test("foreign artifact ID addressed through an authorized project is 404", async () => {
  for (const sub of ["", "/content", "/history", "/preview", "/comments"])
    assert.equal((await A("GET", `/api/projects/proj-one/artifacts/${foreignId}${sub}`)).status, 404, sub);
  assert.equal((await A("PUT", `/api/projects/proj-one/artifacts/${foreignId}`, { expected_revision: 1, body: "pwn" })).status, 404);
  const m = await mA.call("read_artifact", { project_id: "proj-one", artifact_id: foreignId });
  assert.equal(m.isError, true);
  assert.equal(m.data.error.status, 404);
  const m2 = await mA.call("list_artifacts", { project_id: "proj-two" });
  assert.equal(m2.isError, true);
  assert.equal(m2.data.error.status, 404);
});

test("search is scoped to the authorized project", async () => {
  const r = await A("GET", "/api/projects/proj-one/artifacts?q=zebracorn");
  assert.equal(r.status, 200);
  assert.equal(r.body.artifacts.length, 0);
  const m = await mA.call("list_artifacts", { project_id: "proj-one", query: "zebracorn" });
  assert.equal(m.data.artifacts.length, 0);
  const own = await A("GET", "/api/projects/proj-one/artifacts?q=plain%20own");
  assert.deepEqual(own.body.artifacts.map((a) => a.id), [ownId]);
  // owner sees the foreign doc in its own project
  const ho = await h.req("GET", "/api/projects/proj-two/artifacts?q=zebracorn");
  assert.deepEqual(ho.body.artifacts.map((a) => a.id), [foreignId]);
});

test("read-only grant can read but every write is denied (HTTP 403, MCP isError 403)", async () => {
  assert.equal((await R("GET", `/api/projects/proj-one/artifacts/${ownId}`)).status, 200);
  assert.equal((await R("POST", "/api/projects/proj-one/artifacts", { title: "x", body: "y" })).status, 403);
  assert.equal((await R("PUT", `/api/projects/proj-one/artifacts/${ownId}`, { expected_revision: 1, body: "nope" })).status, 403);
  assert.equal((await R("PATCH", `/api/projects/proj-one/artifacts/${ownId}`, { expected_meta_version: 1, trashed: true })).status, 403);
  assert.equal((await R("POST", "/api/projects/proj-one/uploads", { title: "x", mime: "image/png", size: 10, sha256: "0".repeat(64) })).status, 403);
  const m = await mR.call("save_markdown", { project_id: "proj-one", artifact_id: ownId, expected_revision: 1, body: "nope", idempotency_key: "ro-key-0001" });
  assert.equal(m.isError, true);
  assert.equal(m.data.error.status, 403);
  const c = await mR.call("create_markdown", { project_id: "proj-one", title: "x", body: "y", idempotency_key: "ro-key-0002" });
  assert.equal(c.data.error.status, 403);
  const cur = await A("GET", `/api/projects/proj-one/artifacts/${ownId}`);
  assert.equal(cur.body.revision.rev, 1);
  assert.equal(cur.body.body, "plain own text");
});

test("agents cannot administer grants or read audit/backup", async () => {
  assert.equal((await A("POST", "/api/projects/proj-one/grants", { label: "x", can_write: true })).status, 403);
  assert.equal((await A("GET", "/api/projects/proj-one/audit")).status, 403);
  assert.equal((await A("GET", "/api/projects/proj-one/backup")).status, 403);
});
