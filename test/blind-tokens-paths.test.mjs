// Blind-index search tokens (slice 4a, Part 2): every publishing path through its real HTTP route defers search
// indexing after the publication committed, and the deferred run writes the expected tokens. The Worker runs in
// process (test/blind-tokens-app.mjs: the real createWorker fetch over node:sqlite with every migration), so no
// listener is needed; deferred work is awaited through the request's recorded waitUntil promises or a polled
// condition with a deadline, never a fixed sleep. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { ROOT } from "./helpers.mjs";
import { app, captureLogs, expectedFor, lib, until, W } from "./blind-tokens-app.mjs";

const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const docRow = (a, artifact) => W.one(a.world, "SELECT * FROM search_token_docs WHERE artifact_id = ?", artifact);
const headOf = (a, artifact) => W.one(a.world, "SELECT head_revision_id FROM artifacts WHERE id = ?", artifact).head_revision_id;
const wsOf = (a, pid) => W.one(a.world, "SELECT workspace_id FROM projects WHERE id = ?", pid).workspace_id;
const tokensOf = (a, artifact) => W.tokensOf(a.world, artifact);
const assertExact = (a) => assert.deepEqual(W.counters(a.world), W.expectedCounters(a.world));
const missing = (a) => W.missing(a.world);
/** The run's plan read (its first D1 call). */
const isPlan = (c) => c.kind === "batch" && c.qs.some((q) => /\) AS cw,/.test(q));
const idle = () => {
  const s = lib.searchAdmissionState();
  assert.deepEqual([s.active, s.activeBytes, s.detached, s.running], [0, 0, 0, 0], JSON.stringify(s));
};
/** The document is indexed at its head: complete row, not missing, and its tokens are the expected HMACs. */
function assertIndexed(a, pid, artifact, text, why = artifact) {
  const row = docRow(a, artifact);
  assert.ok(row, `${why}: a search document row`);
  assert.equal(row.revision_id, headOf(a, artifact), `${why}: complete at the head`);
  assert.ok(!missing(a).includes(artifact), `${why}: not missing`);
  assert.deepEqual(tokensOf(a, artifact), expectedFor(a.world, wsOf(a, pid), words(text)), `${why}: the expected HMACs`);
  assertExact(a);
}

// --- 13a–13f, 13i, 13j: one test per path through its HTTP route ------------------------------------------------------
test("13a create markdown, 13b create html: the deferred run indexes the new document", async () => {
  const a = await app();
  await a.project("p13a");
  const md = await a.req("POST", "/api/projects/p13a/artifacts", { title: "Synthetic", body: "alpha beta gamma" });
  assert.equal(md.status, 201);
  const html = await a.req("POST", "/api/projects/p13a/artifacts", { title: "Synthetic", kind: "html", body: "<p>delta epsilon</p>" });
  assert.equal(html.status, 201);
  assert.equal(a.waits.length, 2, "one waitUntil per publishing request");
  await a.settle();
  assertIndexed(a, "p13a", md.body.artifact_id, "alpha beta gamma", "13a");
  assertIndexed(a, "p13a", html.body.artifact_id, "p delta epsilon p", "13b");
  idle();
});

test("13c create json and csv (App Connect on): indexed", async () => {
  const a = await app({ APP_CONNECT_ENABLED: "1" });
  await a.project("p13c");
  const j = await a.req("POST", "/api/projects/p13c/artifacts", { title: "Synthetic", kind: "json", content: "{\"zeta\": \"eta\"}" });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const c = await a.req("POST", "/api/projects/p13c/artifacts", { title: "Synthetic", kind: "csv", content: "theta,iota\n1,2\n" });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await a.settle();
  assertIndexed(a, "p13c", j.body.artifact_id, "{\"zeta\": \"eta\"}", "13c json");
  assertIndexed(a, "p13c", c.body.artifact_id, "theta,iota\n1,2\n", "13c csv");
  idle();
});

test("13d save markdown, 13e save json, 13f restore version: each new head is indexed", async () => {
  const a = await app({ APP_CONNECT_ENABLED: "1" });
  await a.project("p13d");
  const md = await a.req("POST", "/api/projects/p13d/artifacts", { title: "Synthetic", body: "first words" });
  const id = md.body.artifact_id;
  const s = await a.req("PUT", `/api/projects/p13d/artifacts/${id}`, { expected_revision: 1, body: "second words kappa" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  await a.settle();
  assertIndexed(a, "p13d", id, "second words kappa", "13d");
  const j = await a.req("POST", "/api/projects/p13d/artifacts", { title: "Synthetic", kind: "json", content: "{\"a\": 1}" });
  const sj = await a.req("PUT", `/api/projects/p13d/artifacts/${j.body.artifact_id}`, { expected_revision: 1, content: "{\"lambda\": \"mu\"}" });
  assert.equal(sj.status, 200, JSON.stringify(sj.body));
  await a.settle();
  assertIndexed(a, "p13d", j.body.artifact_id, "{\"lambda\": \"mu\"}", "13e");
  const r = await a.req("POST", `/api/projects/p13d/artifacts/${id}/restore`, { expected_revision: 2, from_revision: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await a.settle();
  assertIndexed(a, "p13d", id, "first words", "13f");
  idle();
});

test("13i template use, 13j template create: indexed", async () => {
  const a = await app();
  await a.project("p13i");
  const src = await a.req("POST", "/api/projects/p13i/artifacts", { title: "Synthetic", body: "template nu xi" });
  const def = await a.req("POST", "/api/projects/p13i/templates", { source_artifact_id: src.body.artifact_id, source_revision: 1, title: "Synthetic template" });
  assert.equal(def.status, 201, JSON.stringify(def.body));
  const use = await a.req("POST", "/api/projects/p13i/artifacts/from-template", { template_id: def.body.artifact_id, template_revision: 1, title: "Synthetic copy" });
  assert.equal(use.status, 201, JSON.stringify(use.body));
  await a.settle();
  assertIndexed(a, "p13i", def.body.artifact_id, "template nu xi", "13j");
  assertIndexed(a, "p13i", use.body.artifact_id, "template nu xi", "13i");
  idle();
});

test("13n MCP create and save through the official SDK client: indexed", async () => {
  const a = await app();
  await a.project("p13n");
  const g = await a.req("POST", "/api/projects/p13n/grants", { label: "Synthetic agent", can_write: true });
  assert.equal(g.status, 201);
  const client = new Client({ name: "synthetic", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${g.body.token}` } },
    fetch: (url, init) => a.fetch(new URL(url).pathname, init),
  }));
  const created = await client.callTool({ name: "create_markdown", arguments: { project_id: "p13n", title: "Synthetic", body: "omicron pi", idempotency_key: "mcp-create-0001" } });
  const id = created.structuredContent.artifact_id;
  await a.settle();
  assertIndexed(a, "p13n", id, "omicron pi", "13n create");
  const saved = await client.callTool({ name: "save_markdown", arguments: { project_id: "p13n", artifact_id: id, expected_revision: 1, body: "rho sigma", idempotency_key: "mcp-save-0001" } });
  assert.ok(!saved.isError, JSON.stringify(saved));
  await a.settle();
  assertIndexed(a, "p13n", id, "rho sigma", "13n save");
  await client.close();
  idle();
});

test("13p a binary upload changes nothing and leaves other tokens alone", async () => {
  const a = await app();
  await a.project("p13p");
  const md = await a.req("POST", "/api/projects/p13p/artifacts", { title: "Synthetic", body: "tau upsilon" });
  await a.settle();
  const before = { docs: W.all(a.world, "SELECT * FROM search_token_docs ORDER BY doc_id"), tokens: tokensOf(a, md.body.artifact_id), counters: W.counters(a.world) };
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
  const { createHash } = await import("node:crypto");
  const b = await a.req("POST", "/api/projects/p13p/uploads", { title: "Synthetic image", mime: "image/png", size: PNG.length, sha256: createHash("sha256").update(PNG).digest("hex") });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const put = await a.fetch(b.body.put_url, { method: "PUT", body: PNG, headers: { "content-length": String(PNG.length), cookie: a.cookie, "x-csrf-token": a.csrf } });
  assert.ok(put.status < 300, String(put.status));
  const f = await a.req("POST", `/api/projects/p13p/uploads/${b.body.upload_id}/finish`, {});
  assert.equal(f.status, 200, JSON.stringify(f.body));
  await a.settle();
  assert.deepEqual(W.all(a.world, "SELECT * FROM search_token_docs ORDER BY doc_id"), before.docs, "no row written or changed");
  assert.deepEqual(tokensOf(a, md.body.artifact_id), before.tokens);
  assert.deepEqual(W.counters(a.world), before.counters);
  idle();
});

// --- 13g, 13h: text upload finish indexes from packed terms ----------------------------------------------------------------
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** Begin, PUT and (optionally) finish one text upload through a route family: "api" (browser), "v1" (API key). */
async function textUpload(a, pid, text, { route = "api", token, begin = {}, finish = true, idem } = {}) {
  const bytes = Buffer.from(text);
  // /v1 is served on MCP_HOST (the app below sets it to mcp.example.test).
  const base = route === "v1" ? `http://mcp.example.test/v1/projects/${pid}/uploads` : `/api/projects/${pid}/uploads`;
  const auth = route === "v1" ? { authorization: `Bearer ${token}` } : { cookie: a.cookie, "x-csrf-token": a.csrf };
  const bres = await a.fetch(base, { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": `begin-${Math.random().toString(36).slice(2)}` },
    body: JSON.stringify({ title: "Synthetic text", mime: "text/markdown", size: bytes.length, sha256: sha(bytes), ...begin }) });
  const b = await bres.json();
  assert.equal(bres.status, 201, JSON.stringify(b));
  const put = await a.fetch(route === "v1" ? "http://mcp.example.test" + b.put_url : b.put_url, { method: "PUT", body: bytes, headers: { ...auth, "content-length": String(bytes.length) } });
  assert.ok(put.status < 300, String(put.status) + await put.text());
  if (!finish) return { begin: b };
  const fres = await a.fetch(`${base}/${b.upload_id}/finish`, { method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": idem ?? `finish-${b.upload_id}` }, body: "{}" });
  const ft = await fres.text();
  return { begin: b, status: fres.status, body: ft ? JSON.parse(ft) : null, finishUrl: `${base}/${b.upload_id}/finish`, auth };
}
const baseline = () => ({ flat: lib.searchFlatHeld(), state: lib.searchAdmissionState() });
const assertBaseline = (b0, why) => {
  assert.equal(lib.searchFlatHeld(), b0.flat, `${why}: no flat storage left`);
  const s = lib.searchAdmissionState();
  assert.deepEqual([s.active, s.activeBytes, s.detached, s.running], [0, 0, 0, 0], `${why}: ${JSON.stringify(s)}`);
};

test("13g text upload finish, new document (browser route): it publishes and its tokens are the expected HMACs", async () => {
  const a = await app();
  await a.project("p13g");
  const b0 = baseline();
  const text = "upload finish alpha beta gamma";
  const f = await textUpload(a, "p13g", text);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(a.waits.length, 1, "one run handed to waitUntil");
  await a.settle();
  assertIndexed(a, "p13g", f.body.artifact_id, text, "13g");
  assertBaseline(b0, "13g");
});

test("13h text upload finish, new version (/v1 with an API key): the new head's tokens replace the old", async () => {
  const a = await app({ MCP_HOST: "mcp.example.test" });
  await a.project("p13h");
  const k = await a.req("POST", "/api/api-keys", { label: "Synthetic key", lifetime_days: 1, projects: [{ project_id: "p13h", access: "read_write" }] });
  assert.equal(k.status, 201, JSON.stringify(k.body));
  const b0 = baseline();
  const first = await textUpload(a, "p13h", "first version words", { route: "v1", token: k.body.secret });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await a.settle();
  assertIndexed(a, "p13h", first.body.artifact_id, "first version words", "13h v1");
  const text = "second version other words";
  const next = await textUpload(a, "p13h", text, { route: "v1", token: k.body.secret, begin: { title: undefined, artifact_id: first.body.artifact_id, expected_revision: 1 } });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  await a.settle();
  assertIndexed(a, "p13h", first.body.artifact_id, text, "13h v2");
  assertBaseline(b0, "13h");
});

test("13g MCP upload_finish (official SDK client): indexed", async () => {
  const a = await app();
  await a.project("p13gm");
  const g = await a.req("POST", "/api/projects/p13gm/grants", { label: "Synthetic agent", can_write: true });
  const client = new Client({ name: "synthetic", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${g.body.token}` } }, fetch: (url, init) => a.fetch(new URL(url).pathname, init) }));
  const text = "mcp upload words";
  const b = await client.callTool({ name: "upload_begin", arguments: { project_id: "p13gm", title: "Synthetic", mime: "text/markdown", size: Buffer.byteLength(text), sha256: sha(text), idempotency_key: "mcp-begin-0001" } });
  assert.ok(!b.isError, JSON.stringify(b));
  const put = await a.fetch(b.structuredContent.put_url, { method: "PUT", body: text, headers: { authorization: `Bearer ${g.body.token}`, "content-length": String(Buffer.byteLength(text)) } });
  assert.ok(put.status < 300, String(put.status));
  const f = await client.callTool({ name: "upload_finish", arguments: { project_id: "p13gm", upload_id: b.structuredContent.upload_id, idempotency_key: "mcp-finish-0001" } });
  assert.ok(!f.isError, JSON.stringify(f));
  await a.settle();
  assertIndexed(a, "p13gm", f.structuredContent.artifact_id, text, "13g mcp");
  await client.close();
  idle();
});

test("upload finish exits: replay, conflict, fence refusal, validation failure and publish_failed leave no handle, reservation or job", async () => {
  const a = await app();
  await a.project("pex");
  const b0 = baseline();
  const ws = wsOf(a, "pex");
  const noRun = async (why, fn) => {
    const w0 = a.waits.length;
    const { result, events } = await captureLogs(fn);
    await a.settle();
    assert.equal(a.waits.length, 0);
    assert.ok(!events.some((e) => e.event === "search_phase"), `${why}: no run`);
    assertBaseline(b0, why);
    void w0;
    return { result, events };
  };
  // Replay: the same finish again (recorded result).
  const ok = await textUpload(a, "pex", "replayed words");
  assert.equal(ok.status, 200);
  await a.settle();
  const before = W.all(a.world, "SELECT * FROM search_token_docs ORDER BY doc_id");
  const { result: rp } = await noRun("replay", async () => (await a.fetch(ok.finishUrl, { method: "POST", headers: { ...ok.auth, "content-type": "application/json", "idempotency-key": "finish-replay-2" }, body: "{}" })).json());
  assert.equal(rp.idempotent_replay, true);
  // Conflict: a stale expected revision (a save moved the head after the upload began).
  const v = await textUpload(a, "pex", "conflict words", { begin: { title: undefined, artifact_id: ok.body.artifact_id, expected_revision: 1 }, finish: false });
  assert.equal((await a.req("PUT", `/api/projects/pex/artifacts/${ok.body.artifact_id}`, { expected_revision: 1, body: "moved on" })).status, 200);
  await a.settle();
  const before2 = W.all(a.world, "SELECT * FROM search_token_docs ORDER BY doc_id");
  const { result: cf } = await noRun("conflict", () => a.req("POST", `/api/projects/pex/uploads/${v.begin.upload_id}/finish`, {}));
  assert.equal(cf.status, 409, JSON.stringify(cf.body));
  assert.equal(cf.body.error.code, "revision_conflict");
  assert.deepEqual(W.all(a.world, "SELECT * FROM search_token_docs ORDER BY doc_id"), before2, "conflict wrote nothing");
  // Validation failure after the ticket would be taken: not UTF-8 (invalid_content) ends before extraction.
  const bad = Buffer.from([0x61, 0xff, 0x62]);
  const bres = await a.req("POST", "/api/projects/pex/uploads", { title: "Synthetic text", mime: "text/markdown", size: bad.length, sha256: sha(bad) });
  await a.fetch(bres.body.put_url, { method: "PUT", body: bad, headers: { cookie: a.cookie, "x-csrf-token": a.csrf, "content-length": "3" } });
  const { result: vf } = await noRun("validation", () => a.req("POST", `/api/projects/pex/uploads/${bres.body.upload_id}/finish`, {}));
  assert.equal(vf.status, 422, JSON.stringify(vf.body));
  // Fence refusal (the text-write fence: the staged write expired inside the publishing batch) after extraction.
  const r = await textUpload(a, "pex", "refused upload words", { finish: false });
  a.world.before = async (c) => { if (c.kind === "batch" && c.qs.some((q) => /INSERT INTO revisions/.test(q))) W.run(a.world, "UPDATE content_writes SET created_at = 0"); };
  const { result: rf } = await noRun("fence refusal", () => a.req("POST", `/api/projects/pex/uploads/${r.begin.upload_id}/finish`, {}));
  a.world.before = null;
  assert.equal(rf.status, 503, JSON.stringify(rf.body));
  assert.equal(rf.body.error.code, "text_write_expired");
  // The 503 is retryable (the upload stays sealed); end it so this identity may begin the next one.
  W.run(a.world, "UPDATE uploads SET state = 'failed', finalize_token = NULL, finalize_until = NULL WHERE id = ?", r.begin.upload_id);
  // publish_failed (finalization state inconsistent): the stored object's key is changed under the lease.
  const pf = await textUpload(a, "pex", "publish failed words", { finish: false });
  a.world.after = async (c) => { if (c.kind !== "batch" && /SET finalize_token = \?, finalize_until = \?, final_key = COALESCE/.test(c.q)) W.run(a.world, "UPDATE uploads SET final_key = 'elsewhere' WHERE id = ?", pf.begin.upload_id); };
  const { result: pr } = await noRun("publish_failed", () => a.req("POST", `/api/projects/pex/uploads/${pf.begin.upload_id}/finish`, {}));
  a.world.after = null;
  assert.equal(pr.status, 500, JSON.stringify(pr.body));
  assert.equal(pr.body.error.code, "publish_failed");
  void before; void ws;
  assertExact(a);
});

test("upload finish: SEARCH_TERMS_MAX = 0 writes the off row without extraction; an extraction failure still publishes (counted skipped)", async () => {
  const off = await app({ SEARCH_TERMS_MAX: "0" });
  await off.project("poff");
  const b0 = baseline();
  const f = await textUpload(off, "poff", "off words");
  assert.equal(f.status, 200);
  assert.equal(lib.searchFlatHeld(), b0.flat, "no handle was made");
  await off.settle();
  const row = docRow(off, f.body.artifact_id);
  assert.equal(row.revision_id, headOf(off, f.body.artifact_id));
  assert.equal(row.truncated_by, "off");
  assertExact(off);
  idle();
  // Extraction failure: TextEncoder.encodeInto throwing during packing.
  const a = await app();
  await a.project("pxf");
  const real = TextEncoder.prototype.encodeInto;
  TextEncoder.prototype.encodeInto = function () { throw new Error("synthetic extraction failure"); };
  let r, events;
  try { ({ result: r, events } = await captureLogs(async () => { const x = await textUpload(a, "pxf", "fails to extract"); await a.settle(); return x; })); }
  finally { TextEncoder.prototype.encodeInto = real; }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(events.filter((e) => e.event === "search_index_skipped").map((e) => e.reasons), [{ error: 1 }]);
  assert.equal(docRow(a, r.body.artifact_id), undefined, "left missing");
  assert.ok(missing(a).includes(r.body.artifact_id));
  assertBaseline(b0, "extraction failure");
});

test("18 (upload): a second text finish is accepted while the first one's deferred work is paused; a forced token failure leaves the response unchanged", async () => {
  const a = await app();
  await a.project("p18u");
  const b0 = baseline();
  let release, held = false;
  const paused = new Promise((r) => { release = r; });
  a.world.before = async (c) => { if (!held && isPlan(c)) { held = true; await paused; } };
  const one = await textUpload(a, "p18u", "first paused upload");
  assert.equal(one.status, 200);
  await until(() => held, { what: "the first run's plan read" });
  const two = await textUpload(a, "p18u", "second upload words");
  assert.equal(two.status, 200, JSON.stringify(two.body));
  release();
  a.world.before = null;
  await a.settle();
  assertIndexed(a, "p18u", one.body.artifact_id, "first paused upload", "first");
  assertIndexed(a, "p18u", two.body.artifact_id, "second upload words", "second");
  a.world.before = async (c) => { if ((c.qs ?? [c.q]).some((q) => /search_token_docs|search_tokens|workspace_search_keys/.test(q))) throw new Error("synthetic token failure"); };
  const { result: three, events } = await captureLogs(async () => { const x = await textUpload(a, "p18u", "third upload words"); await a.settle(); return x; });
  a.world.before = null;
  assert.equal(three.status, 200, JSON.stringify(three.body));
  assert.deepEqual(Object.keys(three.body).sort(), Object.keys(two.body).sort(), "the same response shape");
  assert.ok(events.some((e) => e.event === "search_index_failed"));
  assertExact(a);
  assertBaseline(b0, "18 upload");
});

// --- 12: saves --------------------------------------------------------------------------------------------------------
test("12: a small edit takes one batch; a stale save, an idempotent replay and a failed publication do no token work", async () => {
  const a = await app();
  await a.project("p12");
  const md = await a.req("POST", "/api/projects/p12/artifacts", { title: "Synthetic", body: "one two three four five" });
  const id = md.body.artifact_id;
  await a.settle();
  // A small edit: count the run's write batches (the token tables) and its D1 calls.
  // A write batch of the run: it changes search_token_docs (every token batch carries its lease and fences).
  const tokenBatches = () => a.world.log.filter((c) => c.kind === "batch" && c.qs.some((q) => /^\s*(UPDATE|INSERT INTO) search_token_docs\b/.test(q)));
  const b0 = tokenBatches().length;
  const s = await a.req("PUT", `/api/projects/p12/artifacts/${id}`, { expected_revision: 1, body: "one two three four six" }, { idem: "key-save-small-1" });
  assert.equal(s.status, 200);
  await a.settle();
  assert.equal(tokenBatches().length - b0, 1, "a small edit: one write batch");
  assertIndexed(a, "p12", id, "one two three four six");
  const quiet = async (why, fn) => {
    const c0 = a.world.calls, w0 = a.waits.length;
    const { result, events } = await captureLogs(fn);
    assert.equal(a.waits.length, w0, `${why}: no run handed to waitUntil`);
    assert.ok(!events.some((e) => e.event === "search_phase"), `${why}: no run`);
    await a.settle();
    assert.ok(!a.world.log.slice(-(a.world.calls - c0)).some((c) => (c.qs ?? [c.q]).some((q) => /search_tokens|search_token_docs/.test(q))), `${why}: no token statement`);
    return result;
  };
  // Stale save (expected revision 1, head is 2).
  const stale = await quiet("stale", () => a.req("PUT", `/api/projects/p12/artifacts/${id}`, { expected_revision: 1, body: "stale text" }));
  assert.equal(stale.status, 409);
  // Idempotent replay of the small edit.
  const replay = await quiet("replay", () => a.req("PUT", `/api/projects/p12/artifacts/${id}`, { expected_revision: 1, body: "one two three four six" }, { idem: "key-save-small-1" }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent_replay, true);
  // A failed publication: the document is trashed, the save refused.
  const t = await a.req("PATCH", `/api/projects/p12/artifacts/${id}`, { expected_meta_version: 1, trashed: true });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const failed = await quiet("failed", () => a.req("PUT", `/api/projects/p12/artifacts/${id}`, { expected_revision: 2, body: "never published" }));
  assert.ok(failed.status === 404 || failed.status === 409, String(failed.status));
  assertIndexed(a, "p12", id, "one two three four six", "unchanged");
  idle();
});

test("12: with SEARCH_TERMS_MAX = 0 a save writes a complete off row with no tokens, not listed missing", async () => {
  const a = await app({ SEARCH_TERMS_MAX: "0" });
  await a.project("p12off");
  const md = await a.req("POST", "/api/projects/p12off/artifacts", { title: "Synthetic", body: "phi chi psi" });
  const s = await a.req("PUT", `/api/projects/p12off/artifacts/${md.body.artifact_id}`, { expected_revision: 1, body: "omega words" });
  assert.equal(s.status, 200);
  await a.settle();
  const row = docRow(a, md.body.artifact_id);
  assert.equal(row.revision_id, headOf(a, md.body.artifact_id));
  assert.equal(row.truncated_by, "off");
  assert.equal(tokensOf(a, md.body.artifact_id).length, 0);
  assert.ok(!missing(a).includes(md.body.artifact_id));
  assertExact(a);
  idle();
});

test("12: the response resolves before deferred_start for a 10 MiB worst-case save (one ordered observation)", async () => {
  const a = await app({ SEARCH_PHASE_LOG: "1" });
  await a.project("p12big");
  const md = await a.req("POST", "/api/projects/p12big/artifacts", { title: "Synthetic", body: "seed" });
  await a.settle();
  const big = Array.from({ length: 1300000 }, (_, i) => "w" + i.toString(36)).join(" ").slice(0, 10 * 1048576 - 64);
  // Every D1 call of the run touches a search table or the plan read; mark when the first one happens.
  const isRunCall = (c) => (c.qs ?? [c.q]).some((q) => /search_token|search_term_counters|workspace_search_keys|\) AS cw,/.test(q));
  const seen = [];
  a.world.before = async (c) => { if (isRunCall(c)) seen.push("run_call"); };
  const { events } = await captureLogs(async () => {
    // Every log line as written (captureLogs' collector is wrapped): read at the moment the fetch promise resolves.
    const lines = [], collect = console.log;
    console.log = (...x) => { lines.push(String(x[0])); return collect(...x); };
    const r = await a.fetch(`/api/projects/p12big/artifacts/${md.body.artifact_id}`, { method: "PUT",
      headers: { cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json", "idempotency-key": "key-big-save-0001" },
      body: JSON.stringify({ expected_revision: 1, body: big }) });
    // The moment the fetch promise resolved: record what the run had done by then, in the same observation.
    seen.push(`response:${r.status}`);
    // The run has not started: no deferred_start (SEARCH_PHASE_LOG = "1") and no extraction (extract_done) yet.
    seen.push(`started:${lines.some((l) => /"phase":"(deferred_start|extract_done|hmac_done)"/.test(l))}`);
    seen.push(`handler_done:${lines.some((l) => /"phase":"handler_done"/.test(l))}`);
    console.log = collect;
    await r.text();
    await a.settle();
  });
  a.world.before = null;
  const at = seen.findIndex((x) => x.startsWith("response:"));
  assert.equal(seen[at], "response:200");
  assert.deepEqual(seen.slice(0, at), [], "no run D1 call before the response resolved");
  assert.deepEqual(seen.slice(at + 1, at + 3), ["started:false", "handler_done:true"], "at the response: handed over, not started, nothing extracted");
  const phases = events.filter((e) => e.event === "search_phase").map((e) => e.phase);
  assert.deepEqual(phases.slice(0, 2), ["handler_done", "deferred_start"]);
  assert.ok(seen.slice(at + 1).includes("run_call"), "the run ran after");
  const row = docRow(a, md.body.artifact_id);
  assert.equal(row.revision_id, headOf(a, md.body.artifact_id));
  assertExact(a);
  idle();
});

// --- 9 (server part): waitUntil and the boundary ---------------------------------------------------------------------
test("9: the request hands waitUntil exactly one promise, which never rejects, after the Response resolved", async () => {
  const a = await app();
  await a.project("p9a");
  const seen = [];
  a.setWaitUntil((p) => { seen.push({ p, at: performance.now() }); });
  let resolvedAt = 0;
  const r = await a.req("POST", "/api/projects/p9a/artifacts", { title: "Synthetic", body: "alpha" });
  resolvedAt = performance.now();
  assert.equal(r.status, 201);
  assert.equal(seen.length, 1, "one promise");
  assert.ok(seen[0].at <= resolvedAt);
  const settled = await Promise.allSettled([seen[0].p]);
  assert.equal(settled[0].status, "fulfilled");
  await lib.drainSearchIndexing();
  assertIndexed(a, "p9a", r.body.artifact_id, "alpha");
  // A request that publishes nothing hands waitUntil nothing.
  seen.length = 0;
  await a.req("GET", "/api/projects/p9a/artifacts");
  assert.equal(seen.length, 0);
  idle();
});

test("9: deferral never changes the response: waitUntil throwing, missing, or a deferral error give the normal response", async () => {
  const a = await app();
  await a.project("p9b");
  // waitUntil throws.
  a.setWaitUntil(() => { throw new Error("synthetic waitUntil failure"); });
  const { result: r1, events: e1 } = await captureLogs(() => a.req("POST", "/api/projects/p9b/artifacts", { title: "Synthetic", body: "alpha" }));
  assert.equal(r1.status, 201);
  assert.ok(e1.some((e) => e.event === "search_index_skipped" && e.reasons?.unstarted === 1), JSON.stringify(e1));
  assert.equal(lib.searchAdmissionState().active, 0, "settled synchronously");
  await lib.drainSearchIndexing();   // the started run returns quietly after its first yield
  assert.equal(e1.filter((e) => e.event === "search_index_skipped").length, 1, "one skip line");
  idle();
  // No waitUntil at all.
  const { result: r2 } = await captureLogs(() => a.req("POST", "/api/projects/p9b/artifacts", { title: "Synthetic", body: "beta" }, { ctx: {} }));
  assert.equal(r2.status, 201);
  idle();
  assert.equal(docRow(a, r1.body.artifact_id), undefined);
  assert.ok(missing(a).includes(r1.body.artifact_id), "left for a later save or the backfill");
  idle();
});

// --- 14 (deferred-job part): a workspace marked deleting before the first batch -------------------------------------
test("14: a deferred job paused before its first batch, then the workspace marked deleting: it writes nothing, nothing missing", async () => {
  const a = await app();
  const p = await a.project("p14");
  let release;
  const paused = new Promise((r) => { release = r; });
  let hit = false;
  a.world.before = async (c) => {
    if (!hit && c.kind === "batch" && c.qs.some((q) => /INSERT INTO search_token_docs/.test(q))) { hit = true; await paused; }
  };
  const r = await a.req("POST", "/api/projects/p14/artifacts", { title: "Synthetic", body: "alpha beta" });
  assert.equal(r.status, 201);
  await until(() => hit, { what: "the first token batch" });
  W.run(a.world, "UPDATE workspaces SET status = 'deleting' WHERE id = ?", p.workspace_id);
  release();
  a.world.before = null;
  await a.settle();
  assert.equal(docRow(a, r.body.artifact_id), undefined, "no row");
  assert.equal(W.one(a.world, "SELECT COUNT(*) AS n FROM search_tokens").n, 0);
  assert.ok(!missing(a).includes(r.body.artifact_id), "a deleting workspace's documents are not missing");
  assertExact(a);
  idle();
});

// --- 15: search unchanged ---------------------------------------------------------------------------------------------
test("15: search results are unchanged by indexing (12 fixed queries, the same with SEARCH_TERMS_MAX = 0)", async () => {
  const results = [];
  for (const vars of [{}, { SEARCH_TERMS_MAX: "0" }]) {
    const a = await app(vars);
    await a.project("p15");
    const docs = ["alpha beta gamma", "beta delta", "gamma epsilon zeta", "Zürich straße", "日本語 テスト", "naïve café", "eta theta", "iota kappa lambda", "mu nu", "xi omicron", "pi rho", "sigma tau"];
    for (const [i, body] of docs.entries()) await a.req("POST", "/api/projects/p15/artifacts", { title: `Synthetic ${i}`, body }, { idem: `key-search-${i}-fixed` });
    await a.settle();
    const out = [];
    for (const q of ["alpha", "beta", "gamma", "zurich", "strasse", "日本語", "cafe", "theta", "lambda", "nu", "omicron", "tau"]) {
      const r = await a.req("GET", `/api/search?q=${encodeURIComponent(q)}`);
      out.push([q, r.status, (r.body?.results ?? []).map((x) => x.title)]);
    }
    results.push(out);
    idle();
  }
  assert.deepEqual(results[0], results[1]);
});

// --- 16: plaintext key race -------------------------------------------------------------------------------------------
test("16: 20 concurrent creates in a new workspace leave one key row; each document is indexed with it or left missing", async () => {
  const a = await app();
  const p = await a.project("p16");
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => a.req("POST", "/api/projects/p16/artifacts", { title: `Synthetic ${i}`, body: `word${i} common` })));
  assert.ok(rs.every((r) => r.status === 201));
  await a.settle();
  const keys = W.all(a.world, "SELECT key_id FROM workspace_search_keys WHERE workspace_id = ?", p.workspace_id);
  assert.equal(keys.length, 1, "one key row");
  // About 7 small runs fit an isolate at once (design: 32 MiB active, 4.2 MiB each); a refused run's document stays
  // missing for a later save or the backfill. Every row written uses the one key.
  let indexed = 0;
  for (const [i, r] of rs.entries()) {
    const row = docRow(a, r.body.artifact_id);
    if (!row) { assert.ok(missing(a).includes(r.body.artifact_id)); continue; }
    assert.equal(row.key_id, keys[0].key_id);
    assertIndexed(a, "p16", r.body.artifact_id, `word${i} common`);
    indexed++;
  }
  assert.ok(indexed >= 7, `${indexed} indexed`);
  idle();
});

// --- 17: fences after the response -------------------------------------------------------------------------------------
/** The run's first token write batch (it leases or creates the document row). */
const isWrite = (c) => c.kind === "batch" && c.qs.some((q) => /^\s*(UPDATE|INSERT INTO) search_token_docs\b/.test(q));

test("17a: a key shred while the run's first token write is in flight: the key fence refuses it (key_shredded), nothing written", async () => {
  const master = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const a = await app({ CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: master });
  const p = await a.project("p17");
  const first = await a.req("POST", "/api/projects/p17/artifacts", { title: "Synthetic", body: "seed words" });
  assert.equal(first.status, 201);
  await a.settle();
  const before = { tokens: tokensOf(a, first.body.artifact_id), row: docRow(a, first.body.artifact_id), counters: W.counters(a.world) };
  let release, held = false;
  const paused = new Promise((r) => { release = r; });
  a.world.before = async (c) => { if (!held && isWrite(c)) { held = true; await paused; } };
  const { result: s, events } = await captureLogs(async () => {
    const s0 = await a.req("PUT", `/api/projects/p17/artifacts/${first.body.artifact_id}`, { expected_revision: 1, body: "after shred" });
    await until(() => held, { what: "the run's first write batch" });
    W.run(a.world, "UPDATE workspace_keys SET shredded_at = 1, wrapped = '' WHERE workspace_id = ?", p.workspace_id);
    release();
    a.world.before = null;
    await a.settle();
    return s0;
  });
  assert.equal(s.status, 200);
  const failed = events.filter((e) => e.event === "search_index_failed");
  assert.deepEqual(failed.map((e) => e.code), ["key_shredded"], JSON.stringify(failed));
  assert.deepEqual(tokensOf(a, first.body.artifact_id), before.tokens, "prior tokens unchanged");
  assert.deepEqual(docRow(a, first.body.artifact_id), before.row, "nothing written");
  assert.deepEqual(W.counters(a.world), before.counters);
  assertExact(a);
  idle();
});

test("17b: encryption turned on while the run's first token write is in flight: the plaintext fence refuses it (encryption_started)", async () => {
  const a = await app();
  const p = await a.project("p17b");
  const first = await a.req("POST", "/api/projects/p17b/artifacts", { title: "Synthetic", body: "seed words" });
  await a.settle();
  const before = { tokens: tokensOf(a, first.body.artifact_id), row: docRow(a, first.body.artifact_id), counters: W.counters(a.world) };
  let release, held = false;
  const paused = new Promise((r) => { release = r; });
  a.world.before = async (c) => { if (!held && isWrite(c)) { held = true; await paused; } };
  const { result: s, events } = await captureLogs(async () => {
    const s0 = await a.req("PUT", `/api/projects/p17b/artifacts/${first.body.artifact_id}`, { expected_revision: 1, body: "after encryption on" });
    await until(() => held, { what: "the run's first write batch" });
    W.run(a.world, "INSERT INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at) VALUES (?, 'wk_synthetic', 1, 'synthetic-wrapped', 1)", p.workspace_id);
    release();
    a.world.before = null;
    await a.settle();
    return s0;
  });
  assert.equal(s.status, 200);
  const failed = events.filter((e) => e.event === "search_index_failed");
  assert.deepEqual(failed.map((e) => e.code), ["encryption_started"], JSON.stringify(failed));
  assert.deepEqual(tokensOf(a, first.body.artifact_id), before.tokens, "prior tokens unchanged");
  assert.deepEqual(docRow(a, first.body.artifact_id), before.row);
  assert.deepEqual(W.counters(a.world), before.counters);
  assertExact(a);
  idle();
});

test("wiring: a publication refused by a fence creates no job and no run", async () => {
  const a = await app({ SEARCH_PHASE_LOG: "1" });
  await a.project("pfence");
  await a.req("POST", "/api/projects/pfence/artifacts", { title: "Synthetic", body: "seed" });
  await a.settle();
  // The text-write fence (first statement of the publishing batch) refuses when the staged write is gone: expire it
  // just before the batch runs. The publication is refused (503 text_write_expired) and must create no job.
  const w0 = a.waits.length, c0 = a.world.calls;
  a.world.before = async (c) => { if (c.kind === "batch" && c.qs.some((q) => /INSERT INTO revisions/.test(q))) W.run(a.world, "UPDATE content_writes SET created_at = 0"); };
  const { result: r, events } = await captureLogs(() => a.req("POST", "/api/projects/pfence/artifacts", { title: "Synthetic", body: "refused words" }));
  a.world.before = null;
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "text_write_expired");
  assert.equal(a.waits.length, w0, "no run handed to waitUntil");
  assert.ok(!events.some((e) => e.event === "search_phase" || e.event === "search_index_skipped"), "no job, no run");
  assert.ok(!a.world.log.slice(-(a.world.calls - c0)).some((c) => (c.qs ?? [c.q]).some((q) => /search_token_docs|workspace_search_keys/.test(q))));
  idle();
});

test("wiring: a project deleted between the commit and the run's first token batch gets no tokens; counters exact", async () => {
  const a = await app();
  await a.project("pdel");
  const keep = await a.req("POST", "/api/projects/pdel/artifacts", { title: "Synthetic", body: "kept words" });
  await a.settle();
  const before = W.counters(a.world);
  let release, held = false;
  const paused = new Promise((r) => { release = r; });
  a.world.before = async (c) => { if (!held && isWrite(c)) { held = true; await paused; } };
  const r = await a.req("POST", "/api/projects/pdel/artifacts", { title: "Synthetic", body: "never indexed words" });
  assert.equal(r.status, 201);
  await until(() => held, { what: "the run's first write batch" });
  const del = await a.req("DELETE", "/api/projects/pdel", { confirm_title: "Synthetic" });
  assert.ok(del.status < 300, JSON.stringify(del.body));
  release();
  a.world.before = null;
  await captureLogs(() => a.settle());
  assert.equal(docRow(a, r.body.artifact_id), undefined, "no row for the new document");
  assert.equal(W.one(a.world, "SELECT COUNT(*) AS n FROM search_tokens s JOIN search_token_docs d ON d.doc_id = s.doc_id WHERE d.artifact_id = ?", r.body.artifact_id).n, 0);
  assert.deepEqual(W.counters(a.world), before);
  void keep;
  assertExact(a);
  idle();
});

test("R7-2: a plain save logs no search_phase line without SEARCH_PHASE_LOG, and the five with it", async () => {
  for (const [vars, want] of [[{}, []], [{ SEARCH_PHASE_LOG: "1" }, ["handler_done", "deferred_start", "extract_done", "hmac_done", "deferred_end"]]]) {
    const a = await app(vars);
    await a.project("pphase");
    const md = await a.req("POST", "/api/projects/pphase/artifacts", { title: "Synthetic", body: "alpha" });
    await a.settle();
    const { events } = await captureLogs(async () => { await a.req("PUT", `/api/projects/pphase/artifacts/${md.body.artifact_id}`, { expected_revision: 1, body: "beta" }); await a.settle(); });
    assert.deepEqual(events.filter((e) => e.event === "search_phase").map((e) => e.phase), want, JSON.stringify(vars));
    assertIndexed(a, "pphase", md.body.artifact_id, "beta");
    idle();
  }
});

// --- 18: best effort -----------------------------------------------------------------------------------------------------
test("18: a forced token failure on each path gives normal responses", async () => {
  const a = await app({ APP_CONNECT_ENABLED: "1" });
  await a.project("p18");
  const src = await a.req("POST", "/api/projects/p18/artifacts", { title: "Synthetic", body: "seed words" });
  await a.settle();
  const def = await a.req("POST", "/api/projects/p18/templates", { source_artifact_id: src.body.artifact_id, source_revision: 1, title: "Synthetic template" });
  await a.settle();
  // Every token statement fails from here on.
  a.world.before = async (c) => { if ((c.qs ?? [c.q]).some((q) => /search_token_docs|search_tokens|workspace_search_keys/.test(q))) throw new Error("synthetic token failure"); };
  const { result: rs, events } = await captureLogs(async () => {
    const out = [];
    out.push(await a.req("POST", "/api/projects/p18/artifacts", { title: "Synthetic", body: "create" }));
    out.push(await a.req("PUT", `/api/projects/p18/artifacts/${src.body.artifact_id}`, { expected_revision: 1, body: "save" }));
    out.push(await a.req("POST", "/api/projects/p18/artifacts", { title: "Synthetic", kind: "json", content: "{}" }));
    out.push(await a.req("POST", `/api/projects/p18/artifacts/${src.body.artifact_id}/restore`, { expected_revision: 2, from_revision: 1 }));
    out.push(await a.req("POST", "/api/projects/p18/artifacts/from-template", { template_id: def.body.artifact_id, template_revision: 1, title: "Copy" }));
    out.push(await a.req("POST", "/api/projects/p18/templates", { source_artifact_id: src.body.artifact_id, source_revision: 1, title: "Template 2" }));
    await a.settle();
    return out;
  });
  a.world.before = null;
  assert.deepEqual(rs.map((r) => r.status), [201, 200, 201, 200, 201, 201]);
  assert.ok(events.some((e) => e.event === "search_index_failed"), "the failure is logged");
  for (const e of events) assert.ok(!JSON.stringify(e).includes("seed words"), "no content in logs");
  assertExact(a);
  idle();
});

test("18: a kill-like abort of the deferred work mid-run leaves exact counters and a missing document; the next save completes it", async () => {
  const a = await app();
  await a.project("p18k");
  const first = await a.req("POST", "/api/projects/p18k/artifacts", { title: "Synthetic", body: "seed" });
  await a.settle();
  // The abort is injected outside tokens.js: the D1 double never resolves the run's write batch (the isolate died).
  // Released only at the end of the test (with a throw, so the batch never runs): a dead isolate's call never returns.
  let killed = false, revive;
  const dead = new Promise((r) => { revive = r; });
  a.world.before = async (c) => { if (!killed && c.kind === "batch" && c.qs.some((q) => /INSERT INTO search_tokens/.test(q))) { killed = true; await dead; throw new Error("synthetic: the isolate died"); } };
  const words2 = Array.from({ length: 50 }, (_, i) => "k" + i).join(" ");
  const s = await a.req("PUT", `/api/projects/p18k/artifacts/${first.body.artifact_id}`, { expected_revision: 1, body: words2 });
  assert.equal(s.status, 200);
  await until(() => killed, { what: "the killed batch" });
  a.world.before = null;
  // The killed run never settles in this isolate; the database is what a dead isolate leaves.
  assertExact(a);
  assert.ok(missing(a).includes(first.body.artifact_id));
  // The next save completes it (its writer takes the lease over).
  const s2 = await a.req("PUT", `/api/projects/p18k/artifacts/${first.body.artifact_id}`, { expected_revision: 2, body: words2 + " more" });
  assert.equal(s2.status, 200);
  await Promise.all(a.waits.splice(-1));
  assertIndexed(a, "p18k", first.body.artifact_id, words2 + " more");
  // Let the dead run end (its batch throws, nothing written) so the isolate is idle for the next test.
  revive();
  await captureLogs(() => a.settle());
  assertIndexed(a, "p18k", first.body.artifact_id, words2 + " more", "unchanged by the dead run");
  idle();
});

// --- 19: concurrent saves ---------------------------------------------------------------------------------------------
test("19: A deferred and paused, then B: B's set wins and A does nothing", async () => {
  const a = await app();
  await a.project("p19");
  const md = await a.req("POST", "/api/projects/p19/artifacts", { title: "Synthetic", body: "seed" });
  await a.settle();
  const id = md.body.artifact_id;
  // A's run is paused at its first call; B saves and completes; then A resumes.
  let release, held = false;
  const paused = new Promise((r) => { release = r; });
  a.setWaitUntil((p) => { a.waits.push(p); });
  a.world.before = async (c) => { if (!held && isPlan(c)) { held = true; a.world.before = null; await paused; } };
  const sA = await a.req("PUT", `/api/projects/p19/artifacts/${id}`, { expected_revision: 1, body: "version a words" });
  assert.equal(sA.status, 200);
  await until(() => held, { what: "A's plan read" });
  const sB = await a.req("PUT", `/api/projects/p19/artifacts/${id}`, { expected_revision: 2, body: "version b words" });
  assert.equal(sB.status, 200);
  await Promise.all(a.waits.splice(-1));
  assertIndexed(a, "p19", id, "version b words", "B");
  const after = { row: docRow(a, id), tokens: tokensOf(a, id) };
  release();
  await a.settle();
  assert.deepEqual({ row: docRow(a, id), tokens: tokensOf(a, id) }, after, "A did nothing");
  idle();
});

// --- 22: capacity -------------------------------------------------------------------------------------------------------
test("22: with a workspace budget of 3,000 and concurrent creates, the counter never exceeds 3,000; the save is still 201", async () => {
  const a = await app({ SEARCH_WORKSPACE_TERMS_MAX: "3000" });
  const p = await a.project("p22");
  const watch = [];
  a.world.after = async (c) => { if (c.kind === "batch") watch.push(W.one(a.world, "SELECT terms FROM search_term_counters WHERE scope = ?", `w:${p.workspace_id}`)?.terms ?? 0); };
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => a.req("POST", "/api/projects/p22/artifacts", { title: `Synthetic ${i}`, body: Array.from({ length: 600 }, (_, k) => `d${i}w${k}`).join(" ") })));
  assert.ok(rs.every((r) => r.status === 201));
  await a.settle();
  a.world.after = null;
  assert.ok(Math.max(...watch) <= 3000, `peak ${Math.max(...watch)}`);
  // Indexing ran: some documents are rows (complete, or clipped by the workspace), the counter reached the budget.
  assert.ok(W.one(a.world, "SELECT COUNT(*) AS n FROM search_token_docs").n > 0, "some documents indexed");
  assert.ok(Math.max(...watch) > 2400, `the budget was reached (peak ${Math.max(...watch)})`);
  assertExact(a);
  idle();
});

test("22: installation budget 2,000 across two owners: the second owner's document ends 'installation', the save is 201, logged", async () => {
  const a = await app({ SEARCH_INSTALLATION_TERMS_MAX: "2000" });
  await a.project("p22i");
  // Long words so the per-document cap (256 + bytes / 8) is above the word count.
  const text = (prefix, n) => Array.from({ length: n }, (_, k) => `${prefix}synthetic${String(k).padStart(6, "0")}`).join(" ");
  const r1 = await a.req("POST", "/api/projects/p22i/artifacts", { title: "Synthetic", body: text("first", 1000) });
  await a.settle();
  assert.equal(docRow(a, r1.body.artifact_id).truncated_by, "");
  // A second person (local dev login "other"), their own workspace and project.
  const login = await a.fetch("/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: "synthetic-local-pass", user: "other" }) });
  const { csrf } = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const H = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const pr = await a.fetch("/api/projects", { method: "POST", headers: { ...H, "idempotency-key": "key-other-project-1" }, body: JSON.stringify({ title: "Synthetic" }) });
  assert.equal(pr.status, 201);
  const other = (await pr.json()).id;   // a second person: project ids are assigned by the server
  const create = async (n, body) => {
    const res = await a.fetch(`/api/projects/${other}/artifacts`, { method: "POST", headers: { ...H, "idempotency-key": `key-other-create-${n}` }, body: JSON.stringify({ title: "Synthetic", body }) });
    return { status: res.status, body: await res.json() };
  };
  // The second owner's document does not fit: it is clipped by the installation and ends 'installation'.
  const r2 = await create(1, text("second", 1500));
  await a.settle();
  assert.equal(r2.status, 201);
  const row2 = docRow(a, r2.body.artifact_id);
  assert.equal(row2.revision_id, headOf(a, r2.body.artifact_id));
  assert.equal(row2.truncated_by, "installation");
  assert.equal(W.one(a.world, "SELECT terms FROM search_term_counters WHERE scope = 'i'").terms, 2000);
  // With the installation full, the next save is still 201 and search_terms_installation_full is logged (as built in
  // Part 1, when a run plans against a full installation).
  const { result: r3, events } = await captureLogs(async () => { const r = await create(2, "third words"); await a.settle(); return r; });
  assert.equal(r3.status, 201);
  assert.ok(events.some((e) => e.event === "search_terms_installation_full"), JSON.stringify(events.filter((e) => /search/.test(e.event))));
  assert.ok(W.one(a.world, "SELECT terms FROM search_term_counters WHERE scope = 'i'").terms <= 2000);
  assertExact(a);
  idle();
});

// --- 2: static wiring ---------------------------------------------------------------------------------------------------
const src = (f) => readFileSync(join(ROOT, "packages", "core", "src", f), "utf8");
test("2: every revision site except the generation lines reaches deferSearchIndexing or onSearchJob; never awaited", () => {
  const files = ["service.js", "templates/service.js", "backup.js", "uploads.js", "api/publisher.js"];
  const sites = files.flatMap((f) => [...src(f).matchAll(/INSERT INTO revisions/g)].map(() => f));
  // Wired in this commit: service.js (create, publishRevision) and templates/service.js. Backup, upload finish and
  // snapshots are wired by their own commits (Part 2, commits 6 to 8) and listed here so the list stays complete.
  assert.deepEqual([...new Set(sites)].sort(), ["api/publisher.js", "backup.js", "service.js", "templates/service.js"]);
  for (const f of ["service.js", "templates/service.js"]) {
    const s = src(f);
    assert.match(s, /deferSearchIndexing|deferIndexing|onSearchJob/, f);
    assert.doesNotMatch(s, /await\s+(?:[\w.]+\.)?deferSearchIndexing\b/, `${f} awaits deferSearchIndexing`);
    assert.doesNotMatch(s, /=\s*(?:await\s+)?deferSearchIndexing\(/, `${f} uses deferSearchIndexing's result`);
  }
  // No token statement in a publishing batch: the publishing files never name the token tables.
  for (const f of ["service.js", "templates/service.js"]) assert.doesNotMatch(src(f), /search_tokens|search_token_docs|search_term_counters/, f);
});

test("2: createWorker wraps with withDeferredWork, starts after coreWorker.fetch resolves and discards in finally; scheduled creates no jobs", () => {
  const s = src("index.js");
  const cw = s.slice(s.indexOf("function createWorker("), s.indexOf("var coreWorker"));
  assert.match(cw, /withDeferredWork\(/);
  assert.match(cw, /await coreWorker\.fetch\([\s\S]*startDeferredWork\(/);
  assert.match(cw, /finally\s*\{[\s\S]*discardDeferredWork\(/);
  const sched = cw.slice(cw.indexOf("scheduled:"), cw.indexOf("fetch:"));
  assert.doesNotMatch(sched, /withDeferredWork|startDeferredWork/);
  // Only tokens.js (and the lifecycle in project-deletion.js) touch the new tables.
  const users = ["index.js", "service.js", "templates/service.js", "uploads.js", "backup.js", "api/publisher.js", "mcp.js", "oauth/mcp.js", "api/v1.js"]
    .filter((f) => /search_tokens|search_token_docs|search_term_counters|workspace_search_keys/.test(src(f)));
  assert.deepEqual(users, []);
  // No publishing handler returns a streamed body.
  for (const f of ["index.js", "mcp.js", "oauth/mcp.js", "api/v1.js", "api/publisher.js", "api/app-clients.js", "api/credentials.js"])
    assert.doesNotMatch(src(f), /new ReadableStream|new TransformStream|text\/event-stream/, f);
  // No test hook in tokens.js.
  assert.doesNotMatch(src("search/tokens.js"), /AC_TEST_HOOKS/);
});

test("9: when coreWorker.fetch rejects after a job was deferred, discardDeferredWork nulls the holder and releases the reservation", async () => {
  const a = await app();
  await a.project("p9c");
  // The route defers its job, then the request rejects: coreWorker.fetch catches route errors itself, so the rejection
  // is injected after it (Response.headers throws once the publication committed, as a runtime failure would).
  let committed = false;
  a.world.after = async (c) => { if (c.kind === "batch" && c.qs.some((q) => /INSERT INTO revisions/.test(q))) committed = true; };
  const realSet = Headers.prototype.set;
  // Setting the security headers (withSec) fails from the commit on: in the route's try and again in its catch, so
  // coreWorker.fetch rejects.
  Headers.prototype.set = function (...args) { if (committed && args[0] === "x-content-type-options") throw new TypeError("synthetic failure after the commit"); return realSet.apply(this, args); };
  const seen = [];
  let rejected = null;
  try {
    const { events } = await captureLogs(async () => {
      try { await a.fetch("/api/projects/p9c/artifacts", { method: "POST", headers: { cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json", "idempotency-key": "key-reject-0001" }, body: JSON.stringify({ title: "Synthetic", body: "alpha" }) }, { waitUntil: (p) => seen.push(p) }); }
      catch (e) { rejected = e; }
    });
    assert.ok(rejected instanceof TypeError, "the request rejected");
    assert.equal(seen.length, 0, "no run handed to waitUntil");
    assert.ok(events.some((e) => e.event === "search_index_skipped" && e.reasons?.discarded === 1), JSON.stringify(events));
  } finally {
    committed = false;
    Headers.prototype.set = realSet;
    a.world.after = null;
  }
  idle();
});

test("9: deferIndexing never throws: onSearchJob or the deferral throwing logs one search_index_skipped line without content", async () => {
  const secret = "synthetic-secret-words";
  const ctx = { env: {} };
  for (const fail of [() => { throw new Error(secret); }, () => { throw secret; }]) {
    const { result, events } = await captureLogs(() => lib.deferIndexing(ctx, "art_x", "p_x", "rev_x", secret, secret.length, fail));
    assert.equal(result, undefined);
    assert.deepEqual(events, [{ event: "search_index_skipped", skipped: 1, reasons: { error: 1 } }]);
  }
  // An env whose deferral queue is broken (a getter that throws): the same single line, no throw.
  const broken = { get env() { throw new Error(secret); } };
  const { events } = await captureLogs(() => lib.deferIndexing(broken, "art_x", "p_x", "rev_x", secret, secret.length));
  assert.deepEqual(events, [{ event: "search_index_skipped", skipped: 1, reasons: { error: 1 } }]);
  // onSearchJob receives the job (the same text reference, the stored size) and nothing is deferred.
  const got = [];
  lib.deferIndexing(ctx, "art_y", "p_y", "rev_y", secret, 22, (j) => got.push(j));
  assert.deepEqual(got, [{ artifactId: "art_y", projectId: "p_y", revisionId: "rev_y", text: secret, textBytes: 22 }]);
  idle();
});

test("R7-1: coreWorker.fetch rejecting while discardDeferredWork itself throws: the handler's own error surfaces; nothing left registered", async () => {
  const a = await app();
  await a.project("p9d");
  let committed = false;
  a.world.after = async (c) => { if (c.kind === "batch" && c.qs.some((q) => /INSERT INTO revisions/.test(q))) committed = true; };
  const realSet = Headers.prototype.set, realLog = console.log, realError = console.error;
  const handlerError = new TypeError("synthetic failure after the commit");
  Headers.prototype.set = function (...args) { if (committed && args[0] === "x-content-type-options") throw handlerError; return realSet.apply(this, args); };
  // Every search log line throws from the commit on: the discard's skip line fails inside the wrapper's finally.
  const failSearch = (real) => (...x) => { if (committed && /"event":"search_/.test(String(x[0]))) throw new Error("synthetic log failure"); return real(...x); };
  console.log = failSearch(realLog);
  console.error = failSearch(realError);
  let rejected = null;
  try {
    await a.fetch("/api/projects/p9d/artifacts", { method: "POST", headers: { cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json", "idempotency-key": "key-reject-0002" }, body: JSON.stringify({ title: "Synthetic", body: "alpha" }) }, { waitUntil() {} });
  } catch (e) { rejected = e; }
  finally {
    committed = false;
    Headers.prototype.set = realSet; console.log = realLog; console.error = realError;
    a.world.after = null;
  }
  assert.equal(rejected, handlerError, "the handler's own error");
  idle();
});

// --- 13k, 13l, 13q, 13r, 22: backup restore and import defer search indexing ----------------------------------------
/** A synthetic backup: one text revision per document (heads in order), optional trashed head and binary document. */
function synthBackup({ pid = "pbk_src", docs, binary = false } = {}) {
  const artifacts = [], revisions = [], blobs = {};
  const at = "2026-01-01T00:00:00.000Z";
  docs.forEach((body, i) => {
    const id = `art_src_${String(i).padStart(4, "0")}`, rid = `rev_src_${String(i).padStart(4, "0")}`;
    const trashed = typeof body === "object" ? body.trashed : false, text = typeof body === "object" ? body.text : body;
    artifacts.push({ id, kind: "markdown", title: `Synthetic ${i}`, folder: "", tags: "[]", head_rev: 1, head_revision_id: rid, meta_version: 1, trashed_at: trashed ? at : null, created_at: at, updated_at: at });
    revisions.push({ id: rid, artifact_id: id, rev_no: 1, author_id: "hum_src", body: text, blob_key: null, size: Buffer.byteLength(text), sha256: sha(text), mime: "text/markdown", restored_from: null, created_at: at });
  });
  if (binary) {
    const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
    const key = `blobs/${pid}/art_src_bin/png1`;
    artifacts.push({ id: "art_src_bin", kind: "binary", title: "Synthetic image", folder: "", tags: "[]", head_rev: 1, head_revision_id: "rev_src_bin", meta_version: 1, trashed_at: null, created_at: at, updated_at: at });
    revisions.push({ id: "rev_src_bin", artifact_id: "art_src_bin", rev_no: 1, author_id: "hum_src", body: null, blob_key: key, size: PNG.length, sha256: sha(PNG), mime: "image/png", restored_from: null, created_at: at });
    blobs[key] = { sha256: sha(PNG), data: PNG.toString("base64") };
  }
  return { schema: "agent-library-backup/1", exported_at: at, project: { id: pid, title: "Synthetic source", created_at: at }, artifacts, revisions, comments: [], meta_versions: [], blobs };
}
const wsOfPrincipal = (a) => W.one(a.world, "SELECT id FROM workspaces ORDER BY created_at LIMIT 1").id;
const projectDocs = (a, pid) => W.all(a.world, "SELECT id, title, kind FROM artifacts WHERE project_id = ? ORDER BY title", pid);

test("13k backup restore (a trashed head too; a binary head gets no job): every text head is indexed", async () => {
  const a = await app();
  const b0 = baseline();
  const docs = ["restore alpha", { text: "trashed head words", trashed: true }, "restore gamma"];
  const { result: r, events } = await captureLogs(async () => { const x = await a.req("POST", "/api/restore", synthBackup({ docs, binary: true })); await a.settle(); return x; });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pid = r.body.restored_project;
  const rows = projectDocs(a, pid);
  docs.forEach((d, i) => assertIndexed(a, pid, `art_src_${String(i).padStart(4, "0")}`, typeof d === "object" ? d.text : d, `13k ${i}`));
  assert.equal(docRow(a, "art_src_bin"), undefined, "binary head: no row");
  assert.ok(!missing(a).includes("art_src_bin"));
  assert.ok(!events.some((e) => e.event === "search_index_skipped"));
  assert.equal(rows.length, 4);
  assertBaseline(b0, "13k");
});

test("13l backup import: every imported text head is indexed under its new ids; a refused import defers nothing", async () => {
  const a = await app();
  await a.project("pkeep");
  const ws = wsOfPrincipal(a);
  const b0 = baseline();
  const docs = ["import alpha words", "import beta words", { text: "import trashed", trashed: true }];
  const r = await a.req("POST", `/api/workspaces/${ws}/import`, synthBackup({ docs, binary: true }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(a.waits.length, 1, "one run");
  await a.settle();
  const rows = projectDocs(a, r.body.project_id);
  for (const [i, d] of docs.entries()) {
    const art = rows.find((x) => x.title === `Synthetic ${i}`);
    assertIndexed(a, r.body.project_id, art.id, typeof d === "object" ? d.text : d, `13l ${i}`);
  }
  assert.equal(docRow(a, rows.find((x) => x.kind === "binary").id), undefined);
  // Refused import (a bad hash): no job, no run.
  const bad = synthBackup({ docs: ["refused import"] });
  bad.revisions[0].sha256 = "0".repeat(64);
  const w0 = a.waits.length;
  const { result: rf, events } = await captureLogs(() => a.req("POST", `/api/workspaces/${ws}/import`, bad));
  assert.equal(rf.status, 400);
  assert.equal(a.waits.length, w0);
  assert.ok(!events.some((e) => /^search_/.test(e.event)));
  // A failed publication (the text-write fence refuses inside the batch): no job, no run.
  a.world.before = async (c) => { if (c.kind === "batch" && c.qs.some((q) => /INSERT INTO revisions/.test(q))) W.run(a.world, "UPDATE content_writes SET created_at = 0"); };
  const { result: rf2, events: e2 } = await captureLogs(() => a.req("POST", `/api/workspaces/${ws}/import`, synthBackup({ docs: ["fenced import"] })));
  a.world.before = null;
  assert.ok(rf2.status >= 400, JSON.stringify(rf2.body));
  assert.equal(a.waits.length, w0);
  assert.ok(!e2.some((e) => /^search_/.test(e.event)));
  assertExact(a);
  assertBaseline(b0, "13l");
});

test("13q an import beyond the run's document budget leaves exactly the remaining documents missing; a later save completes one", async () => {
  const a = await app();
  await a.project("pkeep2");
  const ws = wsOfPrincipal(a);
  const docs = Array.from({ length: 103 }, (_, i) => `doc${i} shared words`);
  const { result: r, events } = await captureLogs(async () => { const x = await a.req("POST", `/api/workspaces/${ws}/import`, synthBackup({ docs })); await a.settle(); return x; });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = projectDocs(a, r.body.project_id);
  const byOrder = docs.map((_, i) => rows.find((x) => x.title === `Synthetic ${i}`).id);
  const indexed = byOrder.filter((id) => docRow(a, id)?.revision_id === headOf(a, id));
  assert.deepEqual(indexed, byOrder.slice(0, 100), "the first 100 in backup order");
  assert.deepEqual(missing(a).filter((id) => byOrder.includes(id)).sort(), byOrder.slice(100).sort(), "exactly the rest missing");
  assert.deepEqual(events.filter((e) => e.event === "search_index_skipped").map((e) => e.reasons), [{ admission: 3 }]);
  const late = byOrder[101];
  assert.equal((await a.req("PUT", `/api/projects/${r.body.project_id}/artifacts/${late}`, { expected_revision: 1, body: "completed later" })).status, 200);
  await a.settle();
  assertIndexed(a, r.body.project_id, late, "completed later");
  idle();
});

test("13r an import of 300 empty documents responds normally: at most 100 complete rows, the rest missing; the run's calls counted", async () => {
  const a = await app();
  await a.project("pkeep3");
  const ws = wsOfPrincipal(a);
  const docs = Array.from({ length: 300 }, () => "");
  const runCalls = [];
  a.world.before = async (c) => { if ((c.qs ?? [c.q]).some((q) => /search_token|workspace_search_keys|\) AS cw,/.test(q))) runCalls.push(c.kind); };
  const t0 = Date.now();
  const r = await a.req("POST", `/api/workspaces/${ws}/import`, synthBackup({ docs }));
  const ms = Date.now() - t0;
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(runCalls, [], "no run call before the response");
  await captureLogs(() => a.settle());
  a.world.before = null;
  const ids = projectDocs(a, r.body.project_id).map((x) => x.id);
  const complete = ids.filter((id) => docRow(a, id)?.revision_id === headOf(a, id));
  assert.equal(complete.length, 100);
  for (const id of complete) assert.equal(tokensOf(a, id).length, 0);
  assert.equal(missing(a).filter((id) => ids.includes(id)).length, 200);
  assert.ok(runCalls.length <= 9, `the run's D1 calls: ${runCalls.length}`);
  assertExact(a);
  idle();
  console.log(JSON.stringify({ event: "test_measure", test: "13r", responseMs: ms, runCalls: runCalls.length }));
});

test("22: a 300-empty-document import into a nearly full workspace writes only the rows that fit (5 units each); the rest stay missing", async () => {
  const a = await app({ SEARCH_WORKSPACE_TERMS_MAX: "25" });
  await a.project("pkeep4");
  const ws = wsOfPrincipal(a);
  const r = await a.req("POST", `/api/workspaces/${ws}/import`, synthBackup({ docs: Array.from({ length: 300 }, () => "") }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await captureLogs(() => a.settle());
  const ids = projectDocs(a, r.body.project_id).map((x) => x.id);
  const rows = ids.filter((id) => docRow(a, id));
  const counter = W.one(a.world, "SELECT terms FROM search_term_counters WHERE scope = ?", "w:" + ws);
  assert.ok(counter.terms <= 25, JSON.stringify(counter));
  assert.equal(rows.length, Math.floor(25 / 5), "five rows of 5 units fit");
  assert.equal(missing(a).filter((id) => ids.includes(id)).length, 300 - rows.length);
  assertExact(a);
  idle();
});

test("13l calls: a 100 × 10 KB import adds no D1 call before its response; the deferred run's calls are counted", async () => {
  const a = await app();
  await a.project("pcalls");
  const ws = wsOfPrincipal(a);
  const tenK = (seed) => { const w = []; let x = seed; while (w.join(" ").length < 10240) { x = (x * 1103515245 + 12345) & 0x7fffffff; w.push("w" + ((x >>> 8) % 1500).toString(36)); } return w.join(" ").slice(0, 10240); };
  const docs = Array.from({ length: 100 }, (_, i) => tenK(100 + i));
  const isRun = (c) => (c.qs ?? [c.q]).some((q) => /search_token|search_term_counters|workspace_search_keys|\) AS cw,/.test(q));
  const calls = { before: 0, run: 0, all: 0 };
  let responded = false;
  a.world.before = async (c) => { calls.all++; if (isRun(c)) { if (responded) calls.run++; else calls.before++; } };
  const t0 = Date.now();
  const r = await a.req("POST", `/api/workspaces/${ws}/import`, synthBackup({ docs }));
  const responseMs = Date.now() - t0;
  responded = true;
  const atResponse = calls.all;
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { events } = await captureLogs(() => a.settle());
  a.world.before = null;
  assert.equal(calls.before, 0, "no token call before the response");
  // About 1,000 distinct terms each: the run's 50,000 token operations stop it part-way (decision 4: the run's limits
  // stop the rest). The indexed documents are a prefix in backup order; exactly the rest are missing.
  const byOrder = docs.map((_, i) => projectDocs(a, r.body.project_id).find((x) => x.title === `Synthetic ${i}`).id);
  const indexed = byOrder.filter((id) => docRow(a, id)?.revision_id === headOf(a, id));
  assert.ok(indexed.length > 0);
  assert.deepEqual(indexed, byOrder.slice(0, indexed.length), "a prefix in backup order");
  assert.deepEqual(missing(a).filter((id) => byOrder.includes(id)).sort(), byOrder.slice(indexed.length).sort());
  for (const id of indexed) assert.deepEqual(tokensOf(a, id), expectedFor(a.world, ws, words(docs[byOrder.indexOf(id)])));
  assert.ok(calls.run <= 18, `run calls ${calls.run}`);
  assertExact(a);
  idle();
  const skipped = events.filter((e) => e.event === "search_index_skipped").map((e) => e.reasons);
  console.log(JSON.stringify({ event: "test_measure", test: "13l calls", requestCalls: atResponse, runCalls: calls.run, responseMs, indexed: indexed.length, skipped }));
});

test("4a8-1: an upload finish whose publication is paused past the horizon while another request detaches its run answers 200; the document is missing, nothing held", async () => {
  const a = await app();
  await a.project("phz");
  const b0 = baseline();
  const realNow = Date.now;
  let release, held = false;
  const paused = new Promise((r) => { release = r; });
  const text = Array.from({ length: 20000 }, (_, i) => "horizonword" + i.toString(36)).join(" ");
  const f = await textUpload(a, "phz", text, { finish: false });
  a.world.before = async (c) => { if (!held && c.kind === "batch" && c.qs.some((q) => /INSERT INTO revisions/.test(q))) { held = true; await paused; } };
  let fin, events;
  try {
    ({ result: fin, events } = await captureLogs(async () => {
      const p = a.req("POST", `/api/projects/phz/uploads/${f.begin.upload_id}/finish`, {});
      await until(() => held, { what: "the publish batch" });
      assert.equal(lib.searchFlatHeld(), b0.flat + 1, "the ticket's terms are held during publication");
      // Past the 120 s horizon, another request's admission detaches the (unstarted) upload run.
      Date.now = () => realNow() + 121000;
      a.world.before = null;
      const other = await a.req("POST", "/api/projects/phz/artifacts", { title: "Synthetic", body: "other request" });
      assert.equal(other.status, 201);
      assert.equal(lib.searchAdmissionState().detached, 1, "the upload run was detached");
      assert.equal(lib.searchFlatHeld(), b0.flat, "its packed terms dropped at detach");
      release();
      const x = await p;
      await a.settle();
      return x;
    }));
  } finally { Date.now = realNow; a.world.before = null; }
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.ok(events.some((e) => e.event === "search_run_detached"));
  assert.equal(docRow(a, fin.body.artifact_id), undefined, "the upload's document has no row");
  assert.ok(missing(a).includes(fin.body.artifact_id), "it is missing");
  assertBaseline(b0, "after horizon");
  assertExact(a);
});

// --- Review 4a8-2/3: backup jobs are prepared before the commit; restore ids in stored form --------------------------
test("4a8-2: backup.js does no text work after the commit: no utf8Length import, and no TextEncoder call between the batch and the response", async () => {
  const src = readFileSync(join(ROOT, "packages/core/src/backup.js"), "utf8");
  assert.ok(!/\butf8Length\b/.test(src), "utf8Length is not used by backup.js");
  const a = await app();
  await a.project("pk2");
  const ws = wsOfPrincipal(a);
  const docs = Array.from({ length: 20 }, (_, i) => `scan check ${i} ` + "z".repeat(2000));
  let armed = false, encodes = 0;
  const Real = TextEncoder.prototype.encode, RealInto = TextEncoder.prototype.encodeInto;
  // Each document text is over 2,000 units; the response's own small JSON body (encoded by Response) is not text work.
  const isText = (v) => typeof v === "string" && v.length >= 2000;
  TextEncoder.prototype.encode = function (...x) { if (armed && isText(x[0])) encodes++; return Real.apply(this, x); };
  TextEncoder.prototype.encodeInto = function (...x) { if (armed && isText(x[0])) encodes++; return RealInto.apply(this, x); };
  // Armed from the publishing batch's return until the response resolves.
  a.world.after = async (c) => { if (c.kind === "batch" && c.qs.some((q) => /INSERT INTO revisions/.test(q))) armed = true; };
  let r;
  try { r = await a.req("POST", `/api/workspaces/${ws}/import`, synthBackup({ docs })); }
  finally { armed = false; TextEncoder.prototype.encode = Real; TextEncoder.prototype.encodeInto = RealInto; a.world.after = null; }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(encodes, 0, "no text encoded after the commit");
  await captureLogs(() => a.settle());
  idle();
});

/** A restore backup whose documents carry odd ids (numbers, byte lists) beside ordinary ones. */
function oddIdBackup(entries) {
  const at = "2026-01-01T00:00:00.000Z";
  const artifacts = [], revisions = [];
  for (const { id, rev, text } of entries) {
    artifacts.push({ id, kind: "markdown", title: "Synthetic", folder: "", tags: "[]", head_rev: 1, head_revision_id: rev, meta_version: 1, trashed_at: null, created_at: at, updated_at: at });
    revisions.push({ id: rev, artifact_id: id, rev_no: 1, author_id: "hum_src", body: text, blob_key: null, size: Buffer.byteLength(text), sha256: sha(text), mime: "text/markdown", restored_from: null, created_at: at });
  }
  return { schema: "agent-library-backup/1", exported_at: at, project: { id: "podd_src", title: "Synthetic", created_at: at }, artifacts, revisions, comments: [], meta_versions: [], blobs: {} };
}

test("4a8-3: one numeric-id document in a restore no longer costs the others their jobs; it is indexed under its stored form \"7.0\"", async () => {
  const a = await app();
  const entries = [{ id: 7, rev: 8, text: "numeric document words" }, { id: "doc_a", rev: "rev_a", text: "ordinary alpha" }, { id: "doc_b", rev: "rev_b", text: "ordinary beta" }];
  const { result: r, events } = await captureLogs(async () => { const x = await a.req("POST", "/api/restore", oddIdBackup(entries)); await a.settle(); return x; });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { restored_project: "podd_src", artifacts: 3, revisions: 3, blobs: 0, grants: 0 }, "response unchanged");
  assert.equal(headOf(a, "7.0"), "8.0", "D1 stores the numbers as text");
  assertIndexed(a, "podd_src", "7.0", "numeric document words", "numeric");
  assertIndexed(a, "podd_src", "doc_a", "ordinary alpha", "a");
  assertIndexed(a, "podd_src", "doc_b", "ordinary beta", "b");
  assert.ok(!events.some((e) => e.event === "search_index_failed"));
  idle();
});

test("4a8-3: a byte-list document id is skipped alone ({refused: 1}); numeric and ordinary documents of the same restore are indexed", async () => {
  const a = await app();
  const entries = [{ id: 7, rev: 8, text: "numeric words" }, { id: [100, 111, 99], rev: "rev_bytes", text: "byte list words" },
    { id: "doc_a", rev: "rev_a", text: "ordinary alpha" }, { id: "doc_b", rev: "rev_b", text: "ordinary beta" }];
  const { result: r, events } = await captureLogs(async () => { const x = await a.req("POST", "/api/restore", oddIdBackup(entries)); await a.settle(); return x; });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { restored_project: "podd_src", artifacts: 4, revisions: 4, blobs: 0, grants: 0 });
  assertIndexed(a, "podd_src", "7.0", "numeric words", "numeric");
  assertIndexed(a, "podd_src", "doc_a", "ordinary alpha", "a");
  assertIndexed(a, "podd_src", "doc_b", "ordinary beta", "b");
  assert.equal(W.one(a.world, "SELECT COUNT(*) AS n FROM search_token_docs WHERE typeof(artifact_id) <> 'text' OR artifact_id NOT IN ('7.0','doc_a','doc_b')").n, 0, "no row for the byte-list document");
  assert.deepEqual(events.filter((e) => e.event === "search_index_skipped").map((e) => e.reasons), [{ refused: 1 }]);
  idle();
});

test("4a8-3: prepareBackupJobs maps ids through the stored forms, counts non-text ids as refused, and never uses String(id)", async () => {
  const backup = oddIdBackup([{ id: 7, rev: 8, text: "a" }, { id: [1, 2], rev: "r2", text: "b" }, { id: "lone\ud800", rev: "r3", text: "c" }]);
  const tb = new Map(backup.revisions.map((r) => [r, Buffer.byteLength(r.body)]));
  const stored = new Map([[7, "7.0"], [8, "8.0"], ["lone\ud800", "lone\ufffd"], ["r2", "r2"], ["r3", "r3"]]);
  stored.set(backup.artifacts[1].id, "\u0000blob:1,2");
  const { jobs, refused } = lib.prepareBackupJobs(backup, tb, { project: "p", artifact: (id) => stored.get(id) ?? null, revision: (id) => stored.get(id) ?? null });
  assert.deepEqual(jobs.map((j) => [j.artifactId, j.revisionId, j.textBytes]), [["7.0", "8.0", 1], ["lone\ufffd", "r3", 1]]);
  assert.equal(refused, 1);
  // A missing stored form (null) is refused too, never String(id).
  const none = lib.prepareBackupJobs(backup, tb, { project: "p", artifact: () => null, revision: () => null });
  assert.deepEqual([none.jobs.length, none.refused], [0, 3]);
  // The refused count reaches the request's skip line once.
  const env = lib.withDeferredWork({});
  const { events } = await captureLogs(() => { lib.skipSearchJobs(env, "refused", refused); lib.discardDeferredWork(env); });
  assert.deepEqual(events.filter((e) => e.event === "search_index_skipped").map((e) => e.reasons), [{ refused: 1 }]);
});

test("4a8-3: a lone-surrogate text document id does not restore (existing behaviour, not pinned); nothing is deferred", async () => {
  const a = await app();
  const { result: r, events } = await captureLogs(async () => {
    const x = await a.req("POST", "/api/restore", oddIdBackup([{ id: "lone\ud800x", rev: "rev_l", text: "lone words" }, { id: "doc_a", rev: "rev_a", text: "ordinary" }]));
    await a.settle();
    return x;
  });
  assert.ok(r.status < 200 || r.status >= 300, `not a success: ${r.status}`);
  assert.equal(W.one(a.world, "SELECT COUNT(*) AS n FROM revisions").n, 0, "nothing published");
  assert.equal(a.waits.length, 0, "no run");
  assert.ok(!events.some((e) => /^search_/.test(e.event)), "no search line");
  idle();
});
