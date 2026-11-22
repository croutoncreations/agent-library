// Nested folders (docs/folders.md): a real folder tree per project for every installation. Create by path (missing
// parents created), place documents/uploads by path or folder_id, list one folder or a subtree, rename/move (paths
// follow, cycles refused, collisions 409), delete only when empty, legacy free-text folders adopted, agent tools on
// both MCP endpoints, App Connect subfolders inside the publisher's destination, backup round trip, and the browser
// project view (Chrome). Real Worker + OAuth harness, synthetic content only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { startServer, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { makePng } from "./make-fixtures.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const P = "tree-test";
const base = `/api/projects/${P}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
let h, owner, agent, rw;

before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS["nested-folders"] });
  owner = await h.owner();
  assert.equal((await owner.req("POST", "/api/projects", { id: P, title: "Tree" })).status, 201);
  agent = await h.connectMcpAgent({ [P]: "write" }, { clientName: "Folder agent" });
  rw = (await owner.req("POST", "/api/api-keys", { label: "tree rw", lifetime_days: 1, projects: [{ project_id: P, access: "read_write" }] })).body.secret;
});
after(async () => { await h?.stop(); });

const folders = async () => (await owner.req("GET", base + "/folders")).body.folders;
const byPath = async (p) => (await folders()).find((f) => f.path === p);
const v1 = (method, path, body) => fetch(`${h.api}${path}`, { method, headers: { authorization: `Bearer ${rw}`, "user-agent": "t", ...(body ? { "content-type": "application/json", "idempotency-key": key("v") } : {}) }, body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test("create by path makes every missing parent; siblings unique case-insensitively; same name under different parents", async () => {
  const r = await owner.req("POST", base + "/folders", { path: "folder1/nesteda" });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.path, "folder1/nesteda"); assert.equal(r.body.name, "nesteda");
  for (const n of ["nestedb", "nestedc"]) assert.equal((await owner.req("POST", base + "/folders", { name: n, parent_id: (await byPath("folder1")).id })).status, 201);
  const all = await folders();
  assert.deepEqual(all.map((f) => f.path), ["folder1", "folder1/nesteda", "folder1/nestedb", "folder1/nestedc"]);
  const f1 = all.find((f) => f.path === "folder1");
  assert.equal(f1.parent_id, null); assert.equal(f1.folder_count, 3);
  assert.ok(all.filter((f) => f.path.startsWith("folder1/")).every((f) => f.parent_id === f1.id));
  const dup = await owner.req("POST", base + "/folders", { path: "FOLDER1/NestedA" });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, "folder_exists");
  assert.equal((await owner.req("POST", base + "/folders", { path: "other/nesteda" })).status, 201, "same leaf name under another parent");
  for (const bad of ["", "/", "a/../b", "x".repeat(81), "a/b/c/d/e/f/g/h/i", "tab\there"]) assert.equal((await owner.req("POST", base + "/folders", { path: bad })).status, 400, JSON.stringify(bad));
  // one level at a time
  const kids = (await owner.req("GET", base + "/folders?parent=folder1")).body.folders.map((f) => f.name);
  assert.deepEqual(kids, ["nesteda", "nestedb", "nestedc"]);
  assert.deepEqual((await owner.req("GET", base + "/folders?parent_id=root")).body.folders.map((f) => f.name), ["folder1", "other"]);
});

test("documents and uploads land in a folder by path (created on demand) or folder_id; listing one folder or a subtree", async () => {
  const a = await owner.req("POST", base + "/artifacts", { title: "file.md", body: "# a", folder: "folder1/nesteda" });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const nb = await byPath("folder1/nestedb");
  const b = await owner.req("POST", base + "/artifacts", { title: "b.md", body: "# b", folder_id: nb.id });
  assert.equal(b.status, 201);
  const c = await owner.req("POST", base + "/artifacts", { title: "deep.md", body: "# c", folder: "folder1/nestedc/deeper" });
  assert.equal(c.status, 201);
  assert.ok(await byPath("folder1/nestedc/deeper"), "missing folder created by the write");
  const png = makePng(6, 6);
  const up = await owner.req("POST", base + "/uploads", { title: "file.png", folder: "folder1/nesteda", mime: "image/png", size: png.length, sha256: sha(png) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await owner.req("PUT", up.body.put_url, undefined, { raw: png, headers: { "content-type": "application/octet-stream" } })).status, 200);
  assert.equal((await owner.req("POST", `${base}/uploads/${up.body.upload_id}/finish`, {})).status, 200);
  const na = await byPath("folder1/nesteda");
  const inA = (await owner.req("GET", `${base}/artifacts?folder_id=${na.id}`)).body.artifacts;
  assert.deepEqual(inA.map((x) => x.title).sort(), ["file.md", "file.png"]);
  assert.ok(inA.every((x) => x.folder === "folder1/nesteda" && x.folder_id === na.id));
  assert.deepEqual((await owner.req("GET", `${base}/artifacts?folder=folder1`)).body.artifacts, [], "direct children only");
  const sub = (await owner.req("GET", `${base}/artifacts?folder=folder1&recursive=1`)).body.artifacts.map((x) => x.title).sort();
  assert.deepEqual(sub, ["b.md", "deep.md", "file.md", "file.png"]);
  assert.equal((await owner.req("GET", `${base}/artifacts?folder=nope`)).status, 404);
  assert.equal((await folders()).find((f) => f.path === "folder1/nesteda").item_count, 2);
});

test("moving a document between folders is a versioned details change; the folder field takes paths", async () => {
  const doc = (await owner.req("GET", `${base}/artifacts?folder=folder1/nestedb`)).body.artifacts[0];
  const r = await owner.req("PATCH", `${base}/artifacts/${doc.id}`, { expected_meta_version: doc.meta_version, folder: "archive/2026" });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.folder, "archive/2026");
  const arch = await byPath("archive/2026");
  assert.equal(r.body.folder_id, arch.id);
  assert.equal((await owner.req("GET", `${base}/artifacts/${doc.id}`)).body.artifact.folder_id, arch.id);
  // back to the root
  const r2 = await owner.req("PATCH", `${base}/artifacts/${doc.id}`, { expected_meta_version: r.body.meta_version, folder: "" });
  assert.equal(r2.status, 200); assert.equal(r2.body.folder, ""); assert.equal(r2.body.folder_id ?? null, null);
  const r3 = await owner.req("PATCH", `${base}/artifacts/${doc.id}`, { expected_meta_version: r2.body.meta_version, folder_id: (await byPath("folder1/nestedb")).id });
  assert.equal(r3.status, 200); assert.equal(r3.body.folder, "folder1/nestedb");
});

test("rename and move rewrite the subtree's paths and documents' folder labels; cycles and collisions refused", async () => {
  const f1 = await byPath("folder1");
  const ren = await owner.req("PATCH", `${base}/folders/${f1.id}`, { name: "Projects" });
  assert.equal(ren.status, 200, JSON.stringify(ren.body)); assert.equal(ren.body.path, "Projects");
  const paths = (await folders()).map((f) => f.path);
  for (const p of ["Projects/nesteda", "Projects/nestedb", "Projects/nestedc", "Projects/nestedc/deeper"]) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => p.startsWith("folder1")));
  const docs = (await owner.req("GET", `${base}/artifacts?folder=Projects&recursive=1`)).body.artifacts;
  assert.ok(docs.length >= 4 && docs.every((d) => d.folder.startsWith("Projects/")), JSON.stringify(docs.map((d) => d.folder)));
  // move nestedc under other/ -> other/nestedc/deeper
  const nc = await byPath("Projects/nestedc"), other = await byPath("other");
  const mv = await owner.req("PATCH", `${base}/folders/${nc.id}`, { parent_id: other.id });
  assert.equal(mv.status, 200); assert.equal(mv.body.path, "other/nestedc");
  assert.ok(await byPath("other/nestedc/deeper"));
  assert.equal((await owner.req("GET", `${base}/artifacts?folder=other/nestedc/deeper`)).body.artifacts[0].folder, "other/nestedc/deeper");
  // cycle
  const cyc = await owner.req("PATCH", `${base}/folders/${other.id}`, { parent_id: (await byPath("other/nestedc/deeper")).id });
  assert.equal(cyc.status, 400);
  // collision: other/nesteda exists; moving Projects/nesteda under other collides
  const col = await owner.req("PATCH", `${base}/folders/${(await byPath("Projects/nesteda")).id}`, { parent_id: other.id });
  assert.equal(col.status, 409); assert.equal(col.body.error.code, "folder_exists");
  // stale guard
  const stale = await owner.req("PATCH", `${base}/folders/${other.id}`, { name: "x", expected_path: "not-it" });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, "folder_conflict");
  // move to root
  const root = await owner.req("PATCH", `${base}/folders/${(await byPath("other/nestedc")).id}`, { parent_id: "root" });
  assert.equal(root.status, 200); assert.equal(root.body.path, "nestedc");
});

test("rename keeps non-ASCII paths exact and findable (case-insensitive like every lookup)", async () => {
  const r = await owner.req("POST", base + "/folders", { path: "Übersicht/📁 Bilder/Ärger" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await owner.req("POST", base + "/artifacts", { title: "ü.md", body: "# ü", folder: "Übersicht/📁 Bilder/Ärger" })).status, 201);
  const top = await byPath("Übersicht");
  assert.equal((await owner.req("PATCH", `${base}/folders/${top.id}`, { name: "Ölberg" })).status, 200);
  assert.ok(await byPath("Ölberg/📁 Bilder/Ärger"), JSON.stringify((await folders()).map((f) => f.path)));
  const a = (await owner.req("GET", `${base}/artifacts?folder=${encodeURIComponent("ölberg/📁 bilder/ärger")}`));
  assert.equal(a.status, 200, "lower-case lookup finds the renamed subfolder");
  assert.equal(a.body.artifacts[0].folder, "Ölberg/📁 Bilder/Ärger");
  const dup = await owner.req("POST", base + "/folders", { path: "ÖLBERG/📁 BILDER" });
  assert.equal(dup.status, 409, "no duplicate after the rename");
});

test("review: a folder change on a required-review document is a proposal; the folder is created on approval, re-read if renamed", async () => {
  const id = (await owner.req("POST", base + "/artifacts", { title: "Gated", body: "# g" })).body.artifact_id;
  const cur = (await owner.req("GET", `${base}/artifacts/${id}`)).body;
  assert.equal((await owner.req("PUT", `${base}/artifacts/${id}/review-mode`, { mode: "required", expected_revision: cur.revision.rev })).status, 200);
  const doc = (await owner.req("GET", `${base}/artifacts/${id}`)).body.artifact;
  const g = (await owner.req("POST", `${base}/grants`, { label: "details bot", can_write: true })).body.token;
  const patch = (b) => fetch(h.appUi + `${base}/artifacts/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${g}`, "content-type": "application/json", "idempotency-key": key("p") }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const pr = await patch({ expected_meta_version: doc.meta_version, folder: "Proposed/new place" });
  assert.equal(pr.status, 200, JSON.stringify(pr.data)); assert.ok(pr.data.proposal_id, JSON.stringify(pr.data));
  assert.equal(await byPath("Proposed"), undefined, "a proposal creates no folder");
  const ap = await owner.req("POST", `${base}/proposals/${pr.data.proposal_id}/review`, { decision: "approve" });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const placed = await byPath("Proposed/new place");
  assert.ok(placed, "created by the approval");
  const after = (await owner.req("GET", `${base}/artifacts/${id}`)).body.artifact;
  assert.equal(after.folder_id, placed.id); assert.equal(after.folder, "Proposed/new place");
  // A proposal naming an existing folder that is renamed before approval lands under the new name.
  const pr2 = await patch({ expected_meta_version: after.meta_version, folder: "Proposed" });
  assert.ok(pr2.data.proposal_id, JSON.stringify(pr2.data));
  assert.equal((await owner.req("PATCH", `${base}/folders/${(await byPath("Proposed")).id}`, { name: "Accepted" })).status, 200);
  assert.equal((await owner.req("POST", `${base}/proposals/${pr2.data.proposal_id}/review`, { decision: "approve" })).status, 200);
  const fin = (await owner.req("GET", `${base}/artifacts/${id}`)).body.artifact;
  assert.equal(fin.folder, "Accepted"); assert.equal(fin.folder_id, (await byPath("Accepted")).id);
});

test("a refused details change creates no folder", async () => {
  const id = (await owner.req("POST", base + "/artifacts", { title: "Stale", body: "# s" })).body.artifact_id;
  const r = await owner.req("PATCH", `${base}/artifacts/${id}`, { expected_meta_version: 99, folder: "Never/created" });
  assert.equal(r.status, 409);
  assert.equal(await byPath("Never"), undefined);
});

test("delete: only empty folders, not an app's destination; trashed items fall back to the root", async () => {
  const nb = await byPath("Projects/nestedb");
  const full = await owner.req("DELETE", `${base}/folders/${nb.id}`);
  assert.equal(full.status, 409); assert.equal(full.body.error.code, "folder_not_empty");
  const parent = await owner.req("DELETE", `${base}/folders/${(await byPath("Projects")).id}`);
  assert.equal(parent.status, 409, "has subfolders");
  const doc = (await owner.req("GET", `${base}/artifacts?folder_id=${nb.id}`)).body.artifacts[0];
  assert.equal((await owner.req("PATCH", `${base}/artifacts/${doc.id}`, { expected_meta_version: doc.meta_version, trashed: true })).status, 200);
  const del = await owner.req("DELETE", `${base}/folders/${nb.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(!(await byPath("Projects/nestedb")));
  const t = (await owner.req("GET", `${base}/artifacts?trashed=1`)).body.artifacts.find((x) => x.id === doc.id);
  assert.equal(t.folder, ""); assert.equal(t.folder_id ?? null, null);
  const r = await owner.req("PATCH", `${base}/artifacts/${doc.id}`, { expected_meta_version: t.meta_version, trashed: false });
  assert.equal(r.status, 200, "restorable after its folder is gone");
});

test("agents: create folders and file documents by path; rename/move/delete are owner-only", async () => {
  const tools = (await agent.list()).map((t) => t.name);
  for (const n of ["list_folders", "create_folder"]) assert.ok(tools.includes(n), n);
  const cf = await agent.call("create_folder", { project_id: P, path: "Agent notes/2026/Q4", idempotency_key: key("cf") });
  assert.equal(cf.isError, false, JSON.stringify(cf.data)); assert.equal(cf.data.path, "Agent notes/2026/Q4");
  const md = await agent.call("create_markdown", { project_id: P, title: "Plan", body: "# plan", folder: "Agent notes/2026/Q4", idempotency_key: key("cm") });
  assert.equal(md.isError, false, JSON.stringify(md.data));
  const ls = await agent.call("list_artifacts", { project_id: P, folder: "Agent notes", recursive: true });
  assert.deepEqual(ls.data.artifacts.map((a) => a.title), ["Plan"]);
  const lf = await agent.call("list_folders", { project_id: P, parent: "Agent notes" });
  assert.deepEqual(lf.data.folders.map((f) => f.path), ["Agent notes/2026"]);
  // /v1 API key: list, create, filter
  assert.equal((await v1("GET", `/projects/${P}/folders?parent=Agent%20notes/2026`)).json.folders[0].name, "Q4");
  assert.equal((await v1("POST", `/projects/${P}/folders`, { path: "Agent notes/2027" })).status, 201);
  assert.equal((await v1("GET", `/projects/${P}/files?folder=Agent%20notes/2026/Q4`)).json.files.length, 1);
  // owner-only management
  const g = (await owner.req("POST", `${base}/grants`, { label: "folder bot", can_write: true })).body.token;
  const asAgent = (m, p, b) => fetch(h.appUi + p, { method: m, headers: { authorization: `Bearer ${g}`, "content-type": "application/json", "idempotency-key": key("g") }, body: b && JSON.stringify(b) }).then((r) => r.status);
  const q4 = await byPath("Agent notes/2026/Q4");
  assert.equal(await asAgent("PATCH", `${base}/folders/${q4.id}`, { name: "hijack" }), 403);
  assert.equal(await asAgent("DELETE", `${base}/folders/${q4.id}`), 403);
});

test("legacy free-text folders are adopted into the tree", async () => {
  // A pre-tree document: free-text folder label, no folder_id (as older Workers wrote it).
  const id = (await owner.req("POST", base + "/artifacts", { title: "Old", body: "# old" })).body.artifact_id;
  execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--command",
    `UPDATE artifacts SET folder = 'Legacy/Notes', folder_id = NULL WHERE id = '${id}'`], { cwd: ROOT, stdio: "ignore", env: { ...process.env, CI: "1" } });
  // Adoption runs once per project per isolate; a fresh project key path triggers it via a new project.
  const P2 = "tree-legacy";
  assert.equal((await owner.req("POST", "/api/projects", { id: P2, title: "Legacy" })).status, 201);
  const id2 = (await owner.req("POST", `/api/projects/${P2}/artifacts`, { title: "Old2", body: "# old" })).body.artifact_id;
  execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--command",
    `UPDATE artifacts SET folder = 'Legacy/Notes', folder_id = NULL WHERE id = '${id2}'`], { cwd: ROOT, stdio: "ignore", env: { ...process.env, CI: "1" } });
  const fs2 = (await owner.req("GET", `/api/projects/${P2}/folders`)).body.folders.map((f) => f.path);
  assert.deepEqual(fs2, ["Legacy", "Legacy/Notes"]);
  const a = (await owner.req("GET", `/api/projects/${P2}/artifacts?folder=Legacy/Notes`)).body.artifacts;
  assert.deepEqual(a.map((x) => x.id), [id2]);
});

test("App Connect: nested upload names create subfolders inside the destination, owned by the app", async () => {
  const app = await h.registerApp({ display_name: "Shots (local)", redirect_uris: ["http://localhost:5191/cb"], origins: [] });
  const pub = await h.connectPublisher(app, { project_id: P, destination: "new", new_folder_name: "Shots" });
  const png = makePng(9, 9);
  const b = await h.pub(pub.access_token, "POST", "/publisher/uploads", { idem: key("u"), body: { name: "2026/11/shot.png", mime: "image/png", size: png.length, sha256: sha(png) } });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.equal((await fetch(b.json.put_url, { method: "PUT", headers: { authorization: `Bearer ${pub.access_token}` }, body: png })).status, 200);
  const f = await h.pub(pub.access_token, "POST", `/publisher/uploads/${b.json.upload_id}/finish`, { idem: key("f"), body: {} });
  assert.equal(f.status, 200, JSON.stringify(f.json)); assert.equal(f.json.file.name, "2026/11/shot.png");
  const sub = await byPath("Shots/2026/11");
  assert.ok(sub, "subfolders created under the destination"); assert.equal(sub.publisher_id, pub.publisher_id);
  const doc = (await owner.req("GET", `${base}/artifacts/${f.json.file.file_id}`)).body.artifact;
  assert.equal(doc.folder, "Shots/2026/11"); assert.equal(doc.title, "shot.png");
  const dl = await fetch(`${h.api}/publisher/files/${f.json.file.file_id}/content`, { headers: { authorization: `Bearer ${pub.access_token}` } });
  assert.match(dl.headers.get("content-disposition"), /filename="shot\.png"/);
  // Too deep once under the destination: refused before any upload starts (the next begin is not blocked).
  const deepDest = await h.connectPublisher(app, { project_id: P, destination: "new", new_folder_name: "Deep" });
  const dd = await byPath("Deep");
  // Owner moves the destination 5 levels down (allowed: Deep becomes level 6); a name with 3 subfolders would reach 9.
  assert.equal((await owner.req("POST", base + "/folders", { path: "x1/x2/x3/x4/x5" })).status, 201);
  assert.equal((await owner.req("PATCH", `${base}/folders/${dd.id}`, { parent_id: (await byPath("x1/x2/x3/x4/x5")).id })).status, 200);
  const tooDeep = await h.pub(deepDest.access_token, "POST", "/publisher/uploads", { idem: key("u"), body: { name: "p/q/r/s.png", mime: "image/png", size: png.length, sha256: sha(png) } });
  assert.equal(tooDeep.status, 400, JSON.stringify(tooDeep.json));
  const fine = await h.pub(deepDest.access_token, "POST", "/publisher/uploads", { idem: key("u"), body: { name: "p.png", mime: "image/png", size: png.length, sha256: sha(png) } });
  assert.equal(fine.status, 201, "no stuck upload: " + JSON.stringify(fine.json));
  for (const bad of ["../x.png", "a/../b.png", "a//b.png", "1/2/3/4/5/6.png"]) assert.equal((await h.pub(pub.access_token, "POST", "/publisher/uploads", { idem: key("u"), body: { name: bad, mime: "image/png", size: 1, sha256: sha("x") } })).status, 400, bad);
  // The app's destination can't be deleted while connected; the owner can still rename it (paths follow).
  const dest = await byPath("Shots");
  assert.equal((await owner.req("DELETE", `${base}/folders/${(await byPath("Shots/2026/11")).id}`)).status, 409);
  const rn = await owner.req("PATCH", `${base}/folders/${dest.id}`, { name: "Screenshots" });
  assert.equal(rn.status, 200);
  assert.equal((await owner.req("GET", `${base}/artifacts/${f.json.file.file_id}`)).body.artifact.folder, "Screenshots/2026/11");
  assert.equal((await h.pub(pub.access_token, "GET", "/publisher/me")).json.destination.path, "Screenshots");
});

test("backup round trip keeps the tree and every document's folder", async () => {
  const P3 = "tree-backup";
  assert.equal((await owner.req("POST", "/api/projects", { id: P3, title: "Backup tree" })).status, 201);
  for (const [t, f] of [["a", "x/y/z"], ["b", "x"], ["c", ""]]) assert.equal((await owner.req("POST", `/api/projects/${P3}/artifacts`, { title: t, body: "# " + t, folder: f })).status, 201);
  const bk = await owner.req("GET", `/api/projects/${P3}/backup`);
  assert.equal(bk.status, 200, JSON.stringify(bk.body).slice(0, 300));
  assert.deepEqual(bk.body.folders.map((f) => f.path ?? f.name), ["x", "x/y", "x/y/z"]);
  const s2 = await startServer("nested-folders-restore", SERVER_PORTS["nested-folders-restore"]);
  try {
    const o2 = await s2.login();
    const r = await o2.req("POST", "/api/restore", bk.body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const fs3 = (await o2.req("GET", `/api/projects/${P3}/folders`)).body.folders.map((f) => f.path);
    assert.deepEqual(fs3, ["x", "x/y", "x/y/z"]);
    const arts = (await o2.req("GET", `/api/projects/${P3}/artifacts?folder=x&recursive=1`)).body.artifacts.map((a) => [a.title, a.folder]).sort();
    assert.deepEqual(arts, [["a", "x/y/z"], ["b", "x"]]);
  } finally { await s2.stop(); }
});

test("Chrome: browse folders, breadcrumbs, create a subfolder, upload into it, rename, move a document via Details", { skip: !haveChrome }, async () => {
  const P4 = "tree-ui";
  assert.equal((await owner.req("POST", "/api/projects", { id: P4, title: "UI tree" })).status, 201);
  assert.equal((await owner.req("POST", `/api/projects/${P4}/artifacts`, { title: "Inside", body: "# in", folder: "folder1/nesteda" })).status, 201);
  assert.equal((await owner.req("POST", `/api/projects/${P4}/artifacts`, { title: "At root", body: "# root" })).status, 201);
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    // Mobile first: the desktop pass then renames and moves things.
    for (const vp of [{ width: 390, height: 844, n: "mobile" }, { width: 1280, height: 900, n: "desktop" }]) {
      const page = await browser.newPage();
      const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
      await page.setViewport({ width: vp.width, height: vp.height });
      const [name, value] = owner.cookie.split("=");
      await page.setCookie({ name, value, url: h.appUi, httpOnly: true });
      await page.goto(h.appUi + `/#/p/${P4}`);
      await page.waitForFunction(() => [...document.querySelectorAll(".fd-sub a")].some((a) => a.textContent === "folder1"));
      await page.waitForFunction(() => [...document.querySelectorAll("ul.list:not(.fd-sub) a")].some((a) => a.textContent === "At root"));
      assert.equal(await page.evaluate(() => [...document.querySelectorAll("ul.list:not(.fd-sub) a")].map((a) => a.textContent).includes("Inside")), false, "root shows only its own items");
      await page.evaluate(() => [...document.querySelectorAll(".fd-sub a")].find((a) => a.textContent === "folder1").click());
      await page.waitForFunction(() => [...document.querySelectorAll(".fd-sub a")].some((a) => a.textContent === "nesteda"));

      await page.evaluate(() => [...document.querySelectorAll(".fd-sub a")].find((a) => a.textContent === "nesteda").click());
      await page.waitForFunction(() => [...document.querySelectorAll("ul.list:not(.fd-sub) a")].some((a) => a.textContent === "Inside"));
      const crumbs = await page.evaluate(() => [...document.querySelectorAll("#crumbs a, #crumbs span:not(.sep)")].map((e) => e.textContent));
      assert.deepEqual(crumbs.slice(-3), ["UI tree", "folder1", "nesteda"], JSON.stringify(crumbs));
      await page.screenshot({ path: `tmp/test-evidence/folders-${vp.n}.png`, fullPage: true });
      // Folder actions: an inline labelled group on desktop; one "Folder actions" menu on phones.
      const vis = () => page.evaluate(() => [...document.querySelectorAll(".fd-group button")].filter((b) => b.offsetParent).map((b) => b.textContent));
      if (vp.n === "mobile") {
        assert.deepEqual(await vis(), [], "collapsed behind the menu");
        await page.click(".fd-menu-btn");
        assert.deepEqual(await vis(), ["New subfolder", "Rename", "Move", "Delete folder"]);
        assert.equal(await page.$eval(".fd-menu-btn", (b) => b.getAttribute("aria-expanded")), "true");
        await page.screenshot({ path: `tmp/test-evidence/folders-mobile-menu.png` });
        await page.keyboard.press("Escape");
        assert.deepEqual(await vis(), []);
      } else {
        assert.equal(await page.$eval(".fd-menu-btn", (b) => getComputedStyle(b).display), "none");
        assert.deepEqual(await vis(), ["New subfolder", "Rename", "Move", "Delete folder"]);
      }
      if (vp.n === "desktop") {
        // New subfolder here
        await page.evaluate(() => [...document.querySelectorAll(".fd-actions button")].find((b) => b.textContent === "New subfolder").click());
        await page.type('.fd-panel input[aria-label="New folder name"]', "child");
        await page.evaluate(() => [...document.querySelectorAll(".fd-panel form button")].find((b) => b.textContent === "Create folder").click());
        await page.waitForFunction(() => [...document.querySelectorAll(".fd-sub a")].some((a) => a.textContent === "child"));
        assert.ok(await (async () => (await owner.req("GET", `/api/projects/${P4}/folders`)).body.folders.some((f) => f.path === "folder1/nesteda/child"))());
        // Upload into this folder
        const input = await page.$('input[type="file"]');
        await page.evaluate(() => [...document.querySelectorAll(".ph-actions button")].find((b) => /Upload/.test(b.textContent)).click());
        const png = `${ROOT}/tmp/fixtures/fixture.png`;
        await input.uploadFile(png);
        await page.evaluate(() => [...document.querySelectorAll("form button[type=submit]")].find((b) => b.textContent === "Upload").click());
        await page.waitForFunction(() => [...document.querySelectorAll("ul.list:not(.fd-sub) a")].some((a) => a.textContent === "fixture.png"), { timeout: 20000 });
        const up = (await owner.req("GET", `/api/projects/${P4}/artifacts?folder=folder1/nesteda`)).body.artifacts.map((a) => a.title).sort();
        assert.deepEqual(up, ["Inside", "fixture.png"]);
        // Rename this folder
        await page.evaluate(() => [...document.querySelectorAll(".fd-actions button")].find((b) => b.textContent === "Rename").click());
        await page.$eval('.fd-panel input[aria-label="Rename folder"]', (e) => { e.value = ""; });
        await page.type('.fd-panel input[aria-label="Rename folder"]', "renamed");
        await page.evaluate(() => [...document.querySelectorAll(".fd-panel form button")].find((b) => b.textContent === "Rename").click());
        await page.waitForFunction(() => [...document.querySelectorAll("#crumbs span, #crumbs a")].some((e) => e.textContent === "renamed"));
        // Move the document to the root via Details
        const doc = (await owner.req("GET", `/api/projects/${P4}/artifacts?folder=folder1/renamed`)).body.artifacts.find((a) => a.title === "Inside");
        await page.goto(h.appUi + `/#/p/${P4}/a/${doc.id}`);
        await page.waitForFunction(() => [...document.querySelectorAll("#crumbs a")].some((e) => e.textContent === "renamed"));
        await page.evaluate(() => [...document.querySelectorAll("summary")].find((e) => e.textContent === "Details").click());
        const field = await page.evaluateHandle(() => [...document.querySelectorAll("label")].find((l) => l.firstChild?.textContent === "Folder").querySelector("input"));
        assert.ok(await page.evaluate((e) => !!e.list && e.list.options.length >= 3, field), "folder suggestions");
        await page.evaluate((e) => { e.value = "elsewhere/new"; }, field);
        await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Save details").click());
        await page.waitForFunction(() => /Details saved/.test(document.body.innerText));
        assert.equal((await owner.req("GET", `/api/projects/${P4}/artifacts/${doc.id}`)).body.artifact.folder, "elsewhere/new");
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
