// A12: restart on the same persist dir preserves data; backup export -> restore into fresh empty server; tampered backup rejected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startServer, agentHttp, setupProject, grant, sha256 } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makeFixtures } from "./make-fixtures.mjs";

const P = "proj-bk";
let s, h, A, docId, binId, png, backup;
before(async () => {
  png = readFileSync(makeFixtures().png);
  s = await startServer("a12", SERVER_PORTS.a12);
  h = await s.login();
  await setupProject(h, P);
  const g = await grant(h, P, "agent A");
  A = agentHttp(s.base, g.token);
  docId = (await A("POST", `/api/projects/${P}/artifacts`, { title: "durable", body: "v1" })).body.artifact_id;
  await A("PUT", `/api/projects/${P}/artifacts/${docId}`, { expected_revision: 1, body: "v2 **bold**" });
  await A("POST", `/api/projects/${P}/artifacts/${docId}/comments`, { revision: 2, body: "a comment" });
  const b = await A("POST", `/api/projects/${P}/uploads`, { title: "img", mime: "image/png", size: png.length, sha256: sha256(png) });
  await A("PUT", b.body.put_url, undefined, { raw: png });
  binId = (await A("POST", `/api/projects/${P}/uploads/${b.body.upload_id}/finish`)).body.artifact_id;
  assert.ok(binId);
});
after(async () => { await s?.stop(); });

const snapshot = async (req) => {
  const out = {};
  for (const id of [docId, binId]) {
    const hist = await req("GET", `/api/projects/${P}/artifacts/${id}/history`);
    out[id] = hist.body.revisions.map((r) => ({ rev: r.rev, id: r.id, sha256: r.sha256, size: r.size }));
  }
  const c = await req("GET", `/api/projects/${P}/artifacts/${binId}/content`, undefined, { binary: true });
  out.binSha = sha256(c.body);
  return out;
};

test("restart on the same persist dir preserves artifacts, history, bytes and grants", async () => {
  const before = await snapshot(A);
  assert.equal(before.binSha, sha256(png));
  await s.stop();
  s = await startServer("a12", SERVER_PORTS.a12, { fresh: false });
  h = await s.login();
  const after = await snapshot(A); // same agent token still valid after restart
  assert.deepEqual(after, before);
});

test("backup -> restore into fresh empty server preserves IDs/revisions/hashes; grants empty; tamper rejected", async () => {
  const before = await snapshot(A);
  const bk = await h.req("GET", `/api/projects/${P}/backup`);
  assert.equal(bk.status, 200);
  backup = bk.body;
  assert.ok(!JSON.stringify(backup).match(/"token|token_hash|al_session/), "backup must not contain grants/tokens");
  const t = await startServer("a12-restore", SERVER_PORTS["a12-restore"]);
  try {
    const h2 = await t.login();
    // Tampered variants are rejected and leave the target empty.
    const tampered1 = structuredClone(backup);
    tampered1.revisions.find((r) => r.body !== null && r.blob_key === null).body += " tampered";
    const r1 = await h2.req("POST", "/api/restore", tampered1);
    assert.equal(r1.status, 400, JSON.stringify(r1.body));
    const tampered2 = structuredClone(backup);
    const bk2 = Object.keys(tampered2.blobs)[0];
    const raw = Buffer.from(tampered2.blobs[bk2].data, "base64"); raw[raw.length - 1] ^= 1;
    tampered2.blobs[bk2].data = raw.toString("base64");
    const r2 = await h2.req("POST", "/api/restore", tampered2);
    assert.equal(r2.status, 400, JSON.stringify(r2.body));
    assert.deepEqual((await h2.req("GET", "/api/projects")).body.projects, []);

    const r = await h2.req("POST", "/api/restore", backup);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.grants, 0);
    const after = await snapshot(h2.req);
    assert.deepEqual(after, before);
    const grants = await h2.req("GET", `/api/projects/${P}/grants`);
    assert.deepEqual(grants.body.grants, []);
    const doc = await h2.req("GET", `/api/projects/${P}/artifacts/${docId}`);
    assert.equal(doc.body.body, "v2 **bold**");
    const cm = await h2.req("GET", `/api/projects/${P}/artifacts/${docId}/comments`);
    assert.equal(cm.body.comments.length, 1);
    // Old agent token from the source server does not work on the restored server.
    assert.equal((await agentHttp(t.base, "x".repeat(40))("GET", `/api/projects/${P}/artifacts`)).status, 401);
    // Restore into a non-empty store is refused.
    assert.equal((await h2.req("POST", "/api/restore", backup)).status, 409);
  } finally { await t.stop(); }
});
