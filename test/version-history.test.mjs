// Version history (docs/version-history.md): who/why on every version, paging, diffs, content and metadata restore
// over the browser API, both MCP shapes (legacy bearer grant via the official SDK; MCP 2026-07-28 per-request
// _meta clientInfo) and /v1 API keys; backup round-trip; browser timeline in real Chrome. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startServer, setupProject, grant, mcpClient, key, ROOT, LOCAL_CONFIG } from "./helpers.mjs";
import { SERVER_PORTS } from "./ports.mjs";

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
const haveChrome = existsSync(CHROME) && existsSync(PUPPETEER);
const PORT = SERVER_PORTS.history;
const API = `http://127.0.0.1:${PORT}`;   // MCP_HOST: /v1
const APP = `http://localhost:${PORT}`;   // APP_HOST: owner UI/API and legacy /mcp
const P = "hist-a";
let s, owner, agent, agentTok;

const docUrl = (id) => `/api/projects/${P}/artifacts/${id}`;
async function v1(method, path, token, body, idem) {
  const h = { authorization: `Bearer ${token}` };
  if (body !== undefined) h["content-type"] = "application/json";
  if (idem) h["idempotency-key"] = idem;
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
// Raw JSON-RPC to the legacy bearer /mcp endpoint, so a request can carry MCP 2026-07-28 per-request _meta.
async function rawMcp(token, method, params) {
  const r = await fetch(APP + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}

before(async () => {
  s = await startServer("history", PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, RATE_READS_PER_MIN: "100000", RATE_WRITES_PER_MIN: "100000", RATE_AUTHFAIL_PER_MIN: "100000" },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  await setupProject(owner, P, "History project");
  const g = await grant(owner, P, "Research agent", true);
  agentTok = g.token;
  agent = await mcpClient(APP, agentTok, "claude-code");
});
after(async () => { await agent?.close(); await s?.stop(); });

let doc;
test("every version records who and why: browser, legacy MCP grant (with SDK clientInfo), MCP 2026 _meta, API key", async () => {
  const made = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Plan", body: "# Plan\n\nalpha\nbeta\ngamma\n" });
  assert.equal(made.status, 201);
  doc = made.body.artifact_id;

  const r2 = await agent.call("save_markdown", { project_id: P, artifact_id: doc, expected_revision: 1, body: "# Plan\n\nalpha\nBETA\ngamma\n", change_note: "Capitalised beta", idempotency_key: key("s") });
  assert.equal(r2.isError, false, JSON.stringify(r2.data)); assert.equal(r2.data.revision, 2);

  // An MCP 2026-07-28 client sends clientInfo on each request in _meta; it wins over the remembered initialize value.
  const r3 = await rawMcp(agentTok, "tools/call", { name: "save_markdown", arguments: { project_id: P, artifact_id: doc, expected_revision: 2, body: "# Plan\n\nalpha\nBETA\ngamma\ndelta\n", idempotency_key: key("s") },
    _meta: { "io.modelcontextprotocol/clientInfo": { name: "agent-shed", version: "2.1" } } });
  assert.equal(r3.isError, false, JSON.stringify(r3.structuredContent));

  const k = await owner.req("POST", "/api/api-keys", { label: "Muse", lifetime_days: 1, projects: [{ project_id: P, access: "read_write" }] });
  assert.equal(k.status, 201);
  const r4 = await v1("PUT", `/v1/projects/${P}/files/${doc}`, k.body.secret, { expected_revision: 3, body: "# Plan\n\nalpha\nBETA\ngamma\ndelta\nepsilon\n", change_note: "Added epsilon" }, key("v"));
  assert.equal(r4.status, 200, JSON.stringify(r4.body));

  const hist = (await owner.req("GET", docUrl(doc) + "/history")).body;
  const by = Object.fromEntries(hist.revisions.map((v) => [v.rev, v]));
  assert.deepEqual([by[1].who, by[1].via.kind, by[1].change_note], ["You", "browser", null]);
  assert.deepEqual([by[2].who, by[2].via.kind, by[2].via.label, by[2].client_info, by[2].change_note], ["Research agent", "grant", "Research agent", "claude-code 1.0.0", "Capitalised beta"]);
  assert.deepEqual([by[3].via.kind, by[3].client_info], ["grant", "agent-shed 2.1"], "per-request _meta clientInfo is recorded");
  assert.deepEqual([by[4].who, by[4].via.kind, by[4].via.label, by[4].client_info, by[4].change_note], ["Muse", "api_key", "Muse", null, "Added epsilon"]);
  assert.equal(by[4].via.id, k.body.id, "API-key versions name the key");
});

test("change_note is validated: too long or not a string is rejected; nothing is saved", async () => {
  const long = await owner.req("PUT", docUrl(doc), { expected_revision: 4, body: "x", change_note: "n".repeat(281) });
  assert.equal(long.status, 413);
  const bad = await owner.req("PUT", docUrl(doc), { expected_revision: 4, body: "x", change_note: 5 });
  assert.equal(bad.status, 400);
  assert.equal((await owner.req("GET", docUrl(doc))).body.revision.rev, 4);
});

test("diff: line hunks between any two versions; default is current vs previous; binary-safe errors", async () => {
  const d = (await owner.req("GET", docUrl(doc) + "/diff?from=1&to=4")).body;
  assert.equal(d.identical, false); assert.equal(d.binary, false);
  assert.deepEqual([d.added, d.removed], [3, 1]);
  const lines = d.hunks.flatMap((h) => h.lines);
  assert.ok(lines.includes("-beta") && lines.includes("+BETA") && lines.includes("+delta") && lines.includes("+epsilon"), JSON.stringify(lines));
  const def = (await owner.req("GET", docUrl(doc) + "/diff")).body;
  assert.deepEqual([def.from.rev, def.to.rev, def.added, def.removed], [3, 4, 1, 0]);
  const same = (await owner.req("GET", docUrl(doc) + "/diff?from=4&to=4")).body;
  assert.equal(same.identical, true);
  assert.equal((await owner.req("GET", docUrl(doc) + "/diff?from=1&to=99")).status, 404);
  const viaMcp = await agent.call("diff_revisions", { project_id: P, artifact_id: doc, from: 1, to: 2 });
  assert.deepEqual([viaMcp.data.added, viaMcp.data.removed], [1, 1]);
});

test("diff caps keep big diffs cheap: >500 changed lines are one replacement; >20,000 lines are summarised", async () => {
  const made = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Big diff", body: Array.from({ length: 600 }, (_, i) => "a" + i).join("\n") });
  const id = made.body.artifact_id;
  // Every line changes (edit distance 1200 > 500): counts stay exact, the middle is reported as a full replacement.
  assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 1, body: Array.from({ length: 600 }, (_, i) => "b" + i).join("\n") })).status, 200);
  const d1 = (await owner.req("GET", docUrl(id) + "/diff?from=1&to=2")).body;
  assert.deepEqual([d1.added, d1.removed, d1.truncated, d1.too_many_lines], [600, 600, true, undefined]);
  // A small edit in a long document is still diffed precisely.
  const long = Array.from({ length: 5000 }, (_, i) => "line " + i);
  assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 2, body: long.join("\n") })).status, 200);
  long[2500] = "edited"; assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 3, body: long.join("\n") })).status, 200);
  const d2 = (await owner.req("GET", docUrl(id) + "/diff?from=3&to=4")).body;
  assert.deepEqual([d2.added, d2.removed, d2.truncated], [1, 1, false]);
  // Output cap (2,000 changed lines shown): with 934 changes (> MAX_D) the changed middle is one replacement; counts
  // stay exact, the shown lines are capped, and no changed line is presented as context.
  const many = [], many2 = [];
  for (let i = 0; i < 1400; i++) { many.push("same" + i); many2.push("same" + i); if (i % 3 === 0) { many.push("old" + i); many2.push("new" + i); } }
  assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 4, body: many.join("\n") })).status, 200);
  assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 5, body: many2.join("\n") })).status, 200);
  const dc = (await owner.req("GET", docUrl(id) + "/diff?from=5&to=6")).body;
  const shown = dc.hunks.flatMap((h) => h.lines);
  assert.deepEqual([dc.added, dc.removed, dc.truncated, shown.filter((l) => l[0] !== " ").length], [1865, 1865, true, 2000]);
  assert.equal(shown.filter((l) => /^ (old|new)/.test(l)).length, 0, "no changed line is shown as context");
  // More than 20,000 lines: summarised (no hunks, added/removed null) and the UI offers the full text instead.
  assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 6, body: "\n".repeat(20001) })).status, 200);
  const d3 = (await owner.req("GET", docUrl(id) + "/diff?from=6&to=7")).body;
  assert.deepEqual([d3.too_many_lines, d3.truncated, d3.added, d3.removed, d3.hunks.length], [true, true, null, null, 0]);
});

test("agents restore content over MCP: new version, restored_from, default note; stale head 409; replay; read-only refused", async () => {
  const stale = await agent.call("restore_revision", { project_id: P, artifact_id: doc, expected_revision: 1, from_revision: 1, idempotency_key: key("r") });
  assert.equal(stale.data.error.code, "revision_conflict"); assert.equal(stale.data.error.current_revision, 4);
  const k1 = key("r");
  const r = await agent.call("restore_revision", { project_id: P, artifact_id: doc, expected_revision: 4, from_revision: 1, idempotency_key: k1 });
  assert.equal(r.isError, false, JSON.stringify(r.data)); assert.equal(r.data.revision, 5);
  assert.ok(r.data.web_url, "restore result links to the document");
  const again = await agent.call("restore_revision", { project_id: P, artifact_id: doc, expected_revision: 4, from_revision: 1, idempotency_key: k1 });
  assert.equal(again.data.idempotent_replay, true); assert.equal(again.data.revision, 5);
  const cur = (await owner.req("GET", docUrl(doc))).body;
  assert.equal(cur.body, "# Plan\n\nalpha\nbeta\ngamma\n");
  const v5 = (await owner.req("GET", docUrl(doc) + "/history")).body.revisions[0];
  assert.deepEqual([v5.rev, v5.restored_from, v5.change_note, v5.who], [5, 1, "Restored version 1", "Research agent"]);
  // Restoring never deletes: every earlier version is still there.
  assert.deepEqual((await owner.req("GET", docUrl(doc) + "/history")).body.revisions.map((v) => v.rev), [5, 4, 3, 2, 1]);
  const ro = await grant(owner, P, "Reader", false);
  const roClient = await mcpClient(APP, ro.token, "reader");
  const denied = await roClient.call("restore_revision", { project_id: P, artifact_id: doc, expected_revision: 5, from_revision: 2, idempotency_key: key("r") });
  assert.equal(denied.isError, true); assert.equal(denied.data.error.status, 403);
  await roClient.close();
});

test("/v1: restore and diff with an API key; read-only key refused", async () => {
  const k = await owner.req("POST", "/api/api-keys", { label: "Ops", lifetime_days: 1, projects: [{ project_id: P, access: "read_write" }] });
  const r = await v1("POST", `/v1/projects/${P}/files/${doc}/revisions/4/restore`, k.body.secret, { expected_revision: 5, change_note: "Undo the revert" }, key("v"));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.revision, 6);
  const d = await v1("GET", `/v1/projects/${P}/files/${doc}/diff?from=5&to=6`, k.body.secret);
  assert.equal(d.status, 200); assert.equal(d.body.added, 3);
  const h = await v1("GET", `/v1/projects/${P}/files/${doc}/revisions`, k.body.secret);
  assert.deepEqual([h.body.revisions[0].rev, h.body.revisions[0].change_note, h.body.revisions[0].via.kind], [6, "Undo the revert", "api_key"]);
  const rk = await owner.req("POST", "/api/api-keys", { label: "RO", lifetime_days: 1, projects: [{ project_id: P, access: "read" }] });
  assert.equal((await v1("POST", `/v1/projects/${P}/files/${doc}/revisions/1/restore`, rk.body.secret, { expected_revision: 6 }, key("v"))).status, 403);
});

test("history pages past 50 versions with a cursor and never repeats or skips a version", async () => {
  const made = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Busy", body: "0" });
  const id = made.body.artifact_id;
  for (let i = 1; i <= 120; i++) assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: i, body: String(i) })).status, 200);
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const r = (await owner.req("GET", docUrl(id) + "/history" + (cursor ? "?cursor=" + cursor : ""))).body;
    seen.push(...r.revisions.map((v) => v.rev)); cursor = r.next_cursor; pages++;
    if (pages === 1) assert.ok(Array.isArray(r.meta_versions), "first page includes details history");
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, Array.from({ length: 121 }, (_, i) => 121 - i));
});

test("title, folder and tags are versioned: baseline once, then each change; restore as a new version; stale 409", async () => {
  const a = (await owner.req("GET", docUrl(doc))).body.artifact;
  const m1 = await owner.req("PATCH", docUrl(doc), { expected_meta_version: a.meta_version, title: "Plan v2", tags: ["q4"] });
  assert.equal(m1.status, 200);
  const m2 = await agent.call("trash_artifact", { project_id: P, artifact_id: doc, expected_meta_version: m1.body.meta_version, idempotency_key: key("t") });
  assert.equal(m2.isError, false, JSON.stringify(m2.data));
  const un = await owner.req("PATCH", docUrl(doc), { expected_meta_version: m2.data.meta_version, trashed: false });
  assert.equal(un.status, 200);
  const mh = (await owner.req("GET", docUrl(doc) + "/meta-history")).body.meta_versions;
  assert.deepEqual(mh.map((m) => [m.version, m.title, m.trashed]), [[4, "Plan v2", false], [3, "Plan v2", true], [2, "Plan v2", false], [1, "Plan", false]]);
  assert.equal(mh[3].baseline, true); assert.equal(mh[3].who, "Before history was recorded");
  assert.equal(mh[1].who, "Research agent", "agent trash is attributed");
  // Agent restores the original title over MCP.
  const stale = await agent.call("restore_metadata", { project_id: P, artifact_id: doc, expected_meta_version: 2, from_version: 1, idempotency_key: key("m") });
  assert.equal(stale.data.error.code, "metadata_conflict");
  const r = await agent.call("restore_metadata", { project_id: P, artifact_id: doc, expected_meta_version: 4, from_version: 1, change_note: "Title was right before", idempotency_key: key("m") });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual([r.data.meta_version, r.data.title, r.data.tags], [5, "Plan", []]);
  const top = (await owner.req("GET", docUrl(doc) + "/meta-history")).body.meta_versions[0];
  assert.deepEqual([top.version, top.restored_from, top.change_note], [5, 1, "Title was right before"]);
  // An agent restoring a trashed version gets its title/folder/tags back, but never moves the document to the trash.
  const t = await agent.call("restore_metadata", { project_id: P, artifact_id: doc, expected_meta_version: 5, from_version: 3, idempotency_key: key("m") });
  assert.equal(t.isError, false, JSON.stringify(t.data));
  assert.deepEqual([t.data.meta_version, t.data.title, t.data.trashed], [6, "Plan v2", false]);
  // The owner's restore of the same version does bring the trash state back; untrash again to continue.
  const o = await owner.req("POST", docUrl(doc) + "/meta-restore", { expected_meta_version: 6, from_version: 3 }, { idem: key("o") });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.trashed, true);
  // The owner can still read the trashed document's history (the History tab reloads it after this restore);
  // agents can't (the trash takes it away from them).
  const oh = await owner.req("GET", docUrl(doc) + "/history");
  assert.equal(oh.status, 200, JSON.stringify(oh.body));
  assert.equal(oh.body.meta_versions[0].trashed, true);
  const ah2 = await agent.call("artifact_history", { project_id: P, artifact_id: doc });
  assert.equal(ah2.data.error.code, "not_found", JSON.stringify(ah2.data));
  const back = await owner.req("PATCH", docUrl(doc), { expected_meta_version: o.body.meta_version, trashed: false, title: "Plan" });
  assert.equal(back.status, 200);
  // The listing in artifact_history includes the details versions too.
  const ah = await agent.call("artifact_history", { project_id: P, artifact_id: doc });
  assert.equal(ah.data.meta_versions[0].version, 8);
  assert.match(ah.data.revisions[0].version_url, /\?v=\d+$/);
});

test("a details edit cannot pose as a restore: restored_from in a PATCH body is ignored (no label, no replay collision)", async () => {
  const a = (await owner.req("GET", docUrl(doc))).body.artifact;
  const k = key("forge");
  const forged = await owner.req("PATCH", docUrl(doc), { expected_meta_version: a.meta_version, title: "Forged", restored_from: 1 }, { idem: k });
  assert.equal(forged.status, 200);
  const top = (await owner.req("GET", docUrl(doc) + "/meta-history")).body.meta_versions[0];
  assert.deepEqual([top.title, top.restored_from, top.change_note], ["Forged", null, null], "recorded as an ordinary edit");
  // A real restore with the same key is a different operation: it is not answered with the forged edit's result.
  const real = await owner.req("POST", docUrl(doc) + "/meta-restore", { expected_meta_version: forged.body.meta_version, from_version: 1 }, { idem: k });
  assert.equal(real.status, 200); assert.equal(real.body.title, "Plan"); assert.equal(real.body.idempotent_replay, undefined);
});

let manyDetailsDoc; // 61 details versions; reused by the browser test for details paging
test("the trash takes a document away from agents: diff, details history and details restore are 404 for them", async () => {
  const made = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Secret plan", body: "a" });
  const id = made.body.artifact_id;
  assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 1, body: "a\nb" })).status, 200);
  const m1 = await owner.req("PATCH", docUrl(id), { expected_meta_version: made.body.meta_version ?? 1, title: "Secret plan 2" });
  assert.equal(m1.status, 200, JSON.stringify(m1.body));
  // An agent restores the original title; after the owner trashes the document, a same-key retry still replays.
  const rk = key("m");
  const before = await agent.call("restore_metadata", { project_id: P, artifact_id: id, expected_meta_version: m1.body.meta_version, from_version: 1, idempotency_key: rk });
  assert.equal(before.isError, false, JSON.stringify(before.data));
  const t = await owner.req("PATCH", docUrl(id), { expected_meta_version: before.data.meta_version, trashed: true });
  assert.equal(t.status, 200);
  const replay = await agent.call("restore_metadata", { project_id: P, artifact_id: id, expected_meta_version: m1.body.meta_version, from_version: 1, idempotency_key: rk });
  assert.deepEqual([replay.isError, replay.data.meta_version, replay.data.idempotent_replay], [false, before.data.meta_version, true], JSON.stringify(replay.data));
  // Legacy MCP grant, and /v1 API key.
  const d = await agent.call("diff_revisions", { project_id: P, artifact_id: id, from: 1, to: 2 });
  assert.equal(d.data.error.code, "not_found", JSON.stringify(d.data));
  const rm = await agent.call("restore_metadata", { project_id: P, artifact_id: id, expected_meta_version: t.body.meta_version, from_version: 1, idempotency_key: key("m") });
  assert.equal(rm.data.error.code, "not_found", JSON.stringify(rm.data));
  // A version that doesn't exist gets the same answer as one that does: the document is simply not there.
  const rmMissing = await agent.call("restore_metadata", { project_id: P, artifact_id: id, expected_meta_version: t.body.meta_version, from_version: 99, idempotency_key: key("m") });
  assert.deepEqual([rmMissing.data.error.code, rmMissing.data.error.message], [rm.data.error.code, rm.data.error.message]);
  const k = { token: (await owner.req("POST", "/api/api-keys", { label: "Trash probe", lifetime_days: 1, projects: [{ project_id: P, access: "read_write" }] })).body.secret };
  assert.equal((await v1("GET", `/v1/projects/${P}/files/${id}/diff?from=1&to=2`, k.token)).status, 404);
  assert.equal((await v1("GET", `/v1/projects/${P}/files/${id}/meta-versions`, k.token)).status, 404);
  assert.equal((await v1("POST", `/v1/projects/${P}/files/${id}/meta-versions/1/restore`, k.token, { expected_meta_version: t.body.meta_version }, key("r"))).status, 404);
  // Nothing changed, and the owner still can diff and see the details history of the trashed document.
  assert.equal((await owner.req("GET", docUrl(id) + "/diff?from=1&to=2")).status, 200);
  const mh = (await owner.req("GET", docUrl(id) + "/meta-history")).body.meta_versions;
  assert.deepEqual([mh[0].version, mh[0].trashed, mh.length], [t.body.meta_version, true, 4]);
});

test("versions from before who/why was recorded: owner-authored ones are labelled neutrally and never grouped", async () => {
  // Before 0010, OAuth connections wrote as the owner's principal with no via: such a version may be a ChatGPT edit.
  const made = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Legacy", body: "one" });
  const id = made.body.artifact_id;
  assert.equal((await owner.req("PUT", docUrl(id), { expected_revision: 1, body: "two" })).status, 200);
  // Turn both into pre-0010 rows (no via, no client_info), exactly as old rows look after the migration.
  execFileSync("wrangler", ["d1", "--config", LOCAL_CONFIG, "execute", "DB", "--local", "--persist-to", join(ROOT, "tmp", "test-state-history"),
    "--command", `UPDATE revisions SET via_kind = NULL, via_id = NULL, via_label = NULL WHERE artifact_id = '${id}'`],
    { cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore" });
  const hist = (await owner.req("GET", docUrl(id) + "/history")).body.revisions;
  assert.deepEqual(hist.map((v) => [v.rev, v.via, v.who]), [[2, null, "You or a connected app"], [1, null, "You or a connected app"]]);
});

test("details history pages with a cursor", async () => {
  const made = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "t0", body: "x" });
  const id = made.body.artifact_id;
  manyDetailsDoc = id;
  let mv = 1;
  for (let i = 1; i <= 60; i++) mv = (await owner.req("PATCH", docUrl(id), { expected_meta_version: mv, title: "t" + i })).body.meta_version;
  const p1 = (await owner.req("GET", docUrl(id) + "/meta-history")).body;
  assert.equal(p1.meta_versions.length, 50); assert.ok(p1.next_cursor);
  const p2 = (await owner.req("GET", docUrl(id) + "/meta-history?cursor=" + p1.next_cursor)).body;
  assert.deepEqual([...p1.meta_versions, ...p2.meta_versions].map((m) => m.version), Array.from({ length: 61 }, (_, i) => 61 - i));
  assert.equal(p2.meta_versions.at(-1).baseline, true);
  assert.equal(p2.next_cursor, null);
});

test("tools/list: restore and diff tools exist; write tools document change_note", async () => {
  const tools = (await agent.client.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const n of ["diff_revisions", "restore_revision", "restore_metadata"]) assert.ok(names.includes(n), n);
  for (const n of ["save_markdown", "create_markdown", "restore_revision", "restore_metadata"]) {
    const note = tools.find((t) => t.name === n).inputSchema.properties.change_note;
    assert.equal(note?.maxLength, 280, n);
    // Agents are asked to always say why: the field, the tool and the server instructions all say so.
    assert.match(note.description, /^Always include: why you made this change/, n);
  }
  assert.match(tools.find((t) => t.name === "save_markdown").description, /Always set change_note/);
  for (const n of ["restore_revision", "restore_metadata"]) assert.match(tools.find((t) => t.name === n).description, /Set change_note to why/, n);
  assert.match(agent.client.getInstructions() ?? "", /tools with a change_note field\), always set change_note/);
  // Only tools that accept change_note are asked for it (others would reject the argument).
  for (const t of tools) if (/Always set change_note|Set change_note to why/.test(t.description)) assert.ok(t.inputSchema.properties.change_note, t.name);
});

test("backup round-trips who/why and details versions", async () => {
  const b = (await owner.req("GET", `/api/projects/${P}/backup`)).body;
  const r2 = b.revisions.find((r) => r.artifact_id === doc && r.rev_no === 2);
  assert.deepEqual([r2.via_kind, r2.client_info, r2.change_note], ["grant", "claude-code 1.0.0", "Capitalised beta"]);
  assert.ok(b.meta_versions.some((m) => m.artifact_id === doc && m.version === 5));
  const s2 = await startServer("a12-restore", SERVER_PORTS["a12-restore"]);
  try {
    const h2 = await s2.login();
    assert.equal((await h2.req("POST", "/api/restore", b)).status, 201);
    const hist = (await h2.req("GET", docUrl(doc) + "/history")).body;
    assert.equal(hist.revisions.find((v) => v.rev === 2).change_note, "Capitalised beta");
    assert.ok(hist.meta_versions.some((m) => m.change_note === "Title was right before" && m.restored_from === 1));
    assert.deepEqual(hist.meta_versions.map((m) => m.version), b.meta_versions.filter((m) => m.artifact_id === doc).map((m) => m.version).sort((x, y) => y - x));
  } finally { await s2.stop(); }
  // A backup made before version history (no meta_versions, no who/why columns) still restores; a malformed one is a 400.
  // (Restoring rewrites nothing: rows keep their author_id; the restoring owner here is the same synthetic owner.)
  const old = { ...b, meta_versions: undefined, revisions: b.revisions.map(({ via_kind, via_id, via_label, client_info, change_note, ...r }) => r) };
  const s3 = await startServer("a12-restore", SERVER_PORTS["a12-restore"]);
  try {
    const h3 = await s3.login();
    assert.equal((await h3.req("POST", "/api/restore", { ...b, meta_versions: { nope: 1 } })).status, 400);
    assert.equal((await h3.req("POST", "/api/restore", old)).status, 201);
    const hist = (await h3.req("GET", docUrl(doc) + "/history")).body;
    assert.equal(hist.revisions.length, b.revisions.filter((r) => r.artifact_id === doc).length);
    assert.equal(hist.revisions.find((v) => v.rev === 2).change_note, null);
    assert.deepEqual(hist.meta_versions, []);
    // The first details change after restoring records the baseline, as for any pre-0010 document.
    const a = (await h3.req("GET", docUrl(doc))).body.artifact;
    assert.equal((await h3.req("PATCH", docUrl(doc), { expected_meta_version: a.meta_version, title: "After restore" })).status, 200);
    const mh = (await h3.req("GET", docUrl(doc) + "/meta-history")).body.meta_versions;
    assert.deepEqual([mh.length, mh[1].baseline], [2, true]);
  } finally { await s3.stop(); }
});

test("browser: History shows who/why, groups autosave bursts, compares, restores; ?v= deep link opens a version", { skip: !haveChrome && "Chrome not installed" }, async () => {
  // A burst of 5 quick browser saves (as autosave would make) on a fresh document.
  const made = await owner.req("POST", `/api/projects/${P}/artifacts`, { title: "Burst", body: "start" });
  const id = made.body.artifact_id;
  for (let i = 1; i <= 5; i++) await owner.req("PUT", docUrl(id), { expected_revision: i, body: "start\nedit " + i });
  await agent.call("save_markdown", { project_id: P, artifact_id: id, expected_revision: 6, body: "start\nedit 5\nagent line", change_note: "Added agent line", idempotency_key: key("s") });
  const browser = await require(PUPPETEER).launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(APP + "/"); await page.waitForSelector('input[name="passphrase"]');
    await page.type('input[name="passphrase"]', s.passphrase());
    await Promise.all([page.waitForFunction(() => document.querySelectorAll("#nav a").length === 4), page.click('button[type="submit"]')]);
    await page.goto(`${APP}/p/${P}/a/${id}`);
    await page.waitForFunction(() => [...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.trim() === "History"));
    await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "History").click());
    await page.waitForSelector(".vh-list .vh-row");
    const rows = await page.$$eval(".vh-list > li", (ls) => ls.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
    assert.match(rows[0], /v7 .*Research agent.*agent token.*via claude-code 1\.0\.0/, rows[0]);
    assert.match(rows[0], /Added agent line/);
    assert.ok(rows.some((r) => /v1–6|v2–6/.test(r) && /edits/.test(r)), "browser autosaves collapse into one row: " + JSON.stringify(rows));
    // Open the agent's version: the diff shows the added line.
    await page.click('.vh-row[data-rev="7"] button');
    await page.waitForSelector(".vh-diff .vh-line.add");
    assert.ok((await page.$$eval(".vh-diff .vh-line.add", (ls) => ls.map((l) => l.innerText))).some((t) => t.includes("agent line")));
    await page.screenshot({ path: "tmp/test-evidence/version-history-desktop.png", fullPage: true });
    // Restore the version before the agent's edit.
    page.once("dialog", (d) => d.accept());
    const burstToggle = await page.$(".vh-burst .vh-toggle");
    assert.equal(await burstToggle.evaluate((b) => b.textContent), "Show 6 edits");
    await burstToggle.click();
    assert.equal(await burstToggle.evaluate((b) => b.getAttribute("aria-expanded")), "true");
    await page.click('.vh-row[data-rev="6"] button');
    await page.waitForFunction(() => [...document.querySelectorAll(".vh-detail button")].some((b) => b.textContent === "Restore this version"));
    await page.evaluate(() => [...document.querySelectorAll(".vh-detail button")].find((b) => b.textContent === "Restore this version").click());
    await page.waitForFunction(() => /Restored version 6 as version 8/.test(document.querySelector(".vh .msg").textContent));
    assert.equal((await owner.req("GET", docUrl(id))).body.body, "start\nedit 5");
    // Focus moved to the new version's heading after restore; the restored row is open.
    await page.waitForFunction(() => document.activeElement && document.activeElement.textContent === "Version 8 (current)");
    assert.doesNotMatch(await page.$eval(".vh-detail", (e) => e.innerText), /\bnull\b|undefined/, "no stray null/undefined text in the version panel");
    // Deep link from an agent's version_url opens that version, showing what it changed (matching its note).
    await page.goto(`${APP}/p/${P}/a/${id}?v=7`);
    await page.waitForSelector('.vh-row.open[data-rev="7"][aria-current="true"]');
    assert.equal(await page.$eval(".vh-detail h2", (e) => e.textContent), "Version 7");
    await page.waitForSelector(".vh-diff .vh-line.add");
    assert.match(await page.$eval(".vh-body .muted.small", (e) => e.textContent), /Changes from v6 to v7 · 1 added, 0 removed/);
    // A version inside a collapsed autosave burst opens with its burst expanded.
    await page.goto(`${APP}/p/${P}/a/${id}?v=3`);
    await page.waitForSelector('.vh-inner:not([hidden]) .vh-row.open[data-rev="3"]');
    // A version that doesn't exist says so instead of showing an empty heading.
    await page.goto(`${APP}/p/${P}/a/${id}?v=99`);
    await page.waitForFunction(() => [...document.querySelectorAll(".vh-detail")].some((d) => /Version 99 doesn't exist/.test(d.textContent)));
    await page.goto(`${APP}/p/${P}/a/${id}?v=7`);
    await page.waitForSelector(".vh-diff");
    // Mobile width: no horizontal overflow in the timeline and diff.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${APP}/p/${P}/a/${id}?v=7`);
    await page.waitForSelector(".vh-diff");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "no horizontal overflow at 390px");
    await page.screenshot({ path: "tmp/test-evidence/version-history-mobile.png", fullPage: true });
    // Details history past the first 50 versions: "Show older details" pages back to the baseline.
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${APP}/p/${P}/a/${manyDetailsDoc}`);
    await page.waitForFunction(() => [...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.trim() === "History"));
    await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "History").click());
    await page.waitForSelector('.vh-row[data-meta="61"]');
    assert.equal(await page.$('.vh-row[data-meta="1"]'), null, "only the first details page is loaded at first");
    await page.evaluate(() => [...document.querySelectorAll(".vh button")].find((b) => b.textContent === "Show older details").click());
    await page.waitForSelector('.vh-row[data-meta="1"]');
    assert.equal(await page.$$eval(".vh-row[data-meta]", (r) => r.length), 61);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".vh button")].some((b) => b.textContent === "Show older details" && !b.hidden && b.isConnected && b.offsetParent)), false, "no more pages");
    // Owner restores details from a trashed version (via the confirm): the panel reloads without an error.
    const cur = (await owner.req("GET", docUrl(manyDetailsDoc))).body.artifact.meta_version;
    const tr = await owner.req("PATCH", docUrl(manyDetailsDoc), { expected_meta_version: cur, trashed: true });
    assert.equal(tr.status, 200);
    assert.equal((await owner.req("PATCH", docUrl(manyDetailsDoc), { expected_meta_version: tr.body.meta_version, trashed: false })).status, 200);
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.trim() === "History"));
    await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "History").click());
    await page.waitForSelector(`.vh-row[data-meta="${tr.body.meta_version}"] button`);
    let said = "";
    page.once("dialog", (d) => { said = d.message(); d.accept(); });
    await page.waitForFunction(() => document.querySelector(".vh-list").getAttribute("aria-busy") !== "true");
    await page.evaluate((n) => document.querySelector(`.vh-row[data-meta="${n}"] button`).click(), tr.body.meta_version);
    await page.waitForSelector(`.vh-row[data-meta="${tr.body.meta_version + 2}"]`);
    assert.match(said, /This also moves the document to the trash/);
    assert.equal((await owner.req("GET", docUrl(manyDetailsDoc) + "/history")).body.meta_versions[0].trashed, true);
    assert.doesNotMatch(await page.$eval(".vh .msg", (e) => e.textContent), /not found/i);
  } finally { await browser.close(); }
});
