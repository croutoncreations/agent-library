// Blind-index search tokens (slice 4a), unit tests on the real packages/core/src/search/tokens.js (test/load-worker.mjs)
// over node:sqlite with every migration applied (test/blind-tokens-world.mjs). No listeners. Synthetic text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, hkdfSync, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";
import * as W from "./blind-tokens-world.mjs";

const lib = await loadWorker({
  "search/tokens.js": ["extractSearchTerms", "extractSearchTermsFlat", "searchFlatTerms", "searchFlatHeld", "searchTermInputs", "u61FoldTokenBounded", "searchDocCap", "searchTermsMax", "searchScopeBounds",
    "searchSweepWritesMax", "utf8Length", "searchTokensFor", "searchTokenDigest", "decodeSearchSecret", "searchTokenKey",
    "indexSearchJobs", "SEARCH_BATCH_TOKENS_MAX", "SEARCH_BATCH_STATEMENTS_MAX", "SEARCH_RUN_LIMITS",
    "openSearchRun", "admitSearchJobs", "runSearchIndexing", "searchAdmissionState", "withDeferredWork", "deferSearchIndexing", "startDeferredWork",
    "discardDeferredWork", "drainSearchIndexing", "SEARCH_CALL_ENVELOPE_BYTES", "SEARCH_RUN_BASE_BYTES", "SEARCH_ACTIVE_MAX_BYTES", "SEARCH_RUN_MAX_BYTES",
    "SEARCH_DETACHED_MAX", "SEARCH_DETACH_AFTER_MS"],
  "search/unicode61.js": ["u61FoldToken"],
  "limits.js": ["LIMIT_KEYS", "workspaceLimits"],
  "adapters.js": ["withAdapters", "resolveAdapters"],
});
const MiB = 1048576;
/** Text jobs carry their stored UTF-8 size (textBytes is required: admission never scans the text). */
const withBytes = (j) => typeof j.text === "string" && j.textBytes === undefined ? { ...j, textBytes: Buffer.byteLength(j.text) } : j;
const indexJobs = (env, jobs, opts) => lib.indexSearchJobs(env, jobs.map(withBytes), opts);
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
  // A lone surrogate: unicode61 separates at it, and so do we.
  for (const c of ["ab\uD800cd", "x\uDC00y z", "\uD800"]) assert.deepEqual(ours(c), ftsTerms(c), JSON.stringify(c));
  // A word longer than 200 units: the index keeps it, we skip it (queries are at most 200); nothing else differs.
  const long = "w" + "y".repeat(250);
  assert.deepEqual(ftsTerms(`alpha ${long} beta`), ["alpha", "beta", long].sort());
  assert.deepEqual(ours(`alpha ${long} beta`), ["alpha", "beta"]);
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
  const { result } = await logs(() => indexJobs(envOf(world), [
    { artifactId: "d1", projectId: "proj_a", revisionId: "rev_d1", text: big },
    { artifactId: "d2", projectId: "proj_a", revisionId: "rev_d2", text: big }]));
  assert.equal(result.skipped.admission, 1);
  assert.equal(result.completed, 1);
});

// --- Test 7: flat extraction and heap --------------------------------------------------------------------------------
test("test 7: extractSearchTermsFlat decodes to the same terms as extractSearchTerms", () => {
  const text = "Zürich straße 日本語 alpha beta alpha 😀 " + words(500).join(" ");
  const flat = lib.extractSearchTermsFlat(text, 300), plain = lib.extractSearchTerms(text, 300);
  assert.deepEqual(lib.searchFlatTerms(flat), plain.terms);
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
    console.log("FLAT " + JSON.stringify({ fell: withText - after, bytes: flat.byteLength, count: flat.count }));
  `], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  const r = JSON.parse(child.stdout.split("FLAT ")[1]);
  console.log("TEST7_FELL " + r.fell);
  assert.ok(r.fell >= 9 * MiB, `heap fell by ${r.fell}`);
  assert.ok(r.bytes <= 12000000);
  assert.equal(r.count, 20000);
});

test("test 7: heap kept by the first (cold) and a later (warm) capped scan, reported (child processes, --expose-gc)", () => {
  const measure = (warm) => {
    const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
      import { loadWorker } from "./test/load-worker.mjs";
      const lib = await loadWorker({ "search/tokens.js": ["extractSearchTermsFlat"] });
      const make = (n) => { const parts = []; for (let i = 0; parts.length * 8 < n; i++) parts.push("t" + (i % 50000).toString(36).padStart(6, "0") + " "); return parts.join(""); };
      if (${warm}) lib.extractSearchTermsFlat(make(1048576), 20000);
      let text = make(2 * 1048576);
      global.gc(); const withText = process.memoryUsage().heapUsed;
      const flat = lib.extractSearchTermsFlat(text, 20000);
      text = null;
      // kept = heap after gc − heap with the text + the text (ASCII: a one-byte string of 2 Mi bytes), less the result.
      const result = flat.byteLength + 4 * (flat.count + 1);   // the private bytes and offsets the handle stands for
      global.gc(); const kept = process.memoryUsage().heapUsed - withText + 2 * 1048576 - result;
      console.log("KEPT " + JSON.stringify({ kept, result }));
    `], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.split("KEPT ")[1]);
  };
  const runs = { cold: [0, 1, 2].map(() => measure(false)), warm: [0, 1, 2].map(() => measure(true)) };
  console.log("TEST7_COLD_WARM " + JSON.stringify(runs));
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

/** The search-key derivation lives in crypto/ (only search/tokens.js imports workspaceSearchKey). Loaded with its own env helpers. */
let keyLibP = null;
const keyLib = () => (keyLibP ??= loadWorker({
  "crypto/search-key.js": ["deriveSearchKey", "searchKeyInfo", "workspaceSearchKey"],
  "search/tokens.js": ["searchTokensFor", "searchTokenKey"],
  "adapters.js": ["withAdapters", "resolveAdapters"],
  "crypto/keys.js": ["withDataKeyMemo"],
}));
test("test 8: derivation: HKDF-SHA-256 of the data key with info al-search/1 ‖ 0x00 ‖ workspaceId", async () => {
  const lib = await keyLib();
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

test("test 8: workspaceSearchKey (crypto/) gives a non-extractable, sign-only key, memoized per data key, and refuses like the data key", async () => {
  const lib = await keyLib();
  const envOf = (world, vars = {}) => lib.withAdapters({ DB: world.DB, ...vars }, lib.resolveAdapters({}));
  const world = W.mkWorld();
  W.seedWorkspace(world);
  const master = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const env = envOf(world, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: master });
  const got = await lib.workspaceSearchKey(env, "wsp_a");
  assert.deepEqual(Object.keys(got).sort(), ["key", "keyId"], "only the key id and the derived key: never the data key");
  assert.equal(got.key.extractable, false);
  assert.deepEqual(got.key.usages, ["sign"]);
  assert.deepEqual(got.key.algorithm, { name: "HMAC", hash: { name: "SHA-256" }, length: 256 });
  await assert.rejects(crypto.subtle.exportKey("raw", got.key));
  // Within one request (its data-key memo, as createWorker attaches) the derived key is derived once.
  const request = lib.withDataKeyMemo(env);
  const inRequest = await lib.workspaceSearchKey(request, "wsp_a");
  assert.equal((await lib.workspaceSearchKey(request, "wsp_a")).key, inRequest.key, "memoized per data-key object (one request)");
  // The same tokens as the tokens module's own key (the bytes of the derivation did not change).
  const viaTokens = await lib.searchTokenKey(env, "wsp_a");
  assert.deepEqual([viaTokens.keyId, viaTokens.encrypted], [got.keyId, true]);
  assert.deepEqual(await lib.searchTokensFor(viaTokens.key, ["word"]), await lib.searchTokensFor(got.key, ["word"]));
  // Refusals are workspaceDataKey's own.
  await assert.rejects(lib.workspaceSearchKey(envOf(world), "wsp_a"), (e) => e.status === 500 && e.code === "encryption_not_configured");
  W.run(world, "UPDATE workspace_keys SET shredded_at = 1, wrapped = '' WHERE workspace_id = 'wsp_a'");
  await assert.rejects(lib.workspaceSearchKey(envOf(world, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: master }), "wsp_a"),
    (e) => e.status === 410 && e.code === "key_shredded");
});

test("test 8: encryption on: the run derives from the workspace data key and fences on it", async () => {
  const world = W.mkWorld();
  W.seedWorkspace(world);
  W.seedDoc(world, { artifact: "enc_1" });
  const env = envOf(world, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  const { result } = await logs(() => indexJobs(env, [{ artifactId: "enc_1", projectId: "proj_a", revisionId: "rev_enc_1", text: "alpha beta" }]));
  assert.equal(result.completed, 1);
  const row = W.docRow(world, "enc_1");
  assert.equal(row.key_id, W.one(world, "SELECT key_id FROM workspace_keys WHERE workspace_id = 'wsp_a'").key_id);
  assert.equal(W.one(world, "SELECT COUNT(*) AS n FROM workspace_search_keys").n, 0, "no plaintext key when encryption is on");
  assert.ok(batches(world).some((b) => b.qs.at(-1).includes("key_active")), "keyFence last");
  // The workspace key is shredded (configuration unchanged and valid): the next run stores nothing, logs key_shredded.
  W.run(world, "UPDATE workspace_keys SET shredded_at = 1, wrapped = '' WHERE workspace_id = 'wsp_a'");
  W.setHead(world, "enc_1", "rev_enc_2");
  const tokensBefore = W.tokensOf(world, "enc_1"), countersBefore = W.counters(world);
  const second = await logs(() => indexJobs(env, [{ artifactId: "enc_1", projectId: "proj_a", revisionId: "rev_enc_2", text: "gamma" }]));
  assert.equal(second.result.completed, 0);
  assert.deepEqual(second.events.filter((e) => e.event === "search_index_failed").map((e) => [e.artifactId, e.code]), [["enc_1", "key_shredded"]]);
  assert.equal(W.docRow(world, "enc_1").revision_id, "rev_enc_1");
  assert.deepEqual(W.tokensOf(world, "enc_1"), tokensBefore);
  assert.deepEqual(W.counters(world), countersBefore);
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
  const { result } = await logs(() => indexJobs(envOf(world), [{ artifactId: "cap_1", projectId: "proj_a", revisionId: "rev_cap_1", text }]));
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
  const r2 = (await logs(() => indexJobs(envOf(world), [{ artifactId: "cap_1", projectId: "proj_a", revisionId: "rev_cap_2", text: text2 }]))).result;
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
  const r3 = (await logs(() => indexJobs(envOf(world), [{ artifactId: "cap_1", projectId: "proj_a", revisionId: "rev_cap_3", text }]))).result;
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
  await logs(() => indexJobs(envOf(world), files));
  for (const f of files) W.setHead(world, f.artifactId, f.revisionId + "b");
  world.log.length = 0;
  const next = files.map((f) => ({ ...f, revisionId: f.revisionId + "b", text: f.text + " " + words(50, f.artifactId + "y").join(" ") }));
  const { result } = await logs(() => indexJobs(envOf(world), next));
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
  const { result } = await logs(() => indexJobs(envOf(world), docs));
  assert.equal(result.completed, 100, JSON.stringify(result));
  assert.ok(result.calls <= 17, `${result.calls} calls`);
  assertBatchBounds(world);
  assertExact(world);
  const empties = Array.from({ length: 300 }, (_, i) => ({ artifactId: `e${i}`, projectId: "proj_a", revisionId: `rev_e${i}`, text: "" }));
  for (const d of empties) W.seedDoc(world, { artifact: d.artifactId });
  world.log.length = 0;
  const e = (await logs(() => indexJobs(envOf(world), empties))).result;
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
  const { result } = await logs(() => indexJobs(envOf(world, { SEARCH_TERMS_MAX: "0" }), [{ artifactId: "off_1", projectId: "proj_a", revisionId: "rev_off_1", text: "alpha beta" }]));
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
  for (const f of files) { W.seedDoc(world, { artifact: f.artifactId }); await logs(() => indexJobs(envOf(world), [f])); }
  // Each file changes 2,000 words: 2,000 removes + 2,000 adds; 36,000 values over the run.
  const next = files.map((f, i) => ({ ...f, revisionId: f.revisionId + "b", text: words(19000, `c${i}q`, 2000).join(" ") + " " + words(2000, `c${i}n`).join(" ") }));
  for (const f of next) W.setHead(world, f.artifactId, f.revisionId);
  world.log.length = 0;
  const { result } = await logs(() => indexJobs(envOf(world), next, { declaredCalls: 1000 - 20 - 10 }));
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
  await logs(() => indexJobs(envOf(world), [{ artifactId: "dead_1", projectId: "proj_a", revisionId: "rev_dead_1", text }]));
  // Simulate the dead first index: 15,000 tokens left, term_count 0, row at '' under a dead writer.
  const d = W.docRow(world, "dead_1").doc_id;
  W.run(world, "DELETE FROM search_tokens WHERE doc_id = ? AND token IN (SELECT token FROM search_tokens WHERE doc_id = ? ORDER BY token DESC LIMIT 5000)", d, d);
  W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'dead', term_count = 0, token_digest = '' WHERE doc_id = ?", d);
  W.run(world, "UPDATE search_term_counters SET terms = terms - 5000");
  assertExact(world);
  world.log.length = 0;
  const { result } = await logs(() => indexJobs(envOf(world), [{ artifactId: "dead_1", projectId: "proj_a", revisionId: "rev_dead_1", text }]));
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
  await logs(() => indexJobs(envOf(world), [job("s1", "rev_s1", "one two three"), job("s2", "rev_s2", "four five")]));
  for (const a of ["s1", "s2"]) W.setHead(world, a, `rev_${a}b`);
  // s1: a writer bumps gen after planning, before the stable read. s2: its stored count is wrong.
  W.run(world, "UPDATE search_token_docs SET term_count = 7 WHERE artifact_id = 's2'");
  let reads = 0;
  world.before = ({ kind, q }) => { if (kind === "all" && /d\.gen = \?2/.test(q) && reads++ === 0) W.run(world, "UPDATE search_token_docs SET gen = gen + 1 WHERE artifact_id = 's1'"); };
  const { result } = await logs(() => indexJobs(envOf(world), [job("s1", "rev_s1b", "one two six"), job("s2", "rev_s2b", "four seven")]));
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
  await logs(() => indexJobs(envOf(world), docs));
  for (const d of docs) W.setHead(world, d.artifactId, d.revisionId + "b");
  world.log.length = 0;
  const next = docs.map((d) => ({ ...d, revisionId: d.revisionId + "b", text: d.text + " extra" }));
  const { result } = await logs(() => indexJobs(envOf(world), next));
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
  await logs(() => indexJobs(envOf(world), [{ artifactId: "big_1", projectId: "proj_a", revisionId: "rev_big_1", text: "seed" }]));
  // Broken invariant (manual SQL): 20,001 stored tokens on a row at '' under a dead writer, counted exactly.
  const d = W.docRow(world, "big_1").doc_id;
  W.run(world, "DELETE FROM search_tokens WHERE doc_id = ?", d);
  W.run(world, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20001)
    INSERT INTO search_tokens (doc_id, token) SELECT ?, unhex(printf('%032x', i)) FROM n`, d);
  W.run(world, "UPDATE search_token_docs SET revision_id = '', writer = 'dead', term_count = 0 WHERE doc_id = ?", d);
  W.run(world, "UPDATE search_term_counters SET terms = terms + 20000");
  assertExact(world);
  W.setHead(world, "big_1", "rev_big_2");
  const { result, events } = await logs(() => indexJobs(envOf(world), [{ artifactId: "big_1", projectId: "proj_a", revisionId: "rev_big_2", text: "alpha" }]));
  assert.equal(result.completed, 0);
  assert.equal(result.skipped.oversize, 1);
  assert.deepEqual(events.filter((e) => e.event === "search_set_oversize"), [{ event: "search_set_oversize", artifactId: "big_1" }]);
  assert.equal(W.tokensOf(world, "big_1").length, 0);
  const row = W.docRow(world, "big_1");
  assert.equal(row.revision_id, "");
  assert.ok(W.missing(world).includes("big_1"));
  assertExact(world);
  // A later run indexes it from a fresh base.
  const again = (await logs(() => indexJobs(envOf(world), [{ artifactId: "big_1", projectId: "proj_a", revisionId: "rev_big_2", text: "alpha" }]))).result;
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
const job = (a, text, rev = `rev_${a}`) => ({ artifactId: a, projectId: "proj_a", revisionId: rev, text, textBytes: Buffer.byteLength(text) });
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
  await logs(() => indexJobs(env, [job("ph", textA)]));
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
  const { result } = await logs(() => indexJobs(env, [job("dl", text)]));
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

/** A source text of about 6 MiB in two-byte storage (more than the 4 MiB envelope if retained): distinct words, then padding. */
/** Two-byte padding: Ω (U+03A9) is not Latin-1, so V8 stores the string with two bytes per unit (asserted below). */
const PAD_UNITS = 3 * MiB;
const bigSource = (prefix) => words(5000, prefix).join(" ") + " " + "\u03a9".repeat(PAD_UNITS);
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
    await logs(() => indexJobs(env, [job("b1", text)]));
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
    await logs(() => indexJobs(env, [job("b2", words(25000, "bx").join(" "))]));
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
      // A 6 MiB source (above the 4 MiB bound) whose first 5,000 words are distinct: retaining it would fail the bound.
      const { run, done } = start(env, [job("b3", bigSource("bd"))]);
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
    const { run, done } = start(env, [job("b4", bigSource("be"))]);
    while (!unwrapping) await new Promise((r) => setTimeout(r, 5));
    sizes.keyProvider = await retainedWhileBlocked(run, base0);
    block.open(); await done;
  }
  for (const [k, n] of Object.entries(sizes)) assert.ok(n <= ENV, `${k}: ${n} bytes retained`);
  // The fixture's footprint: creating (and flattening) one source costs about 2 bytes per unit, so retaining a source
  // (≥ 6 MiB) would exceed the 4 MiB bound by a clear margin.
  const h0 = await heap();
  let probe = bigSource("fp");
  probe.charCodeAt(probe.length - 1);
  const footprint = (await heap()) - h0;
  assert.ok(footprint >= 2 * PAD_UNITS * 0.95, `fixture footprint ${footprint} bytes`);
  assert.ok(footprint > ENV * 1.4);
  probe = null;
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
  await logs(() => indexJobs(env, [job("wd", textA), job("wd2", "small text here")]));
  for (const a of ["wd", "wd2"]) W.setHead(world, a, `rev_${a}b`);
  const samples = [];
  // Captured synchronously at the top of the first write batch's hook. The first chunk has already left job.removes
  // (spliced into batch 1 when packed): batch 1 must send the smallest removes, and no holder array may still hold its
  // values. The chunk captured there is the next one: exactly what batch 2 sends, and unreachable once batch 2 is packed.
  const storedBefore = W.tokensOf(world, "wd");
  let firstSent = null, firstStillHeld = null;
  let run, firstChunk = null, firstValue = null, writeBatches = 0;
  world.before = async ({ kind, q, qs, ps, tokenValues }) => {
    const j = run.holder.jobs?.[0];
    if (kind === "batch" && qs.some((x) => /search_tokens/.test(x))) {
      writeBatches++;
      const rem = qs.findIndex((x) => /^DELETE FROM search_tokens WHERE doc_id/.test(x));
      const sent = rem >= 0 ? JSON.parse(ps[rem].find((v) => typeof v === "string" && v.startsWith("["))) : [];
      if (writeBatches === 1) {
        firstChunk = new WeakRef(j.removes[0]); firstValue = j.removes[0][0];
        firstSent = sent;
        firstStillHeld = j.removes.some((c) => c.includes(sent[0]));
      }
      const sentFirst = sent[0] === firstValue;
      await settleGc();
      samples.push({ payload: run.payload, removes: run.removeValues, chunks: j?.removes?.length ?? 0, firstGone: firstChunk.deref() === undefined,
        sendsFirst: sentFirst, tokens: !!j?.tokens, tokenValues, final: qs.some((x) => /SET revision_id = \?/.test(x)) });
    }
    if (kind === "all" && /ORDER BY d\.doc_id/.test(q) && samples.length) samples.push({ secondRead: true, remainder: j?.removes?.reduce((n, c) => n + c.length, 0) ?? 0 });
  };
  let done;
  ({ run, done } = start(env, [job("wd", words(20000, "wz").join(" "), "rev_wdb"), job("wd2", "other text now", "rev_wd2b")]));
  await done;
  world.before = null;
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
  assert.deepEqual(firstSent, storedBefore.slice(0, 5000), "batch 1 sends the FIRST chunk: the 5,000 smallest removes");
  assert.equal(firstStillHeld, false, "the first chunk's values left the holder when packed");
  assert.deepEqual(writes.slice(0, 3).map((x) => [x.sendsFirst, x.firstGone]), [[false, false], [true, true], [false, true]],
    "the next chunk is held at batch 1, is what batch 2 sends, and is unreachable (gc) once batch 2 is packed");
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
    await logs(() => indexJobs(env, [job("cf1", a1), job("cf2", a2)]));
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
  await logs(() => indexJobs(env, [job("ten", tenMiB("ta"))]));
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

// --- Review fixes: admission inputs and settlement on throw (commit A items 1, 2) ------------------------------------
/** The isolate is back to exactly zero, every figure finite, and a further admission succeeds and settles. */
function assertRecovered() {
  const s = adm.searchAdmissionState();
  for (const [k, v] of Object.entries(s)) assert.ok(Number.isFinite(v), `${k} = ${v}`);
  assertIdle();
  const r = adm.openSearchRun();
  assert.ok(r, "a further admission succeeds");
  r.settle();
  assertIdle();
}
const MALFORMED = [
  ["text not a string", { text: 12345, textBytes: 5 }],
  ["text without textBytes", { text: "alpha" }],
  ["textBytes NaN", { text: "alpha", textBytes: NaN }],
  ["textBytes negative", { text: "alpha", textBytes: -1 }],
  ["textBytes fractional", { text: "alpha", textBytes: 1.5 }],
  ["textBytes Infinity", { text: "alpha", textBytes: Infinity }],
  ["textBytes a string", { text: "alpha", textBytes: "5" }],
  ["textUnits NaN", { text: "alpha", textBytes: 5, textUnits: NaN }],
  // Flat jobs are the extractor's own results; the caller's size context must still agree with them.
  ["flat count above the cap", { flat: lib.extractSearchTermsFlat("a b c d", 4), textBytes: 7, textUnits: 7, cap: 2 }],
  ["flat bytes larger than charged", { flat: lib.extractSearchTermsFlat("x".repeat(100), 1), textBytes: 10, textUnits: 10 }],
  ["flat textUnits missing", { flat: lib.extractSearchTermsFlat("a", 1), textBytes: 1 }],
  // Anything not returned by extractSearchTermsFlat is refused, however consistent it looks.
  ["flat offsets inconsistent", { flat: { bytes: new Uint8Array(2), offsets: Uint32Array.from([0, 1, 9]), count: 2, truncated: false }, textBytes: 9, textUnits: 9 }],
  ["flat count not an integer", { flat: { bytes: new Uint8Array(1), offsets: Uint32Array.from([0, 1]), count: "1", truncated: false }, textBytes: 1, textUnits: 1 }],
];

test("review A1: each malformed descriptor is refused with search_job_invalid before any counter changes", () => {
  const world = world1([]);
  for (const [why, extra] of MALFORMED) {
    const { cap, ...rest } = extra;
    const env = aenv(world, cap ? { SEARCH_TERMS_MAX: String(cap) } : {});
    const r = adm.openSearchRun();
    const before = adm.searchAdmissionState();
    const payload = r.payload;
    assert.throws(() => adm.admitSearchJobs(env, r, [{ artifactId: "m", projectId: "proj_a", revisionId: "rev_m", ...rest }]),
      (e) => e.code === "search_job_invalid", why);
    assert.deepEqual(adm.searchAdmissionState(), before, why);
    assert.equal(r.payload, payload, why);
    assert.equal(r.holder.jobs.length, 0, why);
    r.settle();
    assertRecovered();
  }
});

test("review A1: reserve, release, lower and declaredCalls refuse non-finite or negative amounts and never store NaN", () => {
  for (const bad of [NaN, -1, Infinity, -Infinity, "4", undefined, 1.5]) {
    const r = adm.openSearchRun();
    const p = r.payload;
    assert.throws(() => r.reserve(bad), (e) => e.code === "search_amount_invalid", `reserve ${bad}`);
    assert.throws(() => r.release(bad), (e) => e.code === "search_amount_invalid", `release ${bad}`);
    assert.throws(() => r.lower({ charge: 10 }, bad), (e) => e.code === "search_amount_invalid", `lower ${bad}`);
    assert.equal(r.payload, p);
    r.settle();
    // undefined means the default (0 declared calls).
    if (bad !== undefined) assert.throws(() => adm.openSearchRun({ declaredCalls: bad }), (e) => e.code === "search_amount_invalid", `declaredCalls ${bad}`);
    assertRecovered();
  }
});

test("review A1: admitting a 10 MiB text never scans it, also when SEARCH_TERMS_MAX = 0", () => {
  const world = world1([]);
  // A string whose content is never read: any character access through the String prototype throws.
  const text = "q".repeat(10 * MiB);
  const watched = ["charCodeAt", "codePointAt", "at", "charAt", "matchAll", "match", "normalize", "slice", "substring", Symbol.iterator];
  for (const vars of [{}, { SEARCH_TERMS_MAX: "0" }]) {
    const saved = watched.map((k) => [k, String.prototype[k]]);
    let scanned = 0;
    for (const [k, f] of saved) String.prototype[k] = function (...a) { if (this.length === text.length) scanned++; return f.apply(this, a); };
    const r = adm.openSearchRun();
    try {
      adm.admitSearchJobs(aenv(world, vars), r, [{ artifactId: "big", projectId: "proj_a", revisionId: "rev_big", text, textBytes: 10 * MiB }]);
    } finally { for (const [k, f] of saved) String.prototype[k] = f; }
    assert.equal(scanned, 0, `no scan (${JSON.stringify(vars)})`);
    assert.equal(r.holder.jobs.length, 1);
    if (vars.SEARCH_TERMS_MAX === "0") assert.equal(r.holder.jobs[0].text, null, "off mode keeps no text");
    r.settle();
    assertRecovered();
  }
});

test("review A2: a run whose admission throws is settled (first descriptor, and after an admitted prefix)", async () => {
  const world = world1(["ok1", "ok2"]);
  const env = aenv(world);
  for (let i = 0; i < 5; i++) {
    const jobs = i % 2 ? [job("ok1", "alpha"), job("ok2", "beta"), { artifactId: "bad", projectId: "proj_a", revisionId: "rev_bad", text: 7, textBytes: 1 }]
      : [{ artifactId: "bad", projectId: "proj_a", revisionId: "rev_bad", text: "x" }];
    await assert.rejects(lib.indexSearchJobs(env, jobs), (e) => e.code === "search_job_invalid");
    assertRecovered();
  }
  assert.equal(world.calls, 0, "nothing ran");
});

test("review A2: startDeferredWork without a usable ctx.waitUntil settles the run; four in a row fill nothing", async () => {
  const world = world1(["dw"]);
  const env = aenv(world);
  for (const ctx of [undefined, {}, { waitUntil: () => { throw new Error("no waitUntil"); } }, { waitUntil: "nope" }]) {
    const req = adm.withDeferredWork(env);
    adm.deferSearchIndexing(req, [job("dw", "alpha")]);
    assert.equal(adm.searchAdmissionState().active, 1);
    const { events } = await logs(async () => { adm.startDeferredWork(req, ctx); await adm.drainSearchIndexing(); });
    assert.ok(events.some((e) => e.event === "search_index_skipped"), "the dropped job is counted");
    assertRecovered();
  }
  assert.equal(adm.searchAdmissionState().detached, 0);
  assert.equal(W.docRow(world, "dw"), undefined);
});

test("review A3: a re-plan with fewer than 3 calls left leaves a complete row complete (skipped as budget)", async () => {
  const world = world1(["rb"]);
  const env = aenv(world);
  await logs(() => indexJobs(env, [job("rb", "alpha beta")]));
  W.setHead(world, "rb", "rev_rb2");
  // Another writer completes the same head between this run's planning and its stable read (gen moves).
  let moved = false;
  world.before = ({ kind, q }) => {
    if (!moved && kind === "all" && /ORDER BY d\.doc_id/.test(q)) {
      moved = true;
      W.run(world, "UPDATE search_token_docs SET revision_id = 'rev_rb2', gen = gen + 2, token_digest = 'other' WHERE artifact_id = 'rb'");
    }
  };
  // Budget: setup 2 + plan 1 + stable read 1 = 4 used; with a budget of 6 only 2 calls are left for the re-plan.
  const { result } = await logs(() => indexJobs(env, [job("rb", "alpha gamma", "rev_rb2")], { declaredCalls: 1000 - 20 - 6 }));
  world.before = null;
  assert.deepEqual(result.skipped, { budget: 1 }, JSON.stringify(result));
  const row = W.docRow(world, "rb");
  assert.deepEqual([row.revision_id, row.token_digest, row.writer], ["rev_rb2", "other", ""], "left as it was");
  assertExact(world);
  assertIdle();
});

test("review A3: a job whose row is already correct counts as unchanged", async () => {
  const world = world1(["uc"]);
  const env = aenv(world);
  await logs(() => indexJobs(env, [job("uc", "alpha beta")]));
  const { result } = await logs(() => indexJobs(env, [job("uc", "alpha beta")]));
  assert.equal(result.unchanged, 1);
  assert.equal(result.completed, 0);
  assert.deepEqual(result.skipped, {});
});

// --- Review fixes: smaller items (commit A item 4) --------------------------------------------------------------------
test("review A4: jobs are de-duplicated by artifact, keeping the last", async () => {
  const world = world1(["dd"]);
  const env = aenv(world);
  const r = adm.openSearchRun();
  adm.admitSearchJobs(env, r, [job("dd", "very old"), job("dd", "old words")]);
  // A later call (another deferSearchIndexing in the same request) replaces it too.
  adm.admitSearchJobs(env, r, [job("dd", "new words here", "rev_dd")]);
  assert.equal(r.holder.jobs.length, 1);
  assert.equal(r.textUnits, "new words here".length);
  assert.equal(r.payload, BASE + r.holder.jobs[0].charge, "the replaced job's charge is released");
  const { done } = { done: logs(() => adm.runSearchIndexing(env, r)) };
  await done;
  assert.deepEqual(W.tokensOf(world, "dd"), expectedTokens(secretOf(world, "wsp_a"), ["new", "words", "here"]));
  assertIdle();
});

test("review A4: a new or empty document whose diff charge is refused is skipped (charge), not crashed", async () => {
  const world = world1(["nd", "ne"]);
  const env = aenv(world);
  const run = adm.openSearchRun();
  adm.admitSearchJobs(env, run, [job("nd", "alpha"), job("ne", "")]);
  // Every later reservation on this run is refused (the diff's charge is the only one taken after admission).
  run.reserve = (bytes) => { if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("bad"); return false; };
  const { events } = await logs(() => adm.runSearchIndexing(env, run));
  assert.ok(!events.some((e) => e.event === "search_index_failed"), JSON.stringify(events));
  assert.deepEqual(events.find((e) => e.event === "search_index_skipped").reasons, { charge: 2 });
  assert.equal(W.docRow(world, "nd"), undefined);
  assert.equal(W.docRow(world, "ne"), undefined);
  assertIdle();
});

test("review A4: search_index_failed names the artifact when one job is known", async () => {
  const world = world1(["fx"]);
  const env = aenv(world);
  // The workspace key read fails for this job (a shredded workspace under encryption).
  const envEnc = aenv(world, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
  W.run(world, "INSERT INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at, shredded_at) VALUES ('wsp_a', 'wk_gone', 0, '', 1, 1)");
  const { events } = await logs(() => indexJobs(envEnc, [job("fx", "alpha")]));
  const failed = events.filter((e) => e.event === "search_index_failed");
  assert.equal(failed.length, 1, JSON.stringify(events));
  assert.deepEqual(failed[0], { event: "search_index_failed", run: failed[0].run, artifactId: "fx", code: "key_shredded" });
  void env;
});

test("review A4: a SEARCH_* var with a value that is not accepted is logged once per isolate by name, and falls back", async () => {
  const fresh = await loadWorker({ "search/tokens.js": ["searchTermsMax", "searchScopeBounds", "searchSweepWritesMax"] });
  const { events, result } = await logs(() => {
    const env = { SEARCH_TERMS_MAX: "lots", SEARCH_WORKSPACE_TERMS_MAX: "-5", SEARCH_OWNER_TERMS_MAX: "1e6", SEARCH_INSTALLATION_TERMS_MAX: " 9", SEARCH_SWEEP_WRITES_MAX: "x" };
    const out = [];
    for (let i = 0; i < 3; i++) out.push([fresh.searchTermsMax(env), fresh.searchScopeBounds(env), fresh.searchSweepWritesMax(env)]);
    return out;
  });
  assert.deepEqual(result[0], [20000, { workspace: 1000000, owner: 3000000, installation: 50000000 }, 10000]);
  const logged = events.filter((e) => e.event === "search_var_invalid");
  assert.deepEqual(logged.map((e) => e.name).sort(), ["SEARCH_INSTALLATION_TERMS_MAX", "SEARCH_OWNER_TERMS_MAX", "SEARCH_SWEEP_WRITES_MAX", "SEARCH_TERMS_MAX", "SEARCH_WORKSPACE_TERMS_MAX"]);
  for (const e of logged) assert.deepEqual(Object.keys(e).sort(), ["event", "name"]);
  // Unset and accepted values log nothing.
  const quietRun = await logs(() => fresh.searchTermsMax({ SEARCH_TERMS_MAX: "200" }) + fresh.searchSweepWritesMax({}));
  assert.equal(quietRun.events.length, 0);
});

test("review A6 (test 28): a stable group builds every member's diff before packing; charged removes stay within 30,000", async () => {
  const world = world1(["sg1", "sg2", "sg3", "sg4"]);
  const env = aenv(world);
  // Four stored sets of 5,000 tokens: one group of 20,000 stored tokens (the group bound).
  const base = (i) => words(5000, `s${i}a`).join(" ");
  await logs(() => indexJobs(env, [1, 2, 3, 4].map((i) => job(`sg${i}`, base(i)))));
  for (let i = 1; i <= 4; i++) W.setHead(world, `sg${i}`, `rev_sg${i}b`);
  let run, done, maxCharged = 0, atFirstWrite = null, groupReads = 0;
  world.before = ({ kind, q, qs }) => {
    maxCharged = Math.max(maxCharged, run.removeValues);
    if (kind === "all" && /ORDER BY d\.doc_id/.test(q)) groupReads++;
    if (kind === "batch" && !atFirstWrite && qs.some((x) => /search_tokens/.test(x)))
      atFirstWrite = { charged: run.removeValues, built: run.holder.jobs.filter((j) => j.removes).length };
  };
  // Each member's whole set is replaced: 5,000 removes each, 20,000 in the group.
  ({ run, done } = start(env, [1, 2, 3, 4].map((i) => job(`sg${i}`, words(5000, `s${i}b`).join(" "), `rev_sg${i}b`))));
  await done;
  world.before = null;
  assert.equal(groupReads, 1, "one group of four");
  assert.deepEqual(atFirstWrite, { charged: 20000, built: 4 }, "every member's diff was built and charged before the first batch");
  assert.ok(maxCharged <= 30000, `${maxCharged} charged removes`);
  assert.ok(run.maxRemoveValues <= 30000);
  for (let i = 1; i <= 4; i++) assert.equal(W.docRow(world, `sg${i}`).revision_id, `rev_sg${i}b`);
  assertExact(world);
  assertIdle();
});

// --- Review fixes, round 2 -------------------------------------------------------------------------------------------
/** The round-2 exports, loaded on first use (so the older tests still load against code that lacks them). */
let r2lib = null;
const r2 = async () => (r2lib ??= await loadWorker({ "search/tokens.js": ["extractSearchTermsWith", "U61_TOKEN_WELLFORMED", "u61FoldTokenBounded", "extractSearchTerms", "extractSearchTermsFlat", "searchFlatTerms"] }));
test("review R2-1: lone surrogates split words lazily: 300,000 short words with cap 10 give 10 terms after bounded work", async () => {
  const lib = await r2();
  const parts = [];
  for (let i = 0; i < 300000; i++) parts.push("s" + i.toString(36));
  const text = parts.join("\uD800");
  // Count the pieces the scanner consumes by counting folds (one per candidate piece).
  let folds = 0;
  const fold = lib.u61FoldTokenBounded;
  const counting = (w, max) => { folds++; return fold(w, max); };   // short words: one piece, so one fold per word
  const r = lib.extractSearchTermsWith(text, 10, counting);
  assert.equal(r.terms.length, 10);
  assert.equal(r.truncated, true);
  assert.ok(folds <= 11, `${folds} pieces consumed`);
  assert.deepEqual(r.terms, parts.slice(0, 10));
  // Packed and flat give the same terms on the malformed fixtures.
  for (const t of [text, "ab\uD800cd", "x\uDC00y z", "\uD800", "a\uD800" + "b".repeat(300) + " c\uDBFF\uDFFFd"]) {
    const plain = lib.extractSearchTerms(t, 50), flat = lib.extractSearchTermsFlat(t, 50);
    assert.deepEqual(lib.searchFlatTerms(flat), plain.terms, JSON.stringify(t.slice(0, 20)));
  }
});

test("review R2-1: one 5 Mi-unit match with a lone surrogate in the middle yields no term and copies nothing", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { loadWorker } from "./test/load-worker.mjs";
    const lib = await loadWorker({ "search/tokens.js": ["extractSearchTerms", "extractSearchTermsFlat"] });
    const half = 5 * 1048576 / 2;
    global.gc(); const empty = process.memoryUsage().heapUsed;
    let text = "\\u03a9".repeat(half - 1) + "\\uD800" + "\\u03a9".repeat(half);
    if (text.length !== 5 * 1048576) throw new Error("fixture");
    text.charCodeAt(0);
    const size = text.length * 2;
    global.gc(); const base = process.memoryUsage().heapUsed;
    // Peak: heap right after each extraction, before any gc (a copy of the match would still be there).
    let peak = base;
    const t0 = lib.extractSearchTerms(text, 20000);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    const t1 = lib.extractSearchTermsFlat(text, 20000);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    // Retained: once the caller drops the text, nothing of it may stay reachable.
    text = null;
    global.gc(); const after = process.memoryUsage().heapUsed;
    console.log("SURR " + JSON.stringify({ terms: t0.terms.length, flat: t1.count, retained: after - empty, peak: peak - base, size, held: base - empty }));
  `], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  const r = JSON.parse(child.stdout.split("SURR ")[1]);
  assert.deepEqual([r.terms, r.flat], [0, 0], "both pieces are over 200 units: no term");
  // `retained`: heap after extraction and dropping the text, relative to before the text existed. A copy kept by the
  // scanner (or the text itself through the RegExp statics) would be about `size`. `held` checks the fixture's own size.
  assert.ok(r.held >= r.size * 0.95, `fixture held ${r.held} bytes`);
  assert.ok(r.retained < r.size / 10, `retained ${r.retained} of a ${r.size}-byte match`);
  assert.ok(r.peak < r.size / 2, `peak ${r.peak} of a ${r.size}-byte match (no copy)`);
});

test("review R2-1: the token pattern never matches across a lone surrogate and needs no isWellFormed/toWellFormed", async () => {
  const src = readFileSync(join(ROOT, "packages/core/src/search/tokens.js"), "utf8");
  assert.doesNotMatch(src, /\b(isWellFormed|toWellFormed)\b/);
  const lib = await r2();
  for (const t of ["ab\uD800cd", "x\uDC00y z", "\uD800", "a😀b \uD83D\uDE00c", "é\u0301x", "日本\uDFFF語"])
    for (const m of t.matchAll(lib.U61_TOKEN_WELLFORMED)) assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(m[0]), JSON.stringify(m[0]));
});

// --- Flat terms are held privately: the caller gets an opaque frozen handle ----------------------------------------
test("review R5-2: extractSearchTermsFlat returns a frozen handle of exactly { count, truncated, byteLength }, reaching no storage", () => {
  const text = "Zürich straße 日本語 alpha beta 😀 " + words(300).join(" ");
  const h = lib.extractSearchTermsFlat(text, 100);
  assert.ok(Object.isFrozen(h), "the handle is frozen");
  assert.deepEqual(Object.keys(h).sort(), ["byteLength", "count", "truncated"]);
  assert.deepEqual(Reflect.ownKeys(h).sort(), ["byteLength", "count", "truncated"], "no symbol keys either");
  assert.equal(Object.getPrototypeOf(h), Object.prototype);
  assert.deepEqual([typeof h.count, typeof h.truncated, typeof h.byteLength], ["number", "boolean", "number"]);
  for (const k of Reflect.ownKeys(h)) {
    const d = Object.getOwnPropertyDescriptor(h, k);
    assert.ok("value" in d && !d.writable && !d.configurable, `${String(k)} is a fixed data property`);
    assert.ok(!ArrayBuffer.isView(d.value) && !(d.value instanceof ArrayBuffer), `${String(k)} reaches no array or buffer`);
  }
  const terms = lib.searchFlatTerms(h);
  assert.equal(terms.length, h.count);
  assert.deepEqual(terms, lib.extractSearchTerms(text, 100).terms);
  assert.equal(h.byteLength, terms.reduce((n, t) => n + Buffer.byteLength(t), 0));
  terms[0] = "changed";
  assert.notEqual(lib.searchFlatTerms(h)[0], "changed", "searchFlatTerms returns copies");
  const empty = lib.extractSearchTermsFlat("", 10);
  assert.deepEqual([Object.isFrozen(empty), empty.count, empty.byteLength, lib.searchFlatTerms(empty)], [true, 0, 0, []]);
});

test("review R5-2: only a live handle from extractSearchTermsFlat is accepted: forged, copied and spent handles are refused", async () => {
  const world = world1(["fh"]);
  const env = aenv(world);
  const real = lib.extractSearchTermsFlat("alpha beta", 10);
  const descriptor = (flat) => ({ artifactId: "fh", projectId: "proj_a", revisionId: "rev_fh", flat, textBytes: 10, textUnits: 10 });
  const refused = (why, flat) => {
    const r = adm.openSearchRun();
    const before = adm.searchAdmissionState();
    assert.throws(() => adm.admitSearchJobs(env, r, [descriptor(flat)]),
      (e) => e.code === "search_job_invalid" && /flat container/.test(e.message), why);
    assert.deepEqual(adm.searchAdmissionState(), before, why);
    assert.equal(r.holder.jobs.length, 0, why);
    r.settle();
    assertRecovered();
  };
  const legacy = { bytes: new TextEncoder().encode("alphabeta"), offsets: Uint32Array.from([0, 5, 9]), count: 2, truncated: false };
  for (const [why, flat] of [["forged handle", { count: 2, truncated: false, byteLength: 9 }], ["spread copy", { ...real }],
    ["frozen copy", Object.freeze({ ...real })], ["arrays (the old form)", legacy], ["object inheriting from a handle", Object.create(real)]]) refused(why, flat);
  assert.throws(() => lib.searchFlatTerms({ ...real }), (e) => e.code === "search_job_invalid");
  // A real handle indexes exactly, and is spent: once its job is done, the storage is gone and it is refused.
  const held = lib.searchFlatHeld();
  const { result } = await logs(() => indexJobs(env, [descriptor(real)]));
  assert.equal(result.completed, 1);
  assert.deepEqual(W.tokensOf(world, "fh"), expectedTokens(secretOf(world, "wsp_a"), ["alpha", "beta"]));
  assertExact(world);
  assert.equal(lib.searchFlatHeld(), held - 1, "the private storage is dropped when the job finishes");
  assert.throws(() => lib.searchFlatTerms(real), (e) => e.code === "search_job_invalid");
  refused("second use after the job settled", real);
  assertIdle();
});

test("review R5-2: a real handle is admitted and indexes exactly; the descriptor's sidecar is not kept; a refused run drops the storage", async () => {
  const world = world1(["fo"]);
  const env = aenv(world);
  const flat = lib.extractSearchTermsFlat("alpha beta alpha", 10);
  const held = lib.searchFlatHeld();
  const sidecarRef = new WeakRef(new Uint8Array(8 * MiB));
  const block = gate();
  world.before = () => block.wait;
  // The descriptor is reachable only from the call: the sidecar stays on it (never deleted), so if the job kept the
  // descriptor (or read anything else from it) the sidecar would survive the gc below.
  const { run, done } = start(env, [{ artifactId: "fo", projectId: "proj_a", revisionId: "rev_fo", flat, textBytes: 16, textUnits: 16, sidecar: sidecarRef.deref() }]);
  const j = run.holder.jobs[0];
  assert.equal(j.flat, flat, "the job keeps the handle");
  await settleGc();
  assert.equal(sidecarRef.deref(), undefined, "the descriptor's sidecar is not reachable from the admitted job");
  block.open();
  await done;
  world.before = null;
  assert.deepEqual(W.tokensOf(world, "fo"), expectedTokens(secretOf(world, "wsp_a"), ["alpha", "beta"]));
  assertExact(world);
  assertIdle();
  assert.equal(lib.searchFlatHeld(), held - 1);
  // A run that is dropped before it starts (clearHolder) drops its handles' storage too.
  const h2 = lib.extractSearchTermsFlat("gamma", 10);
  const r = adm.openSearchRun();
  adm.admitSearchJobs(env, r, [{ artifactId: "fo", projectId: "proj_a", revisionId: "rev_fo2", flat: h2, textBytes: 5, textUnits: 5 }]);
  assert.equal(lib.searchFlatHeld(), held);
  r.settle();
  assert.equal(lib.searchFlatHeld(), held - 1, "settling an unstarted run drops the storage");
  assert.throws(() => lib.searchFlatTerms(h2), (e) => e.code === "search_job_invalid");
  assertIdle();
});

test("review R5-2: searchTermInputs checks every interval before allocating (both packed forms)", () => {
  const bad = (why, p, from, to) => assert.throws(() => lib.searchTermInputs(p, from, to), (e) => e.status === 500 && e.code === "search_terms_invalid", why);
  const bytes = new Uint8Array(4096), units = new Uint16Array(1024);
  bad("offsets alternating 0 and the length (flat)", { bytes, offsets: Uint32Array.from([0, 4096, 0, 4096]), count: 3 }, 0, 3);
  bad("a flat term over 600 bytes", { bytes, offsets: Uint32Array.from([0, 601]), count: 1 }, 0, 1);
  bad("past the end (flat)", { bytes, offsets: Uint32Array.from([4000, 4100]), count: 1 }, 0, 1);
  bad("backwards (flat)", { bytes, offsets: Uint32Array.from([10, 5]), count: 1 }, 0, 1);
  bad("a units term over 200 units", { units, offsets: Uint32Array.from([0, 201]), count: 1 }, 0, 1);
  bad("past the end (units)", { units, offsets: Uint32Array.from([1000, 1030]), count: 1 }, 0, 1);
  bad("missing offset", { bytes, offsets: Uint32Array.from([0]), count: 1 }, 0, 1);
  bad("non-integer offset (plain array)", { bytes, offsets: [0, 1.5], count: 1 }, 0, 1);
  // Valid: exactly 600 bytes and exactly 200 units are allowed.
  assert.equal(lib.searchTermInputs({ bytes, offsets: Uint32Array.from([0, 600, 600]), count: 2 }, 0, 2).length, 2);
  assert.deepEqual(lib.searchTermInputs({ units: Uint16Array.from("ab", (c) => c.charCodeAt(0)), offsets: Uint32Array.from([0, 2]), count: 1 }, 0, 1).map((b) => [...b]), [[97, 98]]);
});

test("review R2-3: when ctx.waitUntil throws, the run settles at once and one skip line is logged", async () => {
  const world = world1(["wt"]);
  const env = aenv(world);
  const req = adm.withDeferredWork(env);
  adm.deferSearchIndexing(req, [job("wt", "alpha")]);
  const { events } = await logs(async () => {
    adm.startDeferredWork(req, { waitUntil: () => { throw new Error("refused"); } });
    // No timer is advanced: the isolate is idle immediately.
    const s = adm.searchAdmissionState();
    assert.deepEqual([s.active, s.activeBytes], [0, 0], "settled synchronously");
    await adm.drainSearchIndexing();
  });
  const skips = events.filter((e) => e.event === "search_index_skipped");
  assert.equal(skips.length, 1, JSON.stringify(events));
  assert.deepEqual(skips[0].reasons, { unstarted: 1 });
  assert.equal(world.calls, 0);
  assertIdle();
});

test("review R2-4: admitting into a run that has started, stopped, settled or detached is refused", async () => {
  const world = world1(["rs"]);
  const env = aenv(world);
  // Started: the writer owns holder.jobs.
  const block = gate();
  world.before = () => block.wait;
  const { run: started, done } = start(env, [job("rs", "alpha")]);
  assert.throws(() => adm.admitSearchJobs(env, started, [job("rs", "beta")]), (e) => e.code === "search_run_invalid");
  block.open(); await done; world.before = null;
  // Settled.
  assert.throws(() => adm.admitSearchJobs(env, started, [job("rs", "beta")]), (e) => e.code === "search_run_invalid");
  // Detached.
  const d = adm.openSearchRun(); d.detach();
  assert.throws(() => adm.admitSearchJobs(env, d, [job("rs", "beta")]), (e) => e.code === "search_run_invalid");
  d.settle();
  assertRecovered();
});

test("review R2-4: a replaced job whose replacement is refused is counted as replaced", () => {
  const world = world1([]);
  const env = aenv(world);
  const r = adm.openSearchRun();
  adm.admitSearchJobs(env, r, [job("rp", "small")]);
  // The replacement does not fit the run (11 Mi units > the 10 Mi text budget).
  adm.admitSearchJobs(env, r, [job("rp", "x".repeat(11 * MiB))]);
  assert.equal(r.holder.jobs.length, 0);
  assert.deepEqual(r.skipped, { replaced: 1, admission: 1 });
  r.settle();
  assertRecovered();
});

test("review R2-5: a re-plan whose T1u and T1r change nothing: unchanged when another writer completed the same target, lost otherwise", async () => {
  for (const same of [true, false]) {
    const world = world1(["ru"]);
    const env = aenv(world);
    await logs(() => indexJobs(env, [job("ru", "alpha beta")]));
    W.setHead(world, "ru", "rev_ru2");
    const digestOf = async (terms) => { const k = await lib.searchTokenKey(env, "wsp_a"); return lib.searchTokenDigest(await lib.searchTokensFor(k.key, terms), ""); };
    const target = await digestOf(["alpha", "gamma"]);
    // Between planning and the stable read, another writer completes the same head and target (gen moves): the stable
    // read misses, T1u (row complete) and T1r (row already correct) both change nothing, and rowIsCurrent finds it
    // current. In the other case the row is then rebound to another owner (gone from this job's scope): both change
    // nothing and the row is not this job's target, so the job is lost.
    let moved = false;
    world.before = ({ kind, q }) => {
      if (!moved && kind === "all" && /ORDER BY d\.doc_id/.test(q)) {
        moved = true;
        W.run(world, "UPDATE search_token_docs SET revision_id = 'rev_ru2', gen = gen + 2, token_digest = ? WHERE artifact_id = 'ru'", same ? target : "someone-else");
        if (!same) W.run(world, "UPDATE search_token_docs SET owner_id = 'hum_other' WHERE artifact_id = 'ru'");
      }
    };
    const before = W.docRow(world, "ru");
    const { result } = await logs(() => indexJobs(env, [job("ru", "alpha gamma", "rev_ru2")]));
    world.before = null;
    const row = W.docRow(world, "ru");
    if (same) {
      assert.equal(result.unchanged, 1, JSON.stringify(result));
      assert.deepEqual([row.revision_id, row.token_digest, row.writer], ["rev_ru2", target, ""], "row untouched");
    } else {
      assert.deepEqual([result.unchanged, result.completed, result.skipped], [0, 0, { lost: 1 }], JSON.stringify(result));
      assert.deepEqual([row.revision_id, row.token_digest, row.writer], ["rev_ru2", "someone-else", ""], "row untouched");
    }
    void before;
    assertIdle();
  }
});

// --- Words scanned in bounded pieces (no unbounded regular-expression match) -------------------------------------------
let piecesLib = null;
const pieces = async () => (piecesLib ??= await loadWorker({ "search/tokens.js": ["U61_TOKEN_WELLFORMED", "extractSearchTerms", "extractSearchTermsWith", "scanSearchWords", "SEARCH_SCAN_PIECE_UNITS"] }));
/** Word boundaries [start, end) by the unbounded pattern (fixtures small enough for it). */
const unboundedWords = (lib, text) => Array.from(text.matchAll(lib.U61_TOKEN_WELLFORMED), (m) => [m.index, m.index + m[0].length]);

test("pieces: one unbroken 10 Mi-unit word (Ω, 日, astral pairs) scans without a throw and yields no term, packed and flat", async () => {
  const lib = await r2();
  for (const [label, text] of [["omega", "\u03a9".repeat(10 * MiB)], ["cjk", "\u65e5".repeat(10 * MiB)], ["astral", "\u{20000}".repeat(5 * MiB)]]) {
    assert.equal(text.length, 10 * MiB, label);
    const plain = lib.extractSearchTerms(text, 20000);
    assert.deepEqual([plain.terms.length, plain.truncated], [0, false], label);
    const flat = lib.extractSearchTermsFlat(text, 20000);
    assert.deepEqual([flat.count, flat.truncated], [0, false], label);
  }
});

test("pieces: memory of scanning one unbroken 2 Mi-unit word stays within a small fixed amount (child, --expose-gc)", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { loadWorker } from "./test/load-worker.mjs";
    const lib = await loadWorker({ "search/tokens.js": ["extractSearchTermsWith", "u61FoldTokenBounded"] });
    const text = "\\u03a9".repeat(2 * 1048576); text.charCodeAt(0);
    global.gc(); const rss0 = process.memoryUsage().rss, heap0 = process.memoryUsage().heapUsed;
    let peakRss = rss0, peakHeap = heap0;
    const sample = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
    const fold = (w, max) => { sample(); return lib.u61FoldTokenBounded(w, max); };
    const r = lib.extractSearchTermsWith(text, 20000, fold);
    sample();
    console.log("LONGWORD " + JSON.stringify({ terms: r.terms.length, rss: peakRss - rss0, heap: peakHeap - heap0, maxRSS: process.resourceUsage().maxRSS * 1024 - rss0 }));
  `], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  const r = JSON.parse(child.stdout.split("LONGWORD ")[1]);
  console.log("LONGWORD_MEMORY " + JSON.stringify(r));
  assert.equal(r.terms, 0);
  // RSS depends on the allocator (pages kept, reused or returned), so its bound is loose: 32 MiB still catches the
  // failure this guards against (one unbounded match cost +92 MiB of regex stack for this word) without flaking.
  assert.ok(r.rss < 32 * MiB, `peak RSS while scanning grew by ${r.rss} bytes`);
  assert.ok(r.heap < 8 * MiB, `peak heap while scanning grew by ${r.heap} bytes`);
});

test("pieces: folding piece by piece equals folding the whole word; dead words stay dead", async () => {
  const lib = await r2();
  // 100 letters then 3 Mi dropped marks: the marks fold to nothing, the term is the 100 letters.
  const letters = "Ab".repeat(50);
  assert.deepEqual(lib.extractSearchTerms(letters + "\u0301".repeat(3 * MiB), 10).terms, [letters.toLowerCase()]);
  assert.deepEqual(lib.extractSearchTerms("a".repeat(201) + " ok", 10).terms, ["ok"]);
  assert.deepEqual(lib.extractSearchTerms("a".repeat(200) + " ok", 10).terms, ["a".repeat(200), "ok"]);
  // Folding that shrinks across a piece boundary (marks dropped) and folding to 200 exactly at a boundary.
  const mixed = ("e\u0301").repeat(150);            // 300 units folding to 150
  assert.deepEqual(lib.extractSearchTerms(mixed, 10).terms, ["e".repeat(150)]);
  assert.deepEqual(lib.extractSearchTerms("\u00c9".repeat(4096) + " x", 10).terms, ["x"], "folds past 200: no term");
});

test("pieces: word boundaries equal the unbounded pattern at and around the piece size, including astral pairs at the cut", async () => {
  const lib = await pieces();
  const P = lib.SEARCH_SCAN_PIECE_UNITS;
  assert.ok(Number.isInteger(P) && P > 0 && P <= 4096, `piece ${P}`);
  const fixtures = [];
  for (const n of [P - 1, P, P + 1, 2 * P - 1, 2 * P, 2 * P + 1, 4095, 4096, 4097]) {
    fixtures.push("a".repeat(n), "\u03a9".repeat(n) + " z", "x " + "\u65e5".repeat(n));
    // An astral pair straddling where a naive cut at P units would fall.
    fixtures.push("b".repeat(n - 1) + "\u{1d400}" + "c".repeat(3), "q" + "\u{1d400}".repeat(n) + ". r");
  }
  // A word ending exactly at a piece boundary, then a separator, then a word.
  fixtures.push("w".repeat(P) + " next", "w".repeat(2 * P) + "\u0301" + " next", "\u0301".repeat(P + 3) + "lead");
  for (const t of fixtures) {
    const got = [];
    lib.scanSearchWords(t, (s, e) => { got.push([s, e]); return true; });
    assert.deepEqual(got, unboundedWords(lib, t), `fixture of length ${t.length}`);
  }
});

test("pieces: seeded random strings have the same word boundaries piecewise as with the unbounded pattern", async () => {
  const lib = await pieces();
  let seed = 4242;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
  const alphabet = [" ", ".", "\n", "\u3002", "\u0301", "\u0323", "\u0331", "\u0332", "a", "Z", "\u00e9", "\u03a9", "\u65e5", "\u05e9\u05b8", "7",
    "\u{1d400}", "\u{1f600}", "\u{20000}", "\uD800", "\uDC00", "\uDBFF"];
  for (let i = 0; i < 4000; i++) {
    let t = "";
    for (let k = 0, n = 1 + rnd(40); k < n; k++) t += alphabet[rnd(alphabet.length)];
    const got = [];
    lib.scanSearchWords(t, (s, e) => { got.push([s, e]); return true; });
    assert.deepEqual(got, unboundedWords(lib, t), JSON.stringify(t));
  }
  // Long words that reach the piece cuts. wordChars keeps only alphabet entries that are, as a whole, one token (the
  // unbounded pattern anchored at both ends): U+0332 and U+05B8 are separators in the tables, so "\u0332" and
  // "\u05e9\u05b8" are not word characters; they stay among the breakers. Each iteration places at most one breaker
  // (a separator, a lone surrogate or a dropped mark) within 3 code points of the cut at P or at 2P, and sizes the word
  // so that some compared span always holds at least P code points (and, without a breaker or with one at 2P, at
  // least 2P − 3), so continuation pieces and the cuts themselves are compared at random.
  const P = lib.SEARCH_SCAN_PIECE_UNITS;
  const whole = new RegExp(`^(?:${lib.U61_TOKEN_WELLFORMED.source})$`, lib.U61_TOKEN_WELLFORMED.flags.replace("g", ""));
  const wordChars = alphabet.filter((c) => whole.test(c));
  assert.ok(!wordChars.includes("\u0332") && !wordChars.includes("\u05e9\u05b8") && wordChars.includes("\u03a9"), JSON.stringify(wordChars));
  const breakers = [" ", "\u3002", "\uD800", "\uDC00", "\u0301", "\u0332", "\u05e9\u05b8"];
  const points = (x) => [...x].length;
  let reached2P = 0;
  for (let i = 0; i < 300; i++) {
    const cut = [0, P, 2 * P][rnd(3)];   // 0: no breaker
    const n = cut === P ? 2 * P + 4 + rnd(4) : cut === 2 * P ? 2 * P + rnd(4) : P + rnd(P + 4);
    const cps = [];
    for (let k = 0; k < n; k++) cps.push(wordChars[rnd(wordChars.length)]);
    if (cut) cps[Math.min(n - 1, cut - 3 + rnd(7))] = breakers[rnd(breakers.length)];
    const t = (rnd(2) ? "" : breakers[rnd(breakers.length)]) + cps.join("") + (rnd(2) ? "" : " tail");
    const got = [];
    lib.scanSearchWords(t, (s, e) => { got.push([s, e]); return true; });
    assert.deepEqual(got, unboundedWords(lib, t), `long word ${i} (${t.length} units)`);
    const longest = Math.max(...got.map(([s, e]) => points(t.slice(s, e))));
    assert.ok(longest >= P, `long word ${i}: the longest span holds ${longest} code points, short of the cut at ${P}`);
    if (longest >= 2 * P) reached2P++;
  }
  assert.ok(reached2P >= 30, `${reached2P} long words reached the second cut (2P)`);
});

test("pieces: a callback that throws mid-scan leaves no state behind: the next scan is correct", async () => {
  const lib = await pieces();
  const long = "\u03a9".repeat(3 * lib.SEARCH_SCAN_PIECE_UNITS + 5);
  assert.throws(() => lib.scanSearchWords(`one ${long} two three`, (s) => { if (s > 0) throw new Error("stop"); return true; }), /stop/);
  assert.throws(() => lib.extractSearchTermsWith("alpha beta gamma", 10, (w) => { if (w === "beta") throw new Error("fold"); return w; }), /fold/);
  const got = [];
  lib.scanSearchWords("x yy zzz", (s, e) => { got.push([s, e]); return true; });
  assert.deepEqual(got, [[0, 1], [2, 4], [5, 8]]);
  assert.deepEqual(lib.extractSearchTerms("beta Beta gamma", 10).terms, ["beta", "gamma"], "the seen set starts empty");
});

test("pieces: a scan inside another scan (re-entrant, shared patterns) gives independent, correct results", async () => {
  const lib = await pieces();
  const outer = "alpha beta gamma delta", inner = "one two three";
  const outerWords = [], innerRuns = [];
  lib.scanSearchWords(outer, (s, e) => {
    outerWords.push(outer.slice(s, e));
    const w = [];
    lib.scanSearchWords(inner, (s2, e2) => { w.push(inner.slice(s2, e2)); return true; });
    innerRuns.push(w.join(","));
    return true;
  });
  assert.deepEqual(outerWords, ["alpha", "beta", "gamma", "delta"]);
  assert.deepEqual(innerRuns, Array(4).fill("one,two,three"));
  // Back to back, after a scan that stopped early (cap), the next scan starts at the beginning of its own text.
  assert.deepEqual(lib.extractSearchTerms("x1 x2 x3 x4", 2).terms, ["x1", "x2"]);
  assert.deepEqual(lib.extractSearchTerms("y1 y2", 5).terms, ["y1", "y2"]);
});

test("pieces: timing (reported): 1 MiB prose and a capped 10 MiB document", async () => {
  const lib = await r2();
  const vocab = ["alpha", "Beta", "café", "naïve", "Zürich", "straße", "日本", "テスト", "мой", "λόγος", "x1", "2026"];
  let prose = "", s = 7;
  while (prose.length < MiB) { s = (s * 1103515245 + 12345) & 0x7fffffff; prose += vocab[(s >>> 8) % vocab.length] + " " + ((s >>> 3) % 9973).toString(36) + " "; }
  const big = words(1300000, "t").join(" ").slice(0, 10 * MiB);
  const time = (fn) => { const t = performance.now(); fn(); return Math.round(performance.now() - t); };
  const out = { prose_1mib_ms: time(() => lib.extractSearchTerms(prose, 1e9)), capped_10mib_ms: time(() => lib.extractSearchTermsFlat(big, 20000)) };
  console.log("PIECES_TIMING " + JSON.stringify(out));
});

// --- A flat handle is used once; every way a job lets go of it drops its storage ------------------------------------
const flatJob = (a, text, rev = `rev_${a}`) => ({ artifactId: a, projectId: "proj_a", revisionId: rev, flat: lib.extractSearchTermsFlat(text, 20000),
  textBytes: Buffer.byteLength(text), textUnits: text.length });
const refusedFlat = (env, r, jobs, why) => {
  const before = adm.searchAdmissionState(), payload = r.payload, held = r.holder.jobs.length;
  assert.throws(() => adm.admitSearchJobs(env, r, jobs), (e) => e.code === "search_job_invalid" && /flat container/.test(e.message), why);
  assert.deepEqual(adm.searchAdmissionState(), before, why);
  assert.equal(r.payload, payload, why);
  assert.equal(r.holder.jobs.length, held, why);
};

test("review R6-1: one flat handle given to two jobs (in one call, or in two calls) is refused before anything is reserved", async () => {
  const world = world1(["h1", "h2"]);
  const env = aenv(world);
  const base = lib.searchFlatHeld();
  const one = flatJob("h1", "alpha beta");
  // The same handle for two artifacts in one call.
  const r1 = adm.openSearchRun();
  refusedFlat(env, r1, [one, { ...one, artifactId: "h2", revisionId: "rev_h2" }], "one handle, two artifacts, one call");
  r1.settle();
  assertRecovered();
  assert.throws(() => lib.searchFlatTerms(one.flat), (e) => e.code === "search_job_invalid", "the refused call dropped that handle's storage");
  // The same handle in two calls: the first admits it, the second (any live run) is refused.
  const r2run = adm.openSearchRun();
  const two = flatJob("h1", "alpha beta");
  adm.admitSearchJobs(env, r2run, [two]);
  refusedFlat(env, r2run, [{ ...two, artifactId: "h2", revisionId: "rev_h2" }], "same run, second call");
  const other = adm.openSearchRun();
  refusedFlat(env, other, [{ ...two, artifactId: "h2", revisionId: "rev_h2" }], "another live run");
  assert.deepEqual(lib.searchFlatTerms(two.flat), ["alpha", "beta"], "a refused reuse leaves the admitted job's storage");
  other.settle();
  // The first job still indexes exactly.
  const { result } = await logs(() => adm.runSearchIndexing(env, r2run));
  void result;
  assert.deepEqual(W.tokensOf(world, "h1"), expectedTokens(secretOf(world, "wsp_a"), ["alpha", "beta"]));
  assert.equal(W.docRow(world, "h2"), undefined, "the refused second job wrote nothing");
  assertExact(world);
  assertIdle();
  assert.equal(lib.searchFlatHeld(), base, "every storage dropped");
});

test("review R6-1: an off job and a job refused at validation drop the handle's storage", () => {
  const world = world1(["o1"]);
  const base = lib.searchFlatHeld();
  // Off: SEARCH_TERMS_MAX = 0.
  const off = adm.openSearchRun();
  adm.admitSearchJobs(aenv(world, { SEARCH_TERMS_MAX: "0" }), off, [flatJob("o1", "alpha beta")]);
  assert.equal(lib.searchFlatHeld(), base, "an off job keeps no storage");
  off.settle();
  // Refused at validation: bytes beyond 3 × textUnits, and a count above the cap.
  const r = adm.openSearchRun();
  const big = flatJob("o1", "x".repeat(100));
  assert.throws(() => adm.admitSearchJobs(aenv(world), r, [{ ...big, textBytes: 10, textUnits: 10 }]), (e) => e.code === "search_job_invalid");
  assert.equal(lib.searchFlatHeld(), base, "a job refused at validation drops its storage");
  const many = flatJob("o1", "a b c d e f");
  assert.throws(() => adm.admitSearchJobs(aenv(world, { SEARCH_TERMS_MAX: "2" }), r, [many]), (e) => e.code === "search_job_invalid");
  assert.equal(lib.searchFlatHeld(), base);
  // A call refused because of another descriptor still drops the valid one's storage.
  const fine = flatJob("o1", "alpha");
  assert.throws(() => adm.admitSearchJobs(aenv(world), r, [fine, { artifactId: "o2", projectId: "proj_a", revisionId: "rev_o2", text: 5, textBytes: 1 }]),
    (e) => e.code === "search_job_invalid");
  assert.equal(lib.searchFlatHeld(), base, "nothing admitted, nothing held");
  r.settle();
  assertIdle();
});

test("review R6-1: storage is dropped on replacement, de-duplication within a call, admission refusal and detach", () => {
  const world = world1(["d1"]);
  const env = aenv(world);
  const base = lib.searchFlatHeld();
  // Replacement by a later job of the same artifact (a second call).
  const r = adm.openSearchRun();
  adm.admitSearchJobs(env, r, [flatJob("d1", "alpha")]);
  assert.equal(lib.searchFlatHeld(), base + 1);
  adm.admitSearchJobs(env, r, [flatJob("d1", "beta", "rev_d1b")]);
  assert.equal(lib.searchFlatHeld(), base + 1, "the replaced job's storage is dropped");
  // De-duplication within one call: only the last is kept.
  adm.admitSearchJobs(env, r, [flatJob("d1", "c1", "rev_c1"), flatJob("d1", "c2", "rev_c2"), flatJob("d1", "c3", "rev_c3")]);
  assert.equal(lib.searchFlatHeld(), base + 1, "earlier jobs of the same artifact in one call are dropped");
  // Admission refusal (the run's document limit).
  const many = Array.from({ length: adm.SEARCH_RUN_LIMITS.docs + 3 }, (_, i) => flatJob(`m${i}`, "w" + i));
  assert.equal(lib.searchFlatHeld(), base + 1 + many.length);
  adm.admitSearchJobs(env, r, many);
  assert.equal(lib.searchFlatHeld(), base + adm.SEARCH_RUN_LIMITS.docs, "refused jobs drop their storage");
  // Detach drops what the holder held.
  r.detach();
  assert.equal(lib.searchFlatHeld(), base, "detach drops every held storage");
  r.settle();
  assertIdle();
});

test("review R6-1: a job with neither text nor flat that is not off is an error, not a complete empty row", async () => {
  const world = world1(["nn"]);
  const env = aenv(world);
  const r = adm.openSearchRun();
  adm.admitSearchJobs(env, r, [job("nn", "alpha")]);
  r.holder.jobs[0].text = null;   // an internal bug: the job lost its input
  const { events } = await logs(() => adm.runSearchIndexing(env, r));
  assert.equal(W.docRow(world, "nn")?.revision_id ?? "", "", "no complete row");
  assert.ok(events.some((e) => e.event === "search_index_failed" && e.code === "search_terms_invalid"), JSON.stringify(events));
  assertIdle();
});
