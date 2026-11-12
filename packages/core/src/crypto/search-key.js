// The workspace's blind-index search key (slice 4a), derived here so the raw workspace data key never leaves crypto/
// (search/tokens.js receives only the derived key). HKDF-SHA-256 of the data key, empty salt, info
// "al-search/1" ‖ 0x00 ‖ UTF-8(workspaceId); the result is an HMAC-SHA-256 key, non-extractable, usage sign only.
import { workspaceDataKey } from "./keys.js";

const SEARCH_INFO = "al-search/1";
/** Derived search keys, per data-key object (data keys are memoized per request, so this is per request too). */
const derivedKeys = new WeakMap();

/** "al-search/1" ‖ 0x00 ‖ UTF-8(workspaceId). */
export function searchKeyInfo(workspaceId) {
  const prefix = new TextEncoder().encode(SEARCH_INFO), id = new TextEncoder().encode(workspaceId);
  const info = new Uint8Array(prefix.length + 1 + id.length);
  info.set(prefix, 0);
  info.set(id, prefix.length + 1);
  return info;
}

/** HMAC-SHA-256 key for sign only, non-extractable, derived from a data key (HKDF-SHA-256, empty salt, searchKeyInfo). */
export function deriveSearchKey(dataKey, workspaceId) {
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: searchKeyInfo(workspaceId) },
    dataKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

/**
 * The workspace's search key when content encryption is on: { keyId, key }, where keyId is the active data key's id
 * and key is derived from it (memoized per data-key object). Refuses exactly as workspaceDataKey does (410
 * key_shredded, 500 encryption_not_configured, …). Never returns or logs the data key.
 */
export async function workspaceSearchKey(env, workspaceId) {
  const dk = await workspaceDataKey(env, workspaceId);
  let p = derivedKeys.get(dk.key);
  if (!p) { p = deriveSearchKey(dk.key, workspaceId); derivedKeys.set(dk.key, p); }
  return { keyId: dk.keyId, key: await p };
}
