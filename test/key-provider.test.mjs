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
  "crypto/keys.js": ["encryptionConfigured", "workspaceDataKey", "dataKeyById", "withDataKeyMemo"],
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
  await assert.rejects(lib.dataKeyById(request(v1Gone), WS_A, a.keyId),
    (e) => e.code === "master_key_missing" && /CONTENT_MASTER_KEY_V1\b/.test(e.message) && !e.message.includes(v2));
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
    const check = (e) => e.code === code && (!secret || !e.message.includes(secret)) && /CONTENT_MASTER_KEY_V/.test(e.message);
    assert.throws(() => lib.encryptionConfigured(env(vars)), check, JSON.stringify(Object.keys(vars)));
    await assert.rejects(lib.workspaceDataKey(env(vars), WS_A), check);
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
  await assert.rejects(lib.dataKeyById(request(base), WS_B, a.keyId), (e) => e.code === "key_workspace_mismatch");
  // Also when the key is already in this request's memo.
  const r = request(base);
  await lib.dataKeyById(r, WS_A, a.keyId);
  await assert.rejects(lib.dataKeyById(r, WS_B, a.keyId), (e) => e.code === "key_workspace_mismatch");
  await assert.rejects(lib.dataKeyById(request(base), WS_A, "wk_unknown"), (e) => e.code === "key_not_found");

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
});
