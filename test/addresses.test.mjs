// Project addresses (D10 B + D14 A): a workspace handle unique on the installation and a project slug unique in its
// workspace give each project the path <handle>/<slug>. Every entry point accepts the path wherever it accepts a
// project id (browser API, /v1, MCP, search), links use it, old /p/<id> links keep working, and a path someone
// can't open answers exactly like an unknown one. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startServer, mcpClient, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS.addresses;
const API = `http://127.0.0.1:${PORT}`;   // machine host (/v1, /mcp)
const APP = `http://localhost:${PORT}`;   // people host
let s, alice, bob, eve;
const P = {}, W = {}, D = {};
const sql = (q) => JSON.parse(execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", s.dir, "--json", "--command", q], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].results;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const v1 = async (token, method, path, body) => {
  const h = { authorization: `Bearer ${token}` };
  if (body !== undefined) { h["content-type"] = "application/json"; h["idempotency-key"] = key("v1"); }
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const enc = encodeURIComponent;

before(async () => {
  s = await startServer("addresses", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyBase: APP,
  });
  [alice, bob, eve] = [await s.loginAt(APP, "alice"), await s.loginAt(APP, "bob"), await s.loginAt(APP, "eve")];
});
after(async () => { await s?.stop(); });

test("workspaces get handles (chosen or derived; unique; reserved names refused); projects get slugs", async () => {
  // Personal workspaces get a derived handle with a random suffix (a handle never confirms a person exists).
  const mine = ok(await alice.req("GET", "/api/workspaces")).workspaces[0];
  assert.match(mine.handle, /^alice-[a-z2-9]{4}$/);
  W.alicePersonal = mine;
  const acme = ok(await alice.req("POST", "/api/workspaces", { name: "Acme Research", handle: "acme" }), 201);
  assert.equal(acme.handle, "acme");
  W.acme = acme;
  // Taken (by anyone, including a workspace you can't see), reserved, or malformed handles are refused.
  assert.equal((await bob.req("POST", "/api/workspaces", { name: "Mine", handle: "acme" })).status, 409);
  for (const h of ["api", "p", "settings", "auth", "Acme", "-x", "x-", "a".repeat(40), "a_b"])
    assert.equal((await bob.req("POST", "/api/workspaces", { name: "Bad", handle: h })).status, 400, h);
  // Without a handle, one is derived from the name (-2 etc. when taken).
  const derived = ok(await bob.req("POST", "/api/workspaces", { name: "Acme" }), 201);
  assert.match(derived.handle, /^acme-/);
  W.bobAcme = derived;

  const p = ok(await alice.req("POST", "/api/projects", { title: "Q3 Notes!", workspace_id: acme.id }), 201);
  assert.equal(p.slug, "q3-notes"); assert.equal(p.path, "acme/q3-notes");
  const dup = ok(await alice.req("POST", "/api/projects", { title: "Q3 notes", workspace_id: acme.id }), 201);
  assert.equal(dup.path, "acme/q3-notes-2", "derived slugs never collide inside a workspace");
  // The same slug in another workspace is fine; a chosen slug that's taken in this workspace is refused.
  const other = ok(await bob.req("POST", "/api/projects", { title: "Q3 notes", workspace_id: derived.id }), 201);
  assert.equal(other.path, `${derived.handle}/q3-notes`);
  assert.equal((await alice.req("POST", "/api/projects", { title: "x", slug: "q3-notes", workspace_id: acme.id })).status, 409);
  assert.equal((await alice.req("POST", "/api/projects", { title: "x", slug: "Bad Slug", workspace_id: acme.id })).status, 400);
  P.notes = p.id; P.notes2 = dup.id; P.bobNotes = other.id;
  P.private = ok(await alice.req("POST", "/api/projects", { title: "Diary" }), 201).id;
  D.note = ok(await alice.req("POST", `/api/projects/${P.notes}/artifacts`, { title: "Plan", body: "synthetic quokka plan" }), 201).artifact_id;
  // The project list shows each project's path.
  const list = ok(await alice.req("GET", "/api/projects")).projects;
  assert.equal(list.find((x) => x.id === P.notes).path, "acme/q3-notes");
  assert.equal(list.find((x) => x.id === P.private).path, `${mine.handle}/diary`);
});

test("browser API: the path works wherever the id does; others' paths look like unknown ones", async () => {
  const ref = enc("acme/q3-notes");
  const viaPath = ok(await alice.req("GET", `/api/projects/${ref}/artifacts`));
  const viaId = ok(await alice.req("GET", `/api/projects/${P.notes}/artifacts`));
  assert.deepEqual(viaPath.artifacts.map((a) => a.id), viaId.artifacts.map((a) => a.id));
  ok(await alice.req("PUT", `/api/projects/${ref}/artifacts/${D.note}`, { expected_revision: 1, body: "synthetic quokka plan v2" }));
  // Bob isn't in acme: its paths, an unknown path and a malformed one all answer the same 404.
  const a = await bob.req("GET", `/api/projects/${ref}/artifacts`);
  const b = await bob.req("GET", `/api/projects/${enc("acme/nope")}/artifacts`);
  const c = await bob.req("GET", `/api/projects/${enc("nope/nope")}/artifacts`);
  const d = await bob.req("GET", `/api/projects/${enc("ACME/../x")}/artifacts`);
  for (const r of [a, b, c, d]) { assert.equal(r.status, 404); assert.deepEqual(r.body, a.body); }
  assert.equal(a.body.error.code, "not_found");
});

test("old project links (/p/<id>) and address links both open the app; installation routes keep priority", async () => {
  for (const p of [`/p/${P.notes}`, `/p/${P.notes}/a/${D.note}`, "/acme/q3-notes", `/acme/q3-notes/a/${D.note}/preview`, "/acme/q3-notes/"]) {
    const r = await fetch(APP + p);
    assert.equal(r.status, 200, p); assert.match(r.headers.get("content-type"), /text\/html/);
  }
  // Reserved first segments are never treated as addresses.
  assert.equal((await fetch(APP + "/api/whatever")).status, 401);
  assert.equal((await fetch(APP + "/settings/x")).status, 404);
  assert.equal((await fetch(APP + "/acme/q3-notes/a/x/extra")).status, 404);
});

test("links (web_url) use the address; MCP, /v1 and search accept it", async () => {
  // API key on acme/q3-notes (created by path).
  const k = ok(await alice.req("POST", "/api/api-keys", { label: "acme agent", projects: [{ project_id: P.notes, access: "read_write" }] }), 201);
  const lp = await v1(k.secret, "GET", "/v1/projects");
  assert.equal(lp.json.projects[0].path, "acme/q3-notes");
  assert.equal(lp.json.projects[0].web_url, `${APP}/acme/q3-notes`);
  const f = await v1(k.secret, "GET", `/v1/projects/${enc("acme/q3-notes")}/files/${D.note}`);
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.equal(f.json.file.web_url, `${APP}/acme/q3-notes/a/${D.note}`);
  const created = await v1(k.secret, "POST", `/v1/projects/${enc("acme/q3-notes")}/files`, { title: "By path", body: "synthetic" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.web_url, `${APP}/acme/q3-notes/a/${created.json.artifact_id}`);
  // The key can't reach other projects by path either (same answer as an unknown project).
  const other = await v1(k.secret, "GET", `/v1/projects/${enc(`${W.bobAcme.handle}/q3-notes`)}/files`);
  const unknown = await v1(k.secret, "GET", `/v1/projects/${enc("acme/zzz")}/files`);
  assert.equal(other.status, 404); assert.deepEqual({ ...other.json.error, request_id: 0 }, { ...unknown.json.error, request_id: 0 });

  // Legacy MCP grant: project_id may be the path.
  const g = ok(await alice.req("POST", `/api/projects/${P.notes}/grants`, { label: "mcp", can_write: true }), 201);
  const m = await mcpClient(APP, g.token);
  try {
    const lst = await m.call("list_artifacts", { project_id: "acme/q3-notes" });
    assert.equal(lst.isError, false, JSON.stringify(lst.data));
    assert.ok(lst.data.artifacts.every((a) => a.web_url.startsWith(`${APP}/acme/q3-notes/a/`)));
    const rd = await m.call("read_artifact", { project_id: "acme/q3-notes", artifact_id: D.note });
    assert.equal(rd.data.artifact.web_url, `${APP}/acme/q3-notes/a/${D.note}`);
    const bad = await m.call("list_artifacts", { project_id: `${W.bobAcme.handle}/q3-notes` });
    assert.equal(bad.isError, true);
  } finally { await m.close(); }

  // Search: project_ids accepts paths; results link by address.
  const sr = ok(await alice.req("GET", `/api/search?query=quokka&project_ids=${enc("acme/q3-notes")}`));
  assert.equal(sr.results[0].artifact_id, D.note);
  assert.ok(sr.results[0].web_url.startsWith(`${APP}/acme/q3-notes/a/${D.note}?v=`));
  assert.equal((await bob.req("GET", `/api/search?query=quokka&project_ids=${enc("acme/q3-notes")}`)).status, 404);
  // Document text containing a link is never rewritten (only generated link fields are).
  const body = `see ${APP}/p/${P.notes}/a/${D.note}`;
  const doc = ok(await alice.req("POST", `/api/projects/${P.notes}/artifacts`, { title: "Has link", body }), 201);
  assert.equal(ok(await alice.req("GET", `/api/projects/${P.notes}/artifacts/${doc.artifact_id}`)).body, body);
});

test("changing addresses: owners/admins only; old address stops resolving; ids keep working; audit", async () => {
  // Members can't change the workspace address or a project's; Bob isn't even a member (404).
  assert.equal((await bob.req("PATCH", `/api/workspaces/${W.acme.id}`, { handle: "bobs" })).status, 404);
  assert.equal((await bob.req("PATCH", `/api/projects/${P.notes}`, { slug: "x" })).status, 404);
  const inv = ok(await alice.req("POST", `/api/workspaces/${W.acme.id}/invites`, { email: "eve@example.test", role: "member" }), 201);
  ok(await eve.req("POST", "/api/invites/accept", { token: inv.accept_url.split("/").pop() }));
  assert.equal((await eve.req("PATCH", `/api/workspaces/${W.acme.id}`, { handle: "eves" })).status, 403);
  assert.equal((await eve.req("PATCH", `/api/projects/${P.notes}`, { slug: "eves" })).status, 403);
  // Eve (member) can open the project by path.
  ok(await eve.req("GET", `/api/projects/${enc("acme/q3-notes")}/artifacts`));

  // A project slug change: new path works, old one stops; taken slugs refused.
  assert.equal((await alice.req("PATCH", `/api/projects/${P.notes}`, { slug: "q3-notes-2" })).status, 409);
  const up = ok(await alice.req("PATCH", `/api/projects/${P.notes}`, { slug: "quarterly", title: "Quarterly" }));
  assert.equal(up.path, "acme/quarterly"); assert.equal(up.title, "Quarterly");
  assert.equal((await alice.req("GET", `/api/projects/${enc("acme/q3-notes")}/artifacts`)).status, 404);
  ok(await alice.req("GET", `/api/projects/${enc("acme/quarterly")}/artifacts`));
  // The workspace handle change.
  assert.equal((await alice.req("PATCH", `/api/workspaces/${W.acme.id}`, { handle: W.bobAcme.handle })).status, 409);
  const w = ok(await alice.req("PATCH", `/api/workspaces/${W.acme.id}`, { handle: "acme-labs" }));
  assert.equal(w.handle, "acme-labs");
  assert.equal((await alice.req("GET", `/api/projects/${enc("acme/quarterly")}/artifacts`)).status, 404);
  ok(await alice.req("GET", `/api/projects/${enc("acme-labs/quarterly")}/artifacts`));
  ok(await alice.req("GET", `/api/projects/${P.notes}/artifacts`), 200);
  // The freed handle can be claimed by someone else (old links would then point at their workspace's projects only
  // if they also create the same slug, and even then only people with access there can open it).
  ok(await bob.req("PATCH", `/api/workspaces/${W.bobAcme.id}`, { handle: "acme" }));
  const acts = sql(`SELECT action FROM audits WHERE action IN ('workspace.handle','project.address') ORDER BY seq`).map((r) => r.action);
  assert.deepEqual(acts, ["project.address", "workspace.handle", "workspace.handle"]);
});

test("projects and workspaces that predate addresses get them on first use (and the previous Worker's rows too)", async () => {
  // Simulate rows written by a rolled-back Worker (no handle, no slug, no workspace_id).
  const me = ok(await alice.req("GET", "/api/me")).principal.id;
  sql(`INSERT INTO projects (id, owner_id, title, created_at) VALUES ('prj_legacy_addr_1', '${me}', 'Old Stuff', '2026-01-01T00:00:00Z')`);
  sql(`INSERT INTO projects (id, owner_id, title, created_at) VALUES ('prj_legacy_addr_2', '${me}', 'Old Stuff', '2026-01-02T00:00:00Z')`);
  const list = ok(await alice.req("GET", "/api/projects")).projects;
  const a = list.find((x) => x.id === "prj_legacy_addr_1"), b = list.find((x) => x.id === "prj_legacy_addr_2");
  assert.equal(a.path, `${W.alicePersonal.handle}/old-stuff`);
  assert.equal(b.path, `${W.alicePersonal.handle}/old-stuff-2`);
  ok(await alice.req("GET", `/api/projects/${enc(a.path)}/artifacts`));
  // The previous Worker keeps working on these rows: owner_id unchanged, workspace_id now the personal workspace.
  assert.deepEqual(sql("SELECT owner_id, workspace_id FROM projects WHERE id = 'prj_legacy_addr_1'")[0], { owner_id: me, workspace_id: `wsp_${me}` });
});
