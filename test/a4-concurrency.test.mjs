// A4: barrier-synchronised concurrent saves via API and MCP; idempotent retry; key reuse -> 422.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, agentHttp, mcpClient, setupProject, grant, barrier, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const P = "proj-cc";
let s, h, A, B, mA, mB, aid;
before(async () => {
  s = await startServer("a4", SERVER_PORTS.a4);
  h = await s.login();
  await setupProject(h, P);
  const gA = await grant(h, P, "agent A"), gB = await grant(h, P, "agent B");
  A = agentHttp(s.base, gA.token); B = agentHttp(s.base, gB.token);
  mA = await mcpClient(s.base, gA.token, "A"); mB = await mcpClient(s.base, gB.token, "B");
  const c = await A("POST", `/api/projects/${P}/artifacts`, { title: "Shared", body: "rev one" });
  assert.equal(c.status, 201);
  aid = c.body.artifact_id;
});
after(async () => { await mA?.close(); await mB?.close(); await s?.stop(); });

const successAudits = async (rev) => {
  const a = await h.req("GET", `/api/projects/${P}/audit`);
  return a.body.audits.filter((x) => x.action === "artifact.save" && x.object_id === aid && x.rev_no === rev && x.result === "ok").length;
};

test("API: concurrent saves on the same base -> exactly one 200 and one 409", async () => {
  const kA = key("A"), kB = key("B");
  const [ra, rb] = await barrier([
    () => A("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 1, body: "from A" }, { idem: kA }),
    () => B("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 1, body: "from B" }, { idem: kB }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const [win, lose, winKey, winClient, winBody] = ra.status === 200 ? [ra, rb, kA, A, "from A"] : [rb, ra, kB, B, "from B"];
  assert.equal(lose.body.error.code, "revision_conflict");
  assert.equal(lose.body.error.current_revision, 2);
  assert.equal(win.body.revision, 2);
  const hist = await A("GET", `/api/projects/${P}/artifacts/${aid}/history`);
  assert.deepEqual(hist.body.revisions.map((r) => r.rev), [2, 1]);
  assert.equal(hist.body.revisions[0].id, win.body.revision_id);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${aid}`)).body.body, winBody);
  assert.equal(await successAudits(2), 1);

  // Lost-response retry: same key, same body -> same stored result; no new revision.
  const retry = await winClient("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 1, body: winBody }, { idem: winKey });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.revision_id, win.body.revision_id);
  assert.equal(retry.body.idempotent_replay, true);
  // Same key, different body -> 422.
  const reuse = await winClient("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 1, body: "different" }, { idem: winKey });
  assert.equal(reuse.status, 422);
  assert.equal(reuse.body.error.code, "idempotency_key_reused");
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${aid}/history`)).body.revisions.length, 2);
  assert.equal(await successAudits(2), 1);
});

test("API: concurrent identical retries with the same key publish once", async () => {
  const k = key("dup");
  const rs = await barrier(Array.from({ length: 3 }, () => () => A("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 2, body: "dup body" }, { idem: k })));
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(new Set(rs.map((r) => r.body.revision_id)).size, 1);
  const hist = await A("GET", `/api/projects/${P}/artifacts/${aid}/history`);
  assert.deepEqual(hist.body.revisions.map((r) => r.rev), [3, 2, 1]);
  assert.equal(await successAudits(3), 1);
});

test("MCP: concurrent save_markdown from two SDK clients -> one success, one revision_conflict", async () => {
  const kA = key("mA"), kB = key("mB");
  const [ra, rb] = await barrier([
    () => mA.call("save_markdown", { project_id: P, artifact_id: aid, expected_revision: 3, body: "mcp A", idempotency_key: kA }),
    () => mB.call("save_markdown", { project_id: P, artifact_id: aid, expected_revision: 3, body: "mcp B", idempotency_key: kB }),
  ]);
  assert.deepEqual([ra.isError, rb.isError].sort(), [false, true]);
  const [win, lose, wk, wc, wb] = ra.isError ? [rb, ra, kB, mB, "mcp B"] : [ra, rb, kA, mA, "mcp A"];
  assert.equal(lose.data.error.status, 409);
  assert.equal(lose.data.error.code, "revision_conflict");
  assert.equal(win.data.revision, 4);
  const hist = await A("GET", `/api/projects/${P}/artifacts/${aid}/history`);
  assert.deepEqual(hist.body.revisions.map((r) => r.rev), [4, 3, 2, 1]);
  assert.equal(await successAudits(4), 1);
  const retry = await wc.call("save_markdown", { project_id: P, artifact_id: aid, expected_revision: 3, body: wb, idempotency_key: wk });
  assert.equal(retry.isError, false);
  assert.equal(retry.data.revision_id, win.data.revision_id);
  assert.equal(retry.data.idempotent_replay, true);
  const reuse = await wc.call("save_markdown", { project_id: P, artifact_id: aid, expected_revision: 3, body: "changed", idempotency_key: wk });
  assert.equal(reuse.isError, true);
  assert.equal(reuse.data.error.status, 422);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${aid}/history`)).body.revisions.length, 4);
});

test("API and MCP racing each other still produce exactly one winner", async () => {
  const [ra, rb] = await barrier([
    () => A("PUT", `/api/projects/${P}/artifacts/${aid}`, { expected_revision: 4, body: "api racer" }),
    () => mB.call("save_markdown", { project_id: P, artifact_id: aid, expected_revision: 4, body: "mcp racer", idempotency_key: key("x") }),
  ]);
  const wins = (ra.status === 200 ? 1 : 0) + (rb.isError ? 0 : 1);
  assert.equal(wins, 1);
  assert.ok(ra.status === 409 || rb.data?.error?.status === 409);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${aid}/history`)).body.revisions.length, 5);
  assert.equal(await successAudits(5), 1);
});

test("API: concurrent identical metadata retries with the same key apply once", async () => {
  const meta = 1; // the shared artifact's metadata has not been edited above
  const k = key("meta-dup");
  const rs = await barrier(Array.from({ length: 3 }, () => () => A("PATCH", `/api/projects/${P}/artifacts/${aid}`, { expected_meta_version: meta, title: "Shared (renamed)" }, { idem: k })));
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(rs.map((r) => r.body.meta_version), Array(3).fill(meta + 1));
  assert.equal(rs.filter((r) => !r.body.idempotent_replay).length, 1, "one original, the rest replays");
  const row = (await A("GET", `/api/projects/${P}/artifacts`)).body.artifacts.find((a) => a.id === aid);
  assert.deepEqual([row.title, row.meta_version], ["Shared (renamed)", meta + 1]);
  const stale = await A("PATCH", `/api/projects/${P}/artifacts/${aid}`, { expected_meta_version: meta, title: "other" }, { idem: key("meta-other") });
  assert.equal(stale.status, 409, "a different key on the stale version is still a conflict");
  assert.equal(stale.body.error.code, "metadata_conflict");
});
