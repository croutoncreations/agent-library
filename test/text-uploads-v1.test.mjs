// /v1 text uploads with real API keys through a running Worker (wrangler dev). Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { csvFixture } from "./formats-memory-fixtures.mjs";
import { jsonFixture } from "./formats-json-memory-fixtures.mjs";
import { ROOT, LOCAL_CONFIG, startServer, sha256, key, grant, agentHttp } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS["text-uploads-v1"];
const API = `http://127.0.0.1:${PORT}`;   // machine host (MCP_HOST): /v1
const APP = `http://localhost:${PORT}`;   // owner host (APP_HOST): /api
let PA, PB, PBOB;
const kinds = { markdown: "text/markdown", html: "text/html", json: "application/json", csv: "text/csv" };
const TEXT_ALLOWED = "Allowed: text/markdown, text/html, application/json, text/csv";
const source = { markdown: "# v1 upload\nraw 😀\n", html: "<h1>v1 upload 😀</h1>", json: '{"marker":"v1 upload 😀"}', csv: "marker,value\nv1-upload,😀\n" };
const wrap = { markdown: ["# v2\n", "\n"], html: ["<p>", "</p>"], json: ['{"m":"', '"}'], csv: ["h\n", "\n"] };
// A second version whose 4-byte character starts at byte 4094, so byte 4096 falls inside it.
const SPLIT = 4094;
const second = (kind) => { const [pre, post] = wrap[kind]; return pre + "a".repeat(SPLIT - pre.length) + "😀" + "b".repeat(1500) + post; };
let s, owner, bob;

async function call(method, path, { token, body, idem, headers = {}, raw, base = API } = {}) {
  const h = { ...headers };
  if (token !== undefined) h.authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) { h["content-type"] ??= "application/json"; payload = JSON.stringify(body); }
  if (idem) h["idempotency-key"] = idem;
  const r = await fetch(base + path, { method, headers: h, body: payload });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch {}
  return { status: r.status, headers: r.headers, json, buf };
}
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
const mkKey = async (who, projects) => {
  const r = await who.req("POST", "/api/api-keys", { label: "Synthetic v1 uploader", lifetime_days: 1, projects });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const rw = (pid = PA) => mkKey(owner, [{ project_id: pid, access: "read_write" }]);
const uploads = (pid) => `/v1/projects/${pid}/uploads`;
const declare = (kind, bytes, extra = {}) => ({ title: "Synthetic " + kind, mime: kinds[kind], size: bytes.length, sha256: sha256(bytes), ...extra });
async function begin(token, kind, text, extra = {}, { pid = PA, idem = key("b") } = {}) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const r = await call("POST", uploads(pid), { token, idem, body: declare(kind, bytes, extra) });
  return { ...r, bytes };
}
const put = (token, putUrl, bytes, headers = {}) => call("PUT", putUrl, { token, raw: bytes, headers: { "content-type": "application/octet-stream", ...headers } });
const finish = (token, uploadId, { pid = PA, idem = key("f") } = {}) => call("POST", `${uploads(pid)}/${uploadId}/finish`, { token, idem });
async function v1Upload(token, kind, text, extra = {}, opts = {}) {
  const b = await begin(token, kind, text, extra, opts);
  assert.equal(b.status, 201, JSON.stringify(b.json));
  const p = await put(token, b.json.put_url, b.bytes);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  return { b, p, f: await finish(token, b.json.upload_id, opts) };
}
const revisions = (artifactId) => sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${artifactId}'`)[0].n;

before(async () => {
  s = await startServer("text-uploads-v1", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, APP_CONNECT_ENABLED: "1",
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  bob = await s.loginAt(APP, "bob");
  const project = async (who, title) => { const r = await who.req("POST", "/api/projects", { title }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id; };
  PA = await project(owner, "Synthetic A"); PB = await project(owner, "Synthetic B"); PBOB = await project(bob, "Synthetic Bob");
});
after(async () => { await s?.stop(); });

for (const kind of Object.keys(kinds)) test(`/v1 ${kind}: create and save by upload, read back whole, by Range and in chunks`, async () => {
  const k = await rw();
  const { b, f } = await v1Upload(k.secret, kind, source[kind]);
  // put_url is same-origin, relative, under /v1, and worked as returned with the same bearer.
  assert.equal(b.json.put_url, `/v1/projects/${PA}/uploads/${b.json.upload_id}/content`);
  assert.equal(b.json.instructions, `PUT the raw bytes to put_url with the same API key, then POST to /v1/projects/${PA}/uploads/${b.json.upload_id}/finish with an Idempotency-Key header. Text must be UTF-8.`);
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.equal(f.json.revision, 1); assert.equal(f.json.size, Buffer.byteLength(source[kind]));
  const id = f.json.artifact_id, file = `/v1/projects/${PA}/files/${id}`;
  const text = second(kind), bytes = Buffer.from(text);
  const again = await v1Upload(k.secret, kind, text, { title: undefined, artifact_id: id, expected_revision: 1 });
  assert.equal(again.f.status, 200, JSON.stringify(again.f.json)); assert.equal(again.f.json.revision, 2);
  const meta = await call("GET", file, { token: k.secret });
  assert.equal(meta.status, 200); assert.equal(meta.json.file.kind, kind); assert.equal(meta.json.revision.rev, 2);
  assert.deepEqual((await call("GET", file + "/content?revision=1", { token: k.secret })).buf, Buffer.from(source[kind]));
  const whole = await call("GET", file + "/content", { token: k.secret });
  assert.equal(whole.status, 200); assert.deepEqual(whole.buf, bytes);
  // Byte 4096 is inside the 4-byte character: the two ranges split it, and together are the exact bytes.
  const head = await call("GET", file + "/content", { token: k.secret, headers: { range: "bytes=0-4095" } });
  const tail = await call("GET", file + "/content", { token: k.secret, headers: { range: "bytes=4096-" } });
  assert.equal(head.status, 206); assert.equal(tail.status, 206);
  assert.equal(head.buf.length, 4096); assert.equal(tail.buf[0] & 0xc0, 0x80, "the second range starts mid-character");
  assert.deepEqual(Buffer.concat([head.buf, tail.buf]), bytes);
  let joined = "", cursor = null, chunks = 0;
  do {
    const c = await call("GET", file + `/text?max_bytes=4096${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`, { token: k.secret });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    joined += c.json.text; cursor = c.json.next_cursor; chunks++;
  } while (cursor);
  assert.ok(chunks >= 2); assert.equal(joined, text);
  const rows = sql(`SELECT body, body_key, blob_key, mime, via_kind, via_id FROM revisions WHERE artifact_id = '${id}' ORDER BY rev_no`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.body, null); assert.match(r.body_key, /^text\//); assert.equal(r.blob_key, null); assert.equal(r.mime, kinds[kind]);
    assert.equal(r.via_kind, "api_key"); assert.equal(r.via_id, k.id);
  }
});

test("/v1 uploads: the PUT is no JSON request and is bounded by the declared size", async () => {
  const k = await rw();
  // Over /v1's 6,500,000-byte JSON cap, sent with a non-JSON content type: neither applies to the PUT.
  const text = "# big\n" + "x".repeat(7_000_000), b = await begin(k.secret, "markdown", text);
  assert.equal(b.status, 201, JSON.stringify(b.json));
  const short = await put(k.secret, b.json.put_url, Buffer.from("short"));
  assert.equal(short.status, 400); assert.equal(short.json.error.code, "incomplete_body");
  const p = await put(k.secret, b.json.put_url, b.bytes, { "content-type": "text/markdown" });
  assert.equal(p.status, 200, JSON.stringify(p.json)); assert.equal(p.json.received_bytes, b.bytes.length);
  const f = await finish(k.secret, b.json.upload_id); assert.equal(f.status, 200, JSON.stringify(f.json));
});

test("/v1 uploads: a cookie session is refused on begin, PUT and finish", async () => {
  const k = await rw();
  const b = await begin(k.secret, "markdown", "cookie"); assert.equal(b.status, 201);
  const routes = [["POST", uploads(PA)], ["PUT", b.json.put_url], ["POST", `${uploads(PA)}/${b.json.upload_id}/finish`]];
  for (const [m, path] of routes) for (const token of [undefined, k.secret]) {
    const r = await call(m, path, { token, idem: key(), headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, ...m === "PUT" ? {} : { "content-type": "application/json" } }, raw: m === "PUT" ? "cookie" : JSON.stringify(declare("markdown", Buffer.from("x"))) });
    assert.equal(r.status, 400, `${m} ${path}`); assert.equal(r.json.error.code, "invalid_request"); assert.equal(r.json.error.message, "Cookies are not accepted on the API");
  }
  assert.equal(sql(`SELECT state FROM uploads WHERE id = '${b.json.upload_id}'`)[0].state, "pending");
});

test("/v1 uploads: read-only, other-project, other-identity, expired and revoked keys are refused on all three", async () => {
  const k = await rw();
  const ro = await mkKey(owner, [{ project_id: PA, access: "read" }]);
  const elsewhere = await rw(PB);
  const sibling = await rw();
  const bobs = await mkKey(bob, [{ project_id: PBOB, access: "read_write" }]);
  const pending = await begin(k.secret, "markdown", "refusals"); assert.equal(pending.status, 201);
  const id = pending.json.upload_id;
  const expect = (r, status, code, what) => { assert.equal(r.status, status, `${what}: ${JSON.stringify(r.json)}`); assert.equal(r.json.error.code, code, what); };
  // Begin.
  expect(await begin(ro.secret, "markdown", "x"), 403, "forbidden", "read-only begin");
  expect(await begin(elsewhere.secret, "markdown", "x"), 404, "not_found", "other-project begin");
  expect(await begin(bobs.secret, "markdown", "x"), 404, "not_found", "other-identity begin");
  // PUT and finish of k's upload, before and after its bytes arrive.
  for (const [who, status, code] of [[ro, 403, "forbidden"], [elsewhere, 404, "not_found"], [sibling, 404, "not_found"], [bobs, 404, "not_found"]]) {
    expect(await put(who.secret, pending.json.put_url, pending.bytes), status, code, `PUT ${who.id}`);
    expect(await finish(who.secret, id), status, code, `finish ${who.id}`);
  }
  // Reaching another project's upload through a project the key can write still finds nothing.
  const both = await mkKey(owner, [{ project_id: PA, access: "read_write" }, { project_id: PB, access: "read_write" }]);
  const inA = await begin(both.secret, "markdown", "project scope"); assert.equal(inA.status, 201);
  const viaB = `/v1/projects/${PB}/uploads/${inA.json.upload_id}`;
  const wrongProject = await put(both.secret, viaB + "/content", inA.bytes); expect(wrongProject, 404, "not_found", "PUT via other project");
  assert.equal(wrongProject.json.error.message, "Upload not found");
  assert.equal((await put(both.secret, inA.json.put_url, inA.bytes)).status, 200);
  expect(await finish(both.secret, inA.json.upload_id, { pid: PB }), 404, "not_found", "finish via other project");
  assert.equal((await finish(both.secret, inA.json.upload_id)).status, 200);
  assert.equal((await put(k.secret, pending.json.put_url, pending.bytes)).status, 200);
  expect(await finish(ro.secret, id), 403, "forbidden", "read-only finish after PUT");
  assert.equal((await finish(k.secret, id)).status, 200);
  // Expired and revoked keys, including between begin and PUT and between PUT and finish.
  const stop = {
    expired: async (x) => sql(`UPDATE api_credentials SET expires_at = 1 WHERE id = '${x.id}'`),
    revoked: async (x) => assert.equal((await owner.req("POST", `/api/api-keys/${x.id}/revoke`, {})).status, 200),
  };
  for (const [how, end] of Object.entries(stop)) {
    const code = how === "expired" ? "credential_expired" : "credential_revoked";
    const beforePut = await rw(), afterPut = await rw();
    const b1 = await begin(beforePut.secret, "markdown", "stopped before PUT"); assert.equal(b1.status, 201);
    const b2 = await begin(afterPut.secret, "markdown", "stopped before finish"); assert.equal(b2.status, 201);
    assert.equal((await put(afterPut.secret, b2.json.put_url, b2.bytes)).status, 200);
    await end(beforePut); await end(afterPut);
    expect(await begin(beforePut.secret, "markdown", "x"), 401, code, `${how} begin`);
    expect(await put(beforePut.secret, b1.json.put_url, b1.bytes), 401, code, `${how} PUT`);
    expect(await finish(beforePut.secret, b1.json.upload_id), 401, code, `${how} finish before PUT`);
    expect(await finish(afterPut.secret, b2.json.upload_id), 401, code, `${how} finish after PUT`);
    assert.equal(revisions(b1.json.artifact_id) + revisions(b2.json.artifact_id), 0);
    assert.deepEqual(sql(`SELECT state FROM uploads WHERE id IN ('${b1.json.upload_id}', '${b2.json.upload_id}') ORDER BY state`).map((r) => r.state), ["pending", "received"]);
  }
});

test("/v1 uploads: an API-key upload is not reachable through the app API, nor the reverse", async () => {
  const k = await rw();
  const g = await grant(owner, PA, "Synthetic legacy agent"), legacy = agentHttp(APP, g.token);
  const b = await begin(k.secret, "markdown", "api key upload"); assert.equal(b.status, 201);
  const transfer = `/api/transfers/${b.json.upload_id}`, appFinish = `/api/projects/${PA}/uploads/${b.json.upload_id}/finish`;
  assert.equal((await owner.req("PUT", transfer, undefined, { raw: b.bytes })).status, 404);
  assert.equal((await legacy("PUT", transfer, undefined, { raw: b.bytes })).status, 404);
  assert.equal((await call("PUT", transfer, { token: k.secret, raw: b.bytes, base: APP })).status, 401);
  assert.equal((await put(k.secret, b.json.put_url, b.bytes)).status, 200);
  assert.equal((await owner.req("POST", appFinish)).status, 404);
  assert.equal((await legacy("POST", appFinish, undefined, { headers: { "idempotency-key": key() } })).status, 404);
  assert.equal((await call("POST", appFinish, { token: k.secret, idem: key(), base: APP })).status, 401);
  assert.equal((await finish(k.secret, b.json.upload_id)).status, 200);
  // The reverse: the owner's app API upload cannot be written or finished with an API key.
  const bytes = Buffer.from("owner upload");
  const o = await owner.req("POST", `/api/projects/${PA}/uploads`, declare("markdown", bytes));
  assert.equal(o.status, 201, JSON.stringify(o.body)); assert.equal(o.body.put_url, `/api/transfers/${o.body.upload_id}`);
  const v1Put = `${uploads(PA)}/${o.body.upload_id}/content`;
  const denied = await put(k.secret, v1Put, bytes); assert.equal(denied.status, 404); assert.equal(denied.json.error.message, "Upload not found");
  assert.equal((await owner.req("PUT", o.body.put_url, undefined, { raw: bytes })).status, 200);
  const deniedFinish = await finish(k.secret, o.body.upload_id); assert.equal(deniedFinish.status, 404); assert.equal(deniedFinish.json.error.message, "Upload not found");
  assert.equal((await owner.req("POST", `/api/projects/${PA}/uploads/${o.body.upload_id}/finish`)).status, 200);
});

test("/v1 uploads: Idempotency-Key is required on begin and finish; repeats replay; reuse is refused", async () => {
  const k = await rw();
  const bytes = Buffer.from("# idempotent\n"), body = declare("markdown", bytes);
  for (const idem of [undefined, "short", "bad key with spaces"]) {
    const r = await call("POST", uploads(PA), { token: k.secret, idem, body });
    assert.equal(r.status, 400, String(idem)); assert.equal(r.json.error.code, "idempotency_key_required");
  }
  const ik = key("begin");
  const b = await call("POST", uploads(PA), { token: k.secret, idem: ik, body }); assert.equal(b.status, 201);
  const again = await call("POST", uploads(PA), { token: k.secret, idem: ik, body });
  assert.equal(again.status, 201); assert.equal(again.json.upload_id, b.json.upload_id); assert.equal(again.json.idempotent_replay, true);
  const reuse = await call("POST", uploads(PA), { token: k.secret, idem: ik, body: { ...body, title: "Different" } });
  assert.equal(reuse.status, 422); assert.equal(reuse.json.error.code, "idempotency_key_reused");
  assert.equal((await put(k.secret, b.json.put_url, bytes)).status, 200);
  const finishPath = `${uploads(PA)}/${b.json.upload_id}/finish`;
  for (const idem of [undefined, "short"]) {
    const r = await call("POST", finishPath, { token: k.secret, idem });
    assert.equal(r.status, 400); assert.equal(r.json.error.code, "idempotency_key_required");
  }
  const fk = key("finish");
  const f = await finish(k.secret, b.json.upload_id, { idem: fk }); assert.equal(f.status, 200, JSON.stringify(f.json));
  const f2 = await finish(k.secret, b.json.upload_id, { idem: fk });
  assert.equal(f2.status, 200); assert.equal(f2.json.revision_id, f.json.revision_id); assert.equal(f2.json.idempotent_replay, true);
  assert.equal(revisions(f.json.artifact_id), 1);
});

test("/v1 uploads: begin, PUT and finish each cost one write-rate unit", async () => {
  const k = await rw();
  const principal = sql(`SELECT principal_id FROM api_credentials WHERE id = '${k.id}'`)[0].principal_id;
  const writes = () => sql(`SELECT COALESCE(SUM(n), 0) AS n FROM rate_counters WHERE k = 'w:${principal}'`)[0].n;
  const w0 = writes();
  const b = await begin(k.secret, "markdown", "rate"); assert.equal(b.status, 201);
  const w1 = writes(); assert.equal(w1 - w0, 1, "begin");
  assert.equal((await put(k.secret, b.json.put_url, b.bytes)).status, 200);
  const w2 = writes(); assert.equal(w2 - w1, 1, "PUT is charged once, not twice");
  assert.equal((await finish(k.secret, b.json.upload_id)).status, 200);
  assert.equal(writes() - w2, 1, "finish");
});

test("/v1 uploads: binary types and request fields cannot open binary uploads", async () => {
  const k = await rw();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  for (const extra of [{}, { allowText: true, allowBinary: true }]) {
    const r = await call("POST", uploads(PA), { token: k.secret, idem: key(), body: { title: "Synthetic image", mime: "image/png", size: png.length, sha256: sha256(png), ...extra } });
    assert.equal(r.status, 415); assert.equal(r.json.error.code, "unsupported_type"); assert.equal(r.json.error.message, TEXT_ALLOWED);
  }
  assert.equal(sql("SELECT COUNT(*) AS n FROM uploads WHERE mime = 'image/png'")[0].n, 0);
});

test("/v1 uploads: size, checksum, length, UTF-8 and document errors match the app API", async () => {
  const k = await rw();
  for (const [kind, message] of [["markdown", "Markdown exceeds 10 MiB"], ["html", "HTML exceeds 10 MiB"], ["json", "json file exceeds 10 MiB"], ["csv", "csv file exceeds 10 MiB"]]) {
    const r = await call("POST", uploads(PA), { token: k.secret, idem: key(), body: { title: "Too large", mime: kinds[kind], size: 10485761, sha256: sha256("x") } });
    assert.equal(r.status, 413); assert.equal(r.json.error.code, "too_large"); assert.equal(r.json.error.message, message);
  }
  const b = await begin(k.secret, "markdown", "declared"); assert.equal(b.status, 201);
  const short = await put(k.secret, b.json.put_url, Buffer.from("short")); assert.equal(short.status, 400); assert.equal(short.json.error.code, "incomplete_body");
  const long = await put(k.secret, b.json.put_url, Buffer.from("far too long")); assert.equal(long.status, 413); assert.equal(long.json.error.code, "too_large");
  const bad = await put(k.secret, b.json.put_url, Buffer.from("modified")); assert.equal(bad.status, 422); assert.equal(bad.json.error.code, "integrity_mismatch");
  const ended = await finish(k.secret, b.json.upload_id); assert.equal(ended.status, 422); assert.deepEqual(ended.json.error.code, bad.json.error.code);
  // Same bytes through the app API (the owner) and through /v1: identical finish answers.
  const app = async (kind, bytes) => {
    const o = await owner.req("POST", `/api/projects/${PA}/uploads`, declare(kind, bytes)); assert.equal(o.status, 201);
    assert.equal((await owner.req("PUT", o.body.put_url, undefined, { raw: bytes })).status, 200);
    return owner.req("POST", `/api/projects/${PA}/uploads/${o.body.upload_id}/finish`);
  };
  for (const [kind, bytes] of [["markdown", Buffer.from([0xe2, 0x82])], ["csv", Buffer.from([0xc0, 0xaf])], ["json", Buffer.from("{")], ["json", Buffer.from("\ufeff{}")], ["csv", Buffer.from('a,b\n"unclosed')]]) {
    const expected = await app(kind, bytes);
    assert.ok(expected.status >= 400, JSON.stringify(expected.body));
    const { b: v, f } = await v1Upload(k.secret, kind, bytes);
    // /v1 adds its request_id to every error; everything else is the app API's answer.
    const { request_id, ...error } = f.json.error; assert.match(request_id, /^req_/);
    assert.equal(f.status, expected.status); assert.deepEqual(error, expected.body.error, `${kind} ${bytes.toString("hex")}`);
    const { request_id: _r, ...replayed } = (await finish(k.secret, v.json.upload_id)).json.error; assert.deepEqual(replayed, error);
    assert.equal(revisions(v.json.artifact_id), 0);
  }
});

test("/v1 uploads: exactly 10 MiB one-character-row CSV uploads and exports for spreadsheets", async () => {
  const k = await rw();
  const { text, rows, outputLength } = csvFixture("tiny"); assert.equal(Buffer.byteLength(text), 10485760);
  const { f } = await v1Upload(k.secret, "csv", text); assert.equal(f.status, 200, JSON.stringify(f.json)); assert.equal(f.json.size, 10485760);
  const file = `/v1/projects/${PA}/files/${f.json.artifact_id}`;
  const raw = await fetch(API + file + "/content", { headers: { authorization: `Bearer ${k.secret}` } });
  assert.equal(raw.status, 200);
  const rawDigest = createHash("sha256"); let rawSize = 0;
  for await (const bytes of raw.body) { rawSize += bytes.length; rawDigest.update(bytes); }
  assert.equal(rawSize, 10485760); assert.equal(rawDigest.digest("hex"), sha256(text));
  const response = await fetch(API + file + "/content?format=spreadsheet", { headers: { authorization: `Bearer ${k.secret}` } });
  assert.equal(response.status, 200);
  const digest = createHash("sha256"); let size = 0;
  for await (const bytes of response.body) { size += bytes.length; digest.update(bytes); }
  const expected = createHash("sha256").update("h\r\n");
  // Hash bounded batches rather than retain another full spreadsheet copy.
  for (let left = rows; left > 0;) { const n = Math.min(left, 10000); expected.update("a\r\n".repeat(n)); left -= n; }
  assert.equal(size, outputLength); assert.equal(digest.digest("hex"), expected.digest("hex"));
});

test("/v1 uploads: 100,000 measurement records upload with their schema and are queried through /v1 records", async () => {
  const k = await rw();
  const { text, count } = jsonFixture("ordinary"); assert.equal(count, 100000); assert.equal(Buffer.byteLength(text), 10052060);
  // As a JSON request this document exceeds the unchanged 11 MiB create cap; the upload carries it raw.
  assert.ok(Buffer.byteLength(JSON.stringify({ title: "Measurements", kind: "json", schema: "agentlib.measurements/1", content: text })) > 11 * 1048576);
  const { f } = await v1Upload(k.secret, "json", text, { schema: "agentlib.measurements/1" }); assert.equal(f.status, 200, JSON.stringify(f.json));
  const records = `/v1/projects/${PA}/files/${f.json.artifact_id}/records`;
  const first = await call("GET", records + "?limit=2", { token: k.secret });
  const last = await call("GET", records + "?cursor=99998&limit=2", { token: k.secret });
  const filter = await call("GET", records + "?metric=m&from=2000-01-01&to=2000-01-01&limit=1", { token: k.secret });
  for (const r of [first, last, filter]) assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(first.json.records[0].id, "0"); assert.equal(Object.keys(first.json.records[0]).length, 7);
  assert.equal(last.json.records[1].id, (99999).toString(36)); assert.equal(last.json.next_cursor, null);
  assert.equal(filter.json.records[0].recorded_at, "x"); assert.equal(filter.json.records[0].metric, "m");
  const meta = await call("GET", `/v1/projects/${PA}/files/${f.json.artifact_id}`, { token: k.secret });
  assert.equal(meta.json.file.schema, "agentlib.measurements/1");
});
