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

test("interim (until the upload-finish commit): a TEXT upload finish publishes and defers no search job", async () => {
  // The upload-finish commit (Part 2, commit 6) supplies the flat handle itself; this test is the one it inverts.
  const a = await app();
  await a.project("p13g");
  const text = "interim upload words";
  const { createHash } = await import("node:crypto");
  const b = await a.req("POST", "/api/projects/p13g/uploads", { title: "Synthetic text", mime: "text/markdown", size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const put = await a.fetch(b.body.put_url, { method: "PUT", body: text, headers: { "content-length": String(Buffer.byteLength(text)), cookie: a.cookie, "x-csrf-token": a.csrf } });
  assert.ok(put.status < 300, String(put.status));
  const { result: f, events } = await captureLogs(() => a.req("POST", `/api/projects/p13g/uploads/${b.body.upload_id}/finish`, {}));
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(a.waits.length, 0, "no run handed to waitUntil");
  assert.ok(!events.some((e) => e.event === "search_phase"), "no run admitted");
  await a.settle();
  assert.equal(docRow(a, f.body.artifact_id), undefined, "no search document row");
  assert.equal(W.one(a.world, "SELECT COUNT(*) AS n FROM search_tokens").n, 0, "no token");
  idle();
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
    const r = await a.fetch(`/api/projects/p12big/artifacts/${md.body.artifact_id}`, { method: "PUT",
      headers: { cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json", "idempotency-key": "key-big-save-0001" },
      body: JSON.stringify({ expected_revision: 1, body: big }) });
    // The moment the fetch promise resolved: record what the run had done by then, in the same observation.
    seen.push(`response:${r.status}`);
    seen.push(`phases:${(globalThis.__phaseLog ?? []).length}`);
    await r.text();
    await a.settle();
  });
  a.world.before = null;
  const at = seen.findIndex((x) => x.startsWith("response:"));
  assert.equal(seen[at], "response:200");
  assert.deepEqual(seen.slice(0, at), [], "no run D1 call before the response resolved");
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
