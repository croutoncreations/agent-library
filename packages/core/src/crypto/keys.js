// Workspace data keys (docs/encryption.md#workspace-keys): one active key per workspace in D1 `workspace_keys`, wrapped
// by the keyProvider adapter (default: worker-secret-keys.js). In memory a data key exists only as a non-extractable
// HKDF CryptoKey (usages ["deriveKey"]); its raw bytes exist only while a new key is created, then are zeroed.
// Nothing calls this yet: content is not encrypted. docs/encryption.md#rules-for-code-that-uses-this says how to.
import { adapters } from "../adapters.js";
import { HttpError, randomId } from "../util.js";

const DATA_KEY_BYTES = 32;
const DATA_KEY_MEMO = Symbol("agent-library.data-key-memo");

/** A request's env with its own data-key memo (createWorker attaches one per fetch). Never shared across requests. */
export const withDataKeyMemo = (env) => ({ ...env, [DATA_KEY_MEMO]: new Map() });

/** Within one request, load once per name; a failure is forgotten so the next call tries again. */
function memoized(env, name, load) {
  const memo = env?.[DATA_KEY_MEMO];
  if (!memo) return load();
  if (!memo.has(name)) memo.set(name, load().catch((e) => { memo.delete(name); throw e; }));
  return memo.get(name);
}

/** Concurrent callers in one request share one in-flight load; it is forgotten once settled, so later calls load again. */
function shared(env, name, load) {
  const memo = env?.[DATA_KEY_MEMO];
  if (!memo) return load();
  let p = memo.get(name);
  if (!p) {
    p = load().finally(() => { if (memo.get(name) === p) memo.delete(name); });
    memo.set(name, p);
  }
  return p;
}

/** Server log for a refusal: ids and codes only, never key material. Client-visible messages carry neither. */
const logKeyEvent = (event, detail) => console.error(JSON.stringify({ event, ...detail }));
const providerInvalid = (message) => new HttpError(500, "key_provider_invalid", message);
const isPositiveVersion = (v) => Number.isSafeInteger(v) && v > 0;
/** Keep a rejected Promise that is about to be refused from surfacing as an unhandled rejection. */
const quiet = (v) => { if (typeof v?.then === "function") v.then(() => {}, () => {}); };

/**
 * Is content encryption configured? The keyProvider's configured(env), which must return a boolean synchronously:
 * anything else (a Promise included) is an error, never "off". Throws when the configuration is malformed.
 */
export function encryptionConfigured(env) {
  const v = adapters(env).keyProvider.configured(env);
  if (typeof v !== "boolean") {
    quiet(v);
    throw providerInvalid("The key provider's configured() must return a boolean synchronously");
  }
  return v;
}

/** The message of every encryption_misconfigured refusal (also createWorker's). Names no secret. */
export const ENCRYPTION_MISCONFIGURED_MESSAGE = "Content encryption is required but not configured";

/**
 * Does this installation require content encryption? Worker var CONTENT_ENCRYPTION_REQUIRED: unset, "", "0" or 0 is
 * not required; "1" or 1 is required. Any other value ("true", a TOML boolean, " 1") is never read as "off": it throws
 * 500 encryption_misconfigured. The caller logs it (never the value).
 */
export function encryptionRequired(env) {
  const v = env?.CONTENT_ENCRYPTION_REQUIRED;
  if (v === undefined || v === null || v === "" || v === "0" || v === 0) return false;
  if (v === "1" || v === 1) return true;
  throw new HttpError(500, "encryption_misconfigured", ENCRYPTION_MISCONFIGURED_MESSAGE);
}

/**
 * Should new content be encrypted? The one decision later slices use for writing (never encryptionConfigured() alone).
 * true when configured (no query). false only when not configured, not required and `workspace_keys` has no real key
 * row (master_version > 0, shredded or not; a shred's tombstone has master_version 0 and does not count), probed on
 * every such call, never cached: another request may create the first key at any time. Otherwise 500
 * encryption_misconfigured: CONTENT_ENCRYPTION_REQUIRED has an invalid value (checked first), required but not
 * configured, or encryption was in use (real key rows exist) and its configuration is gone, which must never turn into
 * writing plaintext. A malformed configuration throws its own error.
 */
export async function encryptionEnabled(env) {
  let required;
  try { required = encryptionRequired(env); }
  catch (e) { logKeyEvent("encryption_misconfigured", { reason: "required_value_invalid" }); throw e; }
  if (encryptionConfigured(env)) return true;
  const inUse = !required && !!(await env.DB.prepare("SELECT 1 AS x FROM workspace_keys WHERE master_version > 0 LIMIT 1").first("x"));
  if (required || inUse) {
    logKeyEvent("encryption_misconfigured", { reason: required ? "required_not_configured" : "key_rows_exist_not_configured" });
    throw new HttpError(500, "encryption_misconfigured", ENCRYPTION_MISCONFIGURED_MESSAGE);
  }
  return false;
}

const ROW_COLUMNS = "workspace_id, key_id, master_version, wrapped, created_at, shredded_at";
// A row is shredded when shredded_at is set or its wrapped key was overwritten with ''.
const SHREDDED_SQL = "(shredded_at IS NOT NULL OR wrapped = '')";
const activeRow = (env, workspaceId) =>
  env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM workspace_keys WHERE workspace_id = ? AND shredded_at IS NULL`).bind(workspaceId).first();
const hasShreddedRow = async (env, workspaceId) =>
  !!(await env.DB.prepare(`SELECT 1 AS x FROM workspace_keys WHERE workspace_id = ? AND ${SHREDDED_SQL} LIMIT 1`).bind(workspaceId).first("x"));
const isShredded = (row) => (row.shredded_at !== null && row.shredded_at !== undefined) || row.wrapped === "";
const shredded = () => new HttpError(410, "key_shredded", "This workspace's content key has been shredded");

/**
 * Unwrap a row's data key through the provider and check what the provider returned. Refuses a shredded row and an
 * invalid master version before the provider sees anything. The memo is keyed by everything the wrap authenticates
 * (workspace id, key id, master version, wrapped value), so a row that changed during the request is unwrapped afresh.
 */
function unwrapRow(env, row) {
  if (isShredded(row)) throw shredded();
  if (!isPositiveVersion(row.master_version) || typeof row.wrapped !== "string") {
    logKeyEvent("key_row_invalid", { workspaceId: row.workspace_id, keyId: row.key_id });
    throw new HttpError(500, "key_row_invalid", "A workspace key record is invalid");
  }
  const memoKey = "key:" + JSON.stringify([row.workspace_id, row.key_id, row.master_version, row.wrapped]);
  return memoized(env, memoKey, async () => {
    const ctx = { workspaceId: row.workspace_id, keyId: row.key_id, masterVersion: row.master_version };
    const key = await adapters(env).keyProvider.unwrap(env, row.wrapped, ctx);
    if (!(key instanceof CryptoKey) || key.algorithm?.name !== "HKDF" || key.extractable !== false || key.usages.length !== 1 || key.usages[0] !== "deriveKey") {
      throw providerInvalid("The key provider must return a non-extractable HKDF key usable only for deriveKey");
    }
    return Object.freeze({ ...ctx, key });
  });
}

/** Create the workspace's first data key unless it already has an active one or any shredded one. */
async function createDataKey(env, workspaceId) {
  const provider = adapters(env).keyProvider;
  const masterVersion = provider.currentVersion(env);
  if (!isPositiveVersion(masterVersion)) {
    quiet(masterVersion);
    throw providerInvalid("The key provider's currentVersion() must return a positive integer");
  }
  const keyId = randomId("wk");
  const raw = crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
  let wrapped;
  try { wrapped = await provider.wrap(env, raw, { workspaceId, keyId, masterVersion }); }
  finally { raw.fill(0); }
  if (typeof wrapped !== "string" || !wrapped) {
    quiet(wrapped);
    throw providerInvalid("The key provider returned no wrapped key");
  }
  // Losing the race to a concurrent first use hits the partial unique index (one active key per workspace) and does
  // nothing; the caller re-selects the winner. Any other failure throws (key_create_failed). The NOT EXISTS keeps a
  // shredded or tombstoned workspace from getting a new key, even if it was shredded after the pre-check.
  try {
    await env.DB.prepare(
      `INSERT INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at, shredded_at)
       SELECT ?, ?, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM workspace_keys WHERE workspace_id = ? AND ${SHREDDED_SQL})
       ON CONFLICT (workspace_id) WHERE shredded_at IS NULL DO NOTHING`
    ).bind(workspaceId, keyId, masterVersion, wrapped, Date.now(), workspaceId).run();
  } catch (e) {
    logKeyEvent("key_create_failed", { workspaceId, keyId, error: String(e?.message ?? e).slice(0, 200) });
    throw new HttpError(500, "key_create_failed", "The workspace key could not be created");
  }
}

/**
 * The workspace's active row, creating the first key if there is none. Refuses a shredded workspace. Every call does
 * its own reads; only the creation is shared between concurrent callers in one request, and each re-selects after it.
 */
async function activeOrCreatedRow(env, workspaceId) {
  const row = await activeRow(env, workspaceId);
  if (row) return row;
  if (await hasShreddedRow(env, workspaceId)) throw shredded();
  await shared(env, "create:" + workspaceId, () => createDataKey(env, workspaceId));
  const created = await activeRow(env, workspaceId);
  if (created) return created;
  if (await hasShreddedRow(env, workspaceId)) throw shredded();
  logKeyEvent("key_not_found", { workspaceId, after: "create" });
  throw new HttpError(500, "key_not_found", "The workspace key disappeared after it was created");
}

/**
 * The workspace's active data key for encrypting: { workspaceId, keyId, masterVersion, key }, creating it on first use.
 * Every call does its own read of the active row, so a call that starts after a completed shred is refused (only the
 * unwrap is memoized per request, keyed by the whole row); concurrent first use in one request shares one creation,
 * so it wraps one candidate key and yields one key for every caller. Refuses unless the keyProvider is
 * configured and well-formed, even if the workspace already has a row (500 encryption_not_configured, or the
 * configuration's own error), and refuses a shredded workspace (410 key_shredded).
 */
export async function workspaceDataKey(env, workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId) throw new HttpError(500, "invalid_workspace", "A workspace id is required");
  if (!encryptionConfigured(env)) throw new HttpError(500, "encryption_not_configured", "Content encryption is not configured");
  return unwrapRow(env, await activeOrCreatedRow(env, workspaceId));
}

/**
 * The data key a stored object names, for decrypting: { workspaceId, keyId, masterVersion, key }. workspaceId must
 * come from the server-side project, never from the stored object. Refuses an unknown key id and a key of another
 * workspace than expected with the same client answer (500 key_not_found, so a client cannot tell whether a key id
 * exists elsewhere; the log tells them apart), and a shredded key (410 key_shredded). Needs no
 * current configuration beyond the row's master key: whether to decrypt is decided by the stored object.
 */
export async function dataKeyById(env, workspaceId, keyId) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof keyId !== "string" || !keyId) throw new HttpError(500, "invalid_key_id", "A workspace id and key id are required");
  const row = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM workspace_keys WHERE key_id = ?`).bind(keyId).first();
  const notFound = () => new HttpError(500, "key_not_found", "The workspace key does not exist");
  if (!row) {
    logKeyEvent("key_not_found", { workspaceId, keyId });
    throw notFound();
  }
  if (row.workspace_id !== workspaceId) {
    logKeyEvent("key_workspace_mismatch", { workspaceId, keyId, rowWorkspaceId: row.workspace_id });
    throw notFound();
  }
  return unwrapRow(env, row);
}

/**
 * Shred a workspace's keys (docs/encryption.md#limits says what this does not protect against). Every row of the
 * workspace gets shredded_at (an existing one is kept) and its wrapped key overwritten with ''. A workspace with no
 * row at all gets a tombstone (shredded, wrapped '', master_version 0) so it can never get a key later. Idempotent.
 * The tombstone goes in before the update: a concurrent first use either sees it (and is refused by NOT EXISTS) or
 * inserted its row first (and the update shreds it). A key already unwrapped by a request in flight stays usable in
 * that request (docs/encryption.md#rules-for-code-that-uses-this). Nothing calls this yet.
 */
export async function shredWorkspaceKeys(env, workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId) throw new HttpError(500, "invalid_workspace", "A workspace id is required");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at, shredded_at)
     SELECT ?, ?, 0, '', ?, ? WHERE NOT EXISTS (SELECT 1 FROM workspace_keys WHERE workspace_id = ?)`
  ).bind(workspaceId, randomId("wk"), now, now, workspaceId).run();
  await env.DB.prepare(
    "UPDATE workspace_keys SET shredded_at = COALESCE(shredded_at, ?), wrapped = '' WHERE workspace_id = ? AND (shredded_at IS NULL OR wrapped <> '')"
  ).bind(now, workspaceId).run();
}
