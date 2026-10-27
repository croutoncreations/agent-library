// A11: trash hides from list/content; agent has no purge; owner restores.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, agentHttp, mcpClient, setupProject, grant, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const P = "proj-tr";
let s, h, A, mA, aid;
before(async () => {
  s = await startServer("a11", SERVER_PORTS.a11);
  h = await s.login();
  await setupProject(h, P);
  const g = await grant(h, P, "agent A");
  A = agentHttp(s.base, g.token);
  mA = await mcpClient(s.base, g.token, "A");
  aid = (await A("POST", `/api/projects/${P}/artifacts`, { title: "trash me", body: "content to trash" })).body.artifact_id;
  await A("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 1, body: "second" });
});
after(async () => { await mA?.close(); await s?.stop(); });

test("agent toolset has no purge/delete tool", async () => {
  const names = (await mA.client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("trash_artifact"));
  assert.ok(!names.some((n) => /purge|delete|destroy|remove/i.test(n)), names.join(","));
  assert.ok([404, 405].includes((await A("DELETE", `/api/projects/${P}/artifacts/${aid}`)).status));
});

test("agent trashes via MCP; hidden from list, read and content", async () => {
  const t = await mA.call("trash_artifact", { project_id: P, artifact_id: aid, expected_meta_version: 1, idempotency_key: key("t") });
  assert.equal(t.isError, false, JSON.stringify(t.data));
  assert.equal(t.data.trashed, true);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts`)).body.artifacts.length, 0);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts?q=second`)).body.artifacts.length, 0);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${aid}`)).status, 404);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${aid}/content`)).status, 404);
  const r = await mA.call("read_artifact", { project_id: P, artifact_id: aid });
  assert.equal(r.data.error.status, 404);
  const sv = await A("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 2, body: "write to trashed" });
  assert.ok([404, 409].includes(sv.status));
  const trashList = await h.req("GET", `/api/projects/${P}/artifacts?trashed=1`);
  assert.deepEqual(trashList.body.artifacts.map((a) => a.id), [aid]);
});

test("owner restores from trash; history intact", async () => {
  const r = await h.req("PATCH", `/api/projects/${P}/artifacts/${aid}`, { expected_meta_version: 2, trashed: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.trashed, false);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts`)).body.artifacts.length, 1);
  const g = await A("GET", `/api/projects/${P}/artifacts/${aid}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.body, "second");
  assert.deepEqual((await A("GET", `/api/projects/${P}/artifacts/${aid}/history`)).body.revisions.map((x) => x.rev), [2, 1]);
});
