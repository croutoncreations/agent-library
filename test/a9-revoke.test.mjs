// A9: revoking agent B immediately blocks MCP, API, content/Range and transfer PUT, while A keeps working.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startServer, agentHttp, mcpClient, setupProject, grant, sha256, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makeFixtures } from "./make-fixtures.mjs";

const P = "proj-rv";
let s, h, A, B, gB, gBtok, mA, mB, docId, binId, pendingPut, png;
before(async () => {
  png = readFileSync(makeFixtures().png);
  s = await startServer("a9", SERVER_PORTS.a9);
  h = await s.login();
  await setupProject(h, P);
  const gA = await grant(h, P, "agent A");
  gB = await grant(h, P, "agent B");
  gBtok = gB.token;
  A = agentHttp(s.base, gA.token); B = agentHttp(s.base, gB.token);
  mA = await mcpClient(s.base, gA.token, "A");
  mB = await mcpClient(s.base, gB.token, "B");
  docId = (await A("POST", `/api/projects/${P}/artifacts`, { title: "doc", body: "hello" })).body.artifact_id;
  const b = await A("POST", `/api/projects/${P}/uploads`, { title: "img", mime: "image/png", size: png.length, sha256: sha256(png) });
  await A("PUT", b.body.put_url, undefined, { raw: png });
  binId = (await A("POST", `/api/projects/${P}/uploads/${b.body.upload_id}/finish`)).body.artifact_id;
  // B starts an upload before revocation (pending transfer)
  const bb = await B("POST", `/api/projects/${P}/uploads`, { title: "b-img", mime: "image/png", size: png.length, sha256: sha256(png) });
  assert.equal(bb.status, 201);
  pendingPut = bb.body.put_url;
});
after(async () => { await mA?.close(); try { await mB?.close(); } catch {} await s?.stop(); });

test("B works before revocation", async () => {
  assert.equal((await B("GET", `/api/projects/${P}/artifacts/${docId}`)).status, 200);
  assert.equal((await mB.call("read_artifact", { project_id: P, artifact_id: docId })).isError, false);
});

test("after revoke: B gets 401 on API, content, Range, transfer PUT and MCP; A still works", async () => {
  const rv = await h.req("PATCH", `/api/projects/${P}/grants/${gB.grant_id}`, { revoke: true });
  assert.equal(rv.status, 200);
  assert.equal((await B("GET", `/api/projects/${P}/artifacts`)).status, 401);
  assert.equal((await B("GET", `/api/projects/${P}/artifacts/${docId}`)).status, 401);
  assert.equal((await B("PUT", `/api/projects/${P}/artifacts/${docId}`, { expected_revision: 1, body: "x" })).status, 401);
  assert.equal((await B("GET", `/api/projects/${P}/artifacts/${binId}/content`)).status, 401);
  assert.equal((await B("GET", `/api/projects/${P}/artifacts/${binId}/content`, undefined, { headers: { range: "bytes=0-9" } })).status, 401);
  assert.equal((await B("HEAD", `/api/projects/${P}/artifacts/${binId}/content`)).status, 401);
  assert.equal((await B("PUT", pendingPut, undefined, { raw: png })).status, 401);
  // Existing SDK client: the next call must fail with an HTTP 401 surfaced by the transport.
  await assert.rejects(() => mB.call("read_artifact", { project_id: P, artifact_id: docId }), /401|Unauthorized|unauth|revoked/i);
  // Raw MCP POST also returns 401 + WWW-Authenticate resource_metadata.
  const raw = await fetch(s.base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${gBtok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(raw.status, 401);
  assert.match(raw.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  // A unaffected
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${binId}/content`, undefined, { headers: { range: "bytes=0-9" } })).status, 206);
  const s2 = await mA.call("save_markdown", { project_id: P, artifact_id: docId, expected_revision: 1, body: "A still writes", idempotency_key: key("a") });
  assert.equal(s2.isError, false);
  assert.equal(s2.data.revision, 2);
});

test("revocation is audited and grant list shows revoked", async () => {
  const g = await h.req("GET", `/api/projects/${P}/grants`);
  assert.equal(g.body.grants.find((x) => x.id === gB.grant_id).revoked, true);
  const a = await h.req("GET", `/api/projects/${P}/audit`);
  assert.ok(a.body.audits.some((x) => x.action === "grant.revoke" && x.object_id === gB.grant_id));
  // audits contain no document bodies
  assert.ok(!JSON.stringify(a.body).includes("A still writes"));
});
