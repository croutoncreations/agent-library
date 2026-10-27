// App Connect Phase 2 (contract app-connect/0.4 §3-§5): JSON/CSV kinds, folders, measurements records,
// flag gating. Local synthetic only (APP_CONNECT_ENABLED=1 on a local wrangler dev server).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { startServer, key, ROOT } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const PORT = SERVER_PORTS.acp2;
const API = `http://127.0.0.1:${PORT}`, APP = `http://localhost:${PORT}`;
const PH = "syn-notes", PO = "syn-other";
let s, owner, rw, ro;
const M = "agentlib.measurements/1";

async function call(method, path, { token, body, idem, raw, headers = {} } = {}) {
  const h = { "user-agent": "phase2-test", ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  if (idem) h["idempotency-key"] = idem;
  const r = await fetch(API + path, { method, headers: h, body: payload, redirect: "manual" });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, json, text };
}
const measJson = (records) => JSON.stringify({ schema: M, meta: { source_app: "synthetic" }, records });
const recs = [
  { id: "r1", recorded_at: "2026-09-01T07:14:00-07:00", date: "2026-09-01", metric: "weight_kg", value: 80.1, unit: "kg", source_id: "s1" },
  { id: "r2", recorded_at: "1693552440000", metric: "waist_cm", value: 91, unit: "cm" },                       // no source date
  { id: "r3", recorded_at: "2026-09-03 06:00", date: "2026-09-03", metric: "weight_kg", value: 79.9, unit: "kg", extra: { note: "kept" } },
  { id: "r4", recorded_at: "2026-09-02T23:30:00+14:00", date: "2026-09-02", metric: "weight_kg", value: 80, unit: "kg" },
];

before(async () => {
  s = await startServer("acp2", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, APP_CONNECT_ENABLED: "1",
      RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  for (const [id, title] of [[PH, "Notes"], [PO, "Other"]]) assert.equal((await owner.req("POST", "/api/projects", { id, title })).status, 201);
  const k1 = await owner.req("POST", "/api/api-keys", { label: "p2 rw", lifetime_days: 1, projects: [{ project_id: PH, access: "read_write" }] });
  const k2 = await owner.req("POST", "/api/api-keys", { label: "p2 ro", lifetime_days: 1, projects: [{ project_id: PH, access: "read" }] });
  rw = k1.body.secret; ro = k2.body.secret;
});
after(async () => { await s?.stop(); });

// App Connect is opt-in: never on in the local/default config; installations turn it on explicitly
// (wrangler.example.toml documents APP_CONNECT_ENABLED="1" for a deployed environment).
test("App Connect flag is off in the local config and opt-in in the example installation config", () => {
  const local = parseToml(readFileSync(join(ROOT, "wrangler.local.toml"), "utf8"));
  assert.equal(local.vars?.APP_CONNECT_ENABLED, undefined, "never in the local/default config");
  const example = parseToml(readFileSync(join(ROOT, "wrangler.example.toml"), "utf8"));
  assert.equal(example.vars?.APP_CONNECT_ENABLED, undefined, "example top level stays local-shaped");
  assert.equal(example.env?.hosted?.vars?.APP_CONNECT_ENABLED, "1");
});

test("JSON and CSV create/read/update round-trip byte-exact with correct types", async () => {
  const json = measJson(recs);
  const c = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "json", title: "SYNTHETIC measurements", content: json, schema: M } });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.kind, "json"); assert.equal(c.json.schema, M); assert.equal(c.json.folder_id, null);
  assert.ok(c.json.preview_url && c.json.web_url);
  const fid = c.json.artifact_id;
  const r = await call("GET", `/v1/projects/${PH}/files/${fid}`, { token: rw });
  assert.equal(r.json.content, json, "byte-exact content");
  assert.equal(r.json.file.kind, "json"); assert.equal(r.json.file.schema, M); assert.equal(r.json.file.publisher, null);
  const raw = await call("GET", `/v1/projects/${PH}/files/${fid}/content`, { token: rw });
  assert.equal(raw.text, json);
  assert.equal(raw.headers.get("content-type"), "application/json; charset=utf-8");
  assert.match(raw.headers.get("content-disposition"), /^attachment;/);
  assert.match(raw.headers.get("content-security-policy"), /sandbox/);

  const csv = 'id,recorded_at,date,metric,value,unit,source_id\r\nr1,2026-09-01T07:14:00-07:00,2026-09-01,weight_kg,80.1,kg,s1\r\nr2,1693552440000,,waist_cm,91,cm,\r\nr3,"=HYPERLINK(""x"")",,weight_kg,1,kg,\r\n';
  const cc = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "csv", title: "SYNTHETIC.csv", content: csv, schema: M } });
  assert.equal(cc.status, 201, cc.text);
  const craw = await call("GET", `/v1/projects/${PH}/files/${cc.json.artifact_id}/content`, { token: rw });
  assert.equal(craw.text, csv, "canonical CSV untouched (including the formula-looking cell)");
  assert.equal(craw.headers.get("content-type"), "text/csv; charset=utf-8; header=present");
  const sheet = await call("GET", `/v1/projects/${PH}/files/${cc.json.artifact_id}/content?format=spreadsheet`, { token: rw });
  assert.match(sheet.text, /'=HYPERLINK/); assert.match(sheet.headers.get("content-disposition"), /spreadsheet\.csv/);

  const u = await call("PUT", `/v1/projects/${PH}/files/${fid}`, { token: rw, idem: key(), body: { expected_revision: 1, content: measJson(recs.slice(0, 2)) } });
  assert.equal(u.status, 200, u.text); assert.equal(u.json.revision, 2); assert.equal(u.json.kind, "json");
  const stale = await call("PUT", `/v1/projects/${PH}/files/${fid}`, { token: rw, idem: key(), body: { expected_revision: 1, content: json } });
  assert.equal(stale.status, 409); assert.equal(stale.json.error.code, "revision_conflict"); assert.equal(stale.json.error.current_revision, 2);
  const badUpd = await call("PUT", `/v1/projects/${PH}/files/${fid}`, { token: rw, idem: key(), body: { expected_revision: 2, content: '{"schema":"agentlib.measurements/1","records":[{"id":"x"}]}' } });
  assert.equal(badUpd.status, 422); assert.equal(badUpd.json.error.code, "invalid_content"); assert.equal(badUpd.json.error.path, "records[0].recorded_at");
});

test("validation errors carry format/line/path; idempotency and read-only rules apply", async () => {
  const bad = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "csv", title: "b", content: "a,b\n1,2,3\n" } });
  assert.equal(bad.status, 422); assert.equal(bad.json.error.format, "csv"); assert.equal(bad.json.error.line, 2);
  const badDate = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "json", title: "b", schema: M, content: measJson([{ ...recs[0], date: "2026-02-30" }]) } });
  assert.equal(badDate.status, 422); assert.equal(badDate.json.error.path, "records[0].date");
  assert.equal((await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "xml", title: "b", content: "<a/>" } })).status, 422);
  assert.equal((await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "markdown", title: "b", schema: M } })).status, 400);
  const k = key();
  const a = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: k, body: { kind: "json", title: "idem", content: "{}" } });
  const b = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: k, body: { kind: "json", title: "idem", content: "{}" } });
  assert.equal(b.json.idempotent_replay, true); assert.equal(b.json.artifact_id, a.json.artifact_id);
  assert.equal((await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: k, body: { kind: "csv", title: "idem", content: "a\n1\n" } })).status, 422);
  assert.equal((await call("POST", `/v1/projects/${PH}/files`, { token: ro, idem: key(), body: { kind: "json", title: "x", content: "{}" } })).status, 403);
  assert.equal((await call("POST", `/v1/projects/${PO}/files`, { token: rw, idem: key(), body: { kind: "json", title: "x", content: "{}" } })).status, 404);
});

test("folders: create, duplicate (case-insensitive) 409, place files, filter listing by folder and kind", async () => {
  const f = await call("POST", `/v1/projects/${PH}/folders`, { token: rw, idem: key(), body: { name: "  Field Notes  " } });
  assert.equal(f.status, 201, f.text); assert.match(f.json.id, /^fld_/); assert.equal(f.json.name, "Field Notes");
  const dup = await call("POST", `/v1/projects/${PH}/folders`, { token: rw, idem: key(), body: { name: "field notes" } });
  assert.equal(dup.status, 409); assert.equal(dup.json.error.code, "folder_exists"); assert.equal(dup.json.error.folder_id, f.json.id);
  for (const n of ["", "a/b", "x".repeat(81), "tab\there"]) assert.equal((await call("POST", `/v1/projects/${PH}/folders`, { token: rw, idem: key(), body: { name: n } })).status, 400, JSON.stringify(n));
  assert.equal((await call("POST", `/v1/projects/${PH}/folders`, { token: ro, idem: key(), body: { name: "ro" } })).status, 403);
  const inF = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "csv", title: "in folder", content: "a\n1\n", folder_id: f.json.id } });
  assert.equal(inF.status, 201); assert.equal(inF.json.folder_id, f.json.id);
  const otherF = (await owner.req("POST", `/api/projects/${PO}/folders`, { name: "Elsewhere" })).body.id;
  assert.equal((await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "csv", title: "x", content: "a\n1\n", folder_id: otherF } })).status, 404, "folder from another project");
  const lf = await call("GET", `/v1/projects/${PH}/files?folder_id=${f.json.id}`, { token: ro });
  assert.deepEqual(lf.json.files.map((x) => x.id), [inF.json.artifact_id]);
  const lr = await call("GET", `/v1/projects/${PH}/files?folder_id=root&kind=csv`, { token: ro });
  assert.ok(lr.json.files.every((x) => x.kind === "csv" && x.folder_id === null) && lr.json.files.length >= 1);
  const lst = await call("GET", `/v1/projects/${PH}/folders`, { token: ro });
  assert.deepEqual(lst.json.folders.map((x) => x.name), ["Field Notes"]);
});

test("records query: source order, verbatim recorded_at, ranges only on source date, undated counted", async () => {
  const c = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "json", title: "rq", content: measJson(recs), schema: M } });
  const fid = c.json.artifact_id;
  const all = await call("GET", `/v1/projects/${PH}/files/${fid}/records`, { token: ro });
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.records.map((r) => r.id), ["r1", "r2", "r3", "r4"], "source order, never re-sorted");
  assert.deepEqual(all.json.records.map((r) => r.recorded_at), recs.map((r) => r.recorded_at), "verbatim timestamps");
  assert.equal(all.json.records[1].date, undefined, "no derived date");
  assert.deepEqual(all.json.records[2].extra, { note: "kept" });
  assert.equal(all.json.undated_excluded, 0);
  const rng = await call("GET", `/v1/projects/${PH}/files/${fid}/records?from=2026-09-02&to=2026-09-03`, { token: ro });
  assert.deepEqual(rng.json.records.map((r) => r.id), ["r3", "r4"]); assert.equal(rng.json.undated_excluded, 1);
  const met = await call("GET", `/v1/projects/${PH}/files/${fid}/records?metric=weight_kg&limit=2`, { token: ro });
  assert.deepEqual(met.json.records.map((r) => r.id), ["r1", "r3"]); assert.equal(met.json.next_cursor, "2");
  const p2 = await call("GET", `/v1/projects/${PH}/files/${fid}/records?metric=weight_kg&limit=2&cursor=2`, { token: ro });
  assert.deepEqual(p2.json.records.map((r) => r.id), ["r4"]); assert.equal(p2.json.next_cursor, null);
  for (const qs of ["from=2026-9-1", "from=2026-02-30", "to=2025-02-29", "from=2026-09-03&to=2026-09-01"])
    assert.equal((await call("GET", `/v1/projects/${PH}/files/${fid}/records?${qs}`, { token: ro })).status, 400, qs);
  assert.equal((await call("GET", `/v1/projects/${PH}/files/${fid}/records?from=2026-09-03&to=2026-09-03`, { token: ro })).status, 200, "from == to allowed");
  const plain = await call("POST", `/v1/projects/${PH}/files`, { token: rw, idem: key(), body: { kind: "json", title: "plain", content: '{"a":1}' } });
  const nq = await call("GET", `/v1/projects/${PH}/files/${plain.json.artifact_id}/records`, { token: ro });
  assert.equal(nq.status, 422); assert.equal(nq.json.error.code, "schema_not_queryable");
});

test("owner host and OAuth-MCP-facing service see the new kinds; Markdown behaviour unchanged", async () => {
  const c = await owner.req("POST", `/api/projects/${PH}/artifacts`, { kind: "json", title: "owner json", content: '{"x":1}' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const g = await owner.req("GET", `/api/projects/${PH}/artifacts/${c.body.artifact_id}`);
  assert.equal(g.body.content, '{"x":1}'); assert.equal(g.body.artifact.kind, "json");
  const md = await owner.req("POST", `/api/projects/${PH}/artifacts`, { title: "plain md", body: "# hi" });
  assert.deepEqual(Object.keys(md.body).sort(), ["artifact_id", "revision", "revision_id", "sha256"], "Markdown create response shape unchanged");
  const lst = await owner.req("GET", `/api/projects/${PH}/artifacts?kind=json`);
  assert.ok(lst.body.artifacts.length >= 1 && lst.body.artifacts.every((a) => a.kind === "json"));
});
