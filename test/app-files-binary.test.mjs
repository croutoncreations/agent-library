// App Files: binary files and folders on the one path-addressed API (/v1/app/files/{path}). Path segments become real
// subfolders of the app's destination, owned by the app; binaries stream to storage with the declared size and
// SHA-256 checked, and the type's signature checked; reads support Range and the safe-serving headers. Real local
// wrangler dev, the real App Connect flows and real HTTP; synthetic data only (generated PNG/PDF bytes).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { makePng, makePdf } from "./make-fixtures.mjs";
import { buildWorker } from "../scripts/build.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS["app-files-binary"];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const etagOf = (b) => `"${sha(b)}"`;
let h, owner, n = 0;
const uniq = (p) => `${p}-${++n}-key`;
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body ?? r.json)); return r.body ?? r.json; };
const err = (r, status, code) => { assert.equal(r.status, status, r.text); assert.equal(r.json.error.code, code, r.text); };

async function connect(pid, { destination = "new" } = {}) {
  const label = uniq("bin").replace("-key", "");
  const app = await h.registerApp({ display_name: `Bin ${label}`, redirect_uris: [`https://${label}.example.test/cb`], origins: [] });
  const P = await h.connectPublisher(app, { project_id: pid, destination, ...destination === "new" ? { new_folder_name: label } : {} });
  return { app, P, tok: P.access_token, dest: label };
}
async function reply(r) {
  const bytes = Buffer.from(await r.arrayBuffer()), text = bytes.toString(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, bytes, text, json };
}
/** PUT a binary: sends X-Content-SHA256 of the body unless headers override it (null removes a header). */
async function putBin(tok, path, body, { create, match, type, key = uniq("put"), headers = {} } = {}) {
  const hd = { "content-type": type, "idempotency-key": key, "x-content-sha256": sha(body), ...create ? { "if-none-match": "*" } : {}, ...match ? { "if-match": match } : {}, ...headers };
  for (const [k, v] of Object.entries(hd)) if (v === null || v === undefined) delete hd[k];
  hd.authorization = `Bearer ${tok}`;
  return reply(await fetch(`${h.api}/app/files/${path}`, { method: "PUT", headers: hd, body }));
}
const get = async (tok, path, headers = {}, method = "GET") => reply(await fetch(`${h.api}/app/files/${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...headers } }));
const del = async (tok, path, match) => reply(await fetch(`${h.api}/app/files/${path}`, { method: "DELETE", headers: { authorization: `Bearer ${tok}`, "if-match": match, "idempotency-key": uniq("del") } }));
const list = async (tok, q = "") => reply(await fetch(`${h.api}/app/files${q}`, { headers: { authorization: `Bearer ${tok}` } }));

const PNG = makePng(24, 24), PNG2 = makePng(30, 18), PDF = makePdf();
before(async () => {
  const worker = join(ROOT, "tmp", "test-worker-app-files-binary", "index.js");
  await buildWorker({ entry: join(ROOT, "test/fixtures/app-files-worker.js"), outfile: worker });
  h = await startAppConnectServer({ port: PORT, worker, vars: { PLAN_LIMITS: JSON.stringify({ tiny: { storage_bytes: 4096 } }) } });
  owner = await h.owner();
  ok(await owner.req("POST", "/api/projects", { id: "bin-own", title: "Binary files" }), 201);
});
after(async () => { await h?.stop(); });

test("Markdown and PNG under test/sub/: real subfolders of the destination, owned by the app; list by prefix, read back", async () => {
  const c = await connect("bin-own");
  const md = "# Synthetic brief\n";
  const a = await reply(await fetch(`${h.api}/app/files/test/sub/brief.md`, { method: "PUT", body: md,
    headers: { authorization: `Bearer ${c.tok}`, "content-type": "text/markdown", "if-none-match": "*", "idempotency-key": uniq("md") } }));
  assert.equal(a.status, 201, a.text);
  const b = await putBin(c.tok, "test/sub/shot.png", PNG, { create: true, type: "image/png" });
  assert.equal(b.status, 201, b.text);
  const f = b.json.file;
  assert.deepEqual([f.path, f.kind, f.mime, f.revision, f.size, f.sha256, f.etag], ["test/sub/shot.png", "binary", "image/png", 1, PNG.length, sha(PNG), etagOf(PNG)]);
  assert.equal(f.folder.path, `${c.dest}/test/sub`);
  assert.equal(b.headers.get("etag"), etagOf(PNG));

  // The folders exist in the project tree, under the destination, marked as the app's.
  const tree = ok(await owner.req("GET", "/api/projects/bin-own/folders")).folders;
  const sub = tree.find((x) => x.path === `${c.dest}/test/sub`), mid = tree.find((x) => x.path === `${c.dest}/test`);
  assert.ok(sub && mid, JSON.stringify(tree.map((x) => x.path)));
  assert.equal(sub.publisher_id, c.P.publisher_id); assert.equal(mid.publisher_id, c.P.publisher_id);
  assert.equal(sub.item_count, 2);
  const inSub = ok(await owner.req("GET", `/api/projects/bin-own/artifacts?folder_id=${sub.id}`)).artifacts.map((x) => [x.title, x.kind, x.app_path]).sort();
  assert.deepEqual(inSub, [["brief.md", "markdown", "test/sub/brief.md"], ["shot.png", "binary", "test/sub/shot.png"]]);

  // List by prefix: each item has kind, mime, size, revision, etag, updated_at, title, file_id, folder and web_url.
  const l = await list(c.tok, "?prefix=test/sub/");
  assert.equal(l.status, 200, l.text);
  assert.deepEqual(l.json.files.map((x) => x.path), ["test/sub/brief.md", "test/sub/shot.png"]);
  const item = l.json.files[1];
  for (const k of ["kind", "mime", "size", "revision", "etag", "updated_at", "title", "file_id", "web_url", "folder"]) assert.ok(k in item, k);
  assert.deepEqual([item.kind, item.mime, item.size, item.title, item.folder.path], ["binary", "image/png", PNG.length, "shot.png", `${c.dest}/test/sub`]);
  assert.match(item.web_url, new RegExp(`/a/${item.file_id}$`), "a link to the file in the app (project address or id)");
  assert.equal(l.json.files[0].mime, "text/markdown");
  assert.deepEqual((await list(c.tok, "?prefix=test/other/")).json.files, []);

  // Read back: bytes, ETag, safe headers; Range; HEAD; If-None-Match.
  const r = await get(c.tok, "test/sub/shot.png");
  assert.equal(r.status, 200); assert.ok(r.bytes.equals(PNG));
  assert.equal(r.headers.get("content-type"), "image/png"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /sandbox/); assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.equal(r.headers.get("etag"), etagOf(PNG));
  const part = await get(c.tok, "test/sub/shot.png", { range: "bytes=0-7" });
  assert.equal(part.status, 206); assert.ok(part.bytes.equals(PNG.subarray(0, 8)));
  assert.equal(part.headers.get("content-range"), `bytes 0-7/${PNG.length}`);
  const tail = await get(c.tok, "test/sub/shot.png", { range: "bytes=-4" });
  assert.equal(tail.status, 206); assert.ok(tail.bytes.equals(PNG.subarray(PNG.length - 4)));
  assert.equal((await get(c.tok, "test/sub/shot.png", { range: `bytes=${PNG.length}-` })).status, 416);
  assert.equal((await get(c.tok, "test/sub/shot.png", { "if-none-match": etagOf(PNG) })).status, 304);
  const hd = await get(c.tok, "test/sub/shot.png", {}, "HEAD");
  assert.equal(hd.status, 200); assert.equal(hd.headers.get("content-length"), String(PNG.length));
});

test("replace with If-Match, then delete: revisions, unchanged bytes, stale ETags", async () => {
  const c = await connect("bin-own");
  const a = (await putBin(c.tok, "test/sub/shot.png", PNG, { create: true, type: "image/png" })).json.file;
  err(await putBin(c.tok, "test/sub/shot.png", PNG2, { create: true, type: "image/png" }), 412, "precondition_failed");
  const stale = await putBin(c.tok, "test/sub/shot.png", PNG2, { match: etagOf(PNG2), type: "image/png" });
  err(stale, 412, "precondition_failed"); assert.equal(stale.json.error.current_etag, etagOf(PNG));
  const same = await putBin(c.tok, "test/sub/shot.png", PNG, { match: etagOf(PNG), type: "image/png" });
  assert.equal(same.status, 200, same.text); assert.equal(same.json.unchanged, true);
  const b = await putBin(c.tok, "test/sub/shot.png", PNG2, { match: etagOf(PNG), type: "image/png" });
  assert.equal(b.status, 200, b.text);
  assert.deepEqual([b.json.file.file_id, b.json.file.revision, b.json.file.sha256], [a.file_id, 2, sha(PNG2)]);
  assert.ok((await get(c.tok, "test/sub/shot.png")).bytes.equals(PNG2));
  // The first version is kept in History (owner view).
  assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${a.file_id}'`)[0].n, 2);
  // Delete with a stale ETag is refused; with the current one it moves the file to the owner's trash.
  err(await del(c.tok, "test/sub/shot.png", etagOf(PNG)), 412, "precondition_failed");
  const gone = await del(c.tok, "test/sub/shot.png", etagOf(PNG2));
  assert.equal(gone.status, 200, gone.text); assert.equal(gone.json.file.trashed, true);
  err(await get(c.tok, "test/sub/shot.png"), 404, "not_found");
  assert.equal((await putBin(c.tok, "test/sub/shot.png", PNG, { create: true, type: "image/png" })).status, 201, "the path is free again");
});

test("idempotency: same key and bytes replay; same key with other bytes is 422; replays never read the body twice", async () => {
  const c = await connect("bin-own");
  const k = uniq("same");
  const first = await putBin(c.tok, "r/a.pdf", PDF, { create: true, type: "application/pdf", key: k });
  assert.equal(first.status, 201, first.text);
  const again = await putBin(c.tok, "r/a.pdf", PDF, { create: true, type: "application/pdf", key: k });
  assert.equal(again.status, 201, again.text); assert.equal(again.json.idempotent_replay, true);
  assert.equal(again.json.file.file_id, first.json.file.file_id);
  err(await putBin(c.tok, "r/a.pdf", Buffer.concat([PDF, Buffer.from("\n")]), { create: true, type: "application/pdf", key: k }), 422, "idempotency_key_reused");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${first.json.file.file_id}'`)[0].n, 1);
  // A PDF is served as an attachment (active type), never inline.
  const r = await get(c.tok, "r/a.pdf");
  assert.match(r.headers.get("content-disposition"), /^attachment/); assert.equal(r.headers.get("content-type"), "application/pdf");
});

test("checks: declared SHA-256, Content-Type per extension, signature, length, size limit, path rules; nothing stored on refusal", async () => {
  const c = await connect("bin-own");
  const count = () => sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}'`)[0].n;
  const writes = () => sql(`SELECT COUNT(*) AS n FROM content_writes WHERE project_id = 'bin-own'`)[0].n;
  const w0 = writes();
  err(await putBin(c.tok, "x.png", PNG, { create: true, type: "image/png", headers: { "x-content-sha256": sha("other") } }), 422, "integrity_mismatch");
  err(await putBin(c.tok, "x.png", PNG, { create: true, type: "image/png", headers: { "x-content-sha256": null } }), 428, "precondition_required");
  err(await putBin(c.tok, "x.png", PNG, { create: true, type: "image/png", headers: { "x-content-sha256": "XYZ" } }), 400, "invalid_input");
  err(await putBin(c.tok, "x.png", PNG, { create: true, type: "image/jpeg" }), 415, "unsupported_type");
  err(await putBin(c.tok, "x.png", PNG, { create: true, type: "image/png; charset=utf-8" }), 415, "unsupported_type");
  err(await putBin(c.tok, "x.png", PNG, { create: true, type: "image/svg+xml" }), 415, "unsupported_type");
  err(await putBin(c.tok, "x.png", PDF, { create: true, type: "image/png" }), 422, "signature_mismatch");
  err(await putBin(c.tok, "x.svg", Buffer.from("<svg/>"), { create: true, type: "application/octet-stream" }), 400, "invalid_path");
  err(await putBin(c.tok, "Test/x.png", PNG, { create: true, type: "image/png" }), 400, "invalid_path");
  // A folder named like a binary file is fine (only text extensions are refused as folder names).
  assert.equal((await putBin(c.tok, "a.png/x.md", Buffer.from("# x"), { create: true, type: "text/markdown", headers: { "x-content-sha256": null } })).status, 201);
  err(await putBin(c.tok, "x.png", Buffer.alloc(0), { create: true, type: "image/png" }), 422, "signature_mismatch");
  // Text files never take X-Content-SHA256 (their hash is computed); binaries over the plan's file limit are 413 from the headers.
  err(await putBin(c.tok, "x.md", Buffer.from("# x"), { create: true, type: "text/markdown" }), 400, "invalid_input");
  const big = await reply(await fetch(`${h.api}/app/files/big.bin`, { method: "PUT", body: "x",
    headers: { authorization: `Bearer ${c.tok}`, "content-type": "application/octet-stream", "content-length": "1", "if-none-match": "*", "idempotency-key": uniq("b"), "x-content-sha256": sha("x") } }));
  assert.equal(big.status, 201, "octet-stream: any bytes, " + big.text);
  assert.equal(count(), 2, "only a.png/x.md and big.bin were stored");
  assert.equal(writes(), w0, "every refused or finished write left no intent behind");
  // R2 objects: none for refused writes (only the two stored revisions' objects and text keys exist).
  const keys = sql(`SELECT blob_key FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${c.P.publisher_id}') AND blob_key IS NOT NULL`);
  assert.equal(keys.length, 1);
});

test("5 MiB binary in one PUT (streamed), Range in the middle; GET /v1/app reports the binary limit", async () => {
  const c = await connect("bin-own");
  const me = ok(await h.pub(c.tok, "GET", "/app"));
  assert.equal(me.limits.max_binary_bytes, 25 * 1048576); assert.equal(me.limits.max_text_bytes, 1048576);
  const big = Buffer.alloc(5 * 1048576 + 3);
  PNG.copy(big, 0); for (let i = PNG.length; i < big.length; i++) big[i] = (i * 31) & 255;
  const r = await putBin(c.tok, "media/big.png", big, { create: true, type: "image/png" });
  assert.equal(r.status, 201, r.text); assert.equal(r.json.file.size, big.length);
  const mid = await get(c.tok, "media/big.png", { range: "bytes=3000000-3000099" });
  assert.equal(mid.status, 206); assert.ok(mid.bytes.equals(big.subarray(3000000, 3000100)));
});

test("ownership: the app's subfolders (and folders holding them) can't be renamed or moved while it is connected, only deleted when empty; its files can't be refiled", async () => {
  const c = await connect("bin-own");
  const f = (await putBin(c.tok, "keep/a.png", PNG, { create: true, type: "image/png" })).json.file;
  const tree = ok(await owner.req("GET", "/api/projects/bin-own/folders")).folders;
  const keep = tree.find((x) => x.path === `${c.dest}/keep`), dest = tree.find((x) => x.path === c.dest);
  const rn = await owner.req("PATCH", `/api/projects/bin-own/folders/${keep.id}`, { name: "other" });
  assert.equal(rn.status, 409, JSON.stringify(rn.body)); assert.equal(rn.body.error.code, "folder_app_owned");
  const mv = await owner.req("PATCH", `/api/projects/bin-own/folders/${keep.id}`, { parent_id: "root" });
  assert.equal(mv.status, 409); assert.equal(mv.body.error.code, "folder_app_owned");
  const fdel = await owner.req("DELETE", `/api/projects/bin-own/folders/${keep.id}`);
  assert.equal(fdel.status, 409); assert.equal(fdel.body.error.code, "folder_not_empty");
  // A folder a person made inside the destination, once the app writes below it, can't be renamed or moved either.
  const human = ok(await owner.req("POST", "/api/projects/bin-own/folders", { path: `${c.dest}/human` }), 201);
  const x = await putBin(c.tok, "human/appsub/x.png", PNG, { create: true, type: "image/png" });
  assert.equal(x.status, 201, x.text);
  const hm = await owner.req("PATCH", `/api/projects/bin-own/folders/${human.id}`, { parent_id: "root" });
  assert.equal(hm.status, 409, JSON.stringify(hm.body)); assert.equal(hm.body.error.code, "folder_app_owned");
  const hr = await owner.req("PATCH", `/api/projects/bin-own/folders/${human.id}`, { name: "renamed" });
  assert.equal(hr.body.error?.code, "folder_app_owned");
  // An empty app folder can be deleted; the app recreates it on its next write there.
  assert.equal((await del(c.tok, "human/appsub/x.png", x.json.file.etag)).status, 200);
  const appsub = ok(await owner.req("GET", "/api/projects/bin-own/folders")).folders.find((y) => y.path === `${c.dest}/human/appsub`);
  ok(await owner.req("DELETE", `/api/projects/bin-own/folders/${appsub.id}`));
  assert.equal((await putBin(c.tok, "human/appsub/y.png", PNG2, { create: true, type: "image/png" })).json.file.folder.path, `${c.dest}/human/appsub`);
  // The destination itself can be renamed (paths follow); the app keeps writing to the same folders.
  assert.equal((await owner.req("PATCH", `/api/projects/bin-own/folders/${dest.id}`, { name: `${c.dest}-renamed` })).status, 200);
  const again = await putBin(c.tok, "keep/b.png", PNG2, { create: true, type: "image/png" });
  assert.equal(again.status, 201, again.text); assert.equal(again.json.file.folder.path, `${c.dest}-renamed/keep`);
  // Details: a folder sent for an app's file is ignored (it stays where the app put it).
  const doc = ok(await owner.req("GET", `/api/projects/bin-own/artifacts/${f.file_id}`)).artifact;
  const meta = ok(await owner.req("PATCH", `/api/projects/bin-own/artifacts/${f.file_id}`, { expected_meta_version: doc.meta_version, folder: "Elsewhere" }));
  assert.equal(meta.folder, `${c.dest}-renamed/keep`);
  // Once the app is revoked the owner manages those folders like any other.
  ok(await owner.req("POST", `/api/publishers/${c.P.publisher_id}/revoke`, {}));
  assert.equal((await owner.req("PATCH", `/api/projects/bin-own/folders/${keep.id}`, { name: "kept" })).status, 200);
});

test("files written before paths became folders are refiled into their path's folder on the next replace", async () => {
  const c = await connect("bin-own");
  const md = "# v1\n";
  const a = await reply(await fetch(`${h.api}/app/files/old/notes.md`, { method: "PUT", body: md,
    headers: { authorization: `Bearer ${c.tok}`, "content-type": "text/markdown", "if-none-match": "*", "idempotency-key": uniq("md") } }));
  assert.equal(a.status, 201, a.text);
  // Simulate the previous release: the file sat in the destination itself.
  const destId = sql(`SELECT folder_id FROM publishers WHERE id = '${c.P.publisher_id}'`)[0].folder_id;
  sql(`UPDATE artifacts SET folder_id = '${destId}', folder = '${c.dest}' WHERE id = '${a.json.file.file_id}'`);
  assert.equal((await get(c.tok, "old/notes.md")).text, md, "still readable by path");
  const b = await reply(await fetch(`${h.api}/app/files/old/notes.md`, { method: "PUT", body: "# v2\n",
    headers: { authorization: `Bearer ${c.tok}`, "content-type": "text/markdown", "if-match": etagOf(md), "idempotency-key": uniq("md") } }));
  assert.equal(b.status, 200, b.text); assert.equal(b.json.file.folder.path, `${c.dest}/old`);
  assert.equal(sql(`SELECT folder FROM artifacts WHERE id = '${a.json.file.file_id}'`)[0].folder, `${c.dest}/old`);
});
