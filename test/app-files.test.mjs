// App Files API (/v1/app, /v1/app/files): an app's own text files, addressed by path, in its approved destination.
// Real local wrangler dev, the real App Connect flows (owner consent, code exchange) and real HTTP; synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { buildWorker } from "../scripts/build.mjs";
import { join } from "node:path";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS["app-files"];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const etagOf = (s) => `"${sha(s)}"`;
const APP_DISABLED = "This app has been disabled by the owner of this library";
let h, owner, n = 0;
const uniq = (p) => `${p}-${++n}-key`;
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body ?? r.json)); return r.body ?? r.json; };
const TYPE = { md: "text/markdown", html: "text/html", json: "application/json", csv: "text/csv" };

/** A fresh app + publisher into project `pid` (the owner consents). */
async function connect(pid, { destination = "root", origins = [] } = {}) {
  const label = uniq("app").replace("-key", "");
  const app = await h.registerApp({ display_name: `Files ${label}`, redirect_uris: [`https://${label}.example.test/cb`], origins });
  const P = await h.connectPublisher(app, { project_id: pid, destination, ...destination === "new" ? { new_folder_name: label } : {} });
  return { app, P, tok: P.access_token };
}
/** PUT a file: { create } sends If-None-Match: *, { match } sends If-Match; headers override (null removes). */
async function put(tok, path, body, { create, match, key = uniq("put"), type = TYPE[path.split(".").pop()], headers = {} } = {}) {
  const hd = { "content-type": type, "idempotency-key": key, ...create ? { "if-none-match": "*" } : {}, ...match ? { "if-match": match } : {}, ...headers };
  for (const [k, v] of Object.entries(hd)) if (v === null) delete hd[k];
  if (tok) hd.authorization = `Bearer ${tok}`;
  return reply(await fetch(`${h.api}/app/files/${path}`, { method: "PUT", headers: hd, body }));
}
const del = async (tok, path, { match, key = uniq("del"), headers = {} } = {}) =>
  reply(await fetch(`${h.api}/app/files/${path}`, { method: "DELETE", headers: { authorization: `Bearer ${tok}`, ...match ? { "if-match": match } : {}, ...key ? { "idempotency-key": key } : {}, ...headers } }));
const get = (tok, path, headers = {}, method = "GET") => h.pub(tok, method, `/app/files/${path}`, { headers });
const list = (tok, query = "") => h.pub(tok, "GET", `/app/files${query}`);
async function reply(r) {
  const bytes = Buffer.from(await r.arrayBuffer()), text = bytes.toString(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
const err = (r, status, code) => { assert.equal(r.status, status, r.text); assert.equal(r.json.error.code, code, r.text); };
const rowsOf = (pubId) => sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${pubId}'`)[0].n;
const revsOf = (pubId) => sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${pubId}')`)[0].n;
/** Run `send(headers)` paused (3 s) mid-request, wait until the server is in its pause, run `act`, return the answer. */
async function during(send, act) {
  const b = h.pauseBarrier();
  const pending = send({ "x-test-pause-before-batch-ms": "3000", "x-test-pause-tag": b.tag });
  await b.entered;
  await act();
  return pending;
}

const PLANS = { tiny: { storage_bytes: 65536 } };
before(async () => {
  const worker = join(ROOT, "tmp", "test-worker-app-files", "index.js");
  await buildWorker({ entry: join(ROOT, "test/fixtures/app-files-worker.js"), outfile: worker });
  h = await startAppConnectServer({ port: PORT, worker, vars: { PLAN_LIMITS: JSON.stringify(PLANS) } });
  owner = await h.owner();
  ok(await owner.req("POST", "/api/projects", { id: "files-own", title: "Files own" }), 201);
  // Link the owner's upstream sign-in while they are the only person.
  await connect("files-own");
});
after(async () => { await h?.stop(); });

test("GET /v1/app says who the app is, with its destination and limit", async () => {
  const c = await connect("files-own", { destination: "new" });
  const me = ok(await h.pub(c.tok, "GET", "/app"));
  assert.deepEqual(Object.keys(me).sort(), ["app_id", "display_name", "folder", "limits", "project", "publisher_id"]);
  assert.equal(me.app_id, c.app.app_client_id); assert.equal(me.publisher_id, c.P.publisher_id);
  assert.deepEqual(me.project, { id: "files-own", title: "Files own" });
  assert.match(me.folder.id, /^fld_/); assert.deepEqual(me.limits, { max_file_bytes: 1048576 });
  assert.equal(ok(await h.pub((await connect("files-own")).tok, "GET", "/app")).folder, null, "project root");
});

test("create, read back, replace, delete: ETags, revisions, headers and a freed path", async () => {
  const c = await connect("files-own", { destination: "new" });
  const body = "# Synthetic note\n\n<script>alert(1)</script>\n";
  const created = await put(c.tok, "notes/day.md", body, { create: true });
  assert.equal(created.status, 201, created.text);
  const f = created.json.file;
  assert.deepEqual([f.path, f.kind, f.revision, f.sha256, f.size, f.etag], ["notes/day.md", "markdown", 1, sha(body), Buffer.byteLength(body), etagOf(body)]);
  assert.equal(created.headers.get("etag"), etagOf(body));
  const row = sql(`SELECT publisher_id, export_name, title, kind FROM artifacts WHERE id = '${f.file_id}'`)[0];
  assert.deepEqual(row, { publisher_id: c.P.publisher_id, export_name: "notes/day.md", title: "notes/day.md", kind: "markdown" });

  const r = await get(c.tok, "notes/day.md");
  assert.equal(r.status, 200); assert.equal(r.text, body); assert.equal(r.headers.get("etag"), etagOf(body));
  assert.match(r.headers.get("content-type"), /^text\/plain/); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  const head = await get(c.tok, "notes/day.md", {}, "HEAD");
  assert.equal(head.status, 200); assert.equal(head.text, ""); assert.equal(head.headers.get("etag"), etagOf(body));
  const ranged = await get(c.tok, "notes/day.md", { range: "bytes=2-9" });
  assert.equal(ranged.status, 206); assert.equal(ranged.text, body.slice(2, 10));

  const replaced = await put(c.tok, "notes/day.md", "# Two\n", { match: etagOf(body) });
  assert.equal(replaced.status, 200, replaced.text);
  assert.deepEqual([replaced.json.file.revision, replaced.json.file.file_id], [2, f.file_id]);
  assert.equal((await get(c.tok, "notes/day.md")).text, "# Two\n");
  assert.equal(revsOf(c.P.publisher_id), 2);

  const gone = await del(c.tok, "notes/day.md", { match: etagOf("# Two\n") });
  assert.equal(gone.status, 200, gone.text); assert.equal(gone.json.file.trashed, true);
  err(await get(c.tok, "notes/day.md"), 404, "not_found");
  assert.deepEqual(sql(`SELECT export_name, publisher_id, trashed_at IS NOT NULL AS trashed FROM artifacts WHERE id = '${f.file_id}'`)[0], { export_name: null, publisher_id: c.P.publisher_id, trashed: 1 });
  assert.deepEqual((await list(c.tok)).json.files, []);
  assert.equal((await put(c.tok, "notes/day.md", "again", { create: true })).status, 201, "the path is free again");
});

test("304 carries the same fixed headers as the 200", async () => {
  const c = await connect("files-own");
  await put(c.tok, "a.json", '{"a":1}', { create: true });
  const full = await get(c.tok, "a.json");
  const cached = await get(c.tok, "a.json", { "if-none-match": etagOf('{"a":1}') });
  assert.equal(cached.status, 304); assert.equal(cached.text, "");
  for (const k of ["etag", "cache-control", "x-content-type-options", "content-security-policy", "cross-origin-resource-policy"])
    assert.equal(cached.headers.get(k), full.headers.get(k), k);
});

test("preconditions: create over an existing file, stale If-Match, missing or malformed headers", async () => {
  const c = await connect("files-own");
  const v1 = "first\n";
  await put(c.tok, "p.md", v1, { create: true });
  err(await put(c.tok, "p.md", "x", { create: true }), 412, "precondition_failed");
  const stale = await put(c.tok, "p.md", "x", { match: etagOf("other") });
  err(stale, 412, "precondition_failed");
  assert.equal(stale.json.error.current_etag, etagOf(v1)); assert.equal(stale.json.error.current_revision, 1);
  err(await put(c.tok, "missing.md", "x", { match: etagOf(v1) }), 412, "precondition_failed");
  err(await put(c.tok, "p.md", "x", {}), 428, "precondition_required");
  err(await put(c.tok, "p.md", "x", { match: "rev:1" }), 400, "invalid_input");
  err(await put(c.tok, "p.md", "x", { create: true, match: etagOf(v1) }), 400, "invalid_input");
  err(await put(c.tok, "p.md", "x", { create: true, key: null }), 400, "idempotency_key_required");
  err(await del(c.tok, "p.md", { key: null, match: etagOf(v1) }), 400, "idempotency_key_required");
  err(await del(c.tok, "p.md", {}), 428, "precondition_required");
  err(await del(c.tok, "p.md", { match: etagOf("other") }), 412, "precondition_failed");
  assert.equal((await get(c.tok, "p.md")).text, v1, "every refusal left the file as it was");
  assert.equal(revsOf(c.P.publisher_id), 1);
});

test("unchanged bytes answer 200 {unchanged:true} and write no revision", async () => {
  const c = await connect("files-own");
  const body = "same\n";
  const a = await put(c.tok, "same.md", body, { create: true });
  const b = await put(c.tok, "same.md", body, { match: etagOf(body) });
  assert.equal(b.status, 200, b.text); assert.equal(b.json.unchanged, true);
  assert.deepEqual(b.json.file, a.json.file);
  assert.equal(revsOf(c.P.publisher_id), 1);
});

test("idempotent replay: same key and bytes repeat the first answer; the same key with other bytes is 422", async () => {
  const c = await connect("files-own");
  const key = uniq("replay");
  const a = await put(c.tok, "r.md", "one\n", { create: true, key });
  const again = await put(c.tok, "r.md", "one\n", { create: true, key });
  assert.equal(again.status, 201); assert.equal(again.json.idempotent_replay, true); assert.deepEqual(again.json.file, a.json.file);
  err(await put(c.tok, "r.md", "other\n", { create: true, key }), 422, "idempotency_key_reused");
  const k2 = uniq("replace");
  const r1 = await put(c.tok, "r.md", "two\n", { match: etagOf("one\n"), key: k2 });
  const r2 = await put(c.tok, "r.md", "two\n", { match: etagOf("one\n"), key: k2 });
  assert.equal(r1.status, 200); assert.equal(r2.status, 200); assert.equal(r2.json.idempotent_replay, true); assert.equal(r2.json.file.revision, 2);
  const k3 = uniq("delete");
  const d1 = await del(c.tok, "r.md", { match: etagOf("two\n"), key: k3 });
  const d2 = await del(c.tok, "r.md", { match: etagOf("two\n"), key: k3 });
  assert.equal(d1.status, 200); assert.equal(d2.status, 200); assert.equal(d2.json.idempotent_replay, true);
  assert.equal(revsOf(c.P.publisher_id), 2);
});

test("path rule: lowercase [a-z0-9._-] segments, 1-8, at most 200 characters, extension only on the last segment", async () => {
  const c = await connect("files-own");
  for (const p of ["a.md", "summary/steps.json", "v1.0/data.csv", "x_y-1.v2.html", "a/b/c/d/e/f/g/h.md"])
    assert.equal((await put(c.tok, p, p.endsWith(".json") ? "{}" : p.endsWith(".csv") ? "a,b\r\n1,2\r\n" : "ok\n", { create: true })).status, 201, p);
  assert.equal((await put(c.tok, "a".repeat(197) + ".md", "ok\n", { create: true })).status, 201, "200 characters");
  const bad = ["A.md", "a/B.md", ".hidden.md", "a/.x/b.md", "x.txt", "x", "x.markdown", "x.htm", "x.MD", "a.md/b.md", "a.json/b.csv", "a b.md", "%C3%A9.md",
    "a/b/c/d/e/f/g/h/i.md", "a".repeat(198) + ".md", "a%2Fb.md", "a//b.md"];
  for (const p of bad) err(await put(c.tok, p, "ok\n", { create: true, type: "text/markdown" }), 400, "invalid_path");
  err(await get(c.tok, "Upper.md"), 400, "invalid_path");
  const rawGet = (path) => new Promise((resolve, reject) => httpRequest({ host: "127.0.0.1", port: PORT, path, headers: { authorization: `Bearer ${c.tok}` } }, (res) => {
    let t = ""; res.on("data", (d) => t += d); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })(), text: t }));
  }).on("error", reject).end());
  for (const p of ["/v1/app/files/a%5Cb.md", "/v1/app/files//b.md"]) { const r = await rawGet(p); assert.equal(r.status, 400, p + " " + r.text); assert.equal(r.json.error.code, "invalid_path", p); }
  assert.equal(rowsOf(c.P.publisher_id), 6);
});

test("content: Content-Type must match the extension; invalid UTF-8, JSON and CSV are 422", async () => {
  const c = await connect("files-own");
  err(await put(c.tok, "t.md", "x", { create: true, type: "application/json" }), 415, "unsupported_type");
  err(await put(c.tok, "t.md", "x", { create: true, type: "image/png" }), 415, "unsupported_type");
  err(await put(c.tok, "t.md", "x", { create: true, type: "text/markdown; charset=latin1" }), 415, "unsupported_type");
  assert.equal((await put(c.tok, "t.md", "x", { create: true, type: "text/markdown; charset=utf-8" })).status, 201);
  err(await put(c.tok, "bad.json", "{not json", { create: true }), 422, "invalid_content");
  err(await put(c.tok, "bad.csv", "a,b\r\n1\r\n", { create: true }), 422, "invalid_content");
  err(await put(c.tok, "bad.md", Buffer.from([0xff, 0xfe, 0x41]), { create: true }), 422, "invalid_content");
  assert.equal(rowsOf(c.P.publisher_id), 1);
});

test("size: 1 MiB is accepted; a larger Content-Length is 413 before the body is read; a missing one is 411", async () => {
  const c = await connect("files-own");
  assert.equal((await put(c.tok, "max.md", "a".repeat(1048576), { create: true })).status, 201);
  const big = await put(c.tok, "big.md", "a".repeat(1048577), { create: true });
  err(big, 413, "file_too_large");
  // A declared 5 MiB with no body sent at all is refused from the headers alone (the answer arrives while the body is still missing).
  const head = [`PUT /v1/app/files/raw.md HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, `Authorization: Bearer ${c.tok}`, "Content-Type: text/markdown", "If-None-Match: *",
    `Idempotency-Key: ${uniq("raw")}`, `Content-Length: ${5 * 1048576}`, "", ""].join("\r\n");
  const answer = await new Promise((resolve) => {
    const socket = netConnect(PORT, "127.0.0.1");
    let text = "";
    socket.on("data", (d) => { text += d; if (/\r\n\r\n[^]*\}/.test(text)) { resolve(text); socket.destroy(); } });
    socket.on("close", () => resolve(text)); socket.on("error", () => {});
    socket.write(head);
  });
  assert.match(answer, /^HTTP\/1\.1 413/); assert.match(answer, /file_too_large/);
  // No Content-Length (a streamed, chunked body) is refused with 411.
  const chunked = await reply(await fetch(`${h.api}/app/files/raw.md`, { method: "PUT", duplex: "half", body: new ReadableStream({ start(ctl) { ctl.enqueue(Buffer.from("chunked")); ctl.close(); } }),
    headers: { authorization: `Bearer ${c.tok}`, "content-type": "text/markdown", "if-none-match": "*", "idempotency-key": uniq("chunked") } }));
  err(chunked, 411, "length_required");
  assert.equal(rowsOf(c.P.publisher_id), 1);
});

test("list: keyset pages in path order with prefix; each item says path, file_id, revision, etag, size", async () => {
  const c = await connect("files-own", { destination: "new" });
  for (const p of ["b.md", "a/2.md", "a/1.md", "c.json"]) await put(c.tok, p, p.endsWith("json") ? "{}" : "x\n", { create: true });
  const p1 = ok(await list(c.tok, "?limit=2"));
  assert.deepEqual(p1.files.map((f) => f.path), ["a/1.md", "a/2.md"]); assert.ok(p1.next_cursor);
  const p2 = ok(await list(c.tok, `?limit=2&cursor=${p1.next_cursor}`));
  assert.deepEqual(p2.files.map((f) => f.path), ["b.md", "c.json"]); assert.equal(p2.next_cursor, null);
  assert.deepEqual(ok(await list(c.tok, "?prefix=a/")).files.map((f) => f.path), ["a/1.md", "a/2.md"]);
  const f = p2.files[1];
  assert.deepEqual([f.kind, f.revision, f.etag, f.sha256, f.size], ["json", 1, etagOf("{}"), sha("{}"), 2]); assert.match(f.file_id, /^art_/);
  for (const q of ["?limit=0", "?limit=101", "?cursor=!!", "?prefix=A"]) assert.equal((await list(c.tok, q)).status, 400, q);
});

test("each app sees only its own files, even at the same project root and with the same paths", async () => {
  const a = await connect("files-own"), b = await connect("files-own");
  await put(a.tok, "same.md", "from a\n", { create: true });
  assert.deepEqual((await list(b.tok)).json.files, []); err(await get(b.tok, "same.md"), 404, "not_found");
  await put(b.tok, "same.md", "from b\n", { create: true });
  assert.equal((await get(a.tok, "same.md")).text, "from a\n"); assert.equal((await get(b.tok, "same.md")).text, "from b\n");
  err(await put(b.tok, "same.md", "x", { match: etagOf("from a\n") }), 412, "precondition_failed");
});

test("authorization is checked on every request: revoked, disabled app, deleted project, and nothing is written", async () => {
  const body = "keep\n";
  const seeded = async () => { const x = await connect("files-own"); await put(x.tok, "k.md", body, { create: true }); return x; };
  const all = async (c, status, code, message) => {
    for (const r of [await list(c.tok), await get(c.tok, "k.md"), await get(c.tok, "k.md", {}, "HEAD"), await h.pub(c.tok, "GET", "/app"),
      await put(c.tok, "k.md", "x", { match: etagOf(body) }), await put(c.tok, "new.md", "x", { create: true }), await del(c.tok, "k.md", { match: etagOf(body) })]) {
      if (r.status !== status) assert.fail(`${status} expected, got ${r.status} ${r.text}`);
      if (r.json) { assert.equal(r.json.error.code, code); assert.equal(r.json.error.message, message ?? r.json.error.message); }
    }
  };
  // Disabled app: every route, reads included.
  const dis = await seeded();
  ok(await owner.req("POST", `/api/app-clients/${dis.app.app_client_id}/disable`, {}));
  await all(dis, 401, "unauthenticated", APP_DISABLED);
  // Revoked publisher.
  const rev = await seeded();
  ok(await owner.req("POST", `/api/publishers/${rev.P.publisher_id}/revoke`, {}));
  await all(rev, 401, "publisher_revoked");
  for (const x of [dis, rev]) { assert.equal(rowsOf(x.P.publisher_id), 1); assert.equal(revsOf(x.P.publisher_id), 1); }
  // Deleted project.
  const title = uniq("Deleted project");
  const pid = ok(await owner.req("POST", "/api/projects", { title }), 201).id;
  const d = await connect(pid);
  await put(d.tok, "d.md", "x\n", { create: true });
  ok(await owner.req("DELETE", `/api/projects/${pid}`, { confirm_title: title }));
  for (const r of [await list(d.tok), await get(d.tok, "d.md"), await put(d.tok, "e.md", "x", { create: true })]) assert.equal(r.status, 401, r.text);
});

test("authorization lost while a PUT or DELETE is in flight: refused, nothing written", async () => {
  const c = await connect("files-own");
  const body = "head\n";
  const f = (await put(c.tok, "m.md", body, { create: true })).json.file;
  const rev = revsOf(c.P.publisher_id);
  const d = await connect("files-own");
  const create = await during((hd) => put(d.tok, "n.md", "x\n", { create: true, headers: hd }), async () => ok(await owner.req("POST", `/api/app-clients/${d.app.app_client_id}/disable`, {})));
  assert.equal(create.status, 401, create.text); assert.equal(create.json.error.message, APP_DISABLED);
  assert.equal(rowsOf(d.P.publisher_id), 0);
  const replace = await during((hd) => put(c.tok, "m.md", "x\n", { match: etagOf(body), headers: hd }), async () => ok(await owner.req("POST", `/api/publishers/${c.P.publisher_id}/revoke`, {})));
  assert.equal(replace.status, 401, replace.text);
  assert.equal(rowsOf(c.P.publisher_id), 1); assert.equal(revsOf(c.P.publisher_id), rev);
  assert.deepEqual(sql(`SELECT head_rev, export_name, trashed_at FROM artifacts WHERE id = '${f.file_id}'`)[0], { head_rev: 1, export_name: "m.md", trashed_at: null });
  const e = await connect("files-own");
  const g = (await put(e.tok, "m.md", body, { create: true })).json.file;
  const removal = await during((hd) => del(e.tok, "m.md", { match: etagOf(body), headers: hd }), async () => ok(await owner.req("POST", `/api/publishers/${e.P.publisher_id}/revoke`, {})));
  assert.equal(removal.status, 401, removal.text);
  assert.deepEqual(sql(`SELECT export_name, trashed_at FROM artifacts WHERE id = '${g.file_id}'`)[0], { export_name: "m.md", trashed_at: null });
});

test("the workspace storage limit applies to app writes (402) and the owner's trash holds a deleted file", async () => {
  const ws = ok(await owner.req("POST", "/api/workspaces", { name: uniq("Tiny") }), 201).id;
  sql(`UPDATE workspaces SET plan = 'tiny' WHERE id = '${ws}'`);
  const pid = ok(await owner.req("POST", "/api/projects", { title: uniq("Tiny project"), workspace_id: ws }), 201).id;
  const c = await connect(pid);
  err(await put(c.tok, "big.md", "x".repeat(70000), { create: true }), 402, "limit_reached");
  assert.equal(rowsOf(c.P.publisher_id), 0);
  const small = await put(c.tok, "small.md", "x".repeat(1000), { create: true });
  assert.equal(small.status, 201);
  assert.equal((await del(c.tok, "small.md", { match: etagOf("x".repeat(1000)) })).status, 200);
  assert.equal(ok(await owner.req("GET", `/api/projects/${pid}/artifacts?trashed=1`)).artifacts.some((a) => a.id === small.json.file.file_id), true);
});

test("agents can read app files but never write them; the owner cannot edit them either", async () => {
  const c = await connect("files-own", { destination: "new" });
  const f = (await put(c.tok, "index.json", '{"files":[]}', { create: true })).json.file;
  const doc = (await put(c.tok, "note.md", "# note\n", { create: true })).json.file;
  const agent = await h.connectMcpAgent({ "files-own": "write" }, { clientName: "Files agent" });
  const apiKey = ok(await owner.req("POST", "/api/api-keys", { label: "path key", projects: [{ project_id: "files-own", access: "read" }] }), 201).secret;
  const read = await agent.call("read_artifact", { project_id: "files-own", artifact_id: f.file_id });
  assert.equal(read.isError, false); assert.match(JSON.stringify(read.data), /files/);
  // An agent finds a file by its app path, and every app file's metadata says its path.
  const found = await agent.call("list_artifacts", { project_id: "files-own", app_path: "index.json" });
  assert.equal(found.isError, false, JSON.stringify(found.data));
  assert.deepEqual(found.data.artifacts.map((x) => [x.id, x.app_path]), [[f.file_id, "index.json"]]);
  assert.deepEqual((await agent.call("list_artifacts", { project_id: "files-own", app_path: "nope.json" })).data.artifacts, []);
  const viaKey = await fetch(`${h.api}/projects/files-own/files?app_path=index.json`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.deepEqual((await viaKey.json()).files.map((x) => x.app_path), ["index.json"]);
  assert.equal((await agent.call("list_artifacts", { project_id: "files-own", app_path: "A/B" })).isError, true, "an invalid path is refused");
  const save = await agent.call("save_markdown", { project_id: "files-own", artifact_id: doc.file_id, expected_revision: 1, body: "x", idempotency_key: uniq("agent-save") });
  assert.equal(save.isError, true); assert.match(JSON.stringify(save.data), /protected_source/);
  const edit = await owner.req("PUT", `/api/projects/files-own/artifacts/${f.file_id}`, { expected_revision: 1, content: "{}" });
  assert.equal(edit.status, 403); assert.equal(edit.body.error.code, "protected_source");
  assert.equal((await get(c.tok, "index.json")).text, '{"files":[]}', "untouched");
});

test("other credentials are refused: cookies 400, an API key, an MCP token and no token 401", async () => {
  const c = await connect("files-own");
  await put(c.tok, "cred.md", "x\n", { create: true });
  const cookie = await get(c.tok, "cred.md", { cookie: "al_session=synthetic" });
  err(cookie, 400, "invalid_request");
  const apiKey = ok(await owner.req("POST", "/api/api-keys", { label: "files key", projects: [{ project_id: "files-own", access: "read_write" }] }), 201).secret;
  const agent = await h.connectMcpAgent({ "files-own": "write" }, { clientName: "Files agent 2" });
  for (const tok of [apiKey, agent.access_token, null]) for (const path of ["/app", "/app/files", "/app/files/cred.md"]) assert.equal((await h.pub(tok, "GET", path)).status, 401, path);
});

test("the removed routes are gone: /v1/publisher/* answers 404 and upload slots or generations no longer exist", async () => {
  const c = await connect("files-own");
  for (const [m, p] of [["GET", "/publisher/me"], ["GET", "/publisher/files"], ["POST", "/publisher/snapshots"], ["POST", "/publisher/generations"]])
    assert.equal((await h.pub(c.tok, m, p)).status, 404, p);
  assert.equal((await h.pub(c.tok, "GET", "/app/nope")).status, 404);
});

test("backup: a project with app files exports them with app:{name,path}; import makes ordinary editable files", async () => {
  const title = uniq("Backup project");
  const pid = ok(await owner.req("POST", "/api/projects", { title }), 201).id;
  const c = await connect(pid, { destination: "new" });
  const kept = (await put(c.tok, "summary/steps.json", '{"steps":1}', { create: true })).json.file;
  const gone = (await put(c.tok, "old.md", "# old\n", { create: true })).json.file;
  assert.equal((await del(c.tok, "old.md", { match: etagOf("# old\n") })).status, 200);
  const backup = ok(await owner.req("GET", `/api/projects/${pid}/backup`));
  assert.equal(backup.schema, "agent-library-backup/3");
  const byId = Object.fromEntries(backup.artifacts.map((a) => [a.id, a]));
  const appName = byId[kept.file_id].app.name;
  assert.match(appName, /^Files app-/);
  assert.deepEqual(byId[kept.file_id].app, { name: appName, path: "summary/steps.json" });
  assert.deepEqual(byId[gone.file_id].app, { name: appName, path: null }, "a trashed app file has no path");
  assert.ok(!("publisher_id" in byId[kept.file_id]) && !("export_name" in byId[kept.file_id]));
  const folder = sql(`SELECT f.name FROM artifacts a JOIN folders f ON f.id = a.folder_id WHERE a.id = '${kept.file_id}'`)[0].name;
  assert.equal(byId[kept.file_id].folder_name, folder, "the app's folder is exported by name");

  const personal = ok(await owner.req("GET", "/api/workspaces")).workspaces.find((w) => w.personal).id;
  const imported = ok(await owner.req("POST", `/api/workspaces/${personal}/import`, { backup, title: "Imported app project" }), 201);
  const rows = sql(`SELECT id, title, tags, publisher_id, export_name, trashed_at IS NOT NULL AS trashed FROM artifacts WHERE project_id = '${imported.project_id}' ORDER BY title`);
  assert.equal(rows.length, 2);
  const restored = rows.find((r) => r.title === "summary/steps.json");
  assert.deepEqual([restored.publisher_id, restored.export_name, JSON.parse(restored.tags)], [null, null, [`app:${appName}`]]);
  // The folder is recreated by name in the new project, owned by the owner (no app), and both files sit in it.
  const placed = sql(`SELECT a.title, f.name, f.publisher_id, f.project_id FROM artifacts a JOIN folders f ON f.id = a.folder_id WHERE a.project_id = '${imported.project_id}' ORDER BY a.title`);
  assert.deepEqual(placed.map((r) => [r.name, r.publisher_id, r.project_id]), [[folder, null, imported.project_id], [folder, null, imported.project_id]]);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM folders WHERE project_id = '${imported.project_id}'`)[0].n, 1);
  // A backup naming an invalid folder is refused before anything is written.
  const badFolder = { ...backup, artifacts: backup.artifacts.map((a) => ({ ...a, folder_name: "a/b" })) };
  assert.equal((await owner.req("POST", `/api/workspaces/${personal}/import`, { backup: badFolder })).status, 400);
  assert.equal(rows.find((r) => r.trashed).publisher_id, null);
  // Ordinary and editable: the owner can save a new version of the restored file.
  const doc = rows.find((r) => r.title === "summary/steps.json");
  const saved = await owner.req("PUT", `/api/projects/${imported.project_id}/artifacts/${doc.id}`, { expected_revision: 1, content: '{"steps":2}' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
});
