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
    "indexSearchJobs", "SEARCH_BATCH_TOKENS_MAX", "SEARCH_BATCH_STATEMENTS_MAX", "SEARCH_RUN_LIMITS"],
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
