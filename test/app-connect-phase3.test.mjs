// App Connect Phase 3 (contract app-connect/0.4 §6-§10): owner-registered apps, publisher OAuth (/v1 audience),
// consent (project + optional folder/root), own-files-only access, atomic complete snapshots, ordering and
// idempotency, owner-approved resume, revocation, source protection on EVERY write route, CORS, no pruning.
// Isolated synthetic harness only (no existing credentials, loopback only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { startAppConnectServer } from "./fixtures/app-connect-harness.mjs";
import { synthMeasurements, toCsv } from "./fixtures/measurements-synthetic.mjs";
import { ROOT, key, mcpClient, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS.acp3, CB = "http://localhost:5173/agent-library/callback", ORIGIN = "http://localhost:5173";
const M = "agentlib.measurements/1";
let h, owner, app, app2, P;
const sha = (s) => createHash("sha256").update(s).digest("hex");
// Async on purpose: a synchronous child process blocks the event loop for seconds, so fetch cannot retire idle keep-alive
// sockets that wrangler dev (Node http, 5 s keepAliveTimeout) has already closed, and the next request fails "other side closed".
const sql = async (q) => (await promisify(execFile)("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", h.dir, "--json", "--command", q], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } })).stdout.toString();
const rows = async (q) => JSON.parse(await sql(q))[0].results;

function snapBody(rev, records, extra = {}) {
  const json = JSON.stringify({ schema: M, meta: { source_app: "synthetic" }, records });
  return { source_revision: rev, exported_at: "2026-10-03T00:00:12-07:00", coverage: { from: records[0]?.recorded_at ?? null, to: records.at(-1)?.recorded_at ?? null },
    files: [{ name: "measurements.json", kind: "json", role: "authoritative", schema: M, content: json },
            { name: "measurements.csv", kind: "csv", role: "derived", derived_from: "measurements.json", schema: M, content: toCsv(records) }], ...extra };
}
const commit = (tok, body, idem = key("snap")) => h.pub(tok, "POST", "/publisher/snapshots", { body, idem });

before(async () => {
  h = await startAppConnectServer({ port: PORT });
  owner = await h.owner();
  for (const [id, title] of [["notes-test", "Notes"], ["other-test", "Other"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
  app = await h.registerApp({ display_name: "Field Notes (local)", redirect_uris: [CB], origins: [ORIGIN] });
  app2 = await h.registerApp({ display_name: "Trip Log (local)", redirect_uris: ["http://127.0.0.1:5174/cb"], origins: [] });
  P = await h.connectPublisher(app, { project_id: "notes-test", destination: "new", new_folder_name: "Field Notes" });
});
after(async () => { await h?.stop(); });

test("committed configs: test hooks absent; no pruning possible (schema CHECK)", async () => {
  for (const f of ["wrangler.local.toml", "wrangler.example.toml", "scripts/self-host/setup.mjs"])
    assert.ok(!/AC_TEST_HOOKS/.test(readFileSync(join(ROOT, f), "utf8")), `test hooks never in ${f}`);
  // App Connect is opt-in per installation, never on in the local config (see app-connect-phase2.test.mjs).
  assert.equal(parseToml(readFileSync(join(ROOT, "wrangler.local.toml"), "utf8")).vars?.APP_CONNECT_ENABLED, undefined);
  // The CHECK constraint makes auto_prune_enabled = 1 impossible (wrangler reports it on stdout).
  await assert.rejects(() => sql(`INSERT INTO publishers (id, owner_principal_id, principal_id, app_client_id, display_name, project_id, created_at, auto_prune_enabled) VALUES ('pub_x','h','h','a','x','p','t',1)`),
    (e) => /CHECK constraint failed/.test(String(e.stdout) + String(e.stderr) + e.message));
});

test("app registration is owner-only; DCR cannot obtain publish; bad redirect/origin refused", async () => {
  const r = await fetch(`${h.appUi}/api/app-clients`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  for (const bad of [{ redirect_uris: ["http://evil.example/cb"] }, { redirect_uris: ["https://x.example/cb#f"] }, { redirect_uris: [CB], origins: ["http://evil.example"] }, { redirect_uris: [] }])
    assert.equal((await owner.req("POST", "/api/app-clients", { display_name: "x", origins: [], ...bad })).status, 400, JSON.stringify(bad));
  const dcr = await fetch(`${h.issuer}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "sneaky", redirect_uris: ["http://127.0.0.1:5999/cb"], token_endpoint_auth_method: "none", scope: "agentlib:publish" }) });
  assert.equal(dcr.status, 400, "DCR with agentlib:publish refused");
  // A DCR client (no publish scope) can't get a /v1 token either.
  const dcr2 = await fetch(`${h.issuer}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "mcp-ish", redirect_uris: ["http://127.0.0.1:5999/cb"], token_endpoint_auth_method: "none" }) });
  const cid = (await dcr2.json()).client_id;
  const a = await h.authorize({ client_id: cid, redirect_uris: ["http://127.0.0.1:5999/cb"] }, {}, { resource: h.resource });
  assert.ok(!a.code, "unregistered app cannot reach publisher consent");
  assert.match(a.html ?? "", /not registered for publishing/);
});

test("OAuth: issuer/iss/state, /v1 audience, publish scope only, token separation from /mcp", async () => {
  assert.equal(P.iss, h.issuer); assert.equal(P.state, P.sentState);
  assert.equal(P.token.resource, h.resource); assert.equal(P.token.scope, "agentlib:publish offline_access");
  assert.equal(P.token.expires_in, 900); assert.ok(P.refresh_token);
  const prm = await (await fetch(`${h.issuer}/.well-known/oauth-protected-resource/v1`)).json();
  assert.equal(prm.resource, h.resource); assert.deepEqual(prm.authorization_servers, [h.issuer]);
  // publisher token on /mcp -> 401; on non-publisher /v1 -> 401 (those accept only alk_ keys)
  const mcp = await fetch(`${h.issuer}/mcp`, { method: "POST", headers: { authorization: `Bearer ${P.access_token}`, "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(mcp.status, 401);
  assert.equal((await h.pub(P.access_token, "GET", "/projects")).status, 401);
  // wrong scope / extra scope / wrong redirect / wrong resource are refused before consent
  for (const opts of [{ scope: "agentlib:read" }, { scope: "agentlib:publish agentlib:write" }, { redirect_uri: "http://localhost:5173/other" }])
    assert.ok(!(await h.authorize(app, { project_id: "notes-test", destination: "root" }, opts)).code, JSON.stringify(opts));
  const toMcp = await h.authorize(app, { project_id: "notes-test", destination: "root" }, { resource: `${h.issuer}/mcp` });
  assert.ok(!toMcp.code && /only connect as a publisher/.test(toMcp.html));
  // anonymous publisher API -> 401 JSON challenge
  const anon = await h.pub(null, "GET", "/publisher/me");
  assert.equal(anon.status, 401); assert.match(anon.headers.get("www-authenticate") ?? "", /Bearer/);
});

test("consent page shows project/destination choices, first project preselected, Field Notes default, reader audience", async () => {
  const a = await h.authorize(app, { project_id: "notes-test", destination: "root", decision: "deny" });
  assert.equal(a.error_param, "access_denied"); assert.equal(a.code, null);
  const html = a.consentHtml;
  assert.match(html, /<option value="notes-test" selected>Notes/);
  assert.match(html, /name="new_folder_name"[^>]*value="Field Notes"/, "default folder name is the app name without its (suffix)");
  assert.match(html, /No folder \(project root\)/);
  // One folder field (hidden controls still submit; /authorize caps bodies at 16 KiB), grouped per project.
  assert.equal(html.match(/name="destination"/g).length, 1, "exactly one destination control");
  assert.doesNotMatch(html, /name="destination:/);
  assert.match(html, /<optgroup label="Folders in Notes" data-i="0"><option value="folder:fld_[^"]+">Field Notes</);
  assert.match(html, /including future exports/); assert.match(html, /cannot edit them/);
  assert.match(html, new RegExp(`name="resume" value="${P.publisher_id}">`), "earlier publisher offered for owner-approved resume, not preselected");
  assert.match(html, /Keep publishing to Notes \/ Field Notes/);
  assert.match(html, /name="resume" value="new" checked>/, "a new destination stays the default: resuming signs out the older session");
});

test("publisher /me, empty current snapshot, then atomic commit with server manifest and verbatim source strings", async () => {
  const me = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
  assert.equal(me.publisher_id, P.publisher_id); assert.equal(me.project.id, "notes-test");
  assert.equal(me.destination.type, "folder"); assert.equal(me.destination.name, "Field Notes"); assert.match(me.destination.folder_id, /^fld_/);
  assert.equal(me.current_source_revision, null); assert.equal(me.current_snapshot_id, null);
  assert.deepEqual(me.retention, { mode: "keep_all", auto_prune_enabled: false });
  assert.deepEqual((await h.pub(P.access_token, "GET", "/publisher/snapshots/current")).json, { snapshot: null });

  const recs = synthMeasurements(5, { seed: 1 });
  const body = snapBody(1, recs);
  const c = await commit(P.access_token, body);
  assert.equal(c.status, 201, c.text);
  const s = c.json.snapshot;
  assert.equal(c.json.already_current, false); assert.equal(s.status, "current"); assert.equal(s.source_revision, 1);
  assert.equal(s.exported_at, "2026-10-03T00:00:12-07:00"); assert.equal(s.coverage.from, recs[0].recorded_at);
  assert.match(s.committed_at, /Z$/);
  const j = s.files.find((f) => f.name === "measurements.json"), cv = s.files.find((f) => f.name === "measurements.csv");
  assert.equal(j.role, "authoritative"); assert.equal(j.record_count, 5); assert.equal(j.sha256, sha(body.files[0].content));
  assert.equal(cv.role, "derived"); assert.equal(cv.derived_from, "measurements.json"); assert.equal(cv.row_count, 5);
  // manifest content
  const man = await h.pub(P.access_token, "GET", `/publisher/files/${s.manifest.file_id}/content`);
  const md = JSON.parse(man.text);
  assert.equal(md.manifest_version, "agentlib.snapshot-manifest/1"); assert.equal(md.snapshot_id, s.snapshot_id);
  assert.equal(md.source_revision, 1); assert.equal(md.exported_at, body.exported_at); assert.deepEqual(md.files, s.files);
  assert.equal(sha(man.text), s.manifest.sha256);
  // content byte-exact; recorded_at verbatim via the records query (reader side)
  assert.equal((await h.pub(P.access_token, "GET", `/publisher/files/${j.file_id}/content`)).text, body.files[0].content);
  const me2 = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
  assert.equal(me2.current_source_revision, 1); assert.equal(me2.current_snapshot_id, s.snapshot_id);
  // files are in the chosen folder
  const fr = (await rows(`SELECT folder_id, publisher_id FROM artifacts WHERE id = '${j.file_id}'`))[0];
  assert.equal(fr.folder_id, me.destination.folder_id); assert.equal(fr.publisher_id, P.publisher_id);
});

test("ordering + idempotency: replay, key reuse, already_current ack, source_revision_conflict, stale", async () => {
  const recs = synthMeasurements(6, { seed: 2 });
  const k = key("s2");
  const a = await commit(P.access_token, snapBody(2, recs), k);
  assert.equal(a.status, 201);
  const replay = await commit(P.access_token, snapBody(2, recs), k);
  assert.equal(replay.status, 201); assert.equal(replay.json.idempotent_replay, true); assert.equal(replay.json.snapshot.snapshot_id, a.json.snapshot.snapshot_id);
  const reuse = await commit(P.access_token, snapBody(3, recs), k);
  assert.equal(reuse.status, 422); assert.equal(reuse.json.error.code, "idempotency_key_reused");
  // lost response, new key, identical content -> 200 already_current, no new revisions
  const before = (await rows(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${P.publisher_id}')`))[0].n;
  const ack = await commit(P.access_token, snapBody(2, recs));
  assert.equal(ack.status, 200); assert.equal(ack.json.already_current, true); assert.equal(ack.json.snapshot.snapshot_id, a.json.snapshot.snapshot_id);
  assert.equal((await rows(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${P.publisher_id}')`))[0].n, before);
  const conflict = await commit(P.access_token, snapBody(2, synthMeasurements(6, { seed: 99 })));
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, "source_revision_conflict");
  assert.equal(conflict.json.error.current_source_revision, 2); assert.equal(conflict.json.error.current_snapshot_id, a.json.snapshot.snapshot_id);
  assert.deepEqual(conflict.json.error.current_files.map((f) => f.name).sort(), ["measurements.csv", "measurements.json"], "the publisher's own files (manifest is server-written)");
  const stale = await commit(P.access_token, snapBody(1, recs));
  assert.equal(stale.status, 409); assert.equal(stale.json.error.code, "stale_source_revision"); assert.equal(stale.json.error.current_source_revision, 2);
  // history newest first, statuses, pagination
  const hist = (await h.pub(P.access_token, "GET", "/publisher/snapshots?limit=1")).json;
  assert.equal(hist.snapshots.length, 1); assert.equal(hist.snapshots[0].source_revision, 2); assert.equal(hist.snapshots[0].status, "current"); assert.equal(hist.next_cursor, "2");
  const hist2 = (await h.pub(P.access_token, "GET", "/publisher/snapshots?limit=1&cursor=2")).json;
  assert.equal(hist2.snapshots[0].source_revision, 1); assert.equal(hist2.snapshots[0].status, "previous");
  assert.equal((await h.pub(P.access_token, "GET", `/publisher/snapshots/${hist2.snapshots[0].snapshot_id}`)).json.snapshot.status, "previous");
});

test("invalid snapshots change nothing (atomic): bad file, no/two authoritative JSON, csv authoritative, reserved name", async () => {
  const cur = (await h.pub(P.access_token, "GET", "/publisher/snapshots/current")).json.snapshot;
  const recs = synthMeasurements(3, { seed: 3 });
  const good = snapBody(10, recs);
  const cases = [
    [{ ...good, files: [good.files[0], { ...good.files[1], content: "id,recorded_at\nbroken" }] }, 422, "invalid_content"],
    [{ ...good, files: [good.files[1]] }, 422, "invalid_content"],
    [{ ...good, files: [good.files[0], { ...good.files[0], name: "b.json" }] }, 422, "invalid_content"],
    [{ ...good, files: [good.files[0], { ...good.files[1], role: "authoritative" }] }, 422, "invalid_content"],
    [{ ...good, files: [good.files[0], { name: "manifest.json", kind: "json", role: "derived", content: "{}" }] }, 400, "invalid_input"],
    [{ ...good, files: [{ ...good.files[0], content: JSON.stringify({ schema: M, records: [{ ...recs[0], date: "2026-02-30" }] }) }] }, 422, "invalid_content"],
    [{ ...good, source_revision: 0 }, 400, "invalid_input"],
    [{ ...good, exported_at: "x".repeat(65) }, 400, "invalid_input"],
  ];
  for (const [b, st, code] of cases) {
    const r = await commit(P.access_token, b);
    assert.equal(r.status, st, r.text); assert.equal(r.json.error.code, code);
  }
  const bad = await commit(P.access_token, cases[0][0]);
  assert.equal(bad.json.error.file, "measurements.csv");
  assert.equal((await h.pub(P.access_token, "GET", "/publisher/snapshots/current")).json.snapshot.snapshot_id, cur.snapshot_id, "current unchanged");
});

test("tombstone: a file missing from a later snapshot stays, marked not in current snapshot", async () => {
  const recs = synthMeasurements(4, { seed: 4 });
  const b = snapBody(20, recs);
  b.files.push({ name: "extra.csv", kind: "csv", role: "derived", content: "a,b\r\n1,2\r\n" });
  assert.equal((await commit(P.access_token, b)).status, 201);
  const b2 = snapBody(21, recs);
  const r = await commit(P.access_token, b2);
  assert.equal(r.status, 201);
  const files = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files;
  const extra = files.find((f) => f.name === "extra.csv");
  assert.equal(extra.in_current_snapshot, false); assert.equal(extra.trashed, false);
  assert.ok(files.find((f) => f.name === "measurements.json").in_current_snapshot);
  assert.ok(!r.json.snapshot.files.some((f) => f.name === "extra.csv"));
  // Version history: published versions record the publishing app as their access path (docs/version-history.md).
  const mj = files.find((f) => f.name === "measurements.json");
  const hist = (await owner.req("GET", `/api/projects/notes-test/artifacts/${mj.file_id}/history`)).body.revisions;
  assert.deepEqual([hist[0].via.kind, hist[0].via.id, hist[0].via.label, hist[0].who], ["publisher", P.publisher_id, "Field Notes (local)", "Field Notes (local)"]);
});

test("publisher sees only its own files, even at project root / shared folder; another publisher's IDs are 404", async () => {
  const Q = await h.connectPublisher(app2, { project_id: "notes-test", destination: "root" });
  assert.notEqual(Q.publisher_id, P.publisher_id);
  assert.deepEqual((await h.pub(Q.access_token, "GET", "/publisher/me")).json.destination, { type: "root" });
  assert.equal((await commit(Q.access_token, snapBody(1, synthMeasurements(2, { seed: 5 })))).status, 201);
  // An ordinary owner note at the root and in P's folder
  const fld = (await h.pub(P.access_token, "GET", "/publisher/me")).json.destination.folder_id;
  const note = (await owner.req("POST", "/api/projects/notes-test/artifacts", { title: "owner note", body: "hi" })).body.artifact_id;
  const inFolder = (await owner.req("POST", "/api/projects/notes-test/artifacts", { kind: "csv", title: "owner csv in WW folder", content: "a\n1\n", folder_id: fld })).body.artifact_id;
  const pFiles = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files.map((f) => f.file_id);
  const qFiles = (await h.pub(Q.access_token, "GET", "/publisher/files")).json.files.map((f) => f.file_id);
  assert.equal(pFiles.filter((x) => qFiles.includes(x)).length, 0);
  for (const id of [...qFiles, note, inFolder]) {
    assert.equal((await h.pub(P.access_token, "GET", `/publisher/files/${id}`)).status, 404, id);
    assert.equal((await h.pub(P.access_token, "GET", `/publisher/files/${id}/content`)).status, 404, id);
  }
  // same file NAME in two publishers is two different files
  assert.ok(!pFiles.includes(qFiles[0]));
  const qSnap = (await h.pub(Q.access_token, "GET", "/publisher/snapshots/current")).json.snapshot;
  assert.equal((await h.pub(P.access_token, "GET", `/publisher/snapshots/${qSnap.snapshot_id}`)).status, 404);
  // publisher tokens can't reach Phase 1/2 routes, folders, or other projects
  for (const p of ["/projects", "/projects/notes-test/files", "/projects/notes-test/folders", "/projects/other-test/files"]) assert.equal((await h.pub(P.access_token, "GET", p)).status, 401, p);
});

test("readers discover exports (REST key, OAuth-MCP-facing service, records); every non-publisher write route is protected_source", async () => {
  const kRw = (await owner.req("POST", "/api/api-keys", { label: "reader rw", lifetime_days: 1, projects: [{ project_id: "notes-test", access: "read_write" }] })).body.secret;
  const cur = (await h.pub(P.access_token, "GET", "/publisher/snapshots/current")).json.snapshot;
  const jf = cur.files.find((f) => f.name === "measurements.json").file_id, cf = cur.files.find((f) => f.name === "measurements.csv").file_id;
  const api = (method, path, body, headers = {}) => fetch(`${h.api}${path}`, { method, headers: { authorization: `Bearer ${kRw}`, "content-type": "application/json", "idempotency-key": key("w"), "user-agent": "t", ...headers }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  // discover
  const list = await api("GET", "/projects/notes-test/files?kind=json");
  const seen = list.json.files.find((f) => f.id === jf);
  assert.ok(seen, "reader lists the export"); assert.deepEqual(seen.publisher, { id: P.publisher_id, display_name: "Field Notes (local)", protected: true });
  const rec = await api("GET", `/projects/notes-test/files/${jf}/records`);
  assert.equal(rec.status, 200); assert.ok(rec.json.records.every((r) => typeof r.recorded_at === "string"));
  // REST write routes
  const curRev = (await api("GET", `/projects/notes-test/files/${jf}`)).json.revision.rev;
  for (const [fid, content] of [[jf, '{"schema":"agentlib.measurements/1","records":[]}'], [cf, "id,recorded_at,date,metric,value,unit,source_id\n"]]) {
    const w = await api("PUT", `/projects/notes-test/files/${fid}`, { expected_revision: curRev, content });
    assert.equal(w.status, 403, "REST PUT"); assert.equal(w.json.error.code, "protected_source");
  }
  // owner-host /api with an agent grant: save, metadata (rename/trash), restore, comment, upload begin
  const grant = (await owner.req("POST", "/api/projects/notes-test/grants", { label: "agent rw", can_write: true })).body.token;
  const g = (method, path, body) => fetch(`${h.appUi}${path}`, { method, headers: { authorization: `Bearer ${grant}`, "content-type": "application/json", "idempotency-key": key("g") }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const base = `/api/projects/notes-test/artifacts/${jf}`;
  const meta = (await g("GET", base)).json.artifact.meta_version;
  for (const [m, p, b, what] of [
    ["PUT", base, { expected_revision: curRev, content: "{}" }, "save"],
    ["PATCH", base, { expected_meta_version: meta, title: "renamed" }, "rename"],
    ["PATCH", base, { expected_meta_version: meta, trashed: true }, "trash"],
    ["POST", `${base}/restore`, { expected_revision: curRev, from_revision: 1 }, "restore"],
    ["POST", `${base}/comments`, { revision: curRev, body: "edit?" }, "comment"],
    ["POST", "/api/projects/notes-test/uploads", { artifact_id: jf, expected_revision: curRev, mime: "application/octet-stream", size: 3, sha256: sha("abc") }, "upload begin"],
  ]) {
    const r = await g(m, p, b);
    assert.equal(r.status, 403, what); assert.equal(r.json.error.code, "protected_source", what);
  }
  // OAuth-MCP save path uses the same service: grant MCP (legacy /mcp on the owner host) save_markdown on a json file
  // is refused by kind first; the protection is proven at the service layer above. Owner content edit also refused:
  const ownerSave = await owner.req("PUT", base, { expected_revision: curRev, content: "{}" });
  assert.equal(ownerSave.status, 403); assert.equal(ownerSave.body.error.code, "protected_source");
  // nothing changed
  assert.equal((await api("GET", `/projects/notes-test/files/${jf}`)).json.revision.rev, curRev);
  assert.equal((await rows(`SELECT COUNT(*) AS n FROM comments WHERE artifact_id = '${jf}'`))[0].n, 0);
});

test("in-batch protection: even a forged write that skips the service pre-check cannot modify a publisher file", async () => {
  // Simulate a race: an ordinary file becomes publisher-owned between read and commit (set publisher_id directly),
  // then an agent save must fail inside the batch.
  const kRw = (await owner.req("POST", "/api/api-keys", { label: "race", lifetime_days: 1, projects: [{ project_id: "notes-test", access: "read_write" }] })).body.secret;
  const c = await fetch(`${h.api}/projects/notes-test/files`, { method: "POST", headers: { authorization: `Bearer ${kRw}`, "content-type": "application/json", "idempotency-key": key("c"), "user-agent": "t" },
    body: JSON.stringify({ title: "race doc", body: "v1" }) }).then((r) => r.json());
  await sql(`UPDATE artifacts SET publisher_id = '${P.publisher_id}' WHERE id = '${c.artifact_id}'`);
  const w = await fetch(`${h.api}/projects/notes-test/files/${c.artifact_id}`, { method: "PUT", headers: { authorization: `Bearer ${kRw}`, "content-type": "application/json", "idempotency-key": key("w"), "user-agent": "t" },
    body: JSON.stringify({ expected_revision: 1, body: "v2" }) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal(w.status, 403); assert.equal(w.json.error.code, "protected_source");
  assert.equal((await rows(`SELECT head_rev FROM artifacts WHERE id = '${c.artifact_id}'`))[0].head_rev, 1);
});

test("MCP write tools (grant MCP on the owner host) are refused on publisher-owned files", async () => {
  const grant = (await owner.req("POST", "/api/projects/notes-test/grants", { label: "mcp agent", can_write: true })).body.token;
  const md = (await owner.req("POST", "/api/projects/notes-test/artifacts", { title: "will be protected", body: "v1" })).body.artifact_id;
  await sql(`UPDATE artifacts SET publisher_id = '${P.publisher_id}' WHERE id = '${md}'`);
  const m = await mcpClient(h.appUi, grant, "protect-test");
  try {
    const save = await m.call("save_markdown", { project_id: "notes-test", artifact_id: md, expected_revision: 1, body: "v2", idempotency_key: key("m") });
    assert.equal(save.isError, true); assert.match(JSON.stringify(save.data), /protected_source/);
    const trash = await m.call("trash_artifact", { project_id: "notes-test", artifact_id: md, expected_meta_version: 1, idempotency_key: key("m") });
    assert.equal(trash.isError, true); assert.match(JSON.stringify(trash.data), /protected_source/);
    const com = await m.call("add_comment", { project_id: "notes-test", artifact_id: md, revision: 1, body: "x", idempotency_key: key("m") });
    assert.equal(com.isError, true); assert.match(JSON.stringify(com.data), /protected_source/);
    const read = await m.call("read_artifact", { project_id: "notes-test", artifact_id: md });
    assert.equal(read.isError, false, "reading is still allowed");
  } finally { await m.close(); }
  assert.equal((await rows(`SELECT head_rev, trashed_at FROM artifacts WHERE id = '${md}'`))[0].head_rev, 1);
});

test("OAuth MCP agents (ChatGPT/Claude path) discover exports and read records, but every MCP write is protected_source", async () => {
  const agent = await h.connectMcpAgent({ "notes-test": "write" });
  const tools = (await agent.list()).map((t) => t.name);
  assert.ok(tools.includes("read_records") && tools.includes("save_markdown"));
  const cur = (await h.pub(P.access_token, "GET", "/publisher/snapshots/current")).json.snapshot;
  const jf = cur.files.find((f) => f.name === "measurements.json").file_id;
  const lst = await agent.call("list_artifacts", { project_id: "notes-test", kind: "json" });
  assert.equal(lst.isError, false);
  assert.ok(lst.data.artifacts.some((a) => a.id === jf && a.publisher?.protected === true), "agent discovers the export");
  const rd = await agent.call("read_artifact", { project_id: "notes-test", artifact_id: jf });
  assert.equal(rd.isError, false); assert.equal(typeof rd.data.content, "string"); assert.equal(rd.data.truncated, false);
  const rr = await agent.call("read_records", { project_id: "notes-test", artifact_id: jf, limit: 2 });
  assert.equal(rr.isError, false); assert.equal(rr.data.records.length, 2); assert.equal(typeof rr.data.records[0].recorded_at, "string");
  // A Markdown export (made publisher-owned) is refused for save_markdown on the OAuth MCP host.
  const md = (await owner.req("POST", "/api/projects/notes-test/artifacts", { title: "pub md", body: "v1" })).body.artifact_id;
  await sql(`UPDATE artifacts SET publisher_id = '${P.publisher_id}' WHERE id = '${md}'`);
  const save = await agent.call("save_markdown", { project_id: "notes-test", artifact_id: md, expected_revision: 1, body: "hacked", idempotency_key: key("m") });
  assert.equal(save.isError, true); assert.equal(save.data.error.code, "protected_source");
  assert.equal((await rows(`SELECT head_rev FROM artifacts WHERE id = '${md}'`))[0].head_rev, 1);
});

test("owner trashes an exported file -> commit 409 destination_file_trashed, nothing changes; restore -> commit OK", async () => {
  const cur = (await h.pub(P.access_token, "GET", "/publisher/snapshots/current")).json.snapshot;
  const cf = cur.files.find((f) => f.name === "measurements.csv").file_id;
  const meta = (await owner.req("GET", `/api/projects/notes-test/artifacts/${cf}`)).body.artifact.meta_version;
  assert.equal((await owner.req("PATCH", `/api/projects/notes-test/artifacts/${cf}`, { expected_meta_version: meta, trashed: true })).status, 200, "owner may trash");
  const r = await commit(P.access_token, snapBody(30, synthMeasurements(2, { seed: 6 })));
  assert.equal(r.status, 409); assert.equal(r.json.error.code, "destination_file_trashed"); assert.equal(r.json.error.name, "measurements.csv"); assert.equal(r.json.error.file_id, cf);
  assert.equal((await h.pub(P.access_token, "GET", "/publisher/me")).json.current_source_revision, cur.source_revision);
  const meta2 = (await owner.req("GET", `/api/projects/notes-test/artifacts?trashed=1`)).body.artifacts.find((a) => a.id === cf).meta_version;
  assert.equal((await owner.req("PATCH", `/api/projects/notes-test/artifacts/${cf}`, { expected_meta_version: meta2, trashed: false })).status, 200);
  assert.equal((await commit(P.access_token, snapBody(30, synthMeasurements(2, { seed: 6 })))).status, 201);
});

test("race (deterministic): owner trashes an exported file/manifest between pre-check and batch -> nothing lands", async () => {
  const pause = { "x-test-pause-before-batch-ms": "1500" };
  for (const target of ["measurements.csv", "manifest.json"]) {
    const before = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
    const files = (await h.pub(P.access_token, "GET", "/publisher/files")).json.files;
    const fid = files.find((f) => f.name === target).file_id;
    const revCount = async () => (await rows(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${P.publisher_id}')`))[0].n;
    const snapCount = async () => (await rows(`SELECT COUNT(*) AS n FROM snapshots WHERE publisher_id = '${P.publisher_id}'`))[0].n;
    const [r0, s0] = [await revCount(), await snapCount()];
    const rev = before.current_source_revision + 1;
    const pending = h.pub(P.access_token, "POST", "/publisher/snapshots", { body: snapBody(rev, synthMeasurements(3, { seed: 40 + rev })), idem: key("race"), headers: pause });
    await new Promise((r) => setTimeout(r, 400));
    const meta = (await owner.req("GET", `/api/projects/notes-test/artifacts/${fid}`)).body.artifact.meta_version;
    assert.equal((await owner.req("PATCH", `/api/projects/notes-test/artifacts/${fid}`, { expected_meta_version: meta, trashed: true })).status, 200);
    const r = await pending;
    assert.equal(r.status, 409, `${target}: ${r.text}`); assert.equal(r.json.error.code, "destination_file_trashed"); assert.equal(r.json.error.file_id, fid);
    const after = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
    assert.equal(after.current_snapshot_id, before.current_snapshot_id, `${target}: pointer unchanged`);
    assert.equal(after.current_source_revision, before.current_source_revision);
    assert.equal(await revCount(), r0, `${target}: no revisions written`); assert.equal(await snapCount(), s0, `${target}: no snapshot row`);
    // current snapshot still complete: every file's revision exists
    const cur = (await h.pub(P.access_token, "GET", "/publisher/snapshots/current")).json.snapshot;
    for (const f of [...cur.files, cur.manifest]) assert.equal((await rows(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '${f.file_id}' AND rev_no = ${f.revision}`))[0].n, 1);
    const m2 = (await owner.req("GET", `/api/projects/notes-test/artifacts?trashed=1`)).body.artifacts.find((a) => a.id === fid).meta_version;
    assert.equal((await owner.req("PATCH", `/api/projects/notes-test/artifacts/${fid}`, { expected_meta_version: m2, trashed: false })).status, 200);
  }
});

test("race (deterministic): two concurrent commits -> exactly one lands; loser writes nothing", async () => {
  const before = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
  const r0 = (await rows(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${P.publisher_id}')`))[0].n;
  const slow = h.pub(P.access_token, "POST", "/publisher/snapshots", { body: snapBody(before.current_source_revision + 2, synthMeasurements(3, { seed: 60 })), idem: key("slow"), headers: { "x-test-pause-before-batch-ms": "1500" } });
  await new Promise((r) => setTimeout(r, 400));
  const fast = await commit(P.access_token, snapBody(before.current_source_revision + 1, synthMeasurements(3, { seed: 61 })));
  assert.equal(fast.status, 201);
  const s = await slow;
  assert.equal(s.status, 409, s.text); assert.equal(s.json.error.code, "conflict");
  const after = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
  assert.equal(after.current_snapshot_id, fast.json.snapshot.snapshot_id);
  assert.equal((await rows(`SELECT COUNT(*) AS n FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE publisher_id = '${P.publisher_id}')`))[0].n, r0 + 3, "only the winner's 3 revisions (2 files + manifest)");
});

test("refresh: rotation, single use, resource pinned; resume is owner-approved, keeps identity, invalidates old tokens", async () => {
  const t1 = await h.token({ grant_type: "refresh_token", refresh_token: P.refresh_token, client_id: app.client_id });
  assert.equal(t1.status, 200, JSON.stringify(t1.body)); assert.notEqual(t1.body.refresh_token, P.refresh_token);
  const again = await h.token({ grant_type: "refresh_token", refresh_token: P.refresh_token, client_id: app.client_id });
  assert.equal(again.status, 400); assert.equal(again.body.error, "invalid_grant");
  const wrongRes = await h.token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: app.client_id, resource: `${h.issuer}/mcp` });
  assert.ok([400].includes(wrongRes.status) && ["invalid_target", "invalid_grant"].includes(wrongRes.body.error), JSON.stringify(wrongRes.body));
  const at = t1.body.access_token;
  const before = (await h.pub(at, "GET", "/publisher/me")).json;
  // A plain reconnect (resume=new) creates a NEW publisher with separate files, never by name.
  const fresh = await h.connectPublisher(app, { project_id: "notes-test", destination: "root", resume: "new" });
  assert.notEqual(fresh.publisher_id, P.publisher_id);
  assert.equal((await h.pub(fresh.access_token, "GET", "/publisher/files")).json.files.length, 0);
  // Owner-approved resume of P: same id/project/folder/current revision; old access + refresh tokens stop working.
  const R = await h.connectPublisher(app, { resume: P.publisher_id });
  assert.equal(R.publisher_id, P.publisher_id);
  const after = (await h.pub(R.access_token, "GET", "/publisher/me")).json;
  assert.equal(after.current_source_revision, before.current_source_revision); assert.deepEqual(after.destination, before.destination);
  assert.equal(after.token_epoch, before.token_epoch + 1); assert.ok(after.resumed_at);
  assert.equal((await h.pub(at, "GET", "/publisher/me")).status, 401, "old access token dead after resume");
  assert.equal((await h.token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: app.client_id })).status, 400, "old refresh dead");
  // resuming another app's publisher is impossible (only same-client publishers are offered/accepted)
  const Qid = (await rows(`SELECT id FROM publishers WHERE app_client_id = '${app2.app_client_id}'`))[0].id;
  const bad = await h.authorize(app, { resume: Qid });
  assert.ok(!bad.code && /can(&#39;|')t be resumed/.test(bad.html));
  P = { ...P, ...R };
});

test("revocation: publisher revoked -> 401 publisher_revoked, refresh invalid_grant, files stay protected; disabled app blocks connect", async () => {
  const X = await h.connectPublisher(app2, { project_id: "other-test", destination: "new", new_folder_name: "Trip Log" });
  assert.equal((await commit(X.access_token, snapBody(1, synthMeasurements(2, { seed: 7 })))).status, 201);
  assert.equal((await owner.req("POST", `/api/publishers/${X.publisher_id}/revoke`, {})).status, 200);
  const r = await h.pub(X.access_token, "GET", "/publisher/me");
  assert.equal(r.status, 401); assert.equal(r.json.error.code, "publisher_revoked"); assert.match(r.headers.get("www-authenticate"), /revoked/);
  assert.equal((await h.token({ grant_type: "refresh_token", refresh_token: X.refresh_token, client_id: app2.client_id })).body.error, "invalid_grant");
  const files = (await rows(`SELECT id FROM artifacts WHERE publisher_id = '${X.publisher_id}'`));
  assert.ok(files.length >= 3, "files remain after revocation");
  const own = await owner.req("PUT", `/api/projects/other-test/artifacts/${files[0].id}`, { expected_revision: 1, content: "{}" });
  assert.equal(own.body.error.code, "protected_source");
  assert.equal((await owner.req("POST", `/api/app-clients/${app2.app_client_id}/disable`, {})).status, 200);
  const blocked = await h.authorize(app2, { project_id: "other-test", destination: "root" });
  assert.ok(!blocked.code && /disabled/.test(blocked.html));
});

test("review F1: disabling an app client stops NEW connections only; its existing publisher keeps working", async () => {
  const app3 = await h.registerApp({ display_name: "Disable probe", redirect_uris: ["http://127.0.0.1:5175/cb"], origins: ["http://127.0.0.1:5175"] });
  const D = await h.connectPublisher(app3, { project_id: "other-test", destination: "root" });
  assert.equal((await owner.req("POST", `/api/app-clients/${app3.app_client_id}/disable`, {})).status, 200);
  assert.equal((await h.pub(D.access_token, "GET", "/publisher/me")).status, 200);
  assert.equal((await commit(D.access_token, snapBody(1, synthMeasurements(2, { seed: 80 })))).status, 201);
  const t = await h.token({ grant_type: "refresh_token", refresh_token: D.refresh_token, client_id: app3.client_id });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const pre = await fetch(`${h.api}/publisher/me`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5175", "access-control-request-method": "GET" } });
  assert.equal(pre.status, 204, "CORS kept for a disabled app's live publisher");
  assert.ok(!(await h.authorize(app3, { project_id: "other-test", destination: "root" })).code, "no new connection");
});

test("review F2: per-publisher quota -> 413 quota_exceeded, nothing written; exports don't use the project file quota", async () => {
  const app4 = await h.registerApp({ display_name: "Quota probe", redirect_uris: ["http://127.0.0.1:5176/cb"], origins: [] });
  const Z = await h.connectPublisher(app4, { project_id: "other-test", destination: "root" });
  const recs = synthMeasurements(2, { seed: 90 });
  let rev = 1;
  // 32 files max: each snapshot adds up to 7 extra derived CSVs (+ json + manifest).
  const extras = (from, n) => Array.from({ length: n }, (_, k) => ({ name: `x${from + k}.csv`, kind: "csv", role: "derived", content: "a\r\n1\r\n" }));
  for (let made = 0; made < 28; made += 7) {
    const b = snapBody(rev++, recs); b.files = [b.files[0], ...extras(made, 7)];
    assert.equal((await commit(Z.access_token, b)).status, 201);
  }
  // 1 json + manifest + 28 csv = 30 files; adding 3 more names exceeds 32.
  const b = snapBody(rev, recs); b.files = [b.files[0], ...extras(100, 3)];
  const r = await commit(Z.access_token, b);
  assert.equal(r.status, 413, r.text); assert.equal(r.json.error.code, "quota_exceeded"); assert.equal(r.json.error.max_files, 32);
  assert.equal((await h.pub(Z.access_token, "GET", "/publisher/me")).json.current_source_revision, rev - 1, "unchanged");
  assert.equal((await rows(`SELECT COUNT(*) AS n FROM artifacts WHERE publisher_id = '${Z.publisher_id}'`))[0].n, 30);
  const n = (await rows(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id = 'other-test' AND publisher_id IS NULL`))[0].n;
  assert.ok(n < 100); // owner can still create (exports excluded from the 100-file count)
  assert.equal((await owner.req("POST", "/api/projects/other-test/artifacts", { title: "owner after quota", body: "x" })).status, 201);
});

test("review F4: a commit in flight from a pre-resume token cannot land", async () => {
  const before = (await h.pub(P.access_token, "GET", "/publisher/me")).json;
  const slow = h.pub(P.access_token, "POST", "/publisher/snapshots", { body: snapBody(before.current_source_revision + 1, synthMeasurements(2, { seed: 95 })), idem: key("ep"), headers: { "x-test-pause-before-batch-ms": "2500" } });
  await new Promise((r) => setTimeout(r, 300));
  const R = await h.connectPublisher(app, { resume: P.publisher_id });
  const s = await slow;
  assert.equal(s.status, 401, s.text);
  assert.equal((await h.pub(R.access_token, "GET", "/publisher/me")).json.current_snapshot_id, before.current_snapshot_id);
  P = { ...P, ...R };
});

test("review F8: a publisher consent handle cannot be submitted as an MCP grant", async () => {
  const a = await h.authorize(app, { project_id: "notes-test", destination: "root" }, { stopAtConsent: true });
  const handle = (a.consentHtml.match(/name="handle" value="([^"]+)"/) ?? [])[1];
  assert.ok(handle);
  const r = await a.browser.go(`${h.issuer}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, step: "grant", "access:notes-test": "write", decision: "approve" }).toString() });
  assert.equal(r.status, 400); assert.match(await r.text(), /connects as a publisher/);
  assert.equal((await rows(`SELECT COUNT(*) AS n FROM oauth_connections WHERE resource LIKE '%/v1'`))[0].n, 0);
});

test("CORS: only registered origins, no credentials; preflight for token endpoint and publisher API", async () => {
  const pre = await fetch(`${h.api}/publisher/snapshots`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,idempotency-key" } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(pre.headers.get("access-control-allow-headers"), /Idempotency-Key/); assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  const evil = await fetch(`${h.api}/publisher/snapshots`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const real = await fetch(`${h.api}/publisher/me`, { headers: { origin: ORIGIN, authorization: `Bearer ${P.access_token}` } });
  assert.equal(real.headers.get("access-control-allow-origin"), ORIGIN);
  const realEvil = await fetch(`${h.api}/publisher/me`, { headers: { origin: "http://evil.example", authorization: `Bearer ${P.access_token}` } });
  assert.equal(realEvil.headers.get("access-control-allow-origin"), null);
  const tok = await fetch(`${h.issuer}/oauth/token`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
  assert.equal(tok.status, 204); assert.equal(tok.headers.get("access-control-allow-origin"), ORIGIN);
});

test("existing MCP OAuth clients unaffected: /mcp still the default resource, metadata adds /v1 only with the flag", async () => {
  const asm = await (await fetch(`${h.issuer}/.well-known/oauth-authorization-server`)).json();
  assert.ok(asm.protected_resources.includes(`${h.issuer}/mcp`) && asm.protected_resources.includes(h.resource));
  const prm = await (await fetch(`${h.issuer}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${h.issuer}/mcp`);
});

test("synthetic only: no real-looking data in fixtures; nothing pruned", async () => {
  assert.equal((await rows(`SELECT COUNT(*) AS n FROM publishers WHERE auto_prune_enabled != 0`))[0].n, 0);
  const snaps = (await rows(`SELECT COUNT(*) AS n FROM snapshots`))[0].n;
  assert.ok(snaps >= 6, "all snapshots retained (keep_all)");
});

test("publisher consent: a fixable mistake re-renders with the error and the owner's choices; a folder from another project is refused inline", async () => {
  const a = await h.authorize(app, {}, { stopAtConsent: true });
  const handle = (a.consentHtml.match(/name="handle" value="([^"]+)"/) ?? [])[1];
  const post = (o) => a.browser.go(`${h.issuer}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, step: "publish", decision: "approve", ...o }).toString() });
  let r = await post({ resume: "new", project_id: "notes-test", destination: "new", new_folder_name: "Field Notes" });
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.match(html, /role="alert"[^]*already exists in this project/);
  assert.match(html, /name="new_folder_name"[^>]*value="Field Notes"/);
  assert.match(html, new RegExp(`name="handle" value="${handle}"`));
  const fld = (html.match(/value="(folder:fld_[^"]+)">Field Notes</) ?? [])[1];
  r = await post({ resume: "new", project_id: "other-test", destination: fld });
  assert.equal(r.status, 400); assert.match(await r.text(), /role="alert"[^]*different project/);
  r = await post({ resume: "new", project_id: "other-test", destination: "root" });
  assert.equal(r.status, 200, "same handle succeeds after the fix");
  assert.match(await r.text(), /http-equiv="refresh"[^>]*code=/);
});

// Suggested destination (docs/app-connect.md#suggested-destination): the app's agentlib_* hint and the owner-set
// registration default only pre-fill the consent page; the owner's submitted choice always decides.
test("suggested destination: app hint and registration default pre-fill the consent page; owner choice wins", async () => {
  const owner = await h.owner();
  const proj = (html) => (html.match(/<option value="([^"]+)" selected>/) ?? [])[1];
  const folderName = (html) => (html.match(/name="new_folder_name"[^>]*value="([^"]*)"/) ?? [])[1];
  // Registration default: by project title (case-insensitive), with an invalid suggestion rejected at registration.
  assert.equal((await owner.req("POST", "/api/app-clients", { display_name: "Bad suggest", redirect_uris: ["http://127.0.0.1:5175/cb"], suggested_folder: "a/b" })).status, 400);
  const sApp = await h.registerApp({ display_name: "Suggest app (local)", redirect_uris: ["http://127.0.0.1:5175/cb"], origins: [], suggested_project: "other", suggested_folder: "Daily exports" });
  assert.equal(sApp.suggested_project, "other"); assert.equal(sApp.suggested_folder, "Daily exports");
  let c = await h.authorize(sApp, {}, { stopAtConsent: true });
  assert.equal(proj(c.consentHtml), "other-test", "registration default project (matched by title)");
  assert.equal(folderName(c.consentHtml), "Daily exports");
  assert.match(c.consentHtml, /<option value="new" selected>New folder/);
  // The app's own hint wins over the registration default; an existing folder of that name is pre-selected.
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_project: "notes-test", agentlib_folder: "field notes" } });
  assert.equal(proj(c.consentHtml), "notes-test", "app hint by project id");
  assert.match(c.consentHtml, /<option value="folder:fld_[^"]+" selected>Field Notes</, "existing folder (case-insensitive) pre-selected");
  // Unknown project falls back to the first project; hostile/oversized hints are ignored and escaped, never errors.
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_project: "no-such-project", agentlib_folder: "<script>x</script>" } });
  assert.equal(proj(c.consentHtml), "notes-test", "unknown project -> first project");
  // "/" is not allowed in folder names, so this hint is dropped and the registration default is used.
  assert.doesNotMatch(c.consentHtml, /<script>x/); assert.equal(folderName(c.consentHtml), "Daily exports");
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_folder: "<b>\"x\"" } });
  assert.doesNotMatch(c.consentHtml, /<b>"x"/); assert.equal(folderName(c.consentHtml), "&#60;b&#62;&#34;x&#34;", "hint is HTML-escaped");
  c = await h.authorize(sApp, {}, { stopAtConsent: true, extraQuery: { agentlib_folder: "x".repeat(81) } });
  assert.equal(folderName(c.consentHtml), "Daily exports", "oversized hint ignored; registration default used");
  // Owner overrides: a different project and folder name than suggested.
  const a = await h.authorize(sApp, { project_id: "notes-test", destination: "new", new_folder_name: "Owner pick" }, { extraQuery: { agentlib_project: "other-test", agentlib_folder: "App pick" } });
  assert.ok(a.code, a.html);
  const t = await h.token({ grant_type: "authorization_code", code: a.code, redirect_uri: a.redirect_uri, client_id: sApp.client_id, code_verifier: a.verifier, resource: h.resource });
  const me = (await h.pub(t.body.access_token, "GET", "/publisher/me")).json;
  assert.equal(me.project.id, "notes-test"); assert.equal(me.destination.name, "Owner pick");
  // Owner can change or clear the registration default.
  const up = await owner.req("PUT", `/api/app-clients/${sApp.app_client_id}`, { suggested_project: "", suggested_folder: "Renamed" });
  assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.suggested_project, null); assert.equal(up.body.suggested_folder, "Renamed");
  assert.equal((await owner.req("PUT", `/api/app-clients/${sApp.app_client_id}`, { suggested_folder: "x".repeat(81) })).status, 400);
  assert.equal((await owner.req("PUT", "/api/app-clients/apc_nope", { suggested_folder: "x" })).status, 404);
  c = await h.authorize(sApp, {}, { stopAtConsent: true });
  assert.equal(proj(c.consentHtml), "notes-test"); assert.equal(folderName(c.consentHtml), "Renamed");
});
