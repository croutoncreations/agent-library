// App Connect binary files (docs/app-connect.md#binary-files): publishers upload images, PDFs, video and other files
// into their own destination (begin -> authenticated PUT -> finish), add versions with expected_revision, and read the
// bytes back (Range). Own files only; everyone else keeps protected_source. Isolated synthetic harness, loopback only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { makeFixtures, makePng } from "./make-fixtures.mjs";
import { key } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS["ac-files"], ORIGIN = "http://localhost:5181";
const sha = (b) => createHash("sha256").update(b).digest("hex");
let h, owner, app, P, Q, fx;

before(async () => {
  fx = makeFixtures();
  h = await startAppConnectServer({ port: PORT });
  owner = await h.owner();
  for (const [id, title] of [["files-test", "Files"], ["files-other", "Other"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
  app = await h.registerApp({ display_name: "Screenshot Saver (local)", redirect_uris: ["http://localhost:5181/cb"], origins: [ORIGIN] });
  const app2 = await h.registerApp({ display_name: "Other App (local)", redirect_uris: ["http://localhost:5182/cb"], origins: [] });
  P = await h.connectPublisher(app, { project_id: "files-test", destination: "new", new_folder_name: "Screenshots" });
  Q = await h.connectPublisher(app2, { project_id: "files-test", destination: "root" });
});
after(async () => { await h?.stop(); });

const begin = (tok, body, idem = key("ub")) => h.pub(tok, "POST", "/publisher/uploads", { body, idem });
const put = (tok, url, bytes, headers = {}) => fetch(url, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream", ...headers }, body: bytes })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const finish = (tok, id, idem = key("uf")) => h.pub(tok, "POST", `/publisher/uploads/${id}/finish`, { body: {}, idem });
async function upload(tok, name, mime, bytes, extra = {}) {
  const b = await begin(tok, { name, mime, size: bytes.length, sha256: sha(bytes), ...extra });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  const p = await put(tok, b.json.put_url, bytes);
  assert.equal(p.status, 200, JSON.stringify(p.json)); assert.equal(p.json.matches_declared, true);
  const f = await finish(tok, b.json.upload_id);
  assert.equal(f.status, 200, JSON.stringify(f.json));
  return { begin: b.json, file: f.json.file };
}

test("me advertises the binary files contract", async () => {
  const me = await h.pub(P.access_token, "GET", "/publisher/me");
  assert.equal(me.status, 200);
  const c = me.json.files_contract;
  assert.equal(c.version, "agentlib.publisher-files/1");
  for (const m of ["image/png", "image/jpeg", "application/pdf", "video/mp4", "application/octet-stream"]) assert.ok(c.mime_types.includes(m), m);
  assert.equal(c.max_bytes, 5 * 1024 * 1024);
});

for (const [kind, mime, name] of [["png", "image/png", "screen.png"], ["pdf", "application/pdf", "report.pdf"], ["mp4", "video/mp4", "clip.mp4"]]) {
  test(`${kind}: begin -> PUT -> finish creates the publisher's own file in its destination; bytes round-trip`, async () => {
    const bytes = readFileSync(fx[kind]);
    const { begin: b, file } = await upload(P.access_token, name, mime, bytes, { change_note: `synthetic ${kind}` });
    assert.equal(b.base_revision, 0); assert.equal(b.name, name);
    assert.deepEqual({ name: file.name, kind: file.kind, mime: file.mime, revision: file.revision, sha256: file.sha256, size: file.size },
      { name, kind: "binary", mime, revision: 1, sha256: sha(bytes), size: bytes.length });
    // listed with the publisher's files, with its MIME type
    const listed = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((f) => f.file_id === file.file_id);
    assert.equal(listed.name, name); assert.equal(listed.kind, "binary"); assert.equal(listed.mime, mime); assert.equal(listed.in_current_snapshot, false);
    // publisher reads its bytes back: always a download
    const c = await fetch(`${h.api}/publisher/files/${file.file_id}/content`, { headers: { authorization: `Bearer ${P.access_token}` } });
    assert.equal(c.status, 200); assert.equal(c.headers.get("content-type"), mime);
    assert.match(c.headers.get("content-disposition"), /^attachment; filename="/); assert.equal(c.headers.get("x-content-type-options"), "nosniff");
    assert.match(c.headers.get("content-security-policy"), /sandbox/);
    assert.equal(sha(Buffer.from(await c.arrayBuffer())), sha(bytes));
    // the owner sees it in the app's folder, attributed to the app
    const a = (await owner.req("GET", `/api/projects/files-test/artifacts/${file.file_id}`)).body;
    assert.equal(a.artifact.kind, "binary"); assert.equal(a.artifact.title, name);
    const me = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
    assert.equal(a.artifact.folder_id, me.destination.folder_id);
    const oc = await owner.req("GET", `/api/projects/files-test/artifacts/${file.file_id}/content`, undefined, { binary: true });
    assert.equal(oc.status, 200); assert.equal(sha(oc.body), sha(bytes));
  });
}

test("Range reads of a binary file", async () => {
  const bytes = readFileSync(fx.pdf);
  const id = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((f) => f.name === "report.pdf").file_id;
  const r = await fetch(`${h.api}/publisher/files/${id}/content`, { headers: { authorization: `Bearer ${P.access_token}`, range: "bytes=0-4" } });
  assert.equal(r.status, 206); assert.equal(r.headers.get("content-range"), `bytes 0-4/${bytes.length}`);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString("latin1"), "%PDF-");
  const bad = await fetch(`${h.api}/publisher/files/${id}/content`, { headers: { authorization: `Bearer ${P.access_token}`, range: `bytes=${bytes.length}-` } });
  assert.equal(bad.status, 416);
});

test("new versions need the current expected_revision; old versions stay readable", async () => {
  const v1 = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((f) => f.name === "screen.png");
  const png2 = makePng(48, 24);
  const exists = await begin(P.access_token, { name: "screen.png", mime: "image/png", size: png2.length, sha256: sha(png2) });
  assert.equal(exists.status, 409); assert.equal(exists.json.error.code, "file_exists"); assert.equal(exists.json.error.current_revision, 1);
  const stale = await begin(P.access_token, { name: "screen.png", mime: "image/png", size: png2.length, sha256: sha(png2), expected_revision: 7 });
  assert.equal(stale.status, 409); assert.equal(stale.json.error.code, "revision_conflict");
  const { file } = await upload(P.access_token, "screen.png", "image/png", png2, { expected_revision: 1, change_note: "retake" });
  assert.equal(file.file_id, v1.file_id); assert.equal(file.revision, 2); assert.equal(file.sha256, sha(png2));
  const old = await fetch(`${h.api}/publisher/files/${v1.file_id}/content?revision=1`, { headers: { authorization: `Bearer ${P.access_token}` } });
  assert.equal(sha(Buffer.from(await old.arrayBuffer())), v1.sha256);
  const hist = (await owner.req("GET", `/api/projects/files-test/artifacts/${v1.file_id}/history`)).body;
  assert.ok(JSON.stringify(hist).includes("retake"), "change note recorded in History");
});

test("begin and finish are idempotent; a key reused with a different request is refused", async () => {
  const bytes = makePng(8, 8), k = key("ub");
  const body = { name: "idem.png", mime: "image/png", size: bytes.length, sha256: sha(bytes) };
  const b1 = await begin(P.access_token, body, k), b2 = await begin(P.access_token, body, k);
  assert.equal(b1.status, 201); assert.equal(b2.json.upload_id, b1.json.upload_id); assert.equal(b2.json.idempotent_replay, true);
  const reuse = await begin(P.access_token, { ...body, size: bytes.length + 1 }, k);
  assert.equal(reuse.status, 422); assert.equal(reuse.json.error.code, "idempotency_key_reused");
  assert.equal((await put(P.access_token, b1.json.put_url, bytes)).status, 200);
  const fk = key("uf");
  const f1 = await finish(P.access_token, b1.json.upload_id, fk), f2 = await finish(P.access_token, b1.json.upload_id, fk), f3 = await finish(P.access_token, b1.json.upload_id);
  assert.equal(f1.status, 200); assert.equal(f2.json.file.revision, 1); assert.equal(f2.json.idempotent_replay, true); assert.equal(f3.json.file.file_id, f1.json.file.file_id);
  const n = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.filter((f) => f.name === "idem.png").length;
  assert.equal(n, 1, "published exactly once");
});

test("integrity: wrong bytes, wrong type and oversize are refused; nothing is published", async () => {
  const png = makePng(4, 4);
  // declared hash does not match the bytes
  let b = await begin(P.access_token, { name: "bad-hash.png", mime: "image/png", size: png.length, sha256: sha("other") });
  assert.equal((await put(P.access_token, b.json.put_url, png)).json.matches_declared, false);
  let f = await finish(P.access_token, b.json.upload_id);
  assert.equal(f.status, 422); assert.equal(f.json.error.code, "integrity_mismatch");
  // bytes are not the declared type
  const fake = Buffer.from("not really a png at all");
  b = await begin(P.access_token, { name: "fake.png", mime: "image/png", size: fake.length, sha256: sha(fake) });
  await put(P.access_token, b.json.put_url, fake);
  f = await finish(P.access_token, b.json.upload_id);
  assert.equal(f.status, 415); assert.equal(f.json.error.code, "signature_mismatch");
  // more bytes than declared: refused before the body is read (the client sees 413 or a reset), then the upload still
  // accepts the right bytes
  b = await begin(P.access_token, { name: "short.png", mime: "image/png", size: png.length, sha256: sha(png) });
  const over = await put(P.access_token, b.json.put_url, Buffer.concat([png, Buffer.alloc(1024)])).catch((e) => ({ status: e.cause?.code ?? "reset" }));
  assert.ok(over.status === 413 || /ECONNRESET|EPIPE|reset/.test(String(over.status)), String(over.status));
  assert.equal((await put(P.access_token, b.json.put_url, png)).status, 200);
  const shortOk = await finish(P.access_token, b.json.upload_id);
  assert.equal(shortOk.status, 200, JSON.stringify(shortOk.json));
  // limits and types at begin
  const big = await begin(P.access_token, { name: "big.bin", mime: "application/octet-stream", size: 5 * 1024 * 1024 + 1, sha256: sha("x") });
  assert.equal(big.status, 413);
  const html = await begin(P.access_token, { name: "page.html", mime: "text/html", size: 10, sha256: sha("x") });
  assert.equal(html.status, 415); assert.equal(html.json.error.code, "unsupported_type");
  for (const name of ["manifest.json", "../x", "a//b", "a/./b", "1/2/3/4/5/6", ""]) assert.equal((await begin(P.access_token, { name, mime: "image/png", size: 1, sha256: sha("x") })).status, 400, name);
  const names = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.map((x) => x.name);
  for (const n of ["bad-hash.png", "fake.png"]) assert.ok(!names.includes(n), `${n} never published`);
  assert.equal((await h.pub(P.access_token, "POST", `/publisher/uploads/${b.json.upload_id}/finish`, { body: { extra: 1 }, idem: key("x") })).status, 400, "finish body must be empty");
  // a failed new upload frees its name for a fresh try, and failed placeholders never count as files
  const ok = await upload(P.access_token, "fake.png", "image/png", png);
  assert.equal(ok.file.revision, 1);
  const me = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.map((x) => x.name);
  assert.ok(!me.includes("bad-hash.png"));
});

test("own files only: no writing another publisher's or the owner's files, no reading them, no JSON overwrite", async () => {
  const bytes = makePng(6, 6);
  const mine = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((f) => f.name === "screen.png");
  // another publisher cannot read or address it; the same name in its own space is its own file
  assert.equal((await h.pub(Q.access_token, "GET", `/publisher/files/${mine.file_id}/content`)).status, 404);
  const q = await upload(Q.access_token, "screen.png", "image/png", bytes);
  assert.notEqual(q.file.file_id, mine.file_id);
  assert.equal((await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((f) => f.name === "screen.png").revision, 2, "P's file untouched");
  // another publisher's upload id is not reachable
  const b = await begin(P.access_token, { name: "p-only.png", mime: "image/png", size: bytes.length, sha256: sha(bytes) });
  assert.equal((await put(Q.access_token, b.json.put_url, bytes)).status, 404);
  assert.equal((await finish(Q.access_token, b.json.upload_id)).status, 404);
  assert.equal((await put(P.access_token, b.json.put_url, bytes)).status, 200);
  assert.equal((await finish(P.access_token, b.json.upload_id)).status, 200);
  // a JSON snapshot file of the same publisher cannot be replaced by a binary
  const snap = await h.pub(P.access_token, "POST", "/publisher/snapshots", { idem: key("s"), body: { source_revision: 1, files: [{ name: "data.json", kind: "json", content: "{\"a\":1}" }] } });
  assert.equal(snap.status, 201, JSON.stringify(snap.json));
  const asBin = await begin(P.access_token, { name: "data.json", mime: "application/octet-stream", size: 3, sha256: sha("abc"), expected_revision: 1 });
  assert.equal(asBin.status, 422); assert.equal(asBin.json.error.code, "unsupported_kind");
  // the owner and agents cannot overwrite the app's binary (protected source)
  const ub = await owner.req("POST", "/api/projects/files-test/uploads", { artifact_id: mine.file_id, expected_revision: 2, mime: "image/png", size: bytes.length, sha256: sha(bytes) });
  assert.equal(ub.status, 403); assert.equal(ub.body.error.code, "protected_source");
  // ordinary files of the project are invisible to the publisher
  const plain = await owner.req("POST", "/api/projects/files-test/artifacts", { title: "Owner note", body: "# hi" });
  assert.equal(plain.status, 201);
  assert.equal((await h.pub(P.access_token, "GET", `/publisher/files/${plain.body.artifact_id}/content`)).status, 404);
});

test("an idempotency key replayed with another file's name is refused", async () => {
  const k = key("ub");
  const cur = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((f) => f.name === "report.pdf");
  const pdf = readFileSync(fx.pdf);
  const b = await begin(P.access_token, { name: "report.pdf", mime: "application/pdf", size: pdf.length, sha256: sha(pdf), expected_revision: cur.revision }, k);
  assert.equal(b.status, 201);
  const other = await begin(P.access_token, { name: "renamed.pdf", mime: "application/pdf", size: pdf.length, sha256: sha(pdf), expected_revision: cur.revision }, k);
  assert.equal(other.status, 422); assert.equal(other.json.error.code, "idempotency_key_reused");
  assert.equal((await put(P.access_token, b.json.put_url, pdf)).status, 200);
  assert.equal((await finish(P.access_token, b.json.upload_id)).status, 200);
});

test("trashed by the owner: new versions refused until restored", async () => {
  const f = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((x) => x.name === "clip.mp4");
  const a = (await owner.req("GET", `/api/projects/files-test/artifacts/${f.file_id}`)).body.artifact;
  assert.equal((await owner.req("PATCH", `/api/projects/files-test/artifacts/${f.file_id}`, { expected_meta_version: a.meta_version, trashed: true })).status, 200);
  const r = await begin(P.access_token, { name: "clip.mp4", mime: "video/mp4", size: 20, sha256: sha("x"), expected_revision: 1 });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, "destination_file_trashed");
});

test("one active upload per publisher; revocation stops PUT and finish", async () => {
  const X = await h.connectPublisher(app, { project_id: "files-other", destination: "root" });
  const bytes = makePng(5, 5);
  const b = await begin(X.access_token, { name: "a.png", mime: "image/png", size: bytes.length, sha256: sha(bytes) });
  assert.equal(b.status, 201);
  const second = await begin(X.access_token, { name: "b.png", mime: "image/png", size: bytes.length, sha256: sha(bytes) });
  assert.equal(second.status, 429); assert.equal(second.json.error.code, "upload_in_progress");
  assert.equal((await owner.req("POST", `/api/publishers/${X.publisher_id}/revoke`, {})).status, 200);
  const p = await put(X.access_token, b.json.put_url, bytes);
  assert.equal(p.status, 401);
  const f = await finish(X.access_token, b.json.upload_id);
  assert.equal(f.status, 401); assert.equal(f.json.error.code, "publisher_revoked");
});

test("CORS: registered origins may PUT bytes and read download headers", async () => {
  const pre = await fetch(`${h.api}/publisher/uploads/upl_x`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type" } });
  assert.equal(pre.status, 204); assert.match(pre.headers.get("access-control-allow-methods"), /PUT/);
  assert.match(pre.headers.get("access-control-allow-headers"), /Range/);
  const id = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.find((f) => f.name === "report.pdf").file_id;
  const r = await fetch(`${h.api}/publisher/files/${id}/content`, { headers: { origin: ORIGIN, authorization: `Bearer ${P.access_token}` } });
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(r.headers.get("access-control-expose-headers"), /Content-Disposition/);
  const evil = await fetch(`${h.api}/publisher/uploads/upl_x`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "PUT" } });
  assert.equal(evil.status, 403);
});
