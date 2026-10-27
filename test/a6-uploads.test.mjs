// A6/A7/A8: real fixture bytes via MCP upload_begin -> HTTP PUT -> MCP upload_finish; integrity, sealing, Range.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startServer, agentHttp, mcpClient, setupProject, grant, sha256, key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";
import { makeFixtures } from "./make-fixtures.mjs";

const P = "proj-up";
let s, h, A, mA, fx;
const published = {};
before(async () => {
  fx = makeFixtures();
  s = await startServer("a6", SERVER_PORTS.a6);
  h = await s.login();
  await setupProject(h, P);
  const g = await grant(h, P, "uploader");
  A = agentHttp(s.base, g.token);
  mA = await mcpClient(s.base, g.token, "uploader");
});
after(async () => { await mA?.close(); await s?.stop(); });

async function begin(title, mime, bytes, declaredSha = sha256(bytes), size = bytes.length) {
  return mA.call("upload_begin", { project_id: P, title, mime, size, sha256: declaredSha, idempotency_key: key("ub") });
}
const put = (url, bytes) => A("PUT", url, undefined, { raw: bytes, headers: { "content-type": "application/octet-stream" } });

for (const [name, mime] of [["png", "image/png"], ["pdf", "application/pdf"], ["mp4", "video/mp4"]]) {
  test(`A6 ${name}: MCP begin -> HTTP PUT -> MCP finish -> content sha256 equals source`, async () => {
    const bytes = readFileSync(fx[name]);
    const b = await begin(`fixture ${name}`, mime, bytes);
    assert.equal(b.isError, false, JSON.stringify(b.data));
    assert.match(b.data.put_url, /^\/api\/transfers\//);
    const p = await put(b.data.put_url, bytes);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.matches_declared, true);
    const fk = key("uf");
    const f = await mA.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: fk });
    assert.equal(f.isError, false, JSON.stringify(f.data));
    assert.equal(f.data.revision, 1);
    assert.equal(f.data.sha256, sha256(bytes));
    const c = await A("GET", `/api/projects/${P}/artifacts/${f.data.artifact_id}/content`, undefined, { binary: true });
    assert.equal(c.status, 200);
    assert.equal(c.headers.get("content-type"), mime);
    assert.equal(sha256(c.body), sha256(bytes));
    published[name] = { ...f.data, upload_id: b.data.upload_id, put_url: b.data.put_url, bytes, finishKey: fk };
  });
}

test("A7 finish twice is idempotent (same key and a new key)", async () => {
  const pub = published.png;
  const again = await mA.call("upload_finish", { project_id: P, upload_id: pub.upload_id, idempotency_key: pub.finishKey });
  assert.equal(again.isError, false);
  assert.equal(again.data.revision_id, pub.revision_id);
  const other = await mA.call("upload_finish", { project_id: P, upload_id: pub.upload_id, idempotency_key: key("uf2") });
  assert.equal(other.isError, false);
  assert.equal(other.data.revision_id, pub.revision_id);
  const hist = await A("GET", `/api/projects/${P}/artifacts/${pub.artifact_id}/history`);
  assert.equal(hist.body.revisions.length, 1);
});

test("A7 PUT after finish -> 409 and published bytes unchanged", async () => {
  const pub = published.png;
  const evil = Buffer.from(pub.bytes); evil[evil.length - 20] ^= 0xff;
  const r = await put(pub.put_url, evil);
  assert.equal(r.status, 409);
  const c = await A("GET", `/api/projects/${P}/artifacts/${pub.artifact_id}/content`, undefined, { binary: true });
  assert.equal(sha256(c.body), sha256(pub.bytes));
});

test("A7 wrong declared hash -> finish 422 and no visible version", async () => {
  const bytes = readFileSync(fx.png);
  const b = await begin("bad hash", "image/png", bytes, "a".repeat(64));
  assert.equal(b.isError, false);
  const p = await put(b.data.put_url, bytes);
  assert.equal(p.status, 200);
  assert.equal(p.body.matches_declared, false);
  const f = await mA.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: key("uf") });
  assert.equal(f.isError, true);
  assert.equal(f.data.error.status, 422);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${b.data.artifact_id}`)).status, 404);
  assert.equal((await A("GET", `/api/projects/${P}/artifacts/${b.data.artifact_id}/content`)).status, 404);
  const list = await A("GET", `/api/projects/${P}/artifacts?q=bad%20hash`);
  assert.equal(list.body.artifacts.length, 0);
  // repeat finish returns the same recorded failure
  const f2 = await mA.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: key("uf") });
  assert.equal(f2.data.error.status, 422);
});

test("A7 oversize declaration -> 413; body larger than declared -> 413 then correct retry succeeds", async () => {
  const big = await mA.call("upload_begin", { project_id: P, title: "big", mime: "image/png", size: 5 * 1024 * 1024 + 1, sha256: "b".repeat(64), idempotency_key: key("ub") });
  assert.equal(big.isError, true);
  assert.equal(big.data.error.status, 413);
  const bytes = readFileSync(fx.png);
  const b = await begin("overflow", "image/png", bytes);
  const over = await put(b.data.put_url, Buffer.concat([bytes, Buffer.alloc(1024)]));
  assert.equal(over.status, 413);
  const ok = await put(b.data.put_url, bytes);
  assert.equal(ok.status, 200);
  const f = await mA.call("upload_finish", { project_id: P, upload_id: b.data.upload_id, idempotency_key: key("uf") });
  assert.equal(f.isError, false);
});

test("A8 HEAD, Range 206 + Content-Range, suffix range, 416", async () => {
  const pub = published.mp4;
  const url = `/api/projects/${P}/artifacts/${pub.artifact_id}/content`;
  const total = pub.bytes.length;
  const hd = await A("HEAD", url);
  assert.equal(hd.status, 200);
  assert.equal(hd.headers.get("content-length"), String(total));
  assert.equal(hd.headers.get("accept-ranges"), "bytes");
  const r = await A("GET", url, undefined, { binary: true, headers: { range: "bytes=0-99" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 0-99/${total}`);
  assert.deepEqual(r.body, pub.bytes.subarray(0, 100));
  const mid = await A("GET", url, undefined, { binary: true, headers: { range: "bytes=100-" } });
  assert.equal(mid.status, 206);
  assert.deepEqual(mid.body, pub.bytes.subarray(100));
  const suf = await A("GET", url, undefined, { binary: true, headers: { range: "bytes=-50" } });
  assert.equal(suf.status, 206);
  assert.equal(suf.headers.get("content-range"), `bytes ${total - 50}-${total - 1}/${total}`);
  assert.deepEqual(suf.body, pub.bytes.subarray(total - 50));
  const bad = await A("GET", url, undefined, { binary: true, headers: { range: `bytes=${total + 10}-` } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("content-range"), `bytes */${total}`);
  const hr = await A("HEAD", url, undefined, { headers: { range: "bytes=0-9" } });
  assert.equal(hr.status, 206);
  assert.equal(hr.headers.get("content-length"), "10");
});
