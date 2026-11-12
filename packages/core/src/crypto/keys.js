// Workspace data keys (docs/encryption.md#workspace-keys): one active key per workspace in D1 `workspace_keys`, wrapped
// by the keyProvider adapter (default: worker-secret-keys.js). In memory a data key exists only as a non-extractable
// HKDF CryptoKey (usages ["deriveKey"]); its raw bytes exist only while a new key is created, then are zeroed.
// Nothing calls this yet: content is not encrypted.
import { adapters } from "../adapters.js";
import { HttpError, randomId } from "../util.js";

const DATA_KEY_BYTES = 32;
const DATA_KEY_MEMO = Symbol("agent-library.data-key-memo");

/** A request's env with its own data-key memo (createWorker attaches one per fetch). Never shared across requests. */
export const withDataKeyMemo = (env) => ({ ...env, [DATA_KEY_MEMO]: new Map() });

/** Within one request each key is unwrapped once; a failure is forgotten so the next call tries again. */
function memoized(env, name, load) {
  const memo = env?.[DATA_KEY_MEMO];
  if (!memo) return load();
  if (!memo.has(name)) memo.set(name, load().catch((e) => { memo.delete(name); throw e; }));
  return memo.get(name);
}

/** Is content encryption configured? false when unset; throws when the configuration is malformed. */
export function encryptionConfigured(env) {
  return adapters(env).keyProvider.configured(env) === true;
}

const ROW_COLUMNS = "workspace_id, key_id, master_version, wrapped, created_at, shredded_at";
const activeRow = (env, workspaceId) =>
  env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM workspace_keys WHERE workspace_id = ? AND shredded_at IS NULL`).bind(workspaceId).first();
const hasShreddedRow = async (env, workspaceId) =>
  !!(await env.DB.prepare("SELECT 1 AS x FROM workspace_keys WHERE workspace_id = ? AND shredded_at IS NOT NULL LIMIT 1").bind(workspaceId).first("x"));
const shredded = (workspaceId) => new HttpError(410, "key_shredded", `The content key of workspace ${workspaceId} was destroyed`);

/** Unwrap a row's data key through the provider (once per request per key id) and check what the provider returned. */
function unwrapRow(env, row) {
  return memoized(env, "key:" + row.key_id, async () => {
    const ctx = { workspaceId: row.workspace_id, keyId: row.key_id, masterVersion: row.master_version };
    const key = await adapters(env).keyProvider.unwrap(env, row.wrapped, ctx);
    if (!(key instanceof CryptoKey) || key.algorithm?.name !== "HKDF" || key.extractable || key.usages.length !== 1 || key.usages[0] !== "deriveKey") {
      throw new HttpError(500, "key_provider_invalid", "The key provider must return a non-extractable HKDF key usable only for deriveKey");
    }
    return Object.freeze({ ...ctx, key });
  });
}

/** Create the workspace's first data key unless it already has an active one or any shredded one. */
async function createDataKey(env, workspaceId) {
  const provider = adapters(env).keyProvider;
  const masterVersion = provider.currentVersion(env);
  const keyId = randomId("wk");
  const raw = crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
  let wrapped;
  try { wrapped = await provider.wrap(env, raw, { workspaceId, keyId, masterVersion }); }
  finally { raw.fill(0); }
  if (typeof wrapped !== "string" || !wrapped) throw new HttpError(500, "key_provider_invalid", "The key provider returned no wrapped key");
  // The partial unique index (one active key per workspace) makes concurrent first use keep exactly one row; the
  // NOT EXISTS keeps a workspace whose key was shredded from getting a new one.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workspace_keys (workspace_id, key_id, master_version, wrapped, created_at, shredded_at)
     SELECT ?, ?, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM workspace_keys WHERE workspace_id = ? AND shredded_at IS NOT NULL)`
  ).bind(workspaceId, keyId, masterVersion, wrapped, Date.now(), workspaceId).run();
}

/**
 * The workspace's active data key for encrypting: { workspaceId, keyId, masterVersion, key }, creating it on first use.
 * Concurrent first use yields one key for every caller. Refuses (410 key_shredded) a workspace whose key was shredded,
 * and (500 encryption_not_configured) when the keyProvider is not configured.
 */
export async function workspaceDataKey(env, workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId) throw new HttpError(500, "invalid_workspace", "A workspace id is required");
  return memoized(env, "ws:" + workspaceId, async () => {
    let row = await activeRow(env, workspaceId);
    if (!row) {
      if (await hasShreddedRow(env, workspaceId)) throw shredded(workspaceId);
      if (!encryptionConfigured(env)) throw new HttpError(500, "encryption_not_configured", "Content encryption is not configured");
      await createDataKey(env, workspaceId);
      row = await activeRow(env, workspaceId);
      if (!row) throw (await hasShreddedRow(env, workspaceId)) ? shredded(workspaceId) : new HttpError(500, "key_not_found", "The workspace key could not be created");
    }
    return unwrapRow(env, row);
  });
}

/**
 * The data key a stored object names, for decrypting: { workspaceId, keyId, masterVersion, key }. Refuses an unknown
 * key id (500 key_not_found), a shredded key (410 key_shredded) and a key of another workspace than expected
 * (500 key_workspace_mismatch).
 */
export async function dataKeyById(env, workspaceId, keyId) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof keyId !== "string" || !keyId) throw new HttpError(500, "invalid_key_id", "A workspace id and key id are required");
  const row = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM workspace_keys WHERE key_id = ?`).bind(keyId).first();
  if (!row) throw new HttpError(500, "key_not_found", `Workspace key ${keyId} does not exist`);
  if (row.workspace_id !== workspaceId) throw new HttpError(500, "key_workspace_mismatch", `Workspace key ${keyId} belongs to another workspace`);
  if (row.shredded_at !== null && row.shredded_at !== undefined) throw shredded(workspaceId);
  return unwrapRow(env, row);
}
