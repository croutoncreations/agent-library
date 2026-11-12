// Workspace data keys (packages/core/src/crypto/keys.js) and the default keyProvider adapter
// (packages/core/src/crypto/worker-secret-keys.js), loaded from the real sources (test/load-worker.mjs) on node:sqlite
// with every migration applied and real WebCrypto. No listeners, no network; master keys are random per run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";

const lib = await loadWorker({
  "crypto/keys.js": ["encryptionConfigured", "encryptionRequired", "encryptionEnabled", "workspaceDataKey", "dataKeyById", "withDataKeyMemo", "shredWorkspaceKeys"],
  "index.js": ["createWorker"],
  "crypto/worker-secret-keys.js": ["workerSecretKeyProvider", "dataKeyAad"],
  "adapters.js": ["withAdapters", "resolveAdapters", "defaultAdapters"],
  "limits.js": ["projectWorkspaceId"]
});

const MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
function mkDB() {
  const sql = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p) => ({ async first(c) { const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; },
    async all() { return { results: sql.prepare(q).all(...p) }; },
    async run() { return { meta: { changes: sql.prepare(q).run(...p).changes } }; } });
  const DB = { prepare: (q) => ({ ...stmt(q, []), bind: (...p) => stmt(q, p) }) };
  const at = new Date().toISOString();
  for (const id of ["hum_a", "hum_b"]) sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', 'synthetic', ?, 'Synthetic', ?)").run(id, id, at);
  return { sql, DB };
}
const b64 = (u8) => Buffer.from(u8).toString("base64");
const b64url = (u8) => Buffer.from(u8).toString("base64url");
const masterSecret = (enc = b64) => enc(crypto.getRandomValues(new Uint8Array(32)));
const WS_A = "wsp_hum_a", WS_B = "wsp_hum_b";

/** One "request": a fresh env with the adapters and its own data-key memo, as createWorker builds per fetch. */
const request = (base, adapterConfig = {}) => lib.withDataKeyMemo(lib.withAdapters({ ...base }, lib.resolveAdapters(adapterConfig)));
/** The default provider with its wrap/unwrap calls counted. */
function countingProvider() {
  const d = lib.defaultAdapters().keyProvider;
  const calls = { wrap: 0, unwrap: 0 };
  return { calls, keyProvider: { ...d, wrap: (...a) => { calls.wrap++; return d.wrap(...a); }, unwrap: (...a) => { calls.unwrap++; return d.unwrap(...a); } } };
}
/** Two HKDF keys hold the same bytes iff an AES key derived from one decrypts what the other's encrypted. */
async function sameKeyBytes(k1, k2) {
  const derive = (k) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("test/1") }, k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await derive(k1), new TextEncoder().encode("synthetic"));
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await derive(k2), ct)) === "synthetic"; }
  catch { return false; }
}
const assertDataKey = (k) => {
  assert.ok(k instanceof CryptoKey);
  assert.equal(k.algorithm.name, "HKDF");
  assert.equal(k.extractable, false);
  assert.deepEqual(k.usages, ["deriveKey"]);
};
/** Run fn with console.error captured; returns the logged lines. */
async function captureErrors(fn) {
  const logs = [];
  const real = console.error;
  console.error = (...a) => logs.push(a.map(String).join(" "));
  try { await fn(); } finally { console.error = real; }
  return logs;
}
const rows = (sql, ws) => sql.prepare("SELECT workspace_id, key_id, master_version, wrapped, created_at, shredded_at FROM workspace_keys WHERE workspace_id = ? ORDER BY created_at").all(ws);

test("a created key round-trips: a later request gets a non-extractable HKDF key with the same bytes", async () => {
  const { sql, DB } = mkDB();
  const base = { DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() };
  const first = await lib.workspaceDataKey(request(base), WS_A);
  assert.match(first.keyId, /^wk_[A-Za-z0-9_-]+$/);
  assert.equal(first.workspaceId, WS_A);
  assert.equal(first.masterVersion, 1);
  assertDataKey(first.key);
  await assert.rejects(crypto.subtle.exportKey("raw", first.key), "the data key is not extractable");
  const [row] = rows(sql, WS_A);
  assert.equal(row.key_id, first.keyId);
  assert.equal(row.master_version, 1);
  assert.equal(row.shredded_at, null);
  assert.ok(Number.isSafeInteger(row.created_at));
  assert.equal(Buffer.from(row.wrapped, "base64url").length, 12 + 32 + 16, "IV ‖ ciphertext ‖ tag");
  assert.doesNotMatch(row.wrapped, /[+/=]/, "base64url");

  const again = await lib.workspaceDataKey(request(base), WS_A);
  assert.equal(again.keyId, first.keyId);
  assert.notEqual(again.key, first.key, "a new request unwraps its own CryptoKey");
  assert.ok(await sameKeyBytes(first.key, again.key));
  const byId = await lib.dataKeyById(request(base), WS_A, first.keyId);
  assertDataKey(byId.key);
  assert.ok(await sameKeyBytes(first.key, byId.key));
  // Another workspace gets a different key.
  const other = await lib.workspaceDataKey(request(base), WS_B);
  assert.notEqual(other.keyId, first.keyId);
  assert.equal(await sameKeyBytes(first.key, other.key), false);
});

test("legacy projects resolve to the owner's wsp_ workspace through projectWorkspaceId", async () => {
  const { sql, DB } = mkDB();
  sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('prj_legacy', 'hum_a', 'Synthetic', ?)").run(new Date().toISOString());
  const base = { DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() };
  const ws = await lib.projectWorkspaceId(base, "prj_legacy");
  assert.equal(ws, WS_A);
  const k = await lib.workspaceDataKey(request(base), ws);
  assert.equal(rows(sql, WS_A)[0].key_id, k.keyId);
});

test("concurrent first use leaves exactly one row and every caller holds the same key", async () => {
  const { sql, DB } = mkDB();
  const base = { DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() };
  const { calls, keyProvider } = countingProvider();
  const got = await Promise.all(Array.from({ length: 6 }, () => lib.workspaceDataKey(request(base, { keyProvider }), WS_A)));
  assert.equal(rows(sql, WS_A).length, 1);
  assert.ok(calls.wrap > 1, "the callers really raced (several wrapped a candidate key)");
  assert.equal(new Set(got.map((g) => g.keyId)).size, 1);
  assert.equal(got[0].keyId, rows(sql, WS_A)[0].key_id);
  for (const g of got.slice(1)) assert.ok(await sameKeyBytes(got[0].key, g.key));
  // Within one request, concurrent callers share one creation and one CryptoKey.
  const env = request(base);
  const same = await Promise.all([lib.workspaceDataKey(env, WS_B), lib.workspaceDataKey(env, WS_B), lib.workspaceDataKey(env, WS_B)]);
  assert.equal(rows(sql, WS_B).length, 1);
  assert.ok(same.every((g) => g.key === same[0].key));
});

test("a wrapped value only unwraps for its own workspace, key id and master version; a flipped byte fails", async () => {
  const { sql, DB } = mkDB();
  const secret = masterSecret();
  // V2 holds the same bytes as V1, so only the bound master version differs.
  const base = { DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: secret, CONTENT_MASTER_KEY_V2: secret };
  const a = await lib.workspaceDataKey(request(base), WS_A);
  const { wrapped } = rows(sql, WS_A)[0];
  const P = lib.defaultAdapters().keyProvider;
  assertDataKey(await P.unwrap(base, wrapped, { workspaceId: WS_A, keyId: a.keyId, masterVersion: 1 }));
  for (const ctx of [{ workspaceId: WS_B, keyId: a.keyId, masterVersion: 1 }, { workspaceId: WS_A, keyId: "wk_other", masterVersion: 1 }, { workspaceId: WS_A, keyId: a.keyId, masterVersion: 2 }]) {
    await assert.rejects(P.unwrap(base, wrapped, ctx), (e) => e.code === "key_unwrap_failed" && !e.message.includes(secret), JSON.stringify(ctx));
  }
  const bad = Buffer.from(wrapped, "base64url"); bad[20] ^= 1;
  await assert.rejects(P.unwrap(base, b64url(bad), { workspaceId: WS_A, keyId: a.keyId, masterVersion: 1 }), (e) => e.code === "key_unwrap_failed");
  await assert.rejects(P.unwrap(base, wrapped.slice(0, -4), { workspaceId: WS_A, keyId: a.keyId, masterVersion: 1 }), (e) => e.code === "key_unwrap_failed");

  // The same through stored rows: moved to another workspace, another master version, or a flipped byte.
  sql.prepare("UPDATE workspace_keys SET workspace_id = ? WHERE key_id = ?").run(WS_B, a.keyId);
  await assert.rejects(lib.dataKeyById(request(base), WS_B, a.keyId), (e) => e.code === "key_unwrap_failed");
  await assert.rejects(lib.workspaceDataKey(request(base), WS_B), (e) => e.code === "key_unwrap_failed");
  sql.prepare("UPDATE workspace_keys SET workspace_id = ?, master_version = 2 WHERE key_id = ?").run(WS_A, a.keyId);
  await assert.rejects(lib.dataKeyById(request(base), WS_A, a.keyId), (e) => e.code === "key_unwrap_failed");
  sql.prepare("UPDATE workspace_keys SET master_version = 1, wrapped = ? WHERE key_id = ?").run(b64url(bad), a.keyId);
  await assert.rejects(lib.dataKeyById(request(base), WS_A, a.keyId), (e) => e.code === "key_unwrap_failed");
  sql.prepare("UPDATE workspace_keys SET wrapped = ? WHERE key_id = ?").run(wrapped, a.keyId);
  assert.ok(await sameKeyBytes(a.key, (await lib.dataKeyById(request(base), WS_A, a.keyId)).key));
});

test("additional data is length-prefixed, so different tuples never give the same bytes", () => {
  const hex = (u) => Buffer.from(u).toString("hex");
  const x = lib.dataKeyAad({ workspaceId: "wsp_a", keyId: "wk_bc", masterVersion: 1 });
  const y = lib.dataKeyAad({ workspaceId: "wsp_ab", keyId: "wk_c", masterVersion: 1 });
  const z = lib.dataKeyAad({ workspaceId: "wsp_a", keyId: "wk_bc", masterVersion: 11 });
  assert.notEqual(hex(x), hex(y));
  assert.notEqual(hex(x), hex(z));
  assert.equal(hex(Buffer.from(x).subarray(0, 4)), "00000008");
  assert.equal(Buffer.from(x).subarray(4, 12).toString(), "al-dek/1");
});

test("master rotation: version 2 unwraps a version-1 row with both secrets; new keys use version 2; a missing old secret names the version", async () => {
  const { sql, DB } = mkDB();
  const v1 = masterSecret(), v2 = masterSecret(b64url);
  const a = await lib.workspaceDataKey(request({ DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: v1 }), WS_A);
  const rotated = { DB, CONTENT_MASTER_KEY_VERSION: "2", CONTENT_MASTER_KEY_V1: v1, CONTENT_MASTER_KEY_V2: v2 };
  const a2 = await lib.workspaceDataKey(request(rotated), WS_A);
  assert.equal(a2.keyId, a.keyId);
  assert.ok(await sameKeyBytes(a.key, a2.key));
  const b = await lib.workspaceDataKey(request(rotated), WS_B);
  assert.equal(b.masterVersion, 2);
  assert.equal(rows(sql, WS_B)[0].master_version, 2);
  assert.equal(rows(sql, WS_A)[0].master_version, 1);

  const v1Gone = { DB, CONTENT_MASTER_KEY_VERSION: "2", CONTENT_MASTER_KEY_V2: v2 };
  const logs = await captureErrors(() => assert.rejects(lib.dataKeyById(request(v1Gone), WS_A, a.keyId),
    (e) => e.code === "master_key_missing" && !/CONTENT_MASTER_KEY/.test(e.message) && !e.message.includes(v2)));
  assert.ok(logs.some((l) => /master_key_missing/.test(l) && /CONTENT_MASTER_KEY_V1\b/.test(l) && !l.includes(v2)), "the log names the missing secret");
  await assert.rejects(lib.workspaceDataKey(request(v1Gone), WS_A), (e) => e.code === "master_key_missing");
  assert.ok(await sameKeyBytes(b.key, (await lib.dataKeyById(request(v1Gone), WS_B, b.keyId)).key), "version-2 rows still work");
});

test("configuration: unset is 'not configured'; a malformed master key or version is an error that never shows the value", async () => {
  const { DB } = mkDB();
  const env = (vars) => request({ DB, ...vars });
  assert.equal(lib.encryptionConfigured(env({})), false);
  assert.equal(lib.encryptionConfigured(env({ CONTENT_MASTER_KEY_V1: masterSecret() })), false, "a secret without a version var is not in use");
  assert.equal(lib.encryptionConfigured(env({ CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() })), true);
  assert.equal(lib.encryptionConfigured(env({ CONTENT_MASTER_KEY_VERSION: "3", CONTENT_MASTER_KEY_V3: masterSecret(b64url) })), true);
  await assert.rejects(lib.workspaceDataKey(env({}), WS_A), (e) => e.code === "encryption_not_configured");

  const short = b64(crypto.getRandomValues(new Uint8Array(31))), long = b64(crypto.getRandomValues(new Uint8Array(33)));
  const bad = [
    [{ CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: short }, "master_key_invalid", short],
    [{ CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: long }, "master_key_invalid", long],
    [{ CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: "not base64 at all!!" }, "master_key_invalid", "not base64"],
    [{ CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: "" }, "master_key_invalid", null],
    [{ CONTENT_MASTER_KEY_VERSION: "1" }, "master_key_missing", null],
    [{ CONTENT_MASTER_KEY_VERSION: "0", CONTENT_MASTER_KEY_V0: masterSecret() }, "master_key_version_invalid", null],
    [{ CONTENT_MASTER_KEY_VERSION: "v1", CONTENT_MASTER_KEY_V1: masterSecret() }, "master_key_version_invalid", null],
  ];
  for (const [vars, code, secret] of bad) {
    // The message can reach a client (errorBody), so it names neither the secret nor its value; the log names the secret.
    const check = (e) => e.code === code && (!secret || !e.message.includes(secret)) && !/CONTENT_MASTER_KEY/.test(e.message);
    const logs = await captureErrors(async () => {
      assert.throws(() => lib.encryptionConfigured(env(vars)), check, JSON.stringify(Object.keys(vars)));
      await assert.rejects(lib.workspaceDataKey(env(vars), WS_A), check);
    });
    assert.ok(logs.some((l) => l.includes(code) && /CONTENT_MASTER_KEY_V/.test(l)), `logged: ${code}`);
    assert.ok(!secret || !logs.some((l) => l.includes(secret)), "the log never shows the value");
  }
});

test("one unwrap per request, never shared across requests", async () => {
  const { DB } = mkDB();
  const base = { DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() };
  const { calls, keyProvider } = countingProvider();
  const r1 = request(base, { keyProvider });
  const k = await lib.workspaceDataKey(r1, WS_A);
  await lib.workspaceDataKey(r1, WS_A);
  await lib.dataKeyById(r1, WS_A, k.keyId);
  await lib.dataKeyById(r1, WS_A, k.keyId);
  assert.deepEqual(calls, { wrap: 1, unwrap: 1 });
  const r2 = request(base, { keyProvider });
  await lib.dataKeyById(r2, WS_A, k.keyId);
  await lib.workspaceDataKey(r2, WS_A);
  assert.deepEqual(calls, { wrap: 1, unwrap: 2 });
  // A failed unwrap is not remembered: the next call in the same request tries again.
  const r3 = request({ ...base, CONTENT_MASTER_KEY_V1: undefined }, { keyProvider });
  await assert.rejects(lib.dataKeyById(r3, WS_A, k.keyId));
  await assert.rejects(lib.dataKeyById(r3, WS_A, k.keyId));
  assert.equal(calls.unwrap, 4);
  // Without a memo (code outside createWorker), every call unwraps.
  const bare = lib.withAdapters({ ...base }, lib.resolveAdapters({ keyProvider }));
  await lib.dataKeyById(bare, WS_A, k.keyId);
  await lib.dataKeyById(bare, WS_A, k.keyId);
  assert.equal(calls.unwrap, 6);
});

test("shredded workspaces get no new key; lookup by id refuses a shredded row, a wrong workspace and an unknown id", async () => {
  const { sql, DB } = mkDB();
  const base = { DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() };
  const a = await lib.workspaceDataKey(request(base), WS_A);
  const b = await lib.workspaceDataKey(request(base), WS_B);
  // Another workspace's key id and an unknown key id give the client the same answer; the log tells them apart.
  const notFound = (e) => e.status === 500 && e.code === "key_not_found" && e.message === "The workspace key does not exist";
  let logs = await captureErrors(() => assert.rejects(lib.dataKeyById(request(base), WS_B, a.keyId), notFound));
  assert.ok(logs.some((l) => JSON.parse(l).event === "key_workspace_mismatch"), "the log keeps the mismatch");
  // Also when the key is already in this request's memo.
  const r = request(base);
  await lib.dataKeyById(r, WS_A, a.keyId);
  await assert.rejects(lib.dataKeyById(r, WS_B, a.keyId), notFound);
  logs = await captureErrors(() => assert.rejects(lib.dataKeyById(request(base), WS_A, "wk_unknown"), notFound));
  assert.ok(logs.some((l) => JSON.parse(l).event === "key_not_found") && !logs.some((l) => l.includes("key_workspace_mismatch")));

  sql.prepare("UPDATE workspace_keys SET shredded_at = ? WHERE key_id = ?").run(Date.now(), a.keyId);
  await assert.rejects(lib.dataKeyById(request(base), WS_A, a.keyId), (e) => e.code === "key_shredded");
  await assert.rejects(lib.workspaceDataKey(request(base), WS_A), (e) => e.code === "key_shredded");
  assert.equal(rows(sql, WS_A).length, 1, "no replacement key was created");
  // Even concurrently.
  await Promise.all(Array.from({ length: 4 }, () => assert.rejects(lib.workspaceDataKey(request(base), WS_A), (e) => e.code === "key_shredded")));
  assert.equal(rows(sql, WS_A).length, 1);
  // Other workspaces are unaffected.
  assert.equal((await lib.workspaceDataKey(request(base), WS_B)).keyId, b.keyId);
});

test("a custom keyProvider replaces the default: no Worker secrets are read", async () => {
  const { sql, DB } = mkDB();
  const kek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "unwrapKey"]);
  const seen = [];
  const keyProvider = {
    name: "synthetic-kms",
    configured: () => true,
    currentVersion: () => 7,
    async wrap(_env, raw, ctx) {
      seen.push(["wrap", ctx]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ctx.keyId) }, kek, raw));
      return "kms." + b64url(Buffer.concat([iv, ct]));
    },
    async unwrap(_env, wrapped, ctx) {
      seen.push(["unwrap", ctx]);
      const buf = Buffer.from(wrapped.slice(4), "base64url");
      return crypto.subtle.unwrapKey("raw", buf.subarray(12), kek, { name: "AES-GCM", iv: buf.subarray(0, 12), additionalData: new TextEncoder().encode(ctx.keyId) }, "HKDF", false, ["deriveKey"]);
    }
  };
  const base = { DB };
  assert.equal(lib.encryptionConfigured(request(base, { keyProvider })), true);
  const k = await lib.workspaceDataKey(request(base, { keyProvider }), WS_A);
  assertDataKey(k.key);
  const [row] = rows(sql, WS_A);
  assert.equal(row.master_version, 7);
  assert.match(row.wrapped, /^kms\./);
  assert.deepEqual(seen, [["wrap", { workspaceId: WS_A, keyId: k.keyId, masterVersion: 7 }], ["unwrap", { workspaceId: WS_A, keyId: k.keyId, masterVersion: 7 }]]);
  assert.ok(await sameKeyBytes(k.key, (await lib.dataKeyById(request(base, { keyProvider }), WS_A, k.keyId)).key));
  // The default provider has no secrets here.
  assert.equal(lib.encryptionConfigured(request(base)), false);
});

// ---------------------------------------------------------------- review fixes (PR 2 slice 3a)

const configuredBase = (DB, extra = {}) => ({ DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret(), ...extra });
const activeRows = (sql, ws) => sql.prepare("SELECT key_id FROM workspace_keys WHERE workspace_id = ? AND shredded_at IS NULL").all(ws);

test("the unwrap memo is bound to the whole row: a row moved to another workspace in the same request fails, not A's key", async () => {
  const { sql, DB } = mkDB();
  const base = configuredBase(DB);
  const { calls, keyProvider } = countingProvider();
  const r = request(base, { keyProvider });
  const a = await lib.dataKeyById(r, WS_A, (await lib.workspaceDataKey(r, WS_A)).keyId);
  assert.equal(a.workspaceId, WS_A);
  sql.prepare("UPDATE workspace_keys SET workspace_id = ? WHERE key_id = ?").run(WS_B, a.keyId);
  await assert.rejects(lib.dataKeyById(r, WS_B, a.keyId), (e) => e.code === "key_unwrap_failed");
  await assert.rejects(lib.workspaceDataKey(r, WS_B), (e) => e.code === "key_unwrap_failed");
  assert.ok(calls.unwrap >= 2, "the changed row was unwrapped afresh");
  // A changed master version or wrapped value in the same request is also unwrapped afresh.
  sql.prepare("UPDATE workspace_keys SET workspace_id = ? WHERE key_id = ?").run(WS_A, a.keyId);
  assert.ok(await sameKeyBytes(a.key, (await lib.dataKeyById(r, WS_A, a.keyId)).key));
  sql.prepare("UPDATE workspace_keys SET master_version = 2 WHERE key_id = ?").run(a.keyId);
  await assert.rejects(lib.dataKeyById(r, WS_A, a.keyId), (e) => e.code === "master_key_missing" || e.code === "key_unwrap_failed");
});

test("no stale answer about the active key: load, shred, load again in the same request is refused", async () => {
  const { sql, DB } = mkDB();
  const base = configuredBase(DB);
  const { calls, keyProvider } = countingProvider();
  const r = request(base, { keyProvider });
  const a = await lib.workspaceDataKey(r, WS_A);
  await lib.shredWorkspaceKeys(r, WS_A);
  await assert.rejects(lib.workspaceDataKey(r, WS_A), (e) => e.code === "key_shredded");
  await assert.rejects(lib.dataKeyById(r, WS_A, a.keyId), (e) => e.code === "key_shredded");
  assert.deepEqual(calls, { wrap: 1, unwrap: 1 });
  assert.equal(activeRows(sql, WS_A).length, 0);
});

test("concurrent first use inside one request shares one creation, which is forgotten once settled", async () => {
  const { sql, DB } = mkDB();
  const { calls, keyProvider } = countingProvider();
  const r = request(configuredBase(DB), { keyProvider });
  const got = await Promise.all([1, 2, 3].map(() => lib.workspaceDataKey(r, WS_A)));
  assert.equal(calls.wrap, 1);
  assert.ok(got.every((g) => g.key === got[0].key));
  // Settled: after the row is deleted (an operator mistake), the same request creates a new key instead of reusing.
  sql.prepare("DELETE FROM workspace_keys WHERE workspace_id = ?").run(WS_A);
  const again = await lib.workspaceDataKey(r, WS_A);
  assert.notEqual(again.keyId, got[0].keyId);
  assert.equal(calls.wrap, 2);
});

test("a lookup that starts after a completed shred is refused, even while an earlier lookup in the same request is still in flight", async () => {
  const { sql, DB } = mkDB();
  const base = configuredBase(DB);
  await lib.workspaceDataKey(request(base), WS_A);
  // The test database holds back the result of one active-row SELECT: the statement has executed (it read the active
  // row), but its promise resolves only when the test releases it.
  const ACTIVE_ROW_SELECT = /FROM workspace_keys WHERE workspace_id = \? AND shredded_at IS NULL$/;
  let hold = false, heldReached, release;
  const reached = new Promise((res) => { heldReached = res; });
  const gate = new Promise((res) => { release = res; });
  const heldDB = { prepare(q) {
    const s = DB.prepare(q);
    const wrapFirst = (st) => ({ ...st, async first(c) {
      const result = await st.first(c);
      if (hold && ACTIVE_ROW_SELECT.test(q)) { hold = false; heldReached(); await gate; }
      return result;
    } });
    return { ...wrapFirst(s), bind: (...p) => wrapFirst(s.bind(...p)) };
  } };
  const r = request({ ...base, DB: heldDB });
  hold = true;
  const callA = lib.workspaceDataKey(r, WS_A).then((k) => k, (e) => e);
  await reached;
  await lib.shredWorkspaceKeys(request(base), WS_A);
  assert.equal(activeRows(sql, WS_A).length, 0, "the shred has completed");
  const callB = lib.workspaceDataKey(r, WS_A).then((k) => k, (e) => e);
  release();
  const [a, b] = await Promise.all([callA, callB]);
  assert.equal(b.code, "key_shredded", "a lookup started after the shred completed gets no key");
  // Call A read the row before the shred: it gets the key (the documented allowance for a lookup already in flight).
  assert.equal(a.workspaceId, WS_A);
  assertDataKey(a.key);
});

test("encryptionEnabled does not cache 'no key rows': a row created by another request during this one is seen", async () => {
  const { sql, DB } = mkDB();
  const r = request({ DB });
  assert.equal(await lib.encryptionEnabled(r), false);
  sql.prepare("INSERT INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at, shredded_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(WS_A, "wk_synthetic", 1, "synthetic-wrapped", Date.now(), null);
  await assert.rejects(lib.encryptionEnabled(r), (e) => e.status === 500 && e.code === "encryption_misconfigured");
});

test("the unwrap memo is bound to the wrapped value: a row whose wrapped value changes in the same request is unwrapped afresh and fails", async () => {
  const { sql, DB } = mkDB();
  const base = configuredBase(DB);
  const { calls, keyProvider } = countingProvider();
  const r = request(base, { keyProvider });
  const a = await lib.workspaceDataKey(r, WS_A);
  await lib.workspaceDataKey(request(base), WS_B);
  const { wrapped } = rows(sql, WS_A)[0];
  const corrupted = Buffer.from(wrapped, "base64url"); corrupted[20] ^= 1;
  for (const other of [rows(sql, WS_B)[0].wrapped, b64url(corrupted)]) {
    sql.prepare("UPDATE workspace_keys SET wrapped = ? WHERE key_id = ?").run(other, a.keyId);
    const before = calls.unwrap;
    await assert.rejects(lib.workspaceDataKey(r, WS_A), (e) => e.code === "key_unwrap_failed");
    await assert.rejects(lib.dataKeyById(r, WS_A, a.keyId), (e) => e.code === "key_unwrap_failed");
    assert.equal(calls.unwrap, before + 2, "unwrapped afresh, not the cached key");
  }
  sql.prepare("UPDATE workspace_keys SET wrapped = ? WHERE key_id = ?").run(wrapped, a.keyId);
  assert.equal((await lib.workspaceDataKey(r, WS_A)).key, a.key, "the original row still hits the memo");
});

test("encryptionRequired reads CONTENT_ENCRYPTION_REQUIRED: unset, \"\", \"0\"/0 off; \"1\"/1 on; anything else is a configuration error", async () => {
  for (const [v, want] of [[undefined, false], [null, false], ["", false], ["0", false], [0, false], ["1", true], [1, true]]) {
    assert.equal(lib.encryptionRequired({ CONTENT_ENCRYPTION_REQUIRED: v }), want, String(v));
  }
  const { DB } = mkDB();
  const misconfigured = (e) => e.status === 500 && e.code === "encryption_misconfigured" && e.message === "Content encryption is required but not configured";
  const call = (env) => lib.createWorker().fetch(new Request("https://app.example.test/api/me"), { APP_HOST: "app.example.test", DB, ...env }, { waitUntil() {} });
  const secret = masterSecret();
  for (const v of ["true", "yes", true, "2", " 1"]) {
    for (const keys of [{}, { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: secret }]) {
      const label = `${JSON.stringify(v)} ${keys.CONTENT_MASTER_KEY_VERSION ? "configured" : "unconfigured"}`;
      const env = { CONTENT_ENCRYPTION_REQUIRED: v, ...keys };
      assert.throws(() => lib.encryptionRequired(env), misconfigured, label);
      await assert.rejects(lib.encryptionEnabled(request({ DB, ...env })), misconfigured, label);
      let res;
      const logs = await captureErrors(async () => { res = await call(env); });
      assert.equal(res.status, 500, label);
      assert.deepEqual(await res.json(), { error: { code: "encryption_misconfigured", message: "Content encryption is required but not configured" } }, label);
      const lines = logs.filter((l) => l.includes('"event":"encryption_misconfigured"'));
      assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ event: "encryption_misconfigured", reason: "required_value_invalid" }], label);
      assert.ok(!lines[0].includes(secret), label);
    }
  }
});

test("encryptionEnabled: true when configured (no query); false only when not configured, not required and no key rows; otherwise a 500", async () => {
  const { sql, DB } = mkDB();
  let queries = 0;
  const countingDB = { prepare: (q) => { queries++; return DB.prepare(q); } };
  assert.equal(await lib.encryptionEnabled(request(configuredBase(countingDB))), true);
  assert.equal(queries, 0, "configured costs no query");
  const misconfigured = (e) => e.status === 500 && e.code === "encryption_misconfigured" && !/CONTENT_|wsp_|wk_/.test(e.message);
  await assert.rejects(lib.encryptionEnabled(request({ DB: countingDB, CONTENT_ENCRYPTION_REQUIRED: "1" })), misconfigured, "required but unset");
  // Not required, no rows: off. The row probe runs on every call (a "no rows" answer is never cached).
  const r = request({ DB: countingDB });
  queries = 0;
  assert.equal(await lib.encryptionEnabled(r), false);
  assert.equal(await lib.encryptionEnabled(r), false);
  assert.equal(queries, 2, "one probe per call");
  // A malformed configuration is an error, never "off".
  await assert.rejects(lib.encryptionEnabled(request({ DB, CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: "short" })), (e) => e.code === "master_key_invalid");
  // Encryption was in use (rows exist), then the version var was removed: never plaintext.
  const base = configuredBase(DB);
  await lib.workspaceDataKey(request(base), WS_A);
  const removed = { ...base, CONTENT_MASTER_KEY_VERSION: undefined };
  await assert.rejects(lib.encryptionEnabled(request(removed)), misconfigured, "version var removed while rows exist");
  await assert.rejects(lib.encryptionEnabled(request({ ...base, CONTENT_MASTER_KEY_VERSION: "" })), misconfigured, "version var blanked");
  // A tombstone is not a key: an installation that never encrypted and only shredded (purged) workspaces stays off.
  sql.prepare("DELETE FROM workspace_keys").run();
  await lib.shredWorkspaceKeys(request(removed), WS_B);
  assert.equal(await lib.encryptionEnabled(request(removed)), false, "only a tombstone");
});

test("tombstones do not count as 'encryption was in use'; a real key row counts even after it was shredded", async () => {
  const { sql, DB } = mkDB();
  const off = request({ DB });
  await lib.shredWorkspaceKeys(off, WS_A);
  await lib.shredWorkspaceKeys(off, WS_B);
  assert.equal(rows(sql, WS_A)[0].master_version, 0, "a tombstone");
  assert.equal(await lib.encryptionEnabled(request({ DB })), false, "unconfigured, not required, only tombstones");
  assert.equal(await lib.encryptionEnabled(off), false);
  // The tombstone still stops the workspace getting a key once encryption is configured.
  const base = configuredBase(DB);
  await assert.rejects(lib.workspaceDataKey(request(base), WS_A), (e) => e.code === "key_shredded");
  // A real key, later shredded, still means encryption was in use.
  const ws = "wsp_synthetic_real";
  await lib.workspaceDataKey(request(base), ws);
  await lib.shredWorkspaceKeys(request(base), ws);
  assert.equal(activeRows(sql, ws).length, 0);
  await assert.rejects(lib.encryptionEnabled(request({ DB })), (e) => e.status === 500 && e.code === "encryption_misconfigured");
});

test("workspaceDataKey refuses to hand out a key for encrypting when the configuration is missing or malformed, even with a row", async () => {
  const { DB } = mkDB();
  const base = configuredBase(DB);
  await lib.workspaceDataKey(request(base), WS_A);
  await assert.rejects(lib.workspaceDataKey(request({ ...base, CONTENT_MASTER_KEY_VERSION: undefined }), WS_A), (e) => e.code === "encryption_not_configured");
  await assert.rejects(lib.workspaceDataKey(request({ ...base, CONTENT_MASTER_KEY_VERSION: "x" }), WS_A), (e) => e.code === "master_key_version_invalid");
  await assert.rejects(lib.workspaceDataKey(request({ ...base, CONTENT_MASTER_KEY_VERSION: "2" }), WS_A), (e) => e.code === "master_key_missing");
  // Decrypting by key id is decided by the stored object, not the configuration: it still works.
  const keyId = (await lib.workspaceDataKey(request(base), WS_A)).keyId;
  assertDataKey((await lib.dataKeyById(request({ ...base, CONTENT_MASTER_KEY_VERSION: undefined }), WS_A, keyId)).key);
});

test("createWorker refuses every request when encryption is required but not configured (or malformed); unchanged otherwise", async () => {
  const { DB } = mkDB();
  const call = (env, adapters) => lib.createWorker(adapters).fetch(new Request("https://app.example.test/api/me"), { APP_HOST: "app.example.test", DB, ...env }, { waitUntil() {} });
  const refusedBody = { error: { code: "encryption_misconfigured", message: "Content encryption is required but not configured" } };
  const secret = masterSecret();
  for (const env of [
    { CONTENT_ENCRYPTION_REQUIRED: "1" },
    { CONTENT_ENCRYPTION_REQUIRED: "1", CONTENT_MASTER_KEY_V1: secret },
    { CONTENT_ENCRYPTION_REQUIRED: "1", CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: "not-32-bytes" },
    { CONTENT_ENCRYPTION_REQUIRED: "1", CONTENT_MASTER_KEY_VERSION: "1" },
  ]) {
    const res = await call(env);
    assert.equal(res.status, 500, JSON.stringify(Object.keys(env)));
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), refusedBody);
    assert.ok(!text.includes(secret) && !/CONTENT_/.test(text));
  }
  // A custom provider whose configured() throws or says false is refused too.
  const d = lib.defaultAdapters().keyProvider;
  const off = { ...d, name: "synthetic-off", configured: () => false };
  assert.equal((await call({ CONTENT_ENCRYPTION_REQUIRED: "1" }, { keyProvider: off })).status, 500);
  const broken = { ...d, name: "synthetic-broken", configured: () => { throw new Error("synthetic"); } };
  assert.equal((await call({ CONTENT_ENCRYPTION_REQUIRED: "1" }, { keyProvider: broken })).status, 500);
  // Required and configured, or not required: requests go through to core (whatever core answers, it is not this refusal).
  for (const env of [{ CONTENT_ENCRYPTION_REQUIRED: "1", CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: secret }, {}, { CONTENT_ENCRYPTION_REQUIRED: "0" },
    { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: "not-32-bytes" }]) {
    const body = await (await call(env)).text();
    assert.ok(!body.includes("encryption_misconfigured"), JSON.stringify(Object.keys(env)));
  }
});

test("createWorker's encryption refusal logs one line with its reason, never an error message or a secret name", async () => {
  const { DB } = mkDB();
  const call = (env, adapters) => lib.createWorker(adapters).fetch(new Request("https://app.example.test/api/me"), { APP_HOST: "app.example.test", DB, ...env }, { waitUntil() {} });
  const refusedBody = { error: { code: "encryption_misconfigured", message: "Content encryption is required but not configured" } };
  const events = (logs) => logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.event === "encryption_misconfigured");
  const d = lib.defaultAdapters().keyProvider;
  const SYNTHETIC_MESSAGE = "synthetic provider failure text";
  class SyntheticProviderError extends Error {}
  const cases = [
    [{ CONTENT_ENCRYPTION_REQUIRED: "1" }, undefined, { event: "encryption_misconfigured", reason: "not_configured" }],
    [{ CONTENT_ENCRYPTION_REQUIRED: "1", CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: "not-32-bytes" }, undefined,
      { event: "encryption_misconfigured", reason: "configuration_error", error: "master_key_invalid" }],
    [{ CONTENT_ENCRYPTION_REQUIRED: "1" }, { keyProvider: { ...d, name: "synthetic-broken", configured: () => { throw new SyntheticProviderError(SYNTHETIC_MESSAGE); } } },
      { event: "encryption_misconfigured", reason: "configuration_error", error: "SyntheticProviderError" }],
    [{ CONTENT_ENCRYPTION_REQUIRED: "1" }, { keyProvider: { ...d, name: "synthetic-async", configured: async () => true } },
      { event: "encryption_misconfigured", reason: "configuration_error", error: "key_provider_invalid" }],
  ];
  for (const [env, adapters, want] of cases) {
    let res;
    const logs = await captureErrors(async () => { res = await call(env, adapters); });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), refusedBody, "the client response is unchanged");
    assert.deepEqual(events(logs), [want], JSON.stringify(want));
    const line = logs.find((l) => l.includes('"event":"encryption_misconfigured"'));
    assert.ok(!line.includes(SYNTHETIC_MESSAGE) && !/CONTENT_/.test(line), line);
  }
  // Not required: no refusal and no such line.
  const logs = await captureErrors(() => call({}));
  assert.deepEqual(events(logs), []);
});

test("provider results are validated: configured must be a synchronous boolean, currentVersion a positive safe integer, wrap a non-empty string", async () => {
  const { sql, DB } = mkDB();
  const d = lib.defaultAdapters().keyProvider;
  const base = configuredBase(DB);
  const invalid = (e) => e.status === 500 && e.code === "key_provider_invalid";
  for (const configured of [async () => true, async () => false, () => "yes", () => 1, () => undefined]) {
    const env = request(base, { keyProvider: { ...d, configured } });
    assert.throws(() => lib.encryptionConfigured(env), invalid, String(configured));
    await assert.rejects(lib.encryptionEnabled(env), invalid);
    await assert.rejects(lib.workspaceDataKey(env, WS_A), invalid);
  }
  let wraps = 0;
  for (const v of [0, -1, 1.5, "1", 2 ** 53, null, Promise.resolve(1)]) {
    const kp = { ...d, currentVersion: () => v, wrap: (...a) => { wraps++; return d.wrap(...a); } };
    await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider: kp }), WS_A), invalid, String(v));
  }
  assert.equal(wraps, 0, "no wrap with an invalid version");
  for (const w of ["", 42, null, undefined, { wrapped: "x" }]) {
    await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider: { ...d, wrap: async () => w } }), WS_A), invalid, String(w));
  }
  assert.equal(rows(sql, WS_A).length, 0);
});

test("a row's master_version is validated before it names a secret or reaches a provider", async () => {
  const { sql, DB } = mkDB();
  const base = configuredBase(DB);
  const a = await lib.workspaceDataKey(request(base), WS_A);
  const { calls, keyProvider } = countingProvider();
  for (const v of [0, -1, 1.5, "1; x", "V1"]) {
    sql.prepare("UPDATE workspace_keys SET master_version = ? WHERE key_id = ?").run(v, a.keyId);
    await assert.rejects(lib.dataKeyById(request(base, { keyProvider }), WS_A, a.keyId), (e) => e.code === "key_row_invalid" && !e.message.includes(a.keyId), String(v));
    await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider }), WS_A), (e) => e.code === "key_row_invalid", String(v));
  }
  assert.equal(calls.unwrap, 0);
  // The default provider checks it too, for callers that reach it directly.
  await assert.rejects(Promise.resolve().then(() => lib.defaultAdapters().keyProvider.unwrap(base, "x", { workspaceId: WS_A, keyId: a.keyId, masterVersion: "1/../2" })), (e) => e.code === "key_row_invalid");
});

test("shredWorkspaceKeys: no new key and no unwrap afterwards; idempotent; a workspace that never had a key cannot get one", async () => {
  const { sql, DB } = mkDB();
  const base = configuredBase(DB);
  const a = await lib.workspaceDataKey(request(base), WS_A);
  await lib.shredWorkspaceKeys(request(base), WS_A);
  await lib.shredWorkspaceKeys(request(base), WS_A);
  const after = rows(sql, WS_A);
  assert.equal(after.length, 1, "idempotent: no tombstone added next to a shredded key");
  assert.equal(after[0].wrapped, "", "the wrapped key is overwritten");
  assert.ok(Number.isSafeInteger(after[0].shredded_at));
  const { calls, keyProvider } = countingProvider();
  await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider }), WS_A), (e) => e.code === "key_shredded" && !e.message.includes(WS_A));
  await assert.rejects(lib.dataKeyById(request(base, { keyProvider }), WS_A, a.keyId), (e) => e.code === "key_shredded");
  assert.deepEqual(calls, { wrap: 0, unwrap: 0 }, "a shredded workspace never reaches the provider (the pre-check)");
  // Never had a key: a tombstone.
  await lib.shredWorkspaceKeys(request(base), WS_B);
  await lib.shredWorkspaceKeys(request(base), WS_B);
  const tomb = rows(sql, WS_B);
  assert.equal(tomb.length, 1);
  assert.equal(tomb[0].wrapped, "");
  assert.ok(tomb[0].shredded_at !== null);
  await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider }), WS_B), (e) => e.code === "key_shredded");
  assert.deepEqual(calls, { wrap: 0, unwrap: 0 });
  // A row whose wrapped value is empty is shredded even if shredded_at was cleared (never sent to a provider).
  sql.prepare("UPDATE workspace_keys SET shredded_at = NULL WHERE key_id = ?").run(a.keyId);
  await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider }), WS_A), (e) => e.code === "key_shredded");
  await assert.rejects(lib.dataKeyById(request(base, { keyProvider }), WS_A, a.keyId), (e) => e.code === "key_shredded");
  assert.deepEqual(calls, { wrap: 0, unwrap: 0 });
});

test("shredding racing first use, in both orders and concurrently, never leaves an active key", async () => {
  for (const order of ["first use, then shred", "shred, then first use", "concurrent", "concurrent, shred first"]) {
    const { sql, DB } = mkDB();
    const base = configuredBase(DB);
    const use = () => lib.workspaceDataKey(request(base), WS_A).catch((e) => e);
    const shred = () => lib.shredWorkspaceKeys(request(base), WS_A);
    if (order === "first use, then shred") { await use(); await shred(); }
    else if (order === "shred, then first use") { await shred(); assert.equal((await use()).code, "key_shredded"); }
    else if (order === "concurrent") await Promise.all([use(), use(), shred(), use()]);
    else await Promise.all([shred(), use(), use()]);
    assert.equal(activeRows(sql, WS_A).length, 0, order);
    assert.ok(rows(sql, WS_A).every((r) => r.wrapped === ""), `${order}: no wrapped key survives`);
    assert.equal((await use()).code, "key_shredded", order);
  }
});

test("the NOT EXISTS guard: a shred landing after the pre-check but before the insert still leaves no active key", async () => {
  const { sql, DB } = mkDB();
  const base = configuredBase(DB);
  const d = lib.defaultAdapters().keyProvider;
  // The provider's wrap runs between the pre-check and the INSERT; the workspace is shredded (a tombstone) there.
  const keyProvider = { ...d, async wrap(env, raw, ctx) { await lib.shredWorkspaceKeys(request(base), ctx.workspaceId); return d.wrap(env, raw, ctx); } };
  await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider }), WS_A), (e) => e.code === "key_shredded");
  assert.equal(activeRows(sql, WS_A).length, 0);
  assert.equal(rows(sql, WS_A).length, 1, "only the tombstone");
});

test("an INSERT failure other than losing the race is reported as such, not as a missing key", async () => {
  const { sql, DB } = mkDB();
  // Rebuild the table with a CHECK that rejects one synthetic workspace (INSERT OR IGNORE would silently skip it).
  sql.exec(`DROP TABLE workspace_keys;
    CREATE TABLE workspace_keys (workspace_id TEXT NOT NULL CHECK (workspace_id <> 'wsp_broken'), key_id TEXT PRIMARY KEY,
      master_version INTEGER NOT NULL, wrapped TEXT NOT NULL, created_at INTEGER NOT NULL, shredded_at INTEGER);`);
  sql.exec(readFileSync(join(ROOT, "migrations", "0029_workspace_keys.sql"), "utf8"));
  const base = configuredBase(DB);
  const logs = await captureErrors(() => assert.rejects(lib.workspaceDataKey(request(base), "wsp_broken"),
    (e) => e.status === 500 && e.code === "key_create_failed" && !/wsp_broken|CHECK/.test(e.message)));
  assert.ok(logs.some((l) => l.includes("key_create_failed") && l.includes("wsp_broken")), "the log has the workspace id");
  assert.equal((await lib.workspaceDataKey(request(base), WS_A)).workspaceId, WS_A, "other workspaces are fine");
});

test("the core check of what a provider's unwrap returns: an extractable, non-HKDF or wider-usage key is rejected", async () => {
  const { DB } = mkDB();
  const base = configuredBase(DB);
  await lib.workspaceDataKey(request(base), WS_A);
  const d = lib.defaultAdapters().keyProvider;
  // Node's WebCrypto cannot make an extractable HKDF key, so a CryptoKey whose getters are shadowed stands in.
  const fakeKey = (props) => Object.defineProperties(Object.create(CryptoKey.prototype), Object.fromEntries(Object.entries(props).map(([k, value]) => [k, { value }])));
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const returns = {
    "extractable HKDF": fakeKey({ algorithm: { name: "HKDF" }, extractable: true, usages: ["deriveKey"], type: "secret" }),
    "PBKDF2 (not HKDF)": await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]),
    "AES-GCM key": await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]),
    "HKDF with deriveKey and deriveBits": await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey", "deriveBits"]),
    "HKDF with deriveBits only": await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]),
    "raw bytes": raw,
  };
  for (const [name, key] of Object.entries(returns)) {
    await assert.rejects(lib.workspaceDataKey(request(base, { keyProvider: { ...d, unwrap: async () => key } }), WS_A), (e) => e.code === "key_provider_invalid", name);
  }
});

test("two wraps of the same key bytes use different IVs", async () => {
  const base = { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() };
  const P = lib.defaultAdapters().keyProvider;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const ctx = { workspaceId: WS_A, keyId: "wk_synthetic", masterVersion: 1 };
  const w1 = Buffer.from(await P.wrap(base, raw.slice(), ctx), "base64url");
  const w2 = Buffer.from(await P.wrap(base, raw.slice(), ctx), "base64url");
  assert.notEqual(w1.subarray(0, 12).toString("hex"), w2.subarray(0, 12).toString("hex"), "IVs differ");
  assert.notEqual(w1.subarray(12).toString("hex"), w2.subarray(12).toString("hex"), "ciphertexts differ");
});

test("the master key is imported with only the usage each operation needs", async () => {
  const base = { CONTENT_MASTER_KEY_VERSION: "1", CONTENT_MASTER_KEY_V1: masterSecret() };
  const P = lib.defaultAdapters().keyProvider;
  const ctx = { workspaceId: WS_A, keyId: "wk_synthetic", masterVersion: 1 };
  const seen = [];
  const subtle = crypto.subtle;
  const real = subtle.importKey;
  subtle.importKey = function (...a) { seen.push(a[4]); return real.apply(subtle, a); };
  try {
    const wrapped = await P.wrap(base, crypto.getRandomValues(new Uint8Array(32)), ctx);
    await P.unwrap(base, wrapped, ctx);
  } finally { delete subtle.importKey; }
  assert.equal(subtle.importKey, real);
  assert.deepEqual(seen, [["encrypt"], ["unwrapKey"]]);
});

test("master secret and version parsing: alphabets, padding, newline, 32 characters, empty and numeric version", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const std = Buffer.from(bytes).toString("base64"); // 44 characters, one "="
  const url = Buffer.from(bytes).toString("base64url"); // 43 characters
  const P = lib.defaultAdapters().keyProvider;
  const ctx = { workspaceId: WS_A, keyId: "wk_synthetic", masterVersion: 1 };
  const env = (secret, version = "1") => ({ CONTENT_MASTER_KEY_VERSION: version, CONTENT_MASTER_KEY_V1: secret });
  // Every accepted spelling decodes to the same 32 bytes, so a key wrapped with one unwraps with another.
  let mixed = std.replace(/=$/, "");
  for (let i = 0; i < mixed.length; i++) if (mixed[i] === "+" || mixed[i] === "/") { mixed = mixed.slice(0, i) + (mixed[i] === "+" ? "-" : "_") + mixed.slice(i + 1); break; }
  const accepted = [std, url, url + "=", std.replace(/=$/, ""), mixed];
  const wrapped = await P.wrap(env(std), crypto.getRandomValues(new Uint8Array(32)), ctx);
  for (const s of accepted) {
    assert.equal(P.configured(env(s)), true, s.length + " chars");
    assertDataKey(await P.unwrap(env(s), wrapped, ctx));
  }
  const rejected = [std + "\n", " " + std, std + "==".slice(0, 1) + "=", "a".repeat(32), Buffer.from("a".repeat(32)).toString("hex"), std.slice(0, -2)];
  for (const s of rejected) assert.throws(() => P.configured(env(s)), (e) => e.code === "master_key_invalid", JSON.stringify(s.slice(-3)) + " " + s.length);
  // Version: "" and unset are "not configured"; a number is accepted like a string of digits.
  assert.equal(P.configured(env(std, "")), false);
  assert.equal(P.configured({ CONTENT_MASTER_KEY_V1: std }), false);
  assert.equal(P.configured(env(std, 1)), true);
  assert.equal(P.currentVersion(env(std, 1)), 1);
  for (const v of [0, -1, 1.5, NaN, 2 ** 53, "01", " 1", "1 "]) assert.throws(() => P.configured(env(std, v)), (e) => e.code === "master_key_version_invalid", String(v));
});

test("migration 0029 applies twice without error and adds the partial unique index", () => {
  const sql = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  sql.exec(readFileSync(join(ROOT, "migrations", "0029_workspace_keys.sql"), "utf8"));
  const cols = sql.prepare("PRAGMA table_info(workspace_keys)").all().map((c) => c.name);
  assert.deepEqual(cols, ["workspace_id", "key_id", "master_version", "wrapped", "created_at", "shredded_at"]);
  const ins = sql.prepare("INSERT INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at, shredded_at) VALUES (?, ?, 1, 'x', 1, ?)");
  ins.run("wsp_x", "wk_1", 5);
  ins.run("wsp_x", "wk_2", null);
  assert.throws(() => ins.run("wsp_x", "wk_3", null), /UNIQUE/);
  // A plain index serves the lookups by workspace (shredded rows, NOT EXISTS) without scanning the table.
  const indexes = sql.prepare("PRAGMA index_list(workspace_keys)").all().map((i) => i.name);
  assert.ok(indexes.includes("workspace_keys_active") && indexes.includes("workspace_keys_workspace"), indexes.join());
  for (const q of ["SELECT 1 FROM workspace_keys WHERE workspace_id = ? AND shredded_at IS NOT NULL LIMIT 1", "SELECT 1 FROM workspace_keys WHERE workspace_id = ? LIMIT 1"]) {
    const plan = sql.prepare("EXPLAIN QUERY PLAN " + q).all("wsp_x").map((r) => r.detail).join(" | ");
    assert.match(plan, /USING (COVERING )?INDEX workspace_keys_workspace/, plan);
  }
});
