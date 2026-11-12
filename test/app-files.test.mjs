// App Files API (/v1/app/files, slice 5a) and the publisher liveness rule it relies on (docs/app-connect.md).
// Real local wrangler dev, the official App Connect flows (owner consent, code exchange) and real HTTP; synthetic
// people and data only. Raw request paths are sent with node:http so nothing normalizes them on the way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildWorker } from "../scripts/build.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS["app-files"];
const sha = (s) => createHash("sha256").update(s).digest("hex");
let h, owner, bob, ownerId, WSA, n = 0;
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, CI: "1", NO_COLOR: "1" } }))[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body ?? r.json)); return r.body ?? r.json; };
const uniq = (p) => `${p}-${++n}`;

/** A one-part generation begin body (staged only; never committed here). */
const beginBody = (gid) => ({ generation_id: gid, source_revision: 1, expected_current_snapshot_id: null, root_name: `${gid}-root.json`,
  root_sha256: sha(gid), part_count: 1, total_bytes: 64 });
const genState = (gid) => sql(`SELECT state FROM publisher_generations WHERE id = '${gid}'`)[0]?.state;

/** A fresh app + publisher into project `pid` (the owner consents). */
async function connect(pid, { label = uniq("app"), destination = "root", origins = [] } = {}) {
  const app = await h.registerApp({ display_name: `Files ${label}`, redirect_uris: [`https://${label}.example.test/cb`], origins });
  const P = await h.connectPublisher(app, { project_id: pid, destination, ...destination === "new" ? { new_folder_name: label } : {} });
  return { app, P, tok: P.access_token };
}
const ORIGIN = "https://files-app.example.test";
const MIME = { markdown: "text/markdown", html: "text/html", json: "application/json", csv: "text/csv" };
const q = (v) => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
/**
 * Synthetic App Files rows, written straight to local D1 (this commit has no PUT yet). Each file:
 * { path, kind?, content?, exportName?, generationId?, trashed?, publisherId?, folderId? }.
 */
function insertFiles(pubId, files) {
  const pb = sql(`SELECT principal_id, project_id, folder_id FROM publishers WHERE id = '${pubId}'`)[0];
  const now = new Date().toISOString();
  const stmts = files.map((f) => {
    const kind = f.kind ?? "markdown", content = f.content ?? `synthetic ${f.path}`;
    const id = "art_" + randomBytes(9).toString("base64url"), rev = "rev_" + randomBytes(9).toString("base64url");
    f.id = id; f.sha256 = sha(content); f.size = Buffer.byteLength(content);
    const publisherId = "publisherId" in f ? f.publisherId : pubId;
    return `INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, publisher_id, export_name, generation_id, head_rev, head_revision_id, trashed_at, created_at, updated_at)
      VALUES (${[id, pb.project_id, kind, f.path, "", "folderId" in f ? f.folderId : pb.folder_id, publisherId, "exportName" in f ? f.exportName : f.path, f.generationId ?? null, 1, rev, f.trashed ? now : null, now, now].map(q).join(", ")});
      INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at)
      VALUES (${[rev, id, pb.project_id, 1, pb.principal_id, content, f.size, f.sha256, MIME[kind], now].map(q).join(", ")});`;
  });
  for (let i = 0; i < stmts.length; i += 40) sql(stmts.slice(i, i + 40).join("\n"));
  return files;
}
/** One request with the path exactly as given (fetch and URL would normalize it). */
function raw(path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on("error", reject); r.end();
  });
}
const files = (tok, query = "") => h.pub(tok, "GET", `/app/files${query}`);
const file = (tok, path, headers = {}, method = "GET") => h.pub(tok, method, `/app/files/${path}`, { headers });
/** The fixed headers a content answer carries; a 304 must carry the same values. */
const FIXED = ["etag", "cache-control", "x-content-type-options", "content-security-policy", "cross-origin-resource-policy"];
/** A publisher with one staged generation. */
async function staged(pid, opts) {
  const c = await connect(pid, opts);
  const gid = "g_" + uniq("abandon").replace(/-/g, "_");
  const b = await h.pub(c.tok, "POST", "/publisher/generations", { body: beginBody(gid), idem: uniq("begin-key") });
  assert.equal(b.status, 201, b.text);
  return { ...c, gid };
}
const abandon = (tok, gid, headers = {}) => h.pub(tok, "DELETE", `/publisher/generations/${gid}`, { headers });
/**
 * Run `send(headers)` with a 3 s test pause, wait until the server logs that this request entered its pause, then run
 * `act` (which changes authorization) while it is paused, and return the request's answer.
 */
async function during(send, act) {
  const b = h.pauseBarrier();
  const pending = send({ "x-test-pause-before-batch-ms": "3000", "x-test-pause-tag": b.tag });
  await b.entered;
  await act();
  return pending;
}

// Workspaces default to plan "free", which is not listed, so unlimited; plan "tiny" has 64 KB of storage (402 tests).
const PLANS = { tiny: { storage_bytes: 65536 } };
before(async () => {
  const worker = join(ROOT, "tmp", "test-worker-app-files", "index.js");
  await buildWorker({ entry: join(ROOT, "test/fixtures/app-files-worker.js"), outfile: worker });
  h = await startAppConnectServer({ port: PORT, worker, vars: { PLAN_LIMITS: JSON.stringify(PLANS) } });
  owner = await h.owner();
  ownerId = ok(await owner.req("GET", "/api/me")).principal.id;
  ok(await owner.req("POST", "/api/projects", { id: "files-own", title: "Files own" }), 201);
  // Link the owner's upstream sign-in while they are the only person, then add bob and his shared workspace.
  await connect("files-own");
  bob = await h.person("bob");
  WSA = ok(await bob.req("POST", "/api/workspaces", { name: "Shared files" }), 201).id;
  const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
});
after(async () => { await h?.stop(); });

// Design test 13 (abandon): generation abandon is a fenced write; every refusal leaves the generation staged.
test("abandon: disabled client and revoked publisher are refused (401); the generation stays staged", async () => {
  const d = await staged("files-own");
  ok(await owner.req("POST", `/api/app-clients/${d.app.app_client_id}/disable`, {}));
  const r1 = await abandon(d.tok, d.gid);
  assert.equal(r1.status, 401, r1.text); assert.equal(genState(d.gid), "staged");
  const v = await staged("files-own");
  ok(await owner.req("POST", `/api/publishers/${v.P.publisher_id}/revoke`, {}));
  const r2 = await abandon(v.tok, v.gid);
  assert.equal(r2.status, 401, r2.text); assert.equal(r2.json.error.code, "publisher_revoked"); assert.equal(genState(v.gid), "staged");
});

test("abandon: an app client disabled or a publisher revoked mid-request abandons nothing (401)", async () => {
  const d = await staged("files-own");
  const r1 = await during((hd) => abandon(d.tok, d.gid, hd), async () => ok(await owner.req("POST", `/api/app-clients/${d.app.app_client_id}/disable`, {})));
  assert.equal(r1.status, 401, r1.text); assert.equal(genState(d.gid), "staged");
  const v = await staged("files-own");
  const r2 = await during((hd) => abandon(v.tok, v.gid, hd), async () => ok(await owner.req("POST", `/api/publishers/${v.P.publisher_id}/revoke`, {})));
  assert.equal(r2.status, 401, r2.text); assert.equal(genState(v.gid), "staged");
});

test("abandon in a suspended workspace: 403 workspace_read_only, the generation stays staged; works again once active", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Suspended"), workspace_id: WSA }), 201).id;
  const s = await staged(pid);
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`);
  try {
    const r = await abandon(s.tok, s.gid);
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, "workspace_read_only"); assert.equal(genState(s.gid), "staged");
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
  const again = await abandon(s.tok, s.gid);
  assert.equal(again.status, 200, again.text); assert.equal(again.json.state, "abandoned");
  // Suspended mid-request: the fenced UPDATE changes nothing.
  const s2 = await staged(pid);
  try {
    const r = await during((hd) => abandon(s2.tok, s2.gid, hd), async () => sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`));
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, "workspace_read_only"); assert.equal(genState(s2.gid), "staged");
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
});

test("snapshot commit in a suspended workspace: 403 workspace_read_only from the pre-check; nothing written", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Suspended snapshot"), workspace_id: WSA }), 201).id;
  const c = await connect(pid);
  const body = { source_revision: 1, files: [{ name: "export.json", kind: "json", content: JSON.stringify({ synthetic: true }) }] };
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`);
  try {
    const r = await h.pub(c.tok, "POST", "/publisher/snapshots", { body, idem: uniq("snapshot-key") });
    assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, "workspace_read_only");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}'`)[0].n, 0);
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
});

test("abandon after the creator loses membership, before or during the request: refused, the generation stays staged", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Membership"), workspace_id: WSA }), 201).id;
  const a = await staged(pid);
  const b = await staged(pid);
  const r1 = await during((hd) => abandon(b.tok, b.gid, hd), async () => ok(await bob.req("DELETE", `/api/workspaces/${WSA}/members/${ownerId}`)));
  // Observed (design Unverified 13): the post-change re-check answers 403 scope_mismatch mid-request.
  assert.equal(r1.status, 403, r1.text); assert.equal(r1.json.error.code, "scope_mismatch"); assert.equal(genState(b.gid), "staged");
  // Afterwards livePublisher requires membership, so the token is no longer valid at all.
  const r2 = await abandon(a.tok, a.gid);
  assert.equal(r2.status, 401, r2.text); assert.equal(genState(a.gid), "staged");
  const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
  ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
});

test("abandon after the project is deleted, before or during the request: refused, the generation stays staged", async () => {
  for (const mid of [false, true]) {
    const title = uniq("Deleted");
    const pid = ok(await owner.req("POST", "/api/projects", { title }), 201).id;
    const s = await staged(pid);
    const del = async () => ok(await owner.req("DELETE", `/api/projects/${pid}`, { confirm_title: title }));
    const r = mid ? await during((hd) => abandon(s.tok, s.gid, hd), del) : (await del(), await abandon(s.tok, s.gid));
    // Before: livePublisher's membership gate excludes deleted projects (401). During: the re-check finds no valid
    // destination for the creator (403 scope_mismatch).
    assert.equal(r.status, mid ? 403 : 401, `${mid ? "mid" : "before"}: ${r.text}`);
    assert.equal(genState(s.gid), "staged");
  }
});

const folderOf = (pubId) => sql(`SELECT folder_id FROM publishers WHERE id = '${pubId}'`)[0].folder_id;
const snapshot = (tok, rev, content = JSON.stringify({ synthetic: rev }), headers = {}) =>
  h.pub(tok, "POST", "/publisher/snapshots", { body: { source_revision: rev, files: [{ name: "export.json", kind: "json", content }] }, idem: uniq("snapshot-key"), headers });
// Folder deletion and token supersede have no route that fits inside a pause; they are applied to local D1.
const MID = {
  "destination folder deleted": (pubId) => sql(`DELETE FROM folders WHERE id = '${folderOf(pubId)}'`),
  "token epoch superseded": (pubId) => sql(`UPDATE publishers SET token_epoch = token_epoch + 1 WHERE id = '${pubId}'`),
};

test("abandon: destination folder deleted or token superseded mid-request: refused, the generation stays staged", async () => {
  for (const [label, act] of Object.entries(MID)) {
    const s = await staged("files-own", { destination: "new" });
    const r = await during((hd) => abandon(s.tok, s.gid, hd), async () => act(s.P.publisher_id));
    assert.ok(r.status === 401 || r.status === 403, `${label}: ${r.status} ${r.text}`);
    assert.equal(r.status, label.startsWith("token") ? 401 : 403, label);
    assert.equal(genState(s.gid), "staged", label);
  }
});

test("snapshot commit: destination folder deleted or token superseded mid-request: refused, nothing written", async () => {
  for (const [label, act] of Object.entries(MID)) {
    const c = await connect("files-own", { destination: "new" });
    ok(await snapshot(c.tok, 1), 201);
    const revs = () => sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${c.P.publisher_id}')`)[0].n;
    const r0 = revs();
    const r = await during((hd) => snapshot(c.tok, 2, undefined, hd), async () => act(c.P.publisher_id));
    assert.equal(r.status, label.startsWith("token") ? 401 : 403, `${label}: ${r.text}`);
    assert.equal(revs(), r0, `${label}: no revisions`);
    assert.equal(sql(`SELECT current_source_revision AS v FROM publishers WHERE id = '${c.P.publisher_id}'`)[0].v, 1, `${label}: pointer unchanged`);
  }
});

// Design test 7: list.
test("list: keyset pages in path order, prefix, limit; only this app's live files in its destination", async () => {
  const c = await connect("files-own", { destination: "new" });
  insertFiles(c.P.publisher_id, [
    ...Array.from({ length: 105 }, (_, i) => ({ path: `p/${String(i).padStart(3, "0")}.md` })),
    ...["q/a.json", "q/b.csv", "q/c.html"].map((path) => ({ path, kind: { json: "json", csv: "csv", html: "html" }[path.split(".")[1]], content: path.endsWith(".json") ? "{}" : path.endsWith(".csv") ? "a\r\n1\r\n" : "<p>x</p>" })),
    { path: "q/trashed.md", trashed: true },
    { path: "q/part.json", kind: "json", content: "{}", generationId: "g_synthetic_part" },
    { path: "q/released.md", exportName: null },
    { path: "q/elsewhere.md", folderId: null },
  ]);
  const fld = sql(`SELECT folder_id FROM publishers WHERE id = '${c.P.publisher_id}'`)[0].folder_id;
  ok(await owner.req("POST", "/api/projects/files-own/artifacts", { title: "q/owner.md", body: "owner file", folder_id: fld }), 201);
  const p1 = ok(await files(c.tok, "?prefix=p/"));
  assert.equal(p1.files.length, 100); assert.ok(p1.next_cursor);
  assert.deepEqual(p1.files.map((f) => f.path), Array.from({ length: 100 }, (_, i) => `p/${String(i).padStart(3, "0")}.md`));
  const p2 = ok(await files(c.tok, `?prefix=p/&cursor=${p1.next_cursor}`));
  assert.deepEqual(p2.files.map((f) => f.path), ["p/100.md", "p/101.md", "p/102.md", "p/103.md", "p/104.md"]); assert.equal(p2.next_cursor, null);
  const qf = ok(await files(c.tok, "?prefix=q/"));
  assert.deepEqual(qf.files.map((f) => f.path), ["q/a.json", "q/b.csv", "q/c.html"], "no trashed, generation, released, other-folder or owner rows");
  const item = qf.files[0];
  assert.deepEqual(Object.keys(item).sort(), ["content_type", "created_at", "etag", "file_id", "kind", "path", "preview_url", "revision", "sha256", "size", "updated_at", "web_url"]);
  assert.equal(item.etag, `"${sha("{}")}"`); assert.equal(item.content_type, "application/json; charset=utf-8"); assert.equal(item.revision, 1);
  const small = ok(await files(c.tok, "?prefix=q/&limit=2"));
  assert.equal(small.files.length, 2);
  assert.deepEqual(ok(await files(c.tok, `?prefix=q/&limit=2&cursor=${small.next_cursor}`)).files.map((f) => f.path), ["q/c.html"]);
  const all = ok(await files(c.tok));
  assert.equal(all.files.length, 100, "default limit 100");
  assert.equal(ok(await files(c.tok, `?cursor=${all.next_cursor}`)).files.length, 8, "no prefix: everything listed over two pages");
  for (const bad of ["?prefix=" + "a".repeat(201), "?prefix=a%20b", "?prefix=%C3%A9"]) {
    const r = await files(c.tok, bad);
    assert.equal(r.status, 400, bad); assert.equal(r.json.error.message, "prefix must be at most 200 characters of letters, digits, '.', '_', '-' or '/'");
  }
  for (const bad of ["?cursor=", "?cursor=***", `?cursor=${Buffer.from("a b").toString("base64url")}`, `?cursor=${"A".repeat(300)}`]) {
    const r = await files(c.tok, bad);
    assert.equal(r.status, 400, bad); assert.equal(r.json.error.message, "cursor is not valid");
  }
  for (const bad of ["?limit=0", "?limit=101", "?limit=x"]) assert.equal((await files(c.tok, bad)).status, 400, bad);
});

test("list: snapshot data files are listed; the snapshot manifest is invisible (list and GET)", async () => {
  const c = await connect("files-own");
  const content = JSON.stringify({ synthetic: true });
  ok(await h.pub(c.tok, "POST", "/publisher/snapshots", { body: { source_revision: 1, files: [{ name: "export.json", kind: "json", content }] }, idem: uniq("snapshot-key") }), 201);
  assert.deepEqual(ok(await files(c.tok)).files.map((f) => f.path), ["export.json"]);
  const r = await file(c.tok, "export.json");
  assert.equal(r.status, 200); assert.equal(r.text, content);
  const m = await file(c.tok, "manifest.json");
  assert.equal(m.status, 404, m.text); assert.equal(m.json.error.message, "File not found");
});

// Design tests 8 and 17: reads go through serveContent; never executable; not link-rewritten.
test("read: GET, HEAD, Range 206/416, If-None-Match 304 with the same fixed headers as the 200", async () => {
  const c = await connect("files-own");
  const [md] = insertFiles(c.P.publisher_id, [{ path: "notes/day.md", content: "# Synthetic day\n\nabcdef\n" }]);
  const g = await file(c.tok, "notes/day.md");
  assert.equal(g.status, 200); assert.equal(g.text, "# Synthetic day\n\nabcdef\n");
  assert.equal(g.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(g.headers.get("etag"), `"${md.sha256}"`); assert.equal(g.headers.get("accept-ranges"), "bytes");
  // The runtime compresses for clients that accept gzip (and then drops Content-Length); ask for identity.
  assert.equal((await file(c.tok, "notes/day.md", { "accept-encoding": "identity" })).headers.get("content-length"), String(md.size));
  const hd = await file(c.tok, "notes/day.md", {}, "HEAD");
  assert.equal(hd.status, 200); assert.equal(hd.text, ""); assert.equal(hd.headers.get("content-length"), String(md.size));
  const part = await file(c.tok, "notes/day.md", { range: "bytes=2-8" });
  assert.equal(part.status, 206); assert.equal(part.text, "Synthet"); assert.equal(part.headers.get("content-range"), `bytes 2-8/${md.size}`);
  const suffix = await file(c.tok, "notes/day.md", { range: "bytes=-4" });
  assert.equal(suffix.status, 206); assert.equal(suffix.text, "def\n");
  const bad = await file(c.tok, "notes/day.md", { range: "bytes=999-" });
  assert.equal(bad.status, 416); assert.equal(bad.headers.get("content-range"), `bytes */${md.size}`);
  const nm = await file(c.tok, "notes/day.md", { "if-none-match": `"${md.sha256}"` });
  assert.equal(nm.status, 304); assert.equal(nm.text, "");
  for (const k of FIXED) assert.equal(nm.headers.get(k), g.headers.get(k), `304 ${k} equals the 200's`);
  assert.equal((await file(c.tok, "notes/day.md", { "if-none-match": '"' + "0".repeat(64) + '"' })).status, 200, "a different etag reads");
  for (const inm of ["*", `W/"${md.sha256}"`, `"x", "${md.sha256}"`, `W/"x", W/"${md.sha256}"`]) {
    const r = await file(c.tok, "notes/day.md", { "if-none-match": inm });
    assert.equal(r.status, 304, inm);
    for (const k of FIXED) assert.equal(r.headers.get(k), g.headers.get(k), `${inm} ${k}`);
  }
  assert.equal((await file(c.tok, "notes/day.md", { "if-none-match": 'W/"x", "y"' })).status, 200);
  // Query parameters for other content routes never reach serveContent here.
  const dl = await h.pub(c.tok, "GET", "/app/files/notes/day.md?download=1&rev=7");
  assert.equal(dl.status, 200); assert.equal(dl.headers.get("content-disposition"), g.headers.get("content-disposition"));
  assert.equal((await file(c.tok, "notes/missing.md")).status, 404);
  for (const m of ["POST", "PATCH"]) assert.equal((await h.pub(c.tok, m, "/app/files/notes/day.md")).status, 405, m);
  for (const m of ["PUT", "DELETE", "POST"]) assert.equal((await h.pub(c.tok, m, "/app/files")).status, 405, `${m} on the list`);
  ok(await owner.req("POST", `/api/publishers/${c.P.publisher_id}/revoke`, {}));
  for (const hdrs of [{}, { "if-none-match": `"${md.sha256}"` }, { range: "bytes=0-1" }]) assert.equal((await file(c.tok, "notes/day.md", hdrs)).status, 401, JSON.stringify(hdrs));
  assert.equal((await file(c.tok, "notes/day.md", {}, "HEAD")).status, 401);
  assert.equal((await files(c.tok)).status, 401);
});

test("never executable, and stored content is never link-rewritten (lists still are)", async () => {
  const c = await connect("files-own");
  const link = `http://localhost:${PORT}/p/files-own/a/art_synthetic`;
  const body = JSON.stringify({ web_url: link, files: [{ web_url: link }] });
  const [html, data] = insertFiles(c.P.publisher_id, [
    { path: "page.html", kind: "html", content: "<script>alert(1)</script><p>synthetic</p>" },
    { path: "links.json", kind: "json", content: body },
  ]);
  const r = await file(c.tok, "page.html");
  assert.equal(r.status, 200); assert.equal(r.text, "<script>alert(1)</script><p>synthetic</p>");
  assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(r.headers.get("content-disposition"), /^attachment;/);
  assert.match(r.headers.get("content-security-policy"), /sandbox/); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const j = await file(c.tok, "links.json");
  assert.equal(j.status, 200); assert.equal(j.text, body, "byte-identical");
  assert.equal(j.headers.get("etag"), `"${data.sha256}"`);
  const listed = ok(await files(c.tok)).files.find((f) => f.file_id === html.id);
  assert.doesNotMatch(listed.web_url, /\/p\/files-own\//, "list links use the project's address");
});

// Design test 9 (GET): raw path refusals.
test("raw paths: every non-canonical or invalid path answers 400 invalid_path; nothing outside the root matches", async () => {
  const c = await connect("files-own");
  insertFiles(c.P.publisher_id, [{ path: "b.md" }, { path: "a/b.md" }, { path: "a.md" }]);
  const auth = { authorization: `Bearer ${c.tok}` };
  const N1 = "File path must be 1-8 segments of letters, digits, '.', '_' or '-' (1-64 characters each, not starting with '.'), at most 200 characters, ending in .md, .markdown, .html, .htm, .json or .csv";
  const long = "x/".repeat(98) + "abc.md"; // 202 characters
  const cases = ["a%2Fb.md", "%61.md", ".hidden.md", "a//b.md", "",
    "a".repeat(198) + ".md", long, "1/2/3/4/5/6/7/8/9.md", "a".repeat(62) + ".md/x.md", "%C3%A9.md", "a.txt", "a", "a.", "a/b", "a/.md",
    "x.constructor", "x.toString", "x.__proto__", "x.hasOwnProperty", "constructor"];
  for (const rest of cases) {
    const r = await raw(`/v1/app/files/${rest}`, { headers: auth });
    assert.equal(r.status, 400, `${rest}: ${r.status} ${r.text}`); assert.equal(r.json.error.code, "invalid_path", rest); assert.equal(r.json.error.message, N1);
  }
  // Observed: local workerd resolves dot segments (also %2e%2e) and '\\' in req.url before the Worker sees it
  // (design Unverified 1), so these arrive as their canonical path and answer exactly as that path does. Had the raw
  // form arrived, appFilesRawPath would refuse it (raw path != parsed pathname).
  const normalized = { "/v1/app/files/a/../b.md": "b.md", "/v1/app/files/./a.md": "a.md", "/v1/app/files/a/%2e%2e/b.md": "b.md",
    "/v1/app/files/a/%2E%2E/b.md": "b.md", "/v1/app/files/a\\b.md": "a/b.md", "/v1/./app/files/a.md": "a.md", "/v1/app/./files/a.md": "a.md",
    "/v1/x/../app/files/a.md": "a.md", "/v1/app/files/x/../../b.md": null };
  for (const [path, canonical] of Object.entries(normalized)) {
    const r = await raw(path, { headers: auth });
    if (canonical === null) { assert.equal(r.status, 404, `${path}: ${r.text}`); assert.equal(r.json.error.message, "Not found"); continue; }
    const c0 = await raw(`/v1/app/files/${canonical}`, { headers: auth });
    assert.equal(c0.status, 200);
    assert.deepEqual([r.status, r.text], [c0.status, c0.text], `${path} answers as ${canonical}`);
  }
  assert.equal((await raw("/v1/app/filesX", { headers: auth })).status, 404);
  assert.equal((await raw("/v1/app/files/a.md?x=1#y", { headers: auth })).status, 200, "query is not part of the path");
  const ok64 = "a".repeat(61) + ".md"; // a 64-character segment is allowed
  assert.equal((await raw(`/v1/app/files/${ok64}`, { headers: auth })).status, 404);
  assert.equal((await raw("/v1/app/files/1/2/3/4/5/6/7/8.MD", { headers: auth })).status, 404, "8 segments, extension case-insensitive");
  // Extensions are case-insensitive (design §1): .MD and .Md are valid paths, distinct from a.md.
  for (const p of ["a.MD", "a.Md"]) { const r = await raw(`/v1/app/files/${p}`, { headers: auth }); assert.equal(r.status, 404, p); assert.equal(r.json.error.message, "File not found", p); }
});

test("GET by path never reaches an excluded row: trashed, staged generation part, released, unpublished, other folder, other publisher, other workspace", async () => {
  const c = await connect("files-own", { destination: "new" });
  const other = await connect("files-own", { destination: "new" });
  // A second app whose publisher shares c's destination folder.
  const sameApp = await h.registerApp({ display_name: uniq("Same dest"), redirect_uris: [`https://${uniq("same")}.example.test/cb`], origins: [] });
  const same = await h.connectPublisher(sameApp, { project_id: "files-own", destination: `folder:${folderOf(c.P.publisher_id)}` });
  const wsPid = ok(await bob.req("POST", "/api/projects", { title: uniq("Other ws"), workspace_id: WSA }), 201).id;
  const far = await connect(wsPid);
  insertFiles(c.P.publisher_id, [
    { path: "x/trashed.md", trashed: true },
    { path: "x/part.json", kind: "json", content: "{}", generationId: "g_synthetic_staged" },
    { path: "x/released.md", exportName: null },
    { path: "x/elsewhere.md", folderId: null },
  ]);
  const [unpub] = insertFiles(c.P.publisher_id, [{ path: "x/unpublished.md" }]);
  sql(`UPDATE artifacts SET head_rev = 0 WHERE id = '${unpub.id}'`);
  insertFiles(same.publisher_id, [{ path: "x/sibling.md" }]);
  insertFiles(other.P.publisher_id, [{ path: "x/other.md" }]);
  insertFiles(far.P.publisher_id, [{ path: "x/far.md" }]);
  for (const p of ["x/trashed.md", "x/part.json", "x/released.md", "x/elsewhere.md", "x/unpublished.md", "x/sibling.md", "x/other.md", "x/far.md"]) {
    for (const method of ["GET", "HEAD"]) {
      const r = await file(c.tok, p, {}, method);
      assert.equal(r.status, 404, `${method} ${p}`);
    }
  }
  assert.deepEqual(ok(await files(c.tok, "?prefix=x/")).files, []);
  assert.equal((await file(same.access_token, "x/sibling.md")).status, 200, "its own publisher reads it");
});

test("reads of content stored in R2 (written by the snapshot route): Range, HEAD, 304", async () => {
  const c = await connect("files-own");
  const content = JSON.stringify({ synthetic: "r2 content", n: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  ok(await snapshot(c.tok, 1, content), 201);
  const row = sql(`SELECT r.body, r.body_key, r.sha256 FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE a.publisher_id = '${c.P.publisher_id}' AND a.export_name = 'export.json'`)[0];
  assert.equal(row.body, null); assert.ok(row.body_key, "stored as an object, not inline");
  const g = await file(c.tok, "export.json");
  assert.equal(g.status, 200); assert.equal(g.text, content);
  const r = await file(c.tok, "export.json", { range: "bytes=1-9" });
  assert.equal(r.status, 206); assert.equal(r.text, content.slice(1, 10)); assert.equal(r.headers.get("content-range"), `bytes 1-9/${Buffer.byteLength(content)}`);
  const hd = await file(c.tok, "export.json", { "accept-encoding": "identity" }, "HEAD");
  assert.equal(hd.status, 200); assert.equal(hd.text, ""); assert.equal(hd.headers.get("content-length"), String(Buffer.byteLength(content)));
  const nm = await file(c.tok, "export.json", { "if-none-match": `"${row.sha256}"` });
  assert.equal(nm.status, 304);
  for (const k of FIXED) assert.equal(nm.headers.get(k), g.headers.get(k), k);
});

test("reads with a superseded token (owner-approved resume) answer 401", async () => {
  const c = await connect("files-own");
  insertFiles(c.P.publisher_id, [{ path: "s.md" }]);
  assert.equal((await file(c.tok, "s.md")).status, 200);
  const R = await h.connectPublisher(c.app, { resume: c.P.publisher_id });
  assert.equal(R.publisher_id, c.P.publisher_id);
  for (const r of [await file(c.tok, "s.md"), await files(c.tok), await file(c.tok, "s.md", {}, "HEAD")]) assert.equal(r.status, 401);
  assert.equal((await file(R.access_token, "s.md")).status, 200);
});

// Design tests 10 (GET) and 12.
test("the path never chooses the destination; publishers never see each other's or the owner's files", async () => {
  const c1 = await connect("files-own", { destination: "new" });
  const c2 = await connect("files-own", { destination: "new" });
  const fld1 = sql(`SELECT folder_id FROM publishers WHERE id = '${c1.P.publisher_id}'`)[0].folder_id;
  insertFiles(c1.P.publisher_id, [{ path: "mine.md", content: "synthetic one" }, { path: "moved.md", folderId: null }]);
  insertFiles(c2.P.publisher_id, [{ path: "theirs.md" }]);
  ok(await owner.req("POST", "/api/projects/files-own/artifacts", { title: "owner.md", body: "owner text", folder_id: fld1 }), 201);
  assert.deepEqual(ok(await files(c1.tok)).files.map((f) => f.path), ["mine.md"]);
  assert.deepEqual(ok(await files(c2.tok)).files.map((f) => f.path), ["theirs.md"]);
  assert.equal((await file(c2.tok, "mine.md")).status, 404, "same path, other publisher");
  assert.equal((await file(c1.tok, "theirs.md")).status, 404);
  assert.equal((await file(c1.tok, "owner.md")).status, 404, "owner files are invisible");
  assert.equal((await file(c1.tok, "moved.md")).status, 404, "a row outside the destination folder is invisible");
  const auth = { authorization: `Bearer ${c2.tok}` };
  // These resolve (in the local runtime, before the Worker) to /v1/app/mine.md: not an App Files route at all.
  for (const p of ["../mine.md", "%2e%2e/mine.md"]) {
    const r = await raw(`/v1/app/files/${p}`, { headers: auth });
    assert.equal(r.status, 404, p); assert.doesNotMatch(r.text, /synthetic one/);
  }
  // Another publisher's id in the path is just a path.
  assert.equal((await file(c2.tok, `${c1.P.publisher_id}/mine.md`)).status, 404);
});

// Design test 13 (reads): liveness and authorization on every read.
test("reads with a disabled client keep working (list, GET, Range, HEAD, 304); refresh and /me too", async () => {
  const c = await connect("files-own");
  const [f] = insertFiles(c.P.publisher_id, [{ path: "kept.md", content: "synthetic kept" }]);
  ok(await owner.req("POST", `/api/app-clients/${c.app.app_client_id}/disable`, {}));
  assert.deepEqual(ok(await files(c.tok)).files.map((x) => x.path), ["kept.md"]);
  assert.equal((await file(c.tok, "kept.md")).status, 200);
  assert.equal((await file(c.tok, "kept.md", { range: "bytes=0-2" })).status, 206);
  assert.equal((await file(c.tok, "kept.md", {}, "HEAD")).status, 200);
  assert.equal((await file(c.tok, "kept.md", { "if-none-match": `"${f.sha256}"` })).status, 304);
  assert.equal((await h.pub(c.tok, "GET", "/publisher/me")).status, 200);
  const t = await h.token({ grant_type: "refresh_token", refresh_token: c.P.refresh_token, client_id: c.app.client_id });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal((await files(t.body.access_token)).status, 200);
});

test("reads: suspended workspace 200; deleted destination folder 403; creator removed or project deleted 401", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Reads"), workspace_id: WSA }), 201).id;
  const c = await connect(pid);
  const d = await connect(pid, { destination: "new" });
  insertFiles(c.P.publisher_id, [{ path: "s.md" }]);
  insertFiles(d.P.publisher_id, [{ path: "f.md" }]);
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`);
  try {
    assert.equal((await files(c.tok)).status, 200); assert.equal((await file(c.tok, "s.md")).status, 200);
  } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
  // No route deletes folders yet; the destination disappearing is simulated in local D1.
  const fld = sql(`SELECT folder_id FROM publishers WHERE id = '${d.P.publisher_id}'`)[0].folder_id;
  sql(`DELETE FROM folders WHERE id = '${fld}'`);
  for (const r of [await files(d.tok), await file(d.tok, "f.md")]) { assert.equal(r.status, 403, r.text); assert.equal(r.json.error.code, "scope_mismatch"); }
  ok(await bob.req("DELETE", `/api/workspaces/${WSA}/members/${ownerId}`));
  try {
    for (const r of [await files(c.tok), await file(c.tok, "s.md")]) assert.equal(r.status, 401, r.text);
  } finally {
    const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
    ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  }
  const title = uniq("Deleted reads");
  const pid2 = ok(await owner.req("POST", "/api/projects", { title }), 201).id;
  const e = await connect(pid2);
  insertFiles(e.P.publisher_id, [{ path: "e.md" }]);
  ok(await owner.req("DELETE", `/api/projects/${pid2}`, { confirm_title: title }));
  assert.equal((await files(e.tok)).status, 401); assert.equal((await file(e.tok, "e.md")).status, 401);
});

// Design test 14: other credentials.
test("other credentials: cookies 400, an API key 401, an MCP OAuth token 401, no token 401", async () => {
  const c = await connect("files-own");
  insertFiles(c.P.publisher_id, [{ path: "cred.md" }]);
  const cookie = await h.pub(c.tok, "GET", "/app/files/cred.md", { headers: { cookie: "al_session=synthetic" } });
  assert.equal(cookie.status, 400, cookie.text); assert.equal(cookie.json.error.code, "invalid_request");
  const apiKey = ok(await owner.req("POST", "/api/api-keys", { label: "files key", projects: [{ project_id: "files-own", access: "read_write" }] }), 201).secret;
  const agent = await h.connectMcpAgent({ "files-own": "write" }, { clientName: "Files agent" });
  for (const [label, tok] of [["api key", apiKey], ["mcp token", agent.access_token], ["none", null]]) {
    for (const path of ["/app/files", "/app/files/cred.md"]) {
      const r = await h.pub(tok, "GET", path);
      assert.equal(r.status, 401, `${label} ${path}: ${r.text}`);
    }
  }
});

// Design test 20: CORS.
test("CORS: preflight lists the App Files methods and headers; ETag is exposed; an unregistered origin is refused", async () => {
  const c = await connect("files-own", { origins: [ORIGIN] });
  insertFiles(c.P.publisher_id, [{ path: "cors.md" }]);
  const pre = await fetch(`${h.api}/app/files/cors.md`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,if-match" } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, HEAD, PUT, DELETE, POST");
  assert.equal(pre.headers.get("access-control-allow-headers"), "Authorization, Content-Type, Idempotency-Key, If-Match, If-None-Match, Range, X-Content-SHA256");
  assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  const listPre = await fetch(`${h.api}/app/files`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "GET" } });
  assert.equal(listPre.status, 204);
  const g = await file(c.tok, "cors.md", { origin: ORIGIN });
  assert.equal(g.status, 200); assert.equal(g.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(g.headers.get("access-control-expose-headers"), "WWW-Authenticate, Retry-After, X-Request-Id, ETag, Content-Range, Content-Length, Accept-Ranges");
  const evil = await fetch(`${h.api}/app/files/cors.md`, { method: "OPTIONS", headers: { origin: "https://evil.example.test", "access-control-request-method": "GET" } });
  assert.equal(evil.status, 403);
  const e2 = await file(c.tok, "cors.md", { origin: "https://evil.example.test" });
  assert.equal(e2.status, 200); assert.equal(e2.headers.get("access-control-allow-origin"), null);
});

/** Held body slots right now, from the x-test-slots-in-use header on any App Files answer. */
const slotsInUse = async (tok) => Number((await files(tok)).headers.get("x-test-slots-in-use"));
/**
 * A raw PUT that sends its headers and `send` body bytes of a declared `length`, then waits. Returns
 * { socket, response } where response resolves with the raw answer text (or "" if the socket closes first).
 */
function partialPut(tok, path, { length, send, headers = {} }) {
  const socket = netConnect(PORT, "127.0.0.1");
  const all = { Authorization: `Bearer ${tok}`, "Content-Type": "text/markdown", "Content-Length": String(length), "Idempotency-Key": uniq("partial-key"),
    ...("If-Match" in headers ? {} : { "If-None-Match": "*" }), ...headers };
  const head = [`PUT /v1/app/files/${path} HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, ...Object.entries(all).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
  let text = "";
  // Resolves with the first complete answer (headers plus Content-Length bytes), or what arrived when the socket closed.
  const complete = () => {
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) return false;
    const len = /\r\ncontent-length: *(\d+)/i.exec(text.slice(0, end));
    return len ? Buffer.byteLength(text.slice(end + 4)) >= Number(len[1]) : /\r\n0\r\n\r\n$/.test(text);
  };
  const response = new Promise((resolve) => {
    socket.on("data", (d) => { text += d; if (complete()) resolve(text); });
    socket.on("close", () => resolve(text)); socket.on("error", () => {});
  });
  socket.write(head);
  if (send) socket.write(Buffer.alloc(send, 0x61));
  return { socket, response };
}

// Design §3a probe gate (commit 3 starts here): a client that disconnects mid-body must not keep its slot. The slot
// is released by withSlot's `finally`, which runs once the idle deadline (5 s) cancels the stalled read.
test("probe gate: a PUT whose client disconnects mid-body frees its slot within the idle deadline + 2 s", async () => {
  const c = await connect("files-own");
  assert.equal(await slotsInUse(c.tok), 0);
  const x = partialPut(c.tok, "probe/half.md", { length: 1048576, send: 524288 });
  const t0 = Date.now();
  let held = 0;
  while (Date.now() - t0 < 3000 && !(held = await slotsInUse(c.tok))) await new Promise((r) => setTimeout(r, 50));
  assert.equal(held, 1, "the PUT holds one slot while its body is arriving");
  const tDisconnect = Date.now();
  x.socket.destroy();
  let freedAfter = null;
  while (Date.now() - tDisconnect < 7000) {
    if (await slotsInUse(c.tok) === 0) { freedAfter = Date.now() - tDisconnect; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(JSON.stringify({ probe: "disconnect", held_ms_before_disconnect: tDisconnect - t0, freed_after_ms: freedAfter }));
  assert.ok(freedAfter !== null, "slot still held 7 s after the client disconnected");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}'`)[0].n, 0, "nothing written");
});

// ---- PUT (design commit 3) ----
const TYPE = { md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", json: "application/json", csv: "text/csv" };
const typeOf = (path) => TYPE[path.split(".").pop().toLowerCase()];
/** PUT a file. opts: { create: true } (If-None-Match: *) or { match: '"sha"' | "rev:N" }, key, type, headers, body. */
async function put(tok, path, body, { create, match, key, type = typeOf(path), headers = {}, method = "PUT" } = {}) {
  const hd = { "content-type": type, "idempotency-key": key === undefined ? uniq("put-key") : key, ...create ? { "if-none-match": "*" } : {}, ...match ? { "if-match": match } : {}, ...headers };
  for (const [k, v] of Object.entries(hd)) if (v === null || v === undefined) delete hd[k];
  if (tok) hd.authorization = `Bearer ${tok}`;
  const r = await fetch(`${h.api}/app/files/${path}`, { method, headers: hd, body });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
const counters = (pubId) => { const c = sql(`SELECT app_files_created AS f, app_revisions_written AS r, app_bytes_written AS b FROM publishers WHERE id = '${pubId}'`)[0]; return [c.f, c.r, c.b]; };
const setCounters = (pubId, f, r, b) => sql(`UPDATE publishers SET app_files_created = ${f}, app_revisions_written = ${r}, app_bytes_written = ${b} WHERE id = '${pubId}'`);
const appRows = (pubId) => sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${pubId}'`)[0].n;
const revCount = (pubId) => sql(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${pubId}')`)[0].n;
const auditCount = (pubId) => sql(`SELECT COUNT(*) AS n FROM audits WHERE actor_id = (SELECT principal_id FROM publishers WHERE id = '${pubId}')`)[0].n;
const err = (r, status, code, message) => {
  assert.equal(r.status, status, r.text); assert.equal(r.json.error.code, code);
  if (message !== undefined) assert.equal(r.json.error.message, message);
};
const N = {
  N3: "Content-Type does not match the file extension",
  N4: "PUT and DELETE need If-Match (an ETag or rev:N), or If-None-Match: * to create",
  N5: "If-Match does not match the file's current version",
  N6: "A file already exists at this path",
  N7: "No file exists at this path",
  N8: "If-Match must be one quoted SHA-256 ETag or rev:N; If-None-Match must be *; not both",
  N9: "X-Content-SHA256 must be 64 lowercase hex chars",
  N12: "This server is receiving as many files as it can; retry shortly with the same Idempotency-Key",
  N14: "A file sent to this API can be at most 1 MiB (1,048,576 bytes)",
  N15: "The request body arrived too slowly; send it again with the same Idempotency-Key",
  N16: "This workspace or its owner is already sending 2 files to this server; wait for one to finish",
};

// Design test 1.
test("PUT create: 201, etag, the bytes read back as text/plain with nosniff and a sandbox CSP, D1 columns, counters (1, 1, size)", async () => {
  const c = await connect("files-own", { destination: "new" });
  const body = "# Synthetic note\n\n<script>alert(1)</script>\n";
  const r = await put(c.tok, "notes/day.md", body, { create: true });
  assert.equal(r.status, 201, r.text);
  const f = r.json.file;
  assert.deepEqual(Object.keys(f).sort(), ["etag", "file_id", "kind", "path", "revision", "sha256", "size"]);
  assert.deepEqual([f.path, f.kind, f.revision, f.sha256, f.size], ["notes/day.md", "markdown", 1, sha(body), Buffer.byteLength(body)]);
  assert.equal(r.headers.get("etag"), `"${sha(body)}"`); assert.equal(f.etag, `"${sha(body)}"`);
  const g = await file(c.tok, "notes/day.md");
  assert.equal(g.text, body); assert.equal(g.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(g.headers.get("x-content-type-options"), "nosniff"); assert.match(g.headers.get("content-security-policy"), /sandbox/);
  const row = sql(`SELECT a.project_id, a.folder_id, a.folder, a.title, a.export_name, a.publisher_id, a.generation_id, a.kind, r.body, r.body_key, r.via_kind, r.mime
    FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE a.id = '${f.file_id}'`)[0];
  assert.deepEqual({ ...row, body_key: !!row.body_key }, { project_id: "files-own", folder_id: folderOf(c.P.publisher_id), folder: "", title: "notes/day.md", export_name: "notes/day.md",
    publisher_id: c.P.publisher_id, generation_id: null, kind: "markdown", body: null, body_key: true, via_kind: "publisher", mime: "text/markdown" });
  assert.deepEqual(counters(c.P.publisher_id), [1, 1, Buffer.byteLength(body)]);
  // Each kind.
  for (const [path, content] of [["d.json", '{"a":[1,2]}'], ["t.csv", "a,b\r\n1,2\r\n"], ["p.html", "<p>synthetic</p>"], ["x.markdown", "m"], ["y.htm", "<b>y</b>"]]) {
    const x = await put(c.tok, path, content, { create: true });
    assert.equal(x.status, 201, `${path} ${x.text}`);
    assert.equal((await file(c.tok, path)).text, content);
  }
  assert.deepEqual(counters(c.P.publisher_id), [6, 6, Buffer.byteLength(body) + 11 + 10 + 16 + 1 + 8]);
});

// Design test 2.
test("PUT replace: etag and rev:N forms; stale 412 with current_*; early and late unchanged; ABA is 412", async () => {
  const c = await connect("files-own");
  const v1 = "version one", v2 = "version two", v3 = "version three";
  const a = await put(c.tok, "r.md", v1, { create: true });
  const b = await put(c.tok, "r.md", v2, { match: `"${sha(v1)}"` });
  assert.equal(b.status, 200, b.text); assert.equal(b.json.file.revision, 2); assert.equal(b.json.file.file_id, a.json.file.file_id);
  const c3 = await put(c.tok, "r.md", v3, { match: "rev:2" });
  assert.equal(c3.status, 200, c3.text); assert.equal(c3.json.file.revision, 3);
  assert.deepEqual(counters(c.P.publisher_id), [1, 3, v1.length + v2.length + v3.length]);
  // The quoted form "rev:N" (HTTP clients quote entity tags) is accepted like rev:N.
  err(await put(c.tok, "r.md", "x", { match: '"rev:2"' }), 412, "precondition_failed", N.N5);
  const st = await put(c.tok, "r.md", "x", { match: `"${sha(v1)}"` });
  err(st, 412, "precondition_failed", N.N5); assert.equal(st.json.error.current_revision, 3); assert.equal(st.json.error.current_etag, `"${sha(v3)}"`);
  // ABA: the bytes return to an earlier version (A -> B -> A). The etag then matches the head again (the head holds A),
  // but rev:1 is judged by revision and is stale: 412 against head 4.
  const back = await put(c.tok, "r.md", v1, { match: "rev:3" });
  assert.equal(back.status, 200, back.text); assert.equal(back.json.file.revision, 4); assert.equal(back.json.file.etag, a.json.file.etag);
  const aba = await put(c.tok, "r.md", "x", { match: "rev:1" });
  err(aba, 412, "precondition_failed", N.N5); assert.equal(aba.json.error.current_revision, 4);
  const byTag = await put(c.tok, "r.md", "after aba", { match: a.json.file.etag });
  assert.equal(byTag.status, 200, "the first etag names the current bytes again"); assert.equal(byTag.json.file.revision, 5);
  ok(await put(c.tok, "r.md", v3, { match: "rev:5" }), 200);
  const revs = revCount(c.P.publisher_id), cnt = counters(c.P.publisher_id);
  // Early unchanged: a matching X-Content-SHA256 answers before any byte is read, even at a cap.
  setCounters(c.P.publisher_id, cnt[0], 100000, cnt[2]);
  const x = partialPut(c.tok, "r.md", { length: v3.length, send: 0, headers: { "If-Match": "rev:6", "X-Content-SHA256": sha(v3) } });
  const early = await Promise.race([x.response, new Promise((r) => setTimeout(() => r(null), 4000))]);
  x.socket.destroy();
  assert.ok(early && /^HTTP\/1\.1 200/.test(early), `early unchanged answered without the body: ${early?.slice(0, 200)}`);
  assert.match(early, /"unchanged":true/);
  setCounters(c.P.publisher_id, ...cnt);
  // Late unchanged: same bytes without the header; nothing written.
  const late = await put(c.tok, "r.md", v3, { match: '"rev:6"' });
  assert.equal(late.status, 200, late.text); assert.equal(late.json.unchanged, true); assert.equal(late.json.file.revision, 6);
  assert.equal(revCount(c.P.publisher_id), revs); assert.deepEqual(counters(c.P.publisher_id), cnt);
  // Late identical at a cap without the header: refused like any write.
  setCounters(c.P.publisher_id, cnt[0], 100000, cnt[2]);
  const capped = await put(c.tok, "r.md", v3, { match: "rev:6" });
  err(capped, 413, "quota_exceeded"); assert.equal(capped.json.error.max_revisions, 100000);
  setCounters(c.P.publisher_id, ...cnt);
});

// Design test 3.
test("PUT preconditions: N6 on create over a file, N4 without one, N8 malformed or both, N7 replace of nothing", async () => {
  const c = await connect("files-own");
  await put(c.tok, "p.md", "x", { create: true });
  err(await put(c.tok, "p.md", "y", { create: true }), 412, "precondition_failed", N.N6);
  err(await put(c.tok, "p.md", "y", {}), 428, "precondition_required", N.N4);
  for (const hd of [{ "if-match": "rev:0" }, { "if-match": "W/\"" + sha("x") + "\"" }, { "if-match": sha("x") }, { "if-match": "*" }, { "if-none-match": `"${sha("x")}"` },
    { "if-match": "rev:1", "if-none-match": "*" }, { "if-match": `"${sha("x")}", "${sha("y")}"` }])
    err(await put(c.tok, "p.md", "y", { headers: hd }), 400, "invalid_input", N.N8);
  err(await put(c.tok, "nothing.md", "y", { match: "rev:1" }), 412, "precondition_failed", N.N7);
  err(await put(c.tok, "p.md", "y", { create: true, key: null }), 400, "idempotency_key_required");
  err(await put(c.tok, "manifest.json", "{}", { create: true }), 400, "invalid_input", "manifest.json is reserved for the server");
  assert.equal(appRows(c.P.publisher_id), 1);
});

// Design test 4.
test("PUT kinds and content: 422 invalid content, N3 mismatched type, 415 other types, 400 kind change, strict UTF-8, X-Content-SHA256", async () => {
  const c = await connect("files-own");
  err(await put(c.tok, "bad.json", "{not json", { create: true }), 422, "invalid_content");
  err(await put(c.tok, "bad.csv", 'a,"b\r\n', { create: true }), 422, "invalid_content");
  err(await put(c.tok, "a.md", "x", { create: true, type: "application/json" }), 415, "unsupported_type", N.N3);
  err(await put(c.tok, "a.json", "{}", { create: true, type: "text/csv" }), 415, "unsupported_type", N.N3);
  for (const type of ["image/png", "application/octet-stream", "text/plain", "text/markdown; charset=latin-1", null])
    err(await put(c.tok, "a.md", "x", { create: true, type }), 415, "unsupported_type", "Allowed: text/markdown, text/html, application/json, text/csv");
  assert.equal((await put(c.tok, "ok.md", "x", { create: true, type: "text/markdown; charset=UTF-8" })).status, 201);
  const utf = await put(c.tok, "u.md", Buffer.from([0x61, 0xff, 0xfe]), { create: true });
  err(utf, 422, "invalid_content"); assert.match(utf.json.error.message, /UTF-8/);
  err(await put(c.tok, "h.md", "x", { create: true, headers: { "x-content-sha256": "ABC" } }), 400, "invalid_input", N.N9);
  err(await put(c.tok, "h.md", "x", { create: true, headers: { "x-content-sha256": sha("y") } }), 422, "integrity_mismatch");
  assert.equal((await put(c.tok, "h.md", "x", { create: true, headers: { "x-content-sha256": sha("x") } })).status, 201);
  // A snapshot data file keeps its kind; a replace with another kind's content is refused by validation (422).
  ok(await snapshot(c.tok, 1, '{"a":1}'), 201);
  const snap = await put(c.tok, "export.json", '{"a":2}', { match: `"${sha('{"a":1}')}"` });
  assert.equal(snap.status, 200, "snapshot data files are writable");
  assert.equal(appRows(c.P.publisher_id), 4, "ok.md, h.md, export.json, manifest.json");
});

// Design test 5 a-c, e, f.
test("PUT replay: create, replace and capped retries replay; a different body or path is 422; a later write does not change the replay", async () => {
  const c = await connect("files-own");
  const k1 = uniq("replay-key");
  const a = await put(c.tok, "r.md", "one", { create: true, key: k1 });
  const a2 = await put(c.tok, "r.md", "one", { create: true, key: k1 });
  assert.equal(a2.status, 201, a2.text); assert.equal(a2.json.idempotent_replay, true); assert.deepEqual(a2.json.file, a.json.file);
  const k2 = uniq("replay-key");
  const b = await put(c.tok, "r.md", "two", { match: `"${sha("one")}"`, key: k2 });
  assert.equal(b.status, 200);
  const later = await put(c.tok, "r.md", "three", { match: "rev:2" });
  assert.equal(later.status, 200);
  const b2 = await put(c.tok, "r.md", "two", { match: `"${sha("one")}"`, key: k2 });
  assert.equal(b2.status, 200, b2.text); assert.equal(b2.json.idempotent_replay, true); assert.deepEqual(b2.json.file, b.json.file, "the original answer, not the later state");
  err(await put(c.tok, "r.md", "other", { create: true, key: k1 }), 422, "idempotency_key_reused");
  err(await put(c.tok, "s.md", "one", { create: true, key: k1 }), 422, "idempotency_key_reused");
  // (c) the first write fills the revision cap; its retry replays instead of 413.
  const cnt = counters(c.P.publisher_id);
  setCounters(c.P.publisher_id, cnt[0], 99999, cnt[2]);
  const k3 = uniq("replay-key");
  const full = await put(c.tok, "r.md", "four", { match: "rev:3", key: k3 });
  assert.equal(full.status, 200, full.text); assert.equal(counters(c.P.publisher_id)[1], 100000);
  const again = await put(c.tok, "r.md", "four", { match: "rev:3", key: k3 });
  assert.equal(again.status, 200, again.text); assert.equal(again.json.idempotent_replay, true);
  err(await put(c.tok, "r.md", "five", { match: "rev:4" }), 413, "quota_exceeded");
});

test("PUT replay (g): a record pruned after the record check continues as a new request with the same bytes, received once", async () => {
  const c = await connect("files-own");
  const k = uniq("pruned-key");
  ok(await put(c.tok, "g.md", "first", { create: true, key: k }), 201);
  const b = h.pauseBarrier();
  const pending = put(c.tok, "g.md", "first", { create: true, key: k, headers: { "x-test-pause-after-record-check-ms": "3000", "x-test-pause-tag": b.tag } });
  await b.entered;
  sql(`DELETE FROM idempotency WHERE key = '${k}'`);
  const r = await pending;
  // As a new request, the create meets the existing file: N6 (new-request checks apply), and one slot was used.
  err(r, 412, "precondition_failed", N.N6);
  assert.equal(await slotsInUse(c.tok), 0);
  assert.equal(appRows(c.P.publisher_id), 1);
});

// Design tests 9, 10, 11 and 12 (writes).
test("PUT paths: raw path refusals write nothing; case and file/folder conflicts 409; generation rows 409; publishers are isolated", async () => {
  const c = await connect("files-own", { destination: "new" });
  const auth = { authorization: `Bearer ${c.tok}`, "content-type": "text/markdown", "if-none-match": "*", "idempotency-key": uniq("raw-key") };
  for (const p of ["a%2Fb.md", "%61.md", ".h.md", "a//b.md", "x.constructor", "a.txt"]) {
    const r = await raw(`/v1/app/files/${p}`, { method: "PUT", headers: auth });
    assert.equal(r.status, 400, p); assert.equal(r.json.error.code, "invalid_path");
  }
  const dot = await raw("/v1/app/files/x/../dot.md", { method: "PUT", headers: auth });
  assert.ok([201, 400].includes(dot.status), `normalized PUT ${dot.status}`);
  if (dot.status === 201) assert.equal(dot.json.file.path, "dot.md", "a resolved path writes only inside the destination");
  for (const r of sql(`SELECT project_id, folder_id FROM artifacts WHERE publisher_id = '${c.P.publisher_id}'`)) assert.deepEqual(r, { project_id: "files-own", folder_id: folderOf(c.P.publisher_id) });
  ok(await put(c.tok, "Notes/A.md", "x", { create: true }), 201);
  for (const p of ["notes/a.md", "NOTES/A.MD", "Notes/A.md/b.md", "Notes"]) {
    const r = await put(c.tok, p.includes(".") ? p : `${p}.md`, "y", { create: true });
    if (p === "Notes") { assert.equal(r.status, 201, "Notes.md is a different path"); continue; }
    err(r, 409, "path_conflict");
  }
  err(await put(c.tok, "Notes.md/x.md", "y", { create: true }), 409, "path_conflict", "This path conflicts with another file of this app (the same path in another case, a file where a folder is needed, or a reserved export file)");
  insertFiles(c.P.publisher_id, [{ path: "gen-part.json", kind: "json", content: "{}", generationId: "g_synthetic_part" }]);
  const partSha = sql(`SELECT r.sha256 FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE a.export_name = 'gen-part.json'`)[0].sha256;
  err(await put(c.tok, "gen-part.json", "{}", { create: true }), 409, "path_conflict");
  err(await put(c.tok, "gen-part.json", '{"b":1}', { match: "rev:1" }), 409, "path_conflict");
  assert.equal(sql(`SELECT r.sha256 FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE a.export_name = 'gen-part.json'`)[0].sha256, partSha, "the part is unchanged");
  // Another publisher: same path is its own file; the first one's etag means nothing to it.
  const d = await connect("files-own");
  const mine = await put(c.tok, "shared.md", "c's", { create: true });
  const theirs = await put(d.tok, "shared.md", "d's", { create: true });
  assert.equal(theirs.status, 201); assert.notEqual(theirs.json.file.file_id, mine.json.file.file_id);
  err(await put(d.tok, "Notes/A.md", "z", { match: `"${sha("x")}"` }), 412, "precondition_failed", N.N7);
  assert.equal((await file(c.tok, "shared.md")).text, "c's");
});

// Design test 13 (writes).
test("PUT liveness: revoked 401; disabled client 401 (reads continue); suspended 403 workspace_read_only; folder deleted 403; nothing written", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Put live"), workspace_id: WSA }), 201).id;
  const c = await connect(pid, { destination: "new" });
  ok(await put(c.tok, "a.md", "x", { create: true }), 201);
  sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`);
  try { err(await put(c.tok, "b.md", "x", { create: true }), 403, "workspace_read_only"); }
  finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
  ok(await owner.req("POST", `/api/app-clients/${c.app.app_client_id}/disable`, {}));
  err(await put(c.tok, "b.md", "x", { create: true }), 401, "unauthenticated");
  assert.equal((await file(c.tok, "a.md")).status, 200);
  const d = await connect(pid, { destination: "new" });
  sql(`DELETE FROM folders WHERE id = '${folderOf(d.P.publisher_id)}'`);
  err(await put(d.tok, "b.md", "x", { create: true }), 403, "scope_mismatch");
  const e = await connect(pid);
  ok(await owner.req("POST", `/api/publishers/${e.P.publisher_id}/revoke`, {}));
  err(await put(e.tok, "b.md", "x", { create: true }), 401, "publisher_revoked");
  assert.deepEqual([appRows(c.P.publisher_id), appRows(d.P.publisher_id), appRows(e.P.publisher_id)], [1, 0, 0]);
});

test("PUT in flight: client disabled, revoked, folder deleted, token superseded or workspace suspended during the pause: refused, nothing written", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Put mid"), workspace_id: WSA }), 201).id;
  const cases = {
    "client disabled": [401, (c) => owner.req("POST", `/api/app-clients/${c.app.app_client_id}/disable`, {})],
    "publisher revoked": [401, (c) => owner.req("POST", `/api/publishers/${c.P.publisher_id}/revoke`, {})],
    "destination folder deleted": [403, (c) => MID["destination folder deleted"](c.P.publisher_id)],
    "token epoch superseded": [401, (c) => MID["token epoch superseded"](c.P.publisher_id)],
    "workspace suspended": [403, () => sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`)],
  };
  for (const [label, [status, act]] of Object.entries(cases)) {
    const c = await connect(pid, { destination: "new" });
    try {
      const r = await during((hd) => put(c.tok, "mid.md", "x", { create: true, headers: hd }), async () => act(c));
      assert.equal(r.status, status, `${label}: ${r.text}`);
      assert.equal(appRows(c.P.publisher_id), 0, label); assert.deepEqual(counters(c.P.publisher_id), [0, 0, 0], label);
    } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
  }
});

// Design test 15.
test("PUT size: 1 MiB accepted, 1 MiB + 1 refused (N14) declared and chunked; understated length; caps and storage refuse before the body", async () => {
  const c = await connect("files-own");
  const max = "a".repeat(1048576);
  assert.equal((await put(c.tok, "max.md", max, { create: true })).status, 201);
  err(await put(c.tok, "over.md", max + "a", { create: true }), 413, "file_too_large", N.N14);
  const chunked = new ReadableStream({ start(ctl) { ctl.enqueue(Buffer.from(max)); ctl.enqueue(Buffer.from("a")); ctl.close(); } });
  const ch = await fetch(`${h.api}/app/files/over2.md`, { method: "PUT", duplex: "half", body: chunked,
    headers: { authorization: `Bearer ${c.tok}`, "content-type": "text/markdown", "if-none-match": "*", "idempotency-key": uniq("chunk-key") } });
  const chj = await ch.json();
  assert.equal(ch.status, 413); assert.equal(chj.error.message, N.N14);
  // Understated Content-Length: more bytes than declared.
  const x = partialPut(c.tok, "under.md", { length: 10, send: 0 });
  x.socket.write("0123456789ABCDEFGHIJ");
  const ans = await Promise.race([x.response, new Promise((r) => setTimeout(() => r(""), 6000))]);
  x.socket.destroy();
  console.log(JSON.stringify({ understated: ans.split("\r\n")[0] }));
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}' AND export_name = 'under.md' AND trashed_at IS NULL`)[0].n <= 1, true);
  const under = sql(`SELECT r.size FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE a.publisher_id = '${c.P.publisher_id}' AND a.export_name = 'under.md'`);
  if (under.length) assert.equal(under[0].size, 10, "only the declared bytes were taken");
  // At a cap, a slow body is refused before it is read; no audit is written.
  setCounters(c.P.publisher_id, 10000, 5, 5);
  const audits = auditCount(c.P.publisher_id);
  const slow = partialPut(c.tok, "capped.md", { length: 1000, send: 0 });
  const capAns = await Promise.race([slow.response, new Promise((r) => setTimeout(() => r(""), 4000))]);
  slow.socket.destroy();
  assert.match(capAns, /^HTTP\/1\.1 413/); assert.match(capAns, /"max_files":10000/);
  assert.equal(auditCount(c.P.publisher_id), audits);
  setCounters(c.P.publisher_id, 1, 1, 1048576);
  // Workspace storage full: 402 before the body is read.
  const pid = ok(await owner.req("POST", "/api/workspaces", { name: uniq("Tiny") }), 201).id;
  sql(`UPDATE workspaces SET plan = 'tiny' WHERE id = '${pid}'`);
  const tp = ok(await owner.req("POST", "/api/projects", { title: uniq("Tiny project"), workspace_id: pid }), 201).id;
  const t = await connect(tp);
  const full = partialPut(t.tok, "big.md", { length: 70000, send: 0 });
  const fullAns = await Promise.race([full.response, new Promise((r) => setTimeout(() => r(""), 4000))]);
  full.socket.destroy();
  assert.match(fullAns, /^HTTP\/1\.1 402/); assert.match(fullAns, /limit_reached/);
  assert.equal((await put(t.tok, "small.md", "x".repeat(1000), { create: true })).status, 201);
});

// Design test 16 (one local isolate) with A1 and A7. The admission table itself (overrun, reclaim, the 6-body bound,
// the log events once each) is unit-tested with an injectable clock in test/app-files-unit.test.mjs.
/**
 * A publisher in project `pid` whose creator is `personId`. The stand-in IdP signs in only the owner, so the owner
 * consents and the creator is then set in local D1 (with a synthetic membership row so the creator is live).
 */
async function asCreator(pid, personId) {
  const ws = sql(`SELECT COALESCE(workspace_id, 'wsp_' || owner_id) AS w FROM projects WHERE id = '${pid}'`)[0].w;
  sql(`INSERT OR IGNORE INTO workspace_members (workspace_id, principal_id, role, created_at) VALUES ('${ws}', '${personId}', 'member', '${new Date().toISOString()}')`);
  const c = await connect(pid);
  sql(`UPDATE publishers SET created_by = '${personId}' WHERE id = '${c.P.publisher_id}'`);
  return c;
}
async function untilSlots(tok, n, ms = 6000) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { if ((v = await slotsInUse(tok)) === n) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail(`slots in use stayed ${v}, never ${n}`);
}
/** Four slot holders: two of the owner in workspace WSA, two of bob in the owner's personal workspace; and a fifth caller. */
async function slotWorld() {
  const pidA = ok(await bob.req("POST", "/api/projects", { title: uniq("Slots A"), workspace_id: WSA }), 201).id;
  const bobId = ok(await bob.req("GET", "/api/me")).principal.id;
  const carol = await h.person("carol");
  const carolId = ok(await carol.req("GET", "/api/me")).principal.id;
  const third = ok(await owner.req("POST", "/api/workspaces", { name: uniq("Third") }), 201).id;
  const pidC = ok(await owner.req("POST", "/api/projects", { title: uniq("Slots C"), workspace_id: third }), 201).id;
  return { holders: [await connect(pidA), await connect(pidA), await asCreator("files-own", bobId), await asCreator("files-own", bobId)],
    ownerElsewhere: await connect("files-own"), fifth: await asCreator(pidC, carolId) };
}

test("slots: per workspace 429, per creator 429, per isolate 503 (Retry-After 1); tiny bodies take whole slots; a retry after one finishes is admitted", async () => {
  const w = await slotWorld();
  const open = [];
  try {
    // (a) Workspace WSA: two held 10-byte PUTs (3 bytes sent); a third from WSA answers 429.
    open.push(partialPut(w.holders[0].tok, "a1.md", { length: 10, send: 3 }), partialPut(w.holders[1].tok, "a2.md", { length: 10, send: 3 }));
    await untilSlots(w.fifth.tok, 2);
    const third = await put(w.holders[0].tok, "a3.md", "x", { create: true });
    err(third, 429, "app_files_concurrency", N.N16); assert.equal(third.headers.get("retry-after"), "1"); assert.equal(third.json.error.retry_after_seconds, 1);
    // (b) The same person (the owner) through an app in another workspace: the per-creator limit.
    err(await put(w.ownerElsewhere.tok, "b.md", "x", { create: true }), 429, "app_files_concurrency", N.N16);
    // (c, d) bob holds two more tiny bodies: 4 in total. A fifth from carol (third workspace) answers 503.
    open.push(partialPut(w.holders[2].tok, "c1.md", { length: 10, send: 3 }), partialPut(w.holders[3].tok, "c2.md", { length: 10, send: 3 }));
    await untilSlots(w.fifth.tok, 4);
    const fifth = await put(w.fifth.tok, "e.md", "x", { create: true });
    err(fifth, 503, "app_files_busy", N.N12); assert.equal(fifth.headers.get("retry-after"), "1"); assert.equal(fifth.json.error.retry_after_seconds, 1);
    // One finishes (its last 7 bytes arrive): 201, and its slot is free; carol's retry is admitted.
    open[0].socket.write("aaaaaaa");
    const finished = await Promise.race([open[0].response, new Promise((r) => setTimeout(() => r("(no answer in 3 s)"), 3000))]);
    assert.match(finished, /^HTTP\/1\.1 201 /, finished.slice(0, 200));
    assert.match(finished, /"path":"a1\.md"/); assert.match(finished, /"revision":1/);
    await untilSlots(w.fifth.tok, 3);
    assert.equal((await put(w.fifth.tok, "e.md", "x", { create: true })).status, 201);
  } finally { for (const x of open) x.socket.destroy(); }
  await untilSlots(w.fifth.tok, 0);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${w.holders[0].P.publisher_id}' AND export_name = 'a1.md'`)[0].n, 1);
});

test("slots (e): four publishes held 5 s; every PUT during the hold answers 503 and slots never exceed 4; all four release", async () => {
  const w = await slotWorld();
  const held = w.holders.map((c, i) => put(c.tok, `held${i}.md`, "x", { create: true, headers: { "x-test-hold-publish-ms": "5000" } }));
  await untilSlots(w.fifth.tok, 4);
  const t0 = Date.now();
  let max = 4, n = 0;
  while (Date.now() - t0 < 3500) {
    const r = await put(w.fifth.tok, `during${n++}.md`, "x", { create: true });
    err(r, 503, "app_files_busy");
    max = Math.max(max, Number(r.headers.get("x-test-slots-in-use")));
    await new Promise((r2) => setTimeout(r2, 300));
  }
  assert.ok(n >= 6, `${n} PUTs during the hold`); assert.equal(max, 4);
  assert.deepEqual((await Promise.all(held)).map((r) => r.status), [201, 201, 201, 201]);
  await untilSlots(w.fifth.tok, 0);
  assert.equal((await put(w.fifth.tok, "after.md", "x", { create: true })).status, 201);
});

test("slots (f): a stalled body answers 408 (N15) and its slot is released exactly once", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Stall"), workspace_id: WSA }), 201).id;
  const c = await connect(pid), d = await connect(pid);
  const x = partialPut(c.tok, "stall.md", { length: 10, send: 3, headers: { "x-test-receive-deadline-ms": "1000" } });
  const ans = await Promise.race([x.response, new Promise((r) => setTimeout(() => r(""), 6000))]);
  x.socket.destroy();
  assert.match(ans, /^HTTP\/1\.1 408/); assert.ok(ans.includes(N.N15), ans);
  await untilSlots(c.tok, 0);
  // Two further PUTs from the same workspace are both admitted: no stale per-workspace entry.
  const [a, b] = await Promise.all([put(c.tok, "s1.md", "x", { create: true }), put(d.tok, "s2.md", "x", { create: true })]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE export_name = 'stall.md'`)[0].n, 0);
});

test("slots (g): with a 1 s reclaim horizon, a held publish is reclaimed by the next admission and logged once, with no ids or paths", async () => {
  const c = await connect("files-own"), d = await connect("files-own");
  const before = readFileSync(h.logPath, "utf8").split("app_files_slot_reclaimed").length;
  const held = put(c.tok, "reclaim-held.md", "x", { create: true, headers: { "x-test-hold-publish-ms": "5000" } });
  await untilSlots(d.tok, 1);
  await new Promise((r) => setTimeout(r, 1200));
  const next = await put(d.tok, "reclaim-next.md", "x", { create: true, headers: { "x-test-slot-reclaim-ms": "1000" } });
  assert.equal(next.status, 201, next.text);
  assert.equal((await held).status, 201, "the reclaimed handler still finishes");
  await untilSlots(d.tok, 0);
  const log = readFileSync(h.logPath, "utf8");
  const lines = log.split("\n").filter((l) => l.includes("app_files_slot_reclaimed"));
  assert.equal(log.split("app_files_slot_reclaimed").length - before, 1, "one event for the one moved slot");
  for (const l of lines) assert.doesNotMatch(l, /reclaim-held|pub_|afs_|files-own/);
});

test("test hooks: x-test-hold-publish-ms is clamped to 5 s", async () => {
  const c = await connect("files-own");
  const t0 = Date.now();
  const r = await put(c.tok, "clamp.md", "x", { create: true, headers: { "x-test-hold-publish-ms": "60000" } });
  assert.equal(r.status, 201); assert.ok(Date.now() - t0 < 9000, "x-test-hold-publish-ms is clamped to 5 s");
});

// Design test 18.
test("counters: each cap answers 413 with its max_*; exact under concurrent replaces and creates at 9,999; a refused batch changes nothing", async () => {
  const c = await connect("files-own");
  ok(await put(c.tok, "c.md", "x", { create: true }), 201);
  setCounters(c.P.publisher_id, 10000, 1, 1);
  const f = await put(c.tok, "new.md", "x", { create: true });
  err(f, 413, "quota_exceeded"); assert.deepEqual([f.json.error.max_files, f.json.error.max_revisions, f.json.error.max_bytes], [10000, 100000, 1073741824]);
  assert.equal((await put(c.tok, "c.md", "y", { match: "rev:1" })).status, 200, "a replace still works at the file cap");
  setCounters(c.P.publisher_id, 1, 100000, 2);
  err(await put(c.tok, "c.md", "z", { match: "rev:2" }), 413, "quota_exceeded");
  setCounters(c.P.publisher_id, 1, 2, 1073741824 - 1);
  err(await put(c.tok, "c.md", "zz", { match: "rev:2" }), 413, "quota_exceeded");
  assert.equal((await put(c.tok, "c.md", "z", { match: "rev:2" })).status, 200, "exactly at the byte cap is allowed");
  // Exactly once: N creates and M replaces.
  const d = await connect("files-own");
  const sizes = [];
  for (let i = 0; i < 3; i++) { const b = `body ${i}`; sizes.push(b.length); ok(await put(d.tok, `n${i}.md`, b, { create: true }), 201); }
  for (let i = 0; i < 2; i++) { const b = `replace ${i}`; sizes.push(b.length); ok(await put(d.tok, "n0.md", b, { match: `rev:${i + 1}` }), 200); }
  assert.deepEqual(counters(d.P.publisher_id), [3, 5, sizes.reduce((a, b) => a + b, 0)]);
  // Concurrent replaces of different files each count once.
  const before = counters(d.P.publisher_id);
  const rs = await Promise.all([put(d.tok, "n1.md", "p", { match: "rev:1" }), put(d.tok, "n2.md", "q", { match: "rev:1" })]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200]);
  assert.deepEqual(counters(d.P.publisher_id), [before[0], before[1] + 2, before[2] + 2]);
  // Concurrent creates at 9,999: exactly one commits.
  const e = await connect("files-own");
  setCounters(e.P.publisher_id, 9999, 0, 0);
  const cs = await Promise.all([put(e.tok, "k1.md", "a", { create: true }), put(e.tok, "k2.md", "b", { create: true })]);
  assert.deepEqual(cs.map((r) => r.status).sort(), [201, 413], cs.map((r) => r.text).join(" | "));
  assert.deepEqual(counters(e.P.publisher_id), [10000, 1, 1]);
  assert.equal(appRows(e.P.publisher_id), 1);
  // A batch that fails at its counter statement rolls back whole: a temporary local trigger aborts that UPDATE after
  // the artifact and revision inserts of the same batch have run.
  const g = await connect("files-own");
  sql(`CREATE TRIGGER test_counter_rollback BEFORE UPDATE OF app_files_created ON publishers WHEN OLD.id = '${g.P.publisher_id}' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`);
  try {
    const r = await put(g.tok, "rb.md", "x", { create: true });
    assert.ok(r.status >= 400, r.text);
    console.log(JSON.stringify({ rolled_back_answer: r.status, code: r.json?.error?.code }));
  } finally { sql("DROP TRIGGER IF EXISTS test_counter_rollback"); }
  assert.deepEqual(counters(g.P.publisher_id), [0, 0, 0]); assert.equal(appRows(g.P.publisher_id), 0); assert.equal(revCount(g.P.publisher_id), 0);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM idempotency WHERE principal_id = (SELECT principal_id FROM publishers WHERE id = '${g.P.publisher_id}')`)[0].n, 0);
  assert.equal((await put(g.tok, "rb.md", "x", { create: true })).status, 201, "a retry after the rollback succeeds");
  assert.deepEqual(counters(g.P.publisher_id), [1, 1, 1]);
});

// Design test 19.
test("rate limit: App Files writes share the publisher write budget (429 with Retry-After)", async () => {
  const c = await connect("files-own");
  // The budget is per minute window: exhaust this window and the next, so the request is over budget whichever
  // window it lands in.
  const win = Math.floor(Date.now() / 60000);
  const principal = sql(`SELECT principal_id AS p FROM publishers WHERE id = '${c.P.publisher_id}'`)[0].p;
  sql(`INSERT INTO rate_counters (k, win, n) VALUES ('w:${principal}', ${win}, 99999999), ('w:${principal}', ${win + 1}, 99999999)
    ON CONFLICT (k, win) DO UPDATE SET n = 99999999`);
  const r = await put(c.tok, "rl.md", "x", { create: true });
  err(r, 429, "rate_limited"); assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.equal(appRows(c.P.publisher_id), 0);
});

// Design test 21.
test("encryption: App Files text is stored like every other text write", { todo: "App Files are text; text is encrypted by slice 3c, which is not built yet; until then text is stored as plaintext" }, async () => {
  const c = await connect("files-own");
  ok(await put(c.tok, "enc.md", "synthetic secret", { create: true }), 201);
  const key = sql(`SELECT r.body_key FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE a.publisher_id = '${c.P.publisher_id}'`)[0].body_key;
  const stored = execFileSync("wrangler", ["r2", "object", "get", `agent-library-blobs/${key}`, "--local", "--persist-to", h.dir, "--pipe", "--config", LOCAL_CONFIG], { cwd: ROOT }).toString();
  assert.doesNotMatch(stored, /synthetic secret/);
});

// Design test 22 a-c, e: a same-key winner commits while the loser is paused after its record check.
test("concurrent replay: a loser that would be refused replays the winner's answer (create, replace, cap); a different body is 422", async () => {
  const c = await connect("files-own");
  const race = async (path, body, opts, winnerOpts = opts) => {
    const b = h.pauseBarrier();
    const loser = put(c.tok, path, body, { ...opts, headers: { "x-test-pause-after-record-check-ms": "3000", "x-test-pause-tag": b.tag } });
    await b.entered;
    const winner = await put(c.tok, path, winnerOpts.body ?? body, winnerOpts);
    return { winner, loser: await loser };
  };
  // (a) create
  const k1 = uniq("race-key");
  const a = await race("ra.md", "same", { create: true, key: k1 });
  assert.equal(a.winner.status, 201); assert.equal(a.loser.status, 201, a.loser.text); assert.equal(a.loser.json.idempotent_replay, true);
  assert.deepEqual(a.loser.json.file, a.winner.json.file);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}' AND export_name = 'ra.md'`)[0].n, 1);
  // (b) replace
  const k2 = uniq("race-key");
  const b = await race("ra.md", "next", { match: `"${sha("same")}"`, key: k2 });
  assert.equal(b.winner.status, 200); assert.equal(b.loser.status, 200, b.loser.text); assert.equal(b.loser.json.idempotent_replay, true);
  // (c) the winner fills the revision cap; the loser replays instead of 413.
  const cnt = counters(c.P.publisher_id);
  setCounters(c.P.publisher_id, cnt[0], 99999, cnt[2]);
  const k3 = uniq("race-key");
  const cc = await race("ra.md", "capped", { match: "rev:2", key: k3 });
  assert.equal(cc.winner.status, 200); assert.equal(cc.loser.status, 200, cc.loser.text); assert.equal(cc.loser.json.idempotent_replay, true);
  setCounters(c.P.publisher_id, ...cnt);
  // (e) same key, different body: 422, not 412.
  const k4 = uniq("race-key");
  const e = await race("re.md", "loser body", { create: true, key: k4 }, { create: true, key: k4, body: "winner body" });
  assert.equal(e.winner.status, 201); err(e.loser, 422, "idempotency_key_reused");
});

// ---- DELETE (design commit 4) ----
const del = (tok, path, { match, key, headers = {} } = {}) => put(tok, path, undefined, { method: "DELETE", type: null, match, key, headers });

// Design test 6.
test("DELETE: stale 412 then 200; trashed with publisher_id kept and export_name released; re-create; owner restore is read-only; counters unchanged", async () => {
  const c = await connect("files-own", { destination: "new" });
  const a = await put(c.tok, "d.md", "one", { create: true });
  ok(await put(c.tok, "d.md", "two", { match: "rev:1" }), 200);
  const items = sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = 'files-own' AND publisher_id IS NULL`)[0].n;
  const cnt = counters(c.P.publisher_id);
  err(await del(c.tok, "d.md", { match: "rev:1" }), 412, "precondition_failed", N.N5);
  err(await del(c.tok, "d.md"), 428, "precondition_required", N.N4);
  err(await del(c.tok, "d.md", { match: "rev:2", key: null }), 400, "idempotency_key_required");
  err(await del(c.tok, "d.md", { headers: { "if-none-match": "*" } }), 400, "invalid_input", N.N8);
  const d = await del(c.tok, "d.md", { match: `"${sha("two")}"` });
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(d.json, { file: { path: "d.md", file_id: a.json.file.file_id, trashed: true, revision: 2 } });
  const row = sql(`SELECT publisher_id, export_name, trashed_at, title FROM artifacts WHERE id = '${a.json.file.file_id}'`)[0];
  assert.equal(row.publisher_id, c.P.publisher_id); assert.equal(row.export_name, null); assert.ok(row.trashed_at); assert.equal(row.title, "d.md");
  assert.equal((await file(c.tok, "d.md")).status, 404); assert.deepEqual(ok(await files(c.tok)).files, []);
  err(await del(c.tok, "d.md", { match: "rev:2" }), 412, "precondition_failed", N.N7);
  // The path is free: a re-create, deleted again, leaves two released rows (several NULL export_name values coexist).
  ok(await put(c.tok, "d.md", "three", { create: true }), 201);
  ok(await del(c.tok, "d.md", { match: "rev:1" }), 200);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}' AND export_name IS NULL`)[0].n, 2);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = 'files-own' AND publisher_id IS NULL`)[0].n, items, "items_per_project unchanged");
  assert.deepEqual(counters(c.P.publisher_id), [cnt[0] + 1, cnt[1] + 1, cnt[2] + 5], "a delete changes no counter (the re-create did)");
  // The owner restores it: read-only content (403), a rename works; the app still cannot see it.
  const fid = a.json.file.file_id;
  const meta = (await owner.req("GET", `/api/projects/files-own/artifacts?trashed=1`)).body.artifacts.find((x) => x.id === fid).meta_version;
  ok(await owner.req("PATCH", `/api/projects/files-own/artifacts/${fid}`, { expected_meta_version: meta, trashed: false }));
  assert.equal((await owner.req("PUT", `/api/projects/files-own/artifacts/${fid}`, { expected_revision: 2, body: "owner edit" })).status, 403);
  assert.equal((await owner.req("PATCH", `/api/projects/files-own/artifacts/${fid}`, { expected_meta_version: meta + 1, title: "renamed.md" })).status, 200);
  assert.deepEqual(ok(await files(c.tok)).files, [], "a restored file has no path: invisible to the app");
});

test("DELETE refusals: owner-trashed 409; generation row 409; manifest 400; owner trash racing a replace 409", async () => {
  const c = await connect("files-own");
  const a = await put(c.tok, "o.md", "x", { create: true });
  const fid = a.json.file.file_id;
  const meta = (await owner.req("GET", `/api/projects/files-own/artifacts/${fid}`)).body.artifact.meta_version;
  ok(await owner.req("PATCH", `/api/projects/files-own/artifacts/${fid}`, { expected_meta_version: meta, trashed: true }));
  err(await del(c.tok, "o.md", { match: "rev:1" }), 409, "destination_file_trashed");
  err(await put(c.tok, "o.md", "y", { match: "rev:1" }), 409, "destination_file_trashed");
  err(await put(c.tok, "o.md", "y", { create: true }), 409, "destination_file_trashed");
  insertFiles(c.P.publisher_id, [{ path: "gp.json", kind: "json", content: "{}", generationId: "g_synthetic_del" }]);
  err(await del(c.tok, "gp.json", { match: "rev:1" }), 409, "path_conflict");
  err(await del(c.tok, "manifest.json", { match: "rev:1" }), 400, "invalid_input", "manifest.json is reserved for the server");
  // The owner trashes a file while the app's replace is paused: the fenced publish refuses with 409.
  const b = await put(c.tok, "race.md", "x", { create: true });
  const r = await during((hd) => put(c.tok, "race.md", "y", { match: "rev:1", headers: hd }), async () => {
    const m = (await owner.req("GET", `/api/projects/files-own/artifacts/${b.json.file.file_id}`)).body.artifact.meta_version;
    ok(await owner.req("PATCH", `/api/projects/files-own/artifacts/${b.json.file.file_id}`, { expected_meta_version: m, trashed: true }));
  });
  err(r, 409, "destination_file_trashed");
  assert.equal(sql(`SELECT head_rev FROM artifacts WHERE id = '${b.json.file.file_id}'`)[0].head_rev, 1);
});

test("owner trash racing a create: the app deletes its file, then while its re-create is paused the owner restores and trashes the old one; 409", async () => {
  // A create at a path can only meet an owner-trashed file of that path if the row appears during the request. The
  // old (released) row comes back to the path: the owner restores it (no path, read-only), and in D1 the test gives it
  // back its export name and trashes it, as an owner trash of a live file leaves it.
  const c = await connect("files-own");
  const a = await put(c.tok, "cr.md", "old", { create: true });
  ok(await del(c.tok, "cr.md", { match: "rev:1" }), 200);
  const r = await during((hd) => put(c.tok, "cr.md", "new", { create: true, headers: hd }), async () =>
    sql(`UPDATE artifacts SET export_name = 'cr.md', trashed_at = '${new Date().toISOString()}' WHERE id = '${a.json.file.file_id}'`));
  err(r, 409, "destination_file_trashed");
  assert.equal(sql(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${c.P.publisher_id}'`)[0].n, 1, "no second row");
});

// Design test 5d.
test("DELETE replay: a retry after success replays the 200; a different precondition with the same key is 422", async () => {
  const c = await connect("files-own");
  ok(await put(c.tok, "r.md", "x", { create: true }), 201);
  const k = uniq("del-key");
  const a = await del(c.tok, "r.md", { match: "rev:1", key: k });
  const b = await del(c.tok, "r.md", { match: "rev:1", key: k });
  assert.equal(b.status, 200, b.text); assert.equal(b.json.idempotent_replay, true); assert.deepEqual(b.json.file, a.json.file);
  err(await del(c.tok, "r.md", { match: `"${sha("x")}"`, key: k }), 422, "idempotency_key_reused");
});

// Design test 13 (delete).
test("DELETE liveness: disabled client, revoked, suspended, folder deleted, and each during the pause: refused, nothing trashed", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Del live"), workspace_id: WSA }), 201).id;
  const before = {
    "client disabled": [401, (c) => owner.req("POST", `/api/app-clients/${c.app.app_client_id}/disable`, {})],
    "publisher revoked": [401, (c) => owner.req("POST", `/api/publishers/${c.P.publisher_id}/revoke`, {})],
    "destination folder deleted": [403, (c) => MID["destination folder deleted"](c.P.publisher_id)],
    "token epoch superseded": [401, (c) => MID["token epoch superseded"](c.P.publisher_id)],
    "workspace suspended": [403, () => sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`)],
  };
  for (const mid of [false, true]) for (const [label, [status, act]] of Object.entries(before)) {
    const c = await connect(pid, { destination: "new" });
    const f = await put(c.tok, "x.md", "x", { create: true });
    try {
      const r = mid ? await during((hd) => del(c.tok, "x.md", { match: "rev:1", headers: hd }), async () => act(c))
        : (await act(c), await del(c.tok, "x.md", { match: "rev:1" }));
      assert.equal(r.status, status, `${mid ? "during" : "before"} ${label}: ${r.text}`);
    } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
    const row = sql(`SELECT export_name, trashed_at FROM artifacts WHERE id = '${f.json.file.file_id}'`)[0];
    assert.deepEqual(row, { export_name: "x.md", trashed_at: null }, `${label}: nothing trashed`);
  }
});

// Design test 22d.
test("concurrent replay (d): a DELETE loser that would see no file replays the winner's 200", async () => {
  const c = await connect("files-own");
  ok(await put(c.tok, "cd.md", "x", { create: true }), 201);
  const k = uniq("race-del-key");
  const b = h.pauseBarrier();
  const loser = del(c.tok, "cd.md", { match: "rev:1", key: k, headers: { "x-test-pause-after-record-check-ms": "3000", "x-test-pause-tag": b.tag } });
  await b.entered;
  const winner = await del(c.tok, "cd.md", { match: "rev:1", key: k });
  const l = await loser;
  assert.equal(winner.status, 200); assert.equal(l.status, 200, l.text); assert.equal(l.json.idempotent_replay, true);
  assert.deepEqual(l.json.file, winner.json.file);
});

// ---- Part 2 review fixes (commit D) ----
test("path conflicts ignore case for the ancestor and descendant checks too, both ways", async () => {
  const c = await connect("files-own");
  ok(await put(c.tok, "Notes.md", "x", { create: true }), 201);
  err(await put(c.tok, "notes.md/x.md", "y", { create: true }), 409, "path_conflict");
  err(await put(c.tok, "NOTES.MD/deep/x.md", "y", { create: true }), 409, "path_conflict");
  // Folder names may contain dots: with Dir.md/Sub.md/a.md stored, a file named dir.md or DIR.MD/sub.md is where a
  // folder is needed.
  ok(await put(c.tok, "Dir.md/Sub.md/a.md", "x", { create: true }), 201);
  for (const p of ["dir.md", "DIR.MD/sub.md", "dir.md/SUB.MD"]) err(await put(c.tok, p, "y", { create: true }), 409, "path_conflict");
  ok(await put(c.tok, "dir.md/other.md", "x", { create: true }), 201);
  // A folder where a file is needed: an existing Dir/Sub/... makes "dir/sub" unusable as a file of any case.
  insertFiles(c.P.publisher_id, [{ path: "Up/Low.json", kind: "json", content: "{}" }]);
  for (const p of ["up/low.json/x.md", "UP/LOW.JSON/y/z.csv"]) err(await put(c.tok, p, "a,b", { create: true, type: typeOf(p) }), 409, "path_conflict");
  // Exactly the prefix plus '/': "dir/sub0.md" or "dir/sub-x.md" share a prefix but are not under the folder.
  ok(await put(c.tok, "notes.md-x/a.md", "x", { create: true }), 201);
  ok(await put(c.tok, "notes.md0.md", "x", { create: true }), 201);
  assert.equal(appRows(c.P.publisher_id), 6);
});

test("the manifest name is reserved by meaning on PUT and DELETE (400); GET and the list never show it", async () => {
  const c = await connect("files-own");
  ok(await snapshot(c.tok, 1), 201);
  for (const p of ["manifest.json", "Manifest.json", "MANIFEST.JSON", "manifest.json/x.md", "Manifest.Json/a/b.csv"]) {
    err(await put(c.tok, p, "x", { create: true, type: typeOf(p) }), 400, "invalid_input", "manifest.json is reserved for the server");
    err(await del(c.tok, p, { match: "rev:1" }), 400, "invalid_input", "manifest.json is reserved for the server");
    const g = await file(c.tok, p);
    assert.equal(g.status, 404, p); assert.equal(g.json.error.message, "File not found");
  }
  assert.deepEqual(ok(await files(c.tok)).files.map((f) => f.path), ["export.json"]);
  ok(await put(c.tok, "sub/manifest.json", "{}", { create: true }), 201);
});

test("concurrent creates that differ only by case, or where one is the other's mixed-case ancestor: exactly one succeeds, the other 409", async () => {
  for (const [first, second] of [["Case.md", "case.md"], ["Folder.md", "folder.md/inner.md"], ["outer.md/Inner.md", "OUTER.md"]]) {
    const c = await connect("files-own");
    const b = h.pauseBarrier();
    const paused = put(c.tok, first, "a", { create: true, headers: { "x-test-pause-before-batch-ms": "3000", "x-test-pause-tag": b.tag } });
    await b.entered;
    const quick = await put(c.tok, second, "b", { create: true });
    const slow = await paused;
    assert.equal(quick.status, 201, `${second}: ${quick.text}`);
    err(slow, 409, "path_conflict");
    assert.equal(appRows(c.P.publisher_id), 1, `${first} / ${second}`);
  }
});

test("query plans: the path-conflict check and the list use an index on publisher_id (no full scan of artifacts)", async () => {
  const c = await connect("files-own");
  const pub = c.P.publisher_id;
  const plan = (q) => sql(`EXPLAIN QUERY PLAN ${q}`).map((r) => r.detail);
  // The statements as app-files.js builds them (conflictCheck and the list), with literal values.
  const W = await import("./load-worker.mjs").then((m) => m.loadWorker({ "api/app-files.js": ["conflictCheck", "LIST_SQL"] }));
  const cc = W.conflictCheck(pub, "Notes/Day/A.md");
  let i = 0;
  const lit = (sqlText, params) => sqlText.replace(/\?/g, () => { const v = params[i++]; return v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`; });
  const conflictPlan = plan(`SELECT ${lit(cc.sql, cc.params)} AS ok`);
  i = 0;
  const listPlan = plan(lit(W.LIST_SQL, [pub, "files-own", null, "", "~", "", 101]));
  console.log(JSON.stringify({ conflictPlan, listPlan }));
  for (const p of [conflictPlan, listPlan]) {
    assert.ok(p.some((d) => /USING (COVERING )?INDEX artifacts_publisher_(lname|name)/.test(d)), JSON.stringify(p));
    assert.ok(!p.some((d) => /^SCAN (a|c|artifacts)\b(?! USING)/.test(d)), `full scan: ${JSON.stringify(p)}`);
  }
  assert.ok(conflictPlan.some((d) => /artifacts_publisher_lname/.test(d)), JSON.stringify(conflictPlan));
});

test("If-Match accepts the quoted revision \"rev:N\" on PUT and DELETE", async () => {
  const c = await connect("files-own");
  ok(await put(c.tok, "q.md", "one", { create: true }), 201);
  const r = await put(c.tok, "q.md", "two", { match: '"rev:1"' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.file.revision, 2);
  err(await del(c.tok, "q.md", { match: '"rev:1"' }), 412, "precondition_failed", N.N5);
  ok(await del(c.tok, "q.md", { match: '"rev:2"' }), 200);
  for (const bad of ['"rev:0"', '"rev:x"', "'rev:1'", '"rev:1'])
    err(await put(c.tok, "q2.md", "x", { match: bad }), 400, "invalid_input", N.N8);
});

test("PUT replace in flight: client disabled, token superseded or workspace suspended during the pause: refused, head unchanged", async () => {
  const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Replace mid"), workspace_id: WSA }), 201).id;
  const cases = {
    "client disabled": [401, (c) => owner.req("POST", `/api/app-clients/${c.app.app_client_id}/disable`, {})],
    "token epoch superseded": [401, (c) => MID["token epoch superseded"](c.P.publisher_id)],
    "workspace suspended": [403, () => sql(`UPDATE workspaces SET status = 'suspended' WHERE id = '${WSA}'`)],
  };
  for (const [label, [status, act]] of Object.entries(cases)) {
    const c = await connect(pid, { destination: "new" });
    const f = await put(c.tok, "rep.md", "head", { create: true });
    const before = counters(c.P.publisher_id);
    try {
      const r = await during((hd) => put(c.tok, "rep.md", "changed", { match: "rev:1", headers: hd }), async () => act(c));
      assert.equal(r.status, status, `${label}: ${r.text}`);
    } finally { sql(`UPDATE workspaces SET status = 'active' WHERE id = '${WSA}'`); }
    assert.equal(sql(`SELECT head_rev FROM artifacts WHERE id = '${f.json.file.file_id}'`)[0].head_rev, 1, label);
    assert.equal(revCount(c.P.publisher_id), 1, label); assert.deepEqual(counters(c.P.publisher_id), before, label);
  }
});

test("PUT and DELETE in flight: the creator removed from the workspace, or the project deleted, during the pause: refused, nothing written", async () => {
  const rejoin = async () => {
    const inv = ok(await bob.req("POST", `/api/workspaces/${WSA}/invites`, { email: "owner@example.test", role: "member" }), 201);
    ok(await owner.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  };
  for (const op of ["create", "replace", "delete"]) {
    // Creator removed (owner leaves bob's workspace).
    const pid = ok(await bob.req("POST", "/api/projects", { title: uniq("Creator mid"), workspace_id: WSA }), 201).id;
    const c = await connect(pid);
    const f = op === "create" ? null : await put(c.tok, "m.md", "head", { create: true });
    const cBefore = counters(c.P.publisher_id), cRevs = revCount(c.P.publisher_id);
    const send = (hd) => op === "create" ? put(c.tok, "m.md", "x", { create: true, headers: hd })
      : op === "replace" ? put(c.tok, "m.md", "x", { match: "rev:1", headers: hd }) : del(c.tok, "m.md", { match: "rev:1", headers: hd });
    let r;
    try { r = await during(send, async () => ok(await bob.req("DELETE", `/api/workspaces/${WSA}/members/${ownerId}`))); }
    finally { await rejoin(); }
    assert.equal(r.status, 403, `${op} creator removed: ${r.text}`); assert.equal(r.json.error.code, "scope_mismatch");
    if (f) assert.deepEqual(sql(`SELECT head_rev, export_name, trashed_at FROM artifacts WHERE id = '${f.json.file.file_id}'`)[0], { head_rev: 1, export_name: "m.md", trashed_at: null });
    else assert.equal(appRows(c.P.publisher_id), 0);
    assert.equal(revCount(c.P.publisher_id), cRevs, op); assert.deepEqual(counters(c.P.publisher_id), cBefore, op);
    // Project deleted.
    const title = uniq("Project mid");
    const pid2 = ok(await owner.req("POST", "/api/projects", { title }), 201).id;
    const d = await connect(pid2);
    const g = op === "create" ? null : await put(d.tok, "m.md", "head", { create: true });
    const dBefore = counters(d.P.publisher_id), dRevs = revCount(d.P.publisher_id);
    const send2 = (hd) => op === "create" ? put(d.tok, "m.md", "x", { create: true, headers: hd })
      : op === "replace" ? put(d.tok, "m.md", "x", { match: "rev:1", headers: hd }) : del(d.tok, "m.md", { match: "rev:1", headers: hd });
    const r2 = await during(send2, async () => ok(await owner.req("DELETE", `/api/projects/${pid2}`, { confirm_title: title })));
    assert.equal(r2.status, 403, `${op} project deleted: ${r2.text}`);
    if (g) assert.deepEqual(sql(`SELECT head_rev, export_name, trashed_at FROM artifacts WHERE id = '${g.json.file.file_id}'`)[0], { head_rev: 1, export_name: "m.md", trashed_at: null });
    else assert.equal(appRows(d.P.publisher_id), 0);
    assert.equal(revCount(d.P.publisher_id), dRevs, op); assert.deepEqual(counters(d.P.publisher_id), dBefore, op);
  }
});
