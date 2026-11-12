// Blind-index search tokens (slice 4a), unit tests on the real packages/core/src/search/tokens.js (test/load-worker.mjs)
// over node:sqlite with every migration applied (test/blind-tokens-world.mjs). No listeners. Synthetic text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, hkdfSync, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";
import * as W from "./blind-tokens-world.mjs";

const lib = await loadWorker({
  "search/tokens.js": ["extractSearchTerms", "extractSearchTermsFlat", "u61FoldTokenBounded", "searchDocCap", "searchTermsMax", "searchScopeBounds",
    "searchSweepWritesMax", "utf8Length", "searchTokensFor", "searchTokenDigest", "deriveSearchKey", "searchKeyInfo", "decodeSearchSecret", "searchTokenKey",
    "indexSearchJobs", "SEARCH_BATCH_TOKENS_MAX", "SEARCH_BATCH_STATEMENTS_MAX", "SEARCH_RUN_LIMITS",
    "openSearchRun", "admitSearchJobs", "runSearchIndexing", "searchAdmissionState", "withDeferredWork", "deferSearchIndexing", "startDeferredWork",
    "discardDeferredWork", "drainSearchIndexing", "SEARCH_CALL_ENVELOPE_BYTES", "SEARCH_RUN_BASE_BYTES", "SEARCH_ACTIVE_MAX_BYTES", "SEARCH_RUN_MAX_BYTES",
    "SEARCH_DETACHED_MAX", "SEARCH_DETACH_AFTER_MS"],
  "search/unicode61.js": ["u61FoldToken"],
  "limits.js": ["LIMIT_KEYS", "workspaceLimits"],
  "adapters.js": ["withAdapters", "resolveAdapters"],
});
const MiB = 1048576;
const envOf = (world, vars = {}, adapters = {}) => lib.withAdapters({ DB: world.DB, ...vars }, lib.resolveAdapters(adapters));
/** Distinct synthetic words: w0, w1, … in base 36 with a prefix. */
const words = (n, prefix = "w", from = 0) => Array.from({ length: n }, (_, i) => prefix + (from + i).toString(36).padStart(7, "0"));
const secretOf = (world, ws) => Buffer.from(W.one(world, "SELECT secret FROM workspace_search_keys WHERE workspace_id = ?", ws).secret, "base64url");
const expectedTokens = (secret, terms) => [...new Set(terms)].map((t) => createHmac("sha256", secret).update(t).digest().subarray(0, 16).toString("hex")).sort();
/** Capture JSON log lines while fn runs. */
async function logs(fn) {
  const out = [], { log, error } = console;
  const grab = (...a) => { try { out.push(JSON.parse(a[0])); } catch { /* not ours */ } };
  console.log = grab; console.error = grab;
  try { return { result: await fn(), events: out }; } finally { console.log = log; console.error = error; }
}
const batches = (world) => world.log.filter((c) => c.kind === "batch");
function assertBatchBounds(world) {
  for (const b of batches(world)) {
    assert.ok(b.n <= lib.SEARCH_BATCH_STATEMENTS_MAX, `batch of ${b.n} statements`);
    assert.ok(b.tokenValues <= lib.SEARCH_BATCH_TOKENS_MAX, `batch of ${b.tokenValues} token values`);
  }
}
const assertExact = (world) => assert.deepEqual(W.counters(world), W.expectedCounters(world));

// --- Test 5: tokenizer and bounded folding ----------------------------------------------------------------------
function ftsTerms(text) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE v USING fts5vocab(f, 'row');");
  db.prepare("INSERT INTO f (body) VALUES (?)").run(text);
  return db.prepare("SELECT term FROM v").all().map((r) => r.term).sort();
}
const ours = (text) => lib.extractSearchTerms(text, 1e9).terms.slice().sort();

test("test 5: terms match FTS5 unicode61 remove_diacritics 2 (fts5vocab) on hard cases and 1 MiB of prose", () => {
  const cases = ["é e É café CAFÉ", "Straße STRASSE ß", "İstanbul ıi I", "日本語の文章です 東京", "שָׁלוֹם שלום סֵפֶר", "1 22 4096 2026x x2026",
    "emoji 😀 ok 👍🏽 done", "\u0301leading mark word", "a\u0301b\u0302c ümlaut", "mixed-UP_case.words, and; more"];
  for (const c of cases) assert.deepEqual(ours(c), ftsTerms(c), JSON.stringify(c));
  const vocab = ["alpha", "Beta", "café", "naïve", "Zürich", "straße", "ÉCOLE", "łódź", "日本", "テスト", "мой", "ёлка", "λόγος", "كِتَاب", "x1", "2026"];
  let prose = "", seed = 7;
  while (prose.length < MiB) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; prose += vocab[(seed >>> 8) % vocab.length] + ((seed >>> 4) % 7 ? " " : ". ") + ((seed >>> 3) % 97).toString(36) + " "; }
  assert.deepEqual(ours(prose), ftsTerms(prose));
});

test("test 5: u61FoldTokenBounded equals u61FoldToken for every code point and for results of at most 200 units", () => {
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (lib.u61FoldTokenBounded(ch) !== lib.u61FoldToken(ch)) assert.fail(`U+${cp.toString(16)}`);
  }
  for (const w of ["a".repeat(200), "É".repeat(200), "Straße".repeat(33), "日".repeat(200)]) assert.equal(lib.u61FoldTokenBounded(w), lib.u61FoldToken(w));
  assert.equal(lib.u61FoldTokenBounded("a".repeat(201)), null);
  assert.equal(lib.u61FoldTokenBounded("É".repeat(201)), null);
  // A raw 300-unit word with 150 dropped marks folds to 150 units: kept.
  const marked = "a\u0301".repeat(150);
  assert.equal(marked.length, 300);
  assert.deepEqual(lib.extractSearchTerms(marked + " b", 10).terms, ["a".repeat(150), "b"]);
});

// --- Test 6: caps and extraction -----------------------------------------------------------------------------------
test("test 6: docCap, the five vars, and texts that scan everything", () => {
  assert.equal(lib.searchDocCap({}, 1024), 384);
  assert.equal(lib.searchDocCap({}, 10240), 1536);
  assert.equal(lib.searchDocCap({}, 157952), 20000);
  assert.equal(lib.searchDocCap({}, 10 * MiB), 20000);
  assert.equal(lib.searchDocCap({ SEARCH_TERMS_MAX: "2000" }, 157952), 2000);
  assert.equal(lib.searchTermsMax({ SEARCH_TERMS_MAX: "30000" }), 20000, "lower only");
  assert.equal(lib.searchTermsMax({ SEARCH_TERMS_MAX: "0" }), 0);
  assert.equal(lib.searchTermsMax({ SEARCH_TERMS_MAX: "x" }), 20000);
  assert.equal(lib.searchTermsMax({ SEARCH_TERMS_MAX: "-1" }), 20000);
  assert.deepEqual(lib.searchScopeBounds({}), { workspace: 1000000, owner: 3000000, installation: 50000000 });
  assert.deepEqual(lib.searchScopeBounds({ SEARCH_WORKSPACE_TERMS_MAX: "3000", SEARCH_OWNER_TERMS_MAX: "9000", SEARCH_INSTALLATION_TERMS_MAX: "90000000" }),
    { workspace: 3000, owner: 9000, installation: 50000000 }, "installation lower only");
  assert.equal(lib.searchScopeBounds({ SEARCH_INSTALLATION_TERMS_MAX: "2000" }).installation, 2000);
  assert.equal(lib.searchScopeBounds({ SEARCH_WORKSPACE_TERMS_MAX: "3000" }, { search_terms: 500 }).workspace, 500, "entitlements first");
  assert.ok(lib.LIMIT_KEYS.includes("search_terms"));
  for (const [v, n] of [[undefined, 10000], ["0", 0], ["1", 50], ["20", 50], ["49", 50], ["50", 50], ["250", 250], ["10000", 10000], ["20000", 10000], ["bad", 10000]])
    assert.equal(lib.searchSweepWritesMax({ SEARCH_SWEEP_WRITES_MAX: v }), n, String(v));
  assert.deepEqual(lib.extractSearchTerms("again ".repeat(200000), 20000).terms, ["again"]);
  assert.deepEqual(lib.extractSearchTerms(" .,;!?-\n".repeat(100000), 20000).terms, []);
  assert.deepEqual(lib.extractSearchTerms("x".repeat(10 * MiB), 20000).terms, []);
  const capped = lib.extractSearchTerms(words(30).join(" "), 10);
  assert.equal(capped.terms.length, 10); assert.equal(capped.truncated, true);
  assert.equal(lib.utf8Length("aé日😀"), 1 + 2 + 3 + 4);
});

test("test 6: the run's scanned-units budget (10 Mi code units) refuses the job that would pass it", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  const big = "x ".repeat(3 * MiB);
  for (const a of ["d1", "d2"]) W.seedDoc(world, { artifact: a });
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), [
    { artifactId: "d1", projectId: "proj_a", revisionId: "rev_d1", text: big },
    { artifactId: "d2", projectId: "proj_a", revisionId: "rev_d2", text: big }]));
  assert.equal(result.skipped.admission, 1);
  assert.equal(result.completed, 1);
});

// --- Test 7: flat extraction and heap --------------------------------------------------------------------------------
test("test 7: extractSearchTermsFlat decodes to the same terms as extractSearchTerms", () => {
  const text = "Zürich straße 日本語 alpha beta alpha 😀 " + words(500).join(" ");
  const flat = lib.extractSearchTermsFlat(text, 300), plain = lib.extractSearchTerms(text, 300);
  const dec = new TextDecoder(), got = [];
  for (let i = 0; i < flat.count; i++) got.push(dec.decode(flat.bytes.subarray(flat.offsets[i], flat.offsets[i + 1])));
  assert.deepEqual(got, plain.terms);
  assert.equal(flat.truncated, plain.truncated);
});

test("test 7: heap: a 10 MiB text extracted flat and dropped is released (child process, --expose-gc)", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { loadWorker } from "./test/load-worker.mjs";
    const lib = await loadWorker({ "search/tokens.js": ["extractSearchTermsFlat"] });
    let text = "";
    { const parts = []; for (let i = 0; parts.length * 8 < 10 * 1048576; i++) parts.push("t" + (i % 50000).toString(36).padStart(6, "0") + " "); text = parts.join(""); }
    if (text.length !== 10 * 1048576) throw new Error("fixture is not 10 MiB");
    global.gc(); const withText = process.memoryUsage().heapUsed;
    const flat = lib.extractSearchTermsFlat(text, 20000);
    text = null;
    global.gc(); global.gc(); const after = process.memoryUsage().heapUsed;
    console.log("FLAT " + JSON.stringify({ fell: withText - after, bytes: flat.bytes.byteLength, count: flat.count }));
  `], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  const r = JSON.parse(child.stdout.split("FLAT ")[1]);
  assert.ok(r.fell >= 9 * MiB, `heap fell by ${r.fell}`);
  assert.ok(r.bytes <= 12000000);
  assert.equal(r.count, 20000);
});

// --- Test 8: tokens and keys ---------------------------------------------------------------------------------------
test("test 8: tokens are sorted lower-case hex HMACs (createHmac), the digest and the plaintext key", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  const env = envOf(world);
  const k = await lib.searchTokenKey(env, "wsp_a");
  assert.equal(k.encrypted, false);
  assert.match(k.keyId, /^sk_/);
  const again = await lib.searchTokenKey(env, "wsp_a");
  assert.equal(again.keyId, k.keyId, "one key row per workspace");
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM workspace_search_keys").n, 1);
  const terms = ["beta", "alpha", "日本", "alpha"];
  const toks = await lib.searchTokensFor(k.key, terms);
  assert.deepEqual(toks, expectedTokens(secretOf(world, "wsp_a"), terms));
  for (const t of toks) assert.match(t, /^[0-9a-f]{32}$/);
  assert.deepEqual(toks, toks.slice().sort());
  assert.equal(await lib.searchTokenDigest(toks, "cap"), createHash("sha256").update("cap:" + toks.join(",")).digest("hex"));
  // A plaintext secret of the wrong length is refused.
  assert.throws(() => lib.decodeSearchSecret(Buffer.alloc(31).toString("base64url")), (e) => e.code === "search_key_invalid");
  assert.throws(() => lib.decodeSearchSecret("not base64!"), (e) => e.code === "search_key_invalid");
  W.run(world, "UPDATE workspace_search_keys SET secret = ? WHERE workspace_id = 'wsp_a'", Buffer.alloc(33).toString("base64url"));
  await assert.rejects(lib.searchTokenKey(env, "wsp_a"), (e) => e.code === "search_key_invalid");
});

test("test 8: derivation: HKDF-SHA-256 of the data key with info al-search/1 ‖ 0x00 ‖ workspaceId", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const dataKey = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const key = await lib.deriveSearchKey(dataKey, "wsp_derive");
  assert.equal(key.extractable, false); assert.deepEqual(key.usages, ["sign"]);
  const info = Buffer.concat([Buffer.from("al-search/1"), Buffer.from([0]), Buffer.from("wsp_derive")]);
  assert.deepEqual(Buffer.from(lib.searchKeyInfo("wsp_derive")), info);
  const expected = Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), info, 32));
  assert.deepEqual(await lib.searchTokensFor(key, ["word"]), expectedTokens(expected, ["word"]));
  // Another workspace derives an unrelated key from the same data key.
  assert.notDeepEqual(await lib.searchTokensFor(await lib.deriveSearchKey(dataKey, "wsp_other"), ["word"]), expectedTokens(expected, ["word"]));
});

test("test 8: encryption on: the run derives from the workspace data key and fences on it", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  W.seedDoc(world, { artifact: "enc_1" });
  const env = envOf(world, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  const { result } = await logs(() => lib.indexSearchJobs(env, [{ artifactId: "enc_1", projectId: "proj_a", revisionId: "rev_enc_1", text: "alpha beta" }]));
  assert.equal(result.completed, 1);
  const row = W.docRow(world, "enc_1");
  assert.equal(row.key_id, W.one(world, "SELECT key_id FROM workspace_keys WHERE workspace_id = 'wsp_a'").key_id);
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM workspace_search_keys").n, 0, "no plaintext key when encryption is on");
  assert.ok(batches(world).some((b) => b.qs.at(-1).includes("key_active")), "keyFence last");
  // A shredded key: the next run stores nothing and logs key_shredded.
  W.run(world, "UPDATE workspace_keys SET shredded_at = 1, wrapped = '' WHERE workspace_id = 'wsp_a'");
  W.setHead(world, "enc_1", "rev_enc_2");
  const second = await logs(() => lib.indexSearchJobs(envOf(world, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: "AAAA" }),
    [{ artifactId: "enc_1", projectId: "proj_a", revisionId: "rev_enc_2", text: "gamma" }]));
  assert.equal(second.result.completed, 0);
  assert.equal(W.docRow(world, "enc_1").revision_id, "rev_enc_1");
});

// --- Test 11: budgets and tallies ----------------------------------------------------------------------------------
/** Setup calls for one plaintext workspace with the default (unlimited) entitlements: the encryption probe and the key. */
const SETUP = 2;
function cappedText(prefix, n = 25000) { return words(n, prefix).join(" "); }

test("test 11: first index of a capped document takes setup + 1 + 4 calls in bounded batches; ends exact and capped", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  W.seedDoc(world, { artifact: "cap_1" });
  const text = cappedText("a");
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "cap_1", projectId: "proj_a", revisionId: "rev_cap_1", text }]));
  assert.equal(result.completed, 1);
  assert.equal(result.calls, SETUP + 1 + 4, JSON.stringify(result));
  assert.ok(result.calls <= 11);
  assertBatchBounds(world);
  const row = W.docRow(world, "cap_1");
  assert.deepEqual([row.revision_id, row.term_count, row.truncated, row.truncated_by], ["rev_cap_1", 20000, 1, "cap"]);
  assert.deepEqual(W.tokensOf(world, "cap_1"), expectedTokens(secretOf(world, "wsp_a"), lib.extractSearchTerms(text, 20000).terms));
  assertExact(world);
  // Rewrite from a stable base: setup + 1 + 1 (set read) + 4.
  W.setHead(world, "cap_1", "rev_cap_2");
  world.log.length = 0;
  const text2 = cappedText("b");
  const r2 = (await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "cap_1", projectId: "proj_a", revisionId: "rev_cap_2", text: text2 }]))).result;
  assert.equal(r2.completed, 1);
  assert.equal(r2.calls, SETUP + 1 + 1 + 4, JSON.stringify(r2));
  assertBatchBounds(world);
  assert.ok(r2.maxRemoveValues <= 30000);
  assert.deepEqual(W.tokensOf(world, "cap_1"), expectedTokens(secretOf(world, "wsp_a"), lib.extractSearchTerms(text2, 20000).terms));
  assertExact(world);
  // Unstable base (a writer died holding the lease): setup + 1 + 1 (lease) + 1 (lease read) + 4.
  W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'dead' WHERE artifact_id = 'cap_1'");
  W.setHead(world, "cap_1", "rev_cap_3");
  world.log.length = 0;
  const r3 = (await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "cap_1", projectId: "proj_a", revisionId: "rev_cap_3", text }]))).result;
  assert.equal(r3.completed, 1);
  assert.equal(r3.calls, SETUP + 1 + 1 + 1 + 4, JSON.stringify(r3));
  assertBatchBounds(world);
  assert.equal(W.docRow(world, "cap_1").revision_id, "rev_cap_3");
  assertExact(world);
});

test("test 11: a 9-file snapshot of small existing files takes one group read and one batch", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  const files = Array.from({ length: 9 }, (_, i) => ({ artifactId: `f${i}`, projectId: "proj_a", revisionId: `rev_f${i}`, text: words(1000, `f${i}x`).join(" ") }));
  for (const f of files) W.seedDoc(world, { artifact: f.artifactId });
  await logs(() => lib.indexSearchJobs(envOf(world), files));
  for (const f of files) W.setHead(world, f.artifactId, f.revisionId + "b");
  world.log.length = 0;
  const next = files.map((f) => ({ ...f, revisionId: f.revisionId + "b", text: f.text + " " + words(50, f.artifactId + "y").join(" ") }));
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), next));
  assert.equal(result.completed, 9);
  assert.equal(result.calls, SETUP + 1 + 1 + 1, JSON.stringify(result));
  assert.ok(result.calls <= 9);
  assertBatchBounds(world);
  assertExact(world);
  for (const f of next) assert.equal(W.docRow(world, f.artifactId).revision_id, f.revisionId);
});

test("test 11: a 100-document import of 500 tokens each, and 300 empty documents, stay within the budgets", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  const docs = Array.from({ length: 100 }, (_, i) => ({ artifactId: `imp${i}`, projectId: "proj_a", revisionId: `rev_imp${i}`, text: words(500, `i${i}z`).join(" ") }));
  for (const d of docs) W.seedDoc(world, { artifact: d.artifactId });
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), docs));
  assert.equal(result.completed, 100, JSON.stringify(result));
  assert.ok(result.calls <= 17, `${result.calls} calls`);
  assertBatchBounds(world);
  assertExact(world);
  const empties = Array.from({ length: 300 }, (_, i) => ({ artifactId: `e${i}`, projectId: "proj_a", revisionId: `rev_e${i}`, text: "" }));
  for (const d of empties) W.seedDoc(world, { artifact: d.artifactId });
  world.log.length = 0;
  const e = (await logs(() => lib.indexSearchJobs(envOf(world), empties))).result;
  assert.equal(e.completed, 100);
  assert.equal(e.skipped.admission, 200);
  assert.ok(e.calls <= 9, `${e.calls} calls`);
  assertBatchBounds(world);
  assertExact(world);
  assert.equal(W.docRow(world, "e0").term_count, 0);
  assert.equal(W.missing(world).filter((a) => a.startsWith("e")).length, 200);
});

test("test 11: with SEARCH_TERMS_MAX = 0 a document gets a complete off row with no tokens and is not missing", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  W.seedDoc(world, { artifact: "off_1" });
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world, { SEARCH_TERMS_MAX: "0" }), [{ artifactId: "off_1", projectId: "proj_a", revisionId: "rev_off_1", text: "alpha beta" }]));
  assert.equal(result.completed, 1);
  const row = W.docRow(world, "off_1");
  assert.deepEqual([row.revision_id, row.truncated, row.truncated_by, row.term_count], ["rev_off_1", 1, "off", 0]);
  assert.ok(!W.missing(world).includes("off_1"));
  assertExact(world);
});

test("test 11: the call budget (clamped by declared calls) leaves the files beyond it missing, counters exact", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  const files = Array.from({ length: 9 }, (_, i) => ({ artifactId: `c${i}`, projectId: "proj_a", revisionId: `rev_c${i}`, text: words(21000, `c${i}q`).join(" ") }));
  for (const f of files) { W.seedDoc(world, { artifact: f.artifactId }); await logs(() => lib.indexSearchJobs(envOf(world), [f])); }
  // Each file changes 2,000 words: 2,000 removes + 2,000 adds; 36,000 values over the run.
  const next = files.map((f, i) => ({ ...f, revisionId: f.revisionId + "b", text: words(19000, `c${i}q`, 2000).join(" ") + " " + words(2000, `c${i}n`).join(" ") }));
  for (const f of next) W.setHead(world, f.artifactId, f.revisionId);
  world.log.length = 0;
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), next, { declaredCalls: 1000 - 20 - 10 }));
  assert.equal(result.calls, 10, "budget min(18, 1000 − declared − 20)");
  assert.ok(result.completed >= 1 && result.completed < 9, JSON.stringify(result));
  assertBatchBounds(world);
  assertExact(world);
  const done = next.filter((f) => W.docRow(world, f.artifactId).revision_id === f.revisionId).length;
  assert.equal(done, result.completed);
  assert.equal(W.missing(world).length, 9 - done);
});

// --- Test 25: set reads ---------------------------------------------------------------------------------------------
test("test 25: a first index that died after 15,000 tokens (stored count 0) converges under the lease read", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  W.seedDoc(world, { artifact: "dead_1" });
  const text = cappedText("d", 20000);
  await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "dead_1", projectId: "proj_a", revisionId: "rev_dead_1", text }]));
  // Simulate the dead first index: 15,000 tokens left, term_count 0, row at '' under a dead writer.
  const d = W.docRow(world, "dead_1").doc_id;
  W.run(world, "DELETE FROM search_tokens WHERE doc_id = ? AND token IN (SELECT token FROM search_tokens WHERE doc_id = ? ORDER BY token DESC LIMIT 5000)", d, d);
  W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'dead', term_count = 0, token_digest = '' WHERE doc_id = ?", d);
  W.run(world, "UPDATE search_term_counters SET terms = terms - 5000");
  assertExact(world);
  world.log.length = 0;
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "dead_1", projectId: "proj_a", revisionId: "rev_dead_1", text }]));
  assert.equal(result.completed, 1);
  assert.ok(world.log.some((c) => c.kind === "all" && /LIMIT 20001/.test(c.q)), "lease read with LIMIT 20001");
  assert.equal(W.docRow(world, "dead_1").term_count, 20000);
  assertExact(world);
});

test("test 25: a row changed between planning and its stable read, or a wrong stored count, re-plans as unstable", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  for (const a of ["s1", "s2"]) W.seedDoc(world, { artifact: a });
  const job = (a, rev, text) => ({ artifactId: a, projectId: "proj_a", revisionId: rev, text });
  await logs(() => lib.indexSearchJobs(envOf(world), [job("s1", "rev_s1", "one two three"), job("s2", "rev_s2", "four five")]));
  for (const a of ["s1", "s2"]) W.setHead(world, a, `rev_${a}b`);
  // s1: a writer bumps gen after planning, before the stable read. s2: its stored count is wrong.
  W.run(world, "UPDATE search_token_docs SET term_count = 7 WHERE artifact_id = 's2'");
  let reads = 0;
  world.before = ({ kind, q }) => { if (kind === "all" && /d\.gen = \?2/.test(q) && reads++ === 0) W.run(world, "UPDATE search_token_docs SET gen = gen + 1 WHERE artifact_id = 's1'"); };
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), [job("s1", "rev_s1b", "one two six"), job("s2", "rev_s2b", "four seven")]));
  world.before = null;
  assert.equal(result.completed, 2, JSON.stringify(result));
  assert.ok(world.log.filter((c) => c.kind === "all" && /LIMIT 20001/.test(c.q)).length === 2, "both re-planned as unstable");
  for (const a of ["s1", "s2"]) assert.equal(W.docRow(world, a).revision_id, `rev_${a}b`);
  assert.deepEqual(W.tokensOf(world, "s1"), expectedTokens(secretOf(world, "wsp_a"), ["one", "two", "six"]));
  assertExact(world);
});

test("test 25: stable groups never exceed 40 documents or 20,000 tokens", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  const docs = Array.from({ length: 45 }, (_, i) => ({ artifactId: `g${i}`, projectId: "proj_a", revisionId: `rev_g${i}`, text: `word${i} shared` }));
  docs.push({ artifactId: "gbig", projectId: "proj_a", revisionId: "rev_gbig", text: cappedText("gb", 20000) });
  for (const d of docs) W.seedDoc(world, { artifact: d.artifactId });
  await logs(() => lib.indexSearchJobs(envOf(world), docs));
  for (const d of docs) W.setHead(world, d.artifactId, d.revisionId + "b");
  world.log.length = 0;
  const next = docs.map((d) => ({ ...d, revisionId: d.revisionId + "b", text: d.text + " extra" }));
  const { result } = await logs(() => lib.indexSearchJobs(envOf(world), next));
  assert.equal(result.completed, 46, JSON.stringify(result));
  const groupReads = world.log.filter((c) => c.kind === "all" && /ORDER BY d\.doc_id, s\.token/.test(c.q));
  assert.ok(groupReads.length >= 3, `${groupReads.length} group reads`);
  for (const g of groupReads) assert.ok((g.params - 1) / 2 <= 40, `${(g.params - 1) / 2} documents in one group`);
  assertExact(world);
});

// --- Test 26 (run part): the oversize path -------------------------------------------------------------------------
test("test 26: an unstable set of 20,001 rows takes the oversize path: deleted under the run's own lease, logged, row left at ''", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  W.seedDoc(world, { artifact: "big_1" });
  await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "big_1", projectId: "proj_a", revisionId: "rev_big_1", text: "seed" }]));
  // Broken invariant (manual SQL): 20,001 stored tokens on a row at '' under a dead writer, counted exactly.
  const d = W.docRow(world, "big_1").doc_id;
  W.run(world, "DELETE FROM search_tokens WHERE doc_id = ?", d);
  W.run(world, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20001)
    INSERT INTO search_tokens (doc_id, token) SELECT ?, unhex(printf('%032x', i)) FROM n`, d);
  W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'dead', term_count = 0 WHERE doc_id = ?", d);
  W.run(world, "UPDATE search_term_counters SET terms = terms + 20000");
  assertExact(world);
  W.setHead(world, "big_1", "rev_big_2");
  const { result, events } = await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "big_1", projectId: "proj_a", revisionId: "rev_big_2", text: "alpha" }]));
  assert.equal(result.completed, 0);
  assert.equal(result.skipped.oversize, 1);
  assert.deepEqual(events.filter((e) => e.event === "search_set_oversize"), [{ event: "search_set_oversize", artifactId: "big_1" }]);
  assert.equal(W.tokensOf(world, "big_1").length, 0);
  const row = W.docRow(world, "big_1");
  assert.equal(row.revision_id, "");
  assert.ok(W.missing(world).includes("big_1"));
  assertExact(world);
  // A later run indexes it from a fresh base.
  const again = (await logs(() => lib.indexSearchJobs(envOf(world), [{ artifactId: "big_1", projectId: "proj_a", revisionId: "rev_big_2", text: "alpha" }]))).result;
  assert.equal(again.completed, 1);
  assert.equal(W.docRow(world, "big_1").revision_id, "rev_big_2");
  assertExact(world);
});

// --- Admission, holder and lifetime (tests 10, 27, 28) ---------------------------------------------------------------
// One bundle for the whole file: the isolate's admission state is module state.
const adm = lib;
const { default: v8 } = await import("node:v8");
const { runInNewContext } = await import("node:vm");
v8.setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const settleGc = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => setImmediate(r)); gc(); } };
const heap = async () => { await settleGc(); return process.memoryUsage().heapUsed; };
const ENV = adm.SEARCH_CALL_ENVELOPE_BYTES, BASE = adm.SEARCH_RUN_BASE_BYTES;
const aenv = (world, vars = {}, adapters = {}) => adm.withAdapters({ DB: world.DB, ...vars }, adm.resolveAdapters(adapters));
const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };
/** Date.now shifted by `offset` ms while fn runs (the module reads Date.now for the deadline and the horizon). */
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };
/** Every test leaves the isolate empty: nothing active, nothing detached, nothing running. */
function assertIdle() {
  const s = adm.searchAdmissionState();
  assert.deepEqual([s.active, s.activeBytes, s.detached, s.running], [0, 0, 0, 0], JSON.stringify(s));
}
const job = (a, text, rev = `rev_${a}`) => ({ artifactId: a, projectId: "proj_a", revisionId: rev, text });
function world1(artifacts) {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  for (const a of artifacts) W.seedDoc(world, { artifact: a });
  return world;
}
/** Start a run for these jobs; returns { run, done }. */
function start(env, jobs) {
  const run = adm.openSearchRun();
  assert.ok(run, "admitted");
  adm.admitSearchJobs(env, run, jobs);
  return { run, done: logs(() => adm.runSearchIndexing(env, run)) };
}
/** Other runs that bring the isolate's counted active bytes to exactly `free` below its 32 MiB limit. */
const fillLeaving = (free, runs = []) => {
  const target = adm.SEARCH_ACTIVE_MAX_BYTES - free;
  while (adm.searchAdmissionState().activeBytes + ENV + BASE <= target) runs.push(adm.openSearchRun());
  let need = target - adm.searchAdmissionState().activeBytes;
  for (const r of runs) {
    const n = Math.min(need, adm.SEARCH_RUN_MAX_BYTES - r.counted);
    if (n > 0) { assert.ok(r.reserve(n)); need -= n; }
  }
  assert.equal(need, 0, "filled exactly");
  return { runs, settle: () => runs.forEach((r) => r.settle()) };
};

test("test 10: reservations: a 10 KB save about 4.2 MiB; 7 small saves admitted, the 8th refused by bytes; 10 MiB about 26 MiB", () => {
  const world = world1([]);
  const env = aenv(world);
  const small = "x".repeat(10240);
  const runs = [];
  for (let i = 0; i < 7; i++) {
    const r = adm.openSearchRun();
    assert.ok(r, `run ${i + 1} admitted`);
    adm.admitSearchJobs(env, r, [job(`s${i}`, small)]);
    assert.equal(r.holder.jobs.length, 1);
    runs.push(r);
  }
  const one = runs[0].counted;
  assert.equal(one, ENV + BASE + 2 * 10240 + 96 * 1536);
  assert.ok(Math.abs(one / MiB - 4.2) < 0.05, `${one / MiB} MiB`);
  const s = adm.searchAdmissionState();
  assert.equal(s.active, 7);
  assert.ok(s.activeBytes <= adm.SEARCH_ACTIVE_MAX_BYTES);
  assert.equal(adm.openSearchRun(), null, "the 8th is refused by bytes");
  for (const r of runs) r.settle();
  assertIdle();
  const big = adm.openSearchRun();
  adm.admitSearchJobs(env, big, [job("big", "y".repeat(10 * MiB))]);
  assert.equal(big.holder.jobs.length, 1);
  assert.ok(big.counted > 25.8 * MiB && big.counted <= 26 * MiB, `${big.counted / MiB} MiB`);
  const second = adm.openSearchRun();
  assert.ok(second, "a second run reservation fits (4 MiB)");
  adm.admitSearchJobs(env, second, [job("big2", "z".repeat(10 * MiB))]);
  assert.equal(second.holder.jobs.length, 0, "a second 10 MiB save is refused by bytes and never enters the holder");
  assert.equal(second.skipped.admission, 1);
  second.settle(); big.settle();
  assertIdle();
});

test("test 10: phase accounting: the reservation falls after extraction and HMAC and rises only for charged removes", async () => {
  const world = world1(["ph"]);
  const env = aenv(world);
  const textA = words(3000, "pa").join(" "), textB = words(2000, "pa", 1000).join(" ") + " " + words(1000, "pb").join(" ");
  await logs(() => lib.indexSearchJobs(env, [job("ph", textA)]));
  W.setHead(world, "ph", "rev_ph2");
  const samples = [];
  let run;
  world.before = ({ kind, q, qs }) => { samples.push({ kind, q: q ?? qs.join(";"), payload: run.payload, removes: run.removeValues }); };
  let done;
  ({ run, done } = start(env, [job("ph", textB, "rev_ph2")]));
  const admitted = run.payload;
  await done;
  world.before = null;
  const cap = lib.searchDocCap({}, textB.length);
  assert.equal(admitted, BASE + 2 * textB.length + 96 * cap);
  const read = samples.find((x) => /ORDER BY d\.doc_id, s\.token/.test(x.q));
  assert.ok(read.payload < admitted, "after extraction and HMAC");
  assert.equal(read.payload, BASE + 96 * cap, "tokens only after HMAC");
  const write = samples.find((x) => x.kind === "batch" && /search_tokens/.test(x.q));
  assert.equal(write.payload, BASE + 96 * cap + 96 * 1000, "rises only by the charged removes (1,000)");
  assert.equal(write.removes, 1000);
  assertIdle();
});

test("test 10 and 28: deadline after the first of four batches: the call in flight completes, nothing further starts, then the next run converges", async () => {
  const world = world1(["dl"]);
  const env = aenv(world);
  const text = words(25000, "dl").join(" ");
  let batchesSeen = 0;
  world.after = ({ kind, qs }) => { if (kind === "batch" && qs.some((q) => /INTO search_tokens/.test(q)) && ++batchesSeen === 1) advance(21000); };
  const { done } = start(env, [job("dl", text)]);
  const { events } = await done;
  world.after = null;
  assert.equal(batchesSeen, 1, "no further call after the deadline");
  assert.ok(events.some((e) => e.event === "search_phase" && e.phase === "deadline"));
  const skipped = events.find((e) => e.event === "search_index_skipped");
  assert.deepEqual(skipped.reasons, { deadline: 1 });
  assert.equal(W.docRow(world, "dl").revision_id, "", "partial work under the lease");
  assert.equal(W.tokensOf(world, "dl").length, 5000);
  assert.ok(W.missing(world).includes("dl"));
  assertExact(world);
  assertIdle();
  world.log.length = 0;
  const { result } = await logs(() => lib.indexSearchJobs(env, [job("dl", text)]));
  assert.equal(result.completed, 1);
  assert.ok(world.log.some((c) => c.kind === "all" && /LIMIT 20001/.test(c.q)), "T1u then the lease read");
  assert.equal(W.docRow(world, "dl").term_count, 20000);
  assertExact(world);
  assertIdle();
});

test("test 10: past the deadline no HMAC chunk or key-provider call starts", async () => {
  const world = world1(["hd"]);
  const env = aenv(world);
  const sign = crypto.subtle.sign;
  let signs = 0;
  crypto.subtle.sign = function (...a) { signs++; return sign.apply(this, a); };
  try {
    world.after = ({ kind, q }) => { if (kind === "first" && /NOT EXISTS \(SELECT 1 FROM workspace_keys/.test(q)) advance(21000); };
    const { done } = start(env, [job("hd", "alpha beta")]);
    const { events } = await done;
    world.after = null;
    assert.equal(signs, 0);
    assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM workspace_search_keys").n, 0, "the key call did not start");
    assert.ok(events.some((e) => e.phase === "deadline"));
  } finally { crypto.subtle.sign = sign; }
  assertIdle();
});

test("test 10: detachment at the horizon nulls the holder, keeps the envelope counted, and a late settlement frees it once", async () => {
  const world = world1(["dt"]);
  const env = aenv(world);
  const block = gate();
  world.before = ({ kind }) => kind === "batch" && /search_tokens/.test(world.log.at(-1).qs?.join(";") ?? "") ? block.wait : undefined;
  const { run, done } = start(env, [job("dt", words(25000, "dt").join(" "))]);
  // Wait until the run is blocked in its write batch.
  while (!world.log.some((c) => c.kind === "batch" && c.qs.some((q) => /search_tokens/.test(q)))) await new Promise((r) => setTimeout(r, 5));
  const jobRef = new WeakRef(run.holder.jobs[0]), tokensRef = new WeakRef(run.holder.jobs[0].tokens), holderJobs = new WeakRef(run.holder.jobs);
  advance(adm.SEARCH_DETACH_AFTER_MS);
  const other = adm.openSearchRun();
  assert.ok(other, "admission after detaching");
  assert.equal(run.detached, true);
  assert.deepEqual([run.holder.jobs, run.holder.plan, run.holder.set, run.holder.pending, run.holder.detached], [null, null, null, null, true]);
  let s = adm.searchAdmissionState();
  assert.equal(s.detached, 1); assert.equal(s.detachedBytes, ENV);
  assert.equal(s.activeBytes, other.counted, "the detached run's payload is released");
  await settleGc();
  assert.equal(tokensRef.deref(), undefined, "tokens"); assert.equal(holderJobs.deref(), undefined, "jobs array");
  // The job object itself (meta only, every large field nulled) may stay reachable from the batch in flight.
  const j = jobRef.deref();
  if (j) assert.deepEqual([j.text, j.flat, j.terms, j.tokens, j.removes, j.adds], [null, null, null, null, null, null]);
  other.settle();
  block.open();
  const { events } = await done;
  world.before = null;
  assert.equal(events.filter((e) => e.event === "search_run_detached").length, 1);
  // The batch in flight commits (D1 has it); nothing after it is sent or stored.
  assert.equal(W.docRow(world, "dt").revision_id, "", "the detached run stores no further result");
  assert.equal(W.tokensOf(world, "dt").length, 5000);
  assert.equal(world.log.filter((c) => c.kind === "batch" && c.qs.some((q) => /search_tokens/.test(q))).length, 1);
  assertExact(world);
  run.settle(); run.settle();
  s = adm.searchAdmissionState();
  assert.equal(s.detached, 0, "freed exactly once");
  assertIdle();
});

test("test 10 and 27: a stuck isolate refuses admission and logs search_admission_stuck; counted bytes never exceed 48 MiB", async () => {
  const world = world1(Array.from({ length: 12 }, (_, i) => `st${i}`));
  const env = aenv(world);
  const block = gate();
  world.before = () => block.wait;
  const started = [];
  for (let i = 0; i < 4; i++) started.push(start(env, [job(`st${i}`, "alpha")]));
  await new Promise((r) => setTimeout(r, 20));
  advance(adm.SEARCH_DETACH_AFTER_MS);
  const fill = [];
  for (let i = 4; ; i++) {
    const r = adm.openSearchRun();
    if (!r) break;
    adm.admitSearchJobs(env, r, [job(`st${i % 12}`, "alpha")]);
    fill.push(r);
    const s = adm.searchAdmissionState();
    assert.ok(s.activeBytes + s.detachedBytes <= 48 * MiB);
  }
  let s = adm.searchAdmissionState();
  assert.equal(s.detached, adm.SEARCH_DETACHED_MAX);
  assert.ok(s.activeBytes + ENV + BASE > adm.SEARCH_ACTIVE_MAX_BYTES, "active set full");
  // Another horizon passes: nothing is freed by time alone (the detached set is full).
  advance(adm.SEARCH_DETACH_AFTER_MS);
  const req = adm.withDeferredWork(env);
  const { events } = await logs(() => { adm.deferSearchIndexing(req, [job("st0", "a")]); adm.deferSearchIndexing(req, [job("st1", "b")]); adm.discardDeferredWork(req); });
  assert.equal(events.filter((e) => e.event === "search_admission_stuck").length, 1, "once per request");
  const stuck = events.find((e) => e.event === "search_admission_stuck");
  assert.deepEqual(Object.keys(stuck).sort(), ["active", "activeBytes", "detached", "event", "refused"]);
  assert.deepEqual(events.find((e) => e.event === "search_index_skipped").reasons, { admission: 2 });
  s = adm.searchAdmissionState();
  assert.ok(s.activeBytes + s.detachedBytes <= 48 * MiB);
  for (const r of fill) r.settle();
  block.open();
  await Promise.all(started.map((x) => x.done));
  world.before = null;
  assertIdle();
});

test("test 10: deferral: jobs wait for startDeferredWork, run under one waitUntil promise that never rejects; discard drops an unstarted run", async () => {
  const world = world1(["df1", "df2"]);
  const env = aenv(world);
  const req = adm.withDeferredWork(env);
  assert.equal(adm.deferSearchIndexing(req, [job("df1", "alpha")]), undefined);
  assert.equal(world.calls, 0, "nothing runs before the response");
  assert.equal(adm.searchAdmissionState().active, 1);
  const waits = [];
  const { events } = await logs(async () => {
    adm.startDeferredWork(req, { waitUntil: (p) => waits.push(p) });
    adm.startDeferredWork(req, { waitUntil: (p) => waits.push(p) });
    adm.discardDeferredWork(req);
    await Promise.all(waits);
  });
  assert.equal(waits.length, 1);
  assert.equal(W.docRow(world, "df1").revision_id, "rev_df1");
  const phases = events.filter((e) => e.event === "search_phase").map((e) => e.phase);
  assert.deepEqual(phases.slice(0, 2), ["handler_done", "deferred_start"]);
  assert.equal(phases.at(-1), "deferred_end");
  // A rejected D1 call inside the run: the waitUntil promise still resolves.
  W.setHead(world, "df1", "rev_df1b");
  const req2 = adm.withDeferredWork(aenv({ ...world, DB: { prepare: () => { throw new Error("boom"); }, batch: async () => { throw new Error("boom"); } } }));
  adm.deferSearchIndexing(req2, [job("df1", "beta", "rev_df1b")]);
  const w2 = [];
  await logs(async () => { adm.startDeferredWork(req2, { waitUntil: (p) => w2.push(p) }); await Promise.all(w2); });
  // Discard: the run is dropped, its holder nulled and its reservation released.
  const req3 = adm.withDeferredWork(env);
  adm.deferSearchIndexing(req3, [job("df2", "gamma")]);
  assert.equal(adm.searchAdmissionState().active, 1);
  const d = await logs(() => adm.discardDeferredWork(req3));
  assert.deepEqual(d.events.find((e) => e.event === "search_index_skipped").reasons, { discarded: 1 });
  assert.equal(W.docRow(world, "df2"), undefined);
  assertIdle();
});

/** Heap retained by a blocked call once the run is detached (holder nulled), relative to `baseline`. */
async function retainedWhileBlocked(run, baseline) {
  run.detach();
  return (await heap()) - baseline;
}

test("test 27: blocked operations retain at most the 4 MiB envelope once the holder is nulled", async () => {
  const sizes = {};
  // (a) A set read with the exact result shape (doc_id, gen, t): 20,000 rows, blocked after the result exists.
  {
    const world = world1(["b1"]);
    const env = aenv(world);
    const text = words(20000, "ba").join(" ");
    await logs(() => lib.indexSearchJobs(env, [job("b1", text)]));
    W.setHead(world, "b1", "rev_b1b");
    const block = gate();
    let inFlight = null;
    world.after = async ({ kind, q, out }) => { if (kind === "all" && /ORDER BY d\.doc_id/.test(q)) { inFlight = out; await block.wait; } };
    const base0 = await heap();
    const { run, done } = start(env, [job("b1", words(20000, "bb").join(" "), "rev_b1b")]);
    while (!inFlight) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(Object.keys(inFlight.results[0]).sort(), ["doc_id", "gen", "t"]);
    assert.equal(inFlight.results.length, 20000);
    inFlight = null;
    sizes.setRead = await retainedWhileBlocked(run, base0);
    block.open(); await done; world.after = null;
  }
  // (b) The largest write batch (a capped rewrite: 5,000 removes + 5,000 adds = 10,000 values), blocked before it runs.
  {
    const world = world1(["b2"]);
    const env = aenv(world);
    await logs(() => lib.indexSearchJobs(env, [job("b2", words(25000, "bx").join(" "))]));
    W.setHead(world, "b2", "rev_b2b");
    const block = gate();
    let seen = null;
    world.before = ({ kind, tokenValues }) => { if (kind === "batch" && tokenValues >= 10000) { seen = tokenValues; return block.wait; } };
    const base0 = await heap();
    const { run, done } = start(env, [job("b2", words(25000, "bc").join(" "), "rev_b2b")]);
    while (!seen) await new Promise((r) => setTimeout(r, 5));
    sizes.writeBatch = await retainedWhileBlocked(run, base0);
    block.open(); await done; world.before = null;
  }
  // (c) An HMAC chunk with its input buffers (1,000 terms), blocked inside crypto.subtle.sign.
  {
    const world = world1(["b3"]);
    const env = aenv(world);
    const block = gate(), sign = crypto.subtle.sign;
    let signing = false;
    crypto.subtle.sign = async function (...a) { signing = true; await block.wait; return sign.apply(this, a); };
    try {
      const base0 = await heap();
      const { run, done } = start(env, [job("b3", words(5000, "bd").join(" "))]);
      while (!signing) await new Promise((r) => setTimeout(r, 5));
      sizes.hmac = await retainedWhileBlocked(run, base0);
      block.open(); await done;
    } finally { crypto.subtle.sign = sign; }
  }
  // (d) A slow key-provider call (encryption on), blocked in unwrap.
  {
    const world = world1(["b4"]);
    const block = gate();
    let unwrapping = false;
    const provider = { name: "slow", configured: () => true, currentVersion: () => 1,
      wrap: async () => "c3ludGhldGlj",
      unwrap: async () => { unwrapping = true; await block.wait; return crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveKey"]); } };
    const env = aenv(world, {}, { keyProvider: provider });
    const base0 = await heap();
    const { run, done } = start(env, [job("b4", words(5000, "be").join(" "))]);
    while (!unwrapping) await new Promise((r) => setTimeout(r, 5));
    sizes.keyProvider = await retainedWhileBlocked(run, base0);
    block.open(); await done;
  }
  for (const [k, n] of Object.entries(sizes)) assert.ok(n <= ENV, `${k}: ${n} bytes retained`);
  console.log("BLOCKED_RETAINED " + JSON.stringify(sizes));
  assertIdle();
});

test("test 27: with calls blocked, admission refuses once payload plus envelopes reach 32 MiB", async () => {
  const world = world1(Array.from({ length: 20 }, (_, i) => `sat${i}`));
  const env = aenv(world);
  const block = gate();
  world.before = () => block.wait;
  const started = [];
  for (let i = 0; ; i++) {
    const r = adm.openSearchRun();
    if (!r) break;
    adm.admitSearchJobs(env, r, [job(`sat${i}`, words(2000, `s${i}`).join(" "))]);
    started.push(logs(() => adm.runSearchIndexing(env, r)));
  }
  const s = adm.searchAdmissionState();
  assert.ok(s.activeBytes <= adm.SEARCH_ACTIVE_MAX_BYTES && s.activeBytes + ENV + BASE > adm.SEARCH_ACTIVE_MAX_BYTES, JSON.stringify(s));
  assert.ok(s.active >= 6 && s.active <= 7, `${s.active} runs`);
  block.open();
  await Promise.all(started);
  world.before = null;
  assertIdle();
});

test("test 28: whole-document charge, clearing of sent removes, ADD lifetime and no second set read with a remainder outstanding", async () => {
  const world = world1(["wd", "wd2"]);
  const env = aenv(world);
  const textA = words(20000, "wa").join(" ");
  await logs(() => lib.indexSearchJobs(env, [job("wd", textA), job("wd2", "small text here")]));
  for (const a of ["wd", "wd2"]) W.setHead(world, a, `rev_${a}b`);
  const samples = [];
  let run, firstChunk = null;
  world.before = async ({ kind, q, qs, tokenValues }) => {
    const j = run.holder.jobs?.[0];
    if (kind === "batch" && qs.some((x) => /search_tokens/.test(x))) {
      await settleGc();
      samples.push({ payload: run.payload, removes: run.removeValues, chunks: j?.removes?.length ?? 0, firstGone: firstChunk ? firstChunk.deref() === undefined : null,
        tokens: !!j?.tokens, tokenValues, final: qs.some((x) => /SET revision_id = \?/.test(x)) });
    }
    if (kind === "all" && /ORDER BY d\.doc_id/.test(q) && samples.length) samples.push({ secondRead: true, remainder: j?.removes?.reduce((n, c) => n + c.length, 0) ?? 0 });
  };
  world.after = ({ kind, q }) => {
    if (kind === "all" && /ORDER BY d\.doc_id/.test(q)) {
      // Called before the run builds its diff; the diff exists once the next batch is packed.
      queueMicrotask(() => {});
    }
  };
  let done;
  ({ run, done } = start(env, [job("wd", words(20000, "wz").join(" "), "rev_wdb"), job("wd2", "other text now", "rev_wd2b")]));
  // Capture the first remove chunk as soon as the diff is built (before its batch is sent).
  const capture = setInterval(() => { const r = run.holder.jobs?.[0]?.removes; if (r?.length && !firstChunk) firstChunk = new WeakRef(r[0]); }, 0);
  await done;
  clearInterval(capture);
  world.before = null; world.after = null;
  // wd fills a stable group (20,000 stored tokens), so wd2 is read in a second group; wd2's own batch is the fifth.
  const writes = samples.filter((x) => !x.secondRead);
  assert.equal(writes.length, 5, JSON.stringify(writes));
  assert.ok(run.maxRemoveValues <= 30000);
  // The whole document's removes are charged when its diff is built: 20,000 × 96 B ≈ 1.83 MiB.
  assert.equal(writes[0].removes, 20000);
  assert.ok(writes[0].payload >= 96 * 20000 + 96 * 20000);
  // The charge falls as each batch returns (wd2's 2 removes are charged once its diff is built, after wd's remainder
  // was fully packed: only wd's last, packed batch is outstanding then).
  assert.deepEqual(writes.map((x) => x.removes), [20000, 15000, 10000, 5002, 2]);
  // Clearing: by the second batch the first chunk's array is gone (gc), while the unsent rest is held.
  assert.deepEqual(writes.slice(0, 4).map((x) => x.chunks), [3, 2, 1, 0]);
  if (firstChunk) assert.equal(writes[1].firstGone, true);
  // ADD lifetime: while the last batch is in flight its token charge still counts.
  assert.equal(writes[3].final, true);
  assert.equal(writes[3].tokens, true);
  assert.ok(writes[3].payload >= BASE + 96 * 20000);
  for (const w of writes) assert.ok(w.tokenValues <= 10000);
  const second = samples.find((x) => x.secondRead);
  assert.ok(second, "the second document's set was read");
  assert.equal(second.remainder, 0, "no remainder outstanding at the second set read");
  assert.equal(W.docRow(world, "wd").revision_id, "rev_wdb");
  assertExact(world);
  assertIdle();
});

test("test 28: removes charge does not fit, then fits after the flush; still does not fit: skipped and missing", async () => {
  for (const fits of [true, false]) {
    const world = world1(["cf1", "cf2"]);
    const env = aenv(world);
    const a1 = words(3000, "c1").join(" "), a2 = words(3000, "c2").join(" ");
    await logs(() => lib.indexSearchJobs(env, [job("cf1", a1), job("cf2", a2)]));
    for (const a of ["cf1", "cf2"]) W.setHead(world, a, `rev_${a}b`);
    const b1 = words(3000, "c1", 1000).join(" "), b2 = words(3000, "c2", 2000).join(" ");
    let run, setRef = null, flushState = null, reads = 0;
    const fills = [];
    world.after = ({ kind, q, out }) => {
      if (kind !== "all" || !/ORDER BY d\.doc_id/.test(q)) return;
      reads++;
      // First read (both documents): room for cf1's 1,000 removes and all but one byte of cf2's 2,000.
      if (reads === 1) { setRef = new WeakRef(out.results); fills.push(fillLeaving(96 * 1000 + 96 * 2000 - 1)); }
      // The re-read after the flush: still no room for cf2's removes in the second case.
      if (reads === 2 && !fits) fillLeaving(96 * 2000 - 1, fills[0].runs);
    };
    world.before = async ({ kind, qs }) => {
      if (kind === "batch" && qs.some((x) => /search_tokens/.test(x)) && !flushState) {
        await settleGc();
        flushState = { setGone: setRef?.deref() === undefined, set: run.holder.set, cf2removes: run.holder.jobs?.[1]?.removes ?? null };
      }
    };
    let done;
    ({ run, done } = start(env, [job("cf1", b1, "rev_cf1b"), job("cf2", b2, "rev_cf2b")]));
    const { events } = await done;
    world.before = null; world.after = null;
    for (const f of fills) f.settle();
    assert.deepEqual(flushState, { setGone: true, set: null, cf2removes: null }, "while the flush is in flight no set or candidate diff is reachable");
    assert.equal(W.docRow(world, "cf1").revision_id, "rev_cf1b");
    assert.equal(reads, 2, "the second document's set is re-read after the flush");
    if (fits) {
      assert.equal(W.docRow(world, "cf2").revision_id, "rev_cf2b");
      assert.deepEqual(W.tokensOf(world, "cf2"), expectedTokens(secretOf(world, "wsp_a"), lib.extractSearchTerms(b2, 1e9).terms));
    } else {
      assert.equal(W.docRow(world, "cf2").revision_id, "rev_cf2", "row unchanged");
      assert.ok(W.missing(world).includes("cf2"));
      assert.deepEqual(events.find((e) => e.event === "search_index_skipped").reasons, { charge: 1 });
      assert.equal(run.holder.jobs, null);
    }
    assertExact(world);
    assertIdle();
  }
});

test("test 28: a capped 10 MiB document: text released before its set read, about 7.7 MiB after its diff, never above 26 MiB", async () => {
  const world = world1(["ten"]);
  const env = aenv(world);
  const tenMiB = (prefix) => { const w = words(1200000, prefix).join(" "); return w.slice(0, 10 * MiB); };
  await logs(() => lib.indexSearchJobs(env, [job("ten", tenMiB("ta"))]));
  W.setHead(world, "ten", "rev_tenb");
  let run, peak = 0, atRead = null, atWrite = null;
  world.before = ({ kind, q, qs }) => {
    peak = Math.max(peak, run.counted);
    if (kind === "all" && /ORDER BY d\.doc_id/.test(q)) atRead = { counted: run.counted, text: run.holder.jobs[0].text };
    if (kind === "batch" && !atWrite && qs.some((x) => /search_tokens/.test(x))) atWrite = run.counted;
  };
  let done;
  ({ run, done } = start(env, [job("ten", tenMiB("tb"), "rev_tenb")]));
  const admitted = run.counted;
  await done;
  world.before = null;
  assert.ok(admitted <= 26 * MiB && admitted > 25 * MiB, `${admitted / MiB}`);
  assert.equal(atRead.text, null, "text released before the set read");
  assert.ok(Math.abs(atRead.counted / MiB - 5.9) < 0.1, `${atRead.counted / MiB} MiB after HMAC`);
  assert.ok(Math.abs(atWrite / MiB - 7.7) < 0.1, `${atWrite / MiB} MiB after the diff`);
  assert.ok(peak <= 26 * MiB);
  assert.equal(W.docRow(world, "ten").revision_id, "rev_tenb");
  assertExact(world);
  assertIdle();
});

test("test 10: rejected jobs never enter the holder", () => {
  const world = world1([]);
  const env = aenv(world);
  const r = adm.openSearchRun();
  adm.admitSearchJobs(env, r, Array.from({ length: 105 }, (_, i) => job(`rj${i}`, "x")));
  assert.equal(r.holder.jobs.length, 100);
  assert.ok(r.holder.jobs.every((j) => Number(j.meta.artifactId.slice(2)) < 100));
  assert.equal(r.skipped.admission, 5);
  r.settle();
  assertIdle();
});
