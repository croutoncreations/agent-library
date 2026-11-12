// App Files API (/v1/app/files, slice 5a) and the publisher liveness rule it relies on (docs/app-connect.md).
// Real local wrangler dev, the official App Connect flows (owner consent, code exchange) and real HTTP; synthetic
// people and data only. Raw request paths are sent with node:http so nothing normalizes them on the way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { ROOT, LOCAL_CONFIG } from "./helpers.mjs";
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

before(async () => {
  h = await startAppConnectServer({ port: PORT });
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
  for (const m of ["PUT", "DELETE", "POST", "PATCH"]) assert.equal((await h.pub(c.tok, m, "/app/files/notes/day.md")).status, 405, m);
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
