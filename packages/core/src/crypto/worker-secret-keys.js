// The default keyProvider adapter (adapters.js): workspace data keys wrapped with AES-256-GCM under a versioned master
// key held as a Worker secret (docs/encryption.md#workspace-keys). A hosted installation can replace this adapter with
// one backed by an external KMS; row storage, first use and the per-request memo stay in crypto/keys.js.
//
// Secrets: CONTENT_MASTER_KEY_V<n> (base64 or base64url of exactly 32 random bytes) and the var
// CONTENT_MASTER_KEY_VERSION naming the current n. Key material never appears in errors or logs.
import { HttpError, b64url } from "../util.js";

const VERSION_VAR = "CONTENT_MASTER_KEY_VERSION";
const secretName = (version) => `CONTENT_MASTER_KEY_V${version}`;
const IV_BYTES = 12, DATA_KEY_BYTES = 32, TAG_BYTES = 16;
const AAD_LABEL = "al-dek/1";

const configError = (code, message) => new HttpError(500, code, message);

/** The current master version, or null when CONTENT_MASTER_KEY_VERSION is unset. Throws if it is not a positive integer. */
function currentMasterVersion(env) {
  const v = env?.[VERSION_VAR];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^[1-9][0-9]{0,8}$/.test(v)) throw configError("master_key_version_invalid", `${VERSION_VAR} must be a positive integer`);
  return Number(v);
}

/** The 32 bytes of CONTENT_MASTER_KEY_V<version>. Throws (naming the secret, never its value) if unset or malformed. */
function masterKeyBytes(env, version) {
  const name = secretName(version);
  const s = env?.[name];
  if (s === undefined || s === null) throw configError("master_key_missing", `Content master key ${name} is not set`);
  const invalid = () => configError("master_key_invalid", `Content master key ${name} must be the base64 or base64url encoding of exactly 32 bytes`);
  if (typeof s !== "string" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw invalid();
  let bin;
  try {
    const std = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  } catch { throw invalid(); }
  if (bin.length !== DATA_KEY_BYTES) throw invalid();
  const out = new Uint8Array(DATA_KEY_BYTES);
  for (let i = 0; i < DATA_KEY_BYTES; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importMasterKey(env, version) {
  const bytes = masterKeyBytes(env, version);
  try { return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "unwrapKey"]); }
  finally { bytes.fill(0); }
}

/**
 * Additional data binding a wrapped data key to its row: "al-dek/1", workspace id, key id and master version (decimal),
 * each as a 4-byte big-endian length followed by its UTF-8 bytes, so no two different tuples give the same bytes.
 */
export function dataKeyAad({ workspaceId, keyId, masterVersion }) {
  const enc = new TextEncoder();
  const fields = [AAD_LABEL, String(workspaceId), String(keyId), String(masterVersion)].map((f) => enc.encode(f));
  const out = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of fields) { view.setUint32(at, f.length); out.set(f, at + 4); at += 4 + f.length; }
  return out;
}

function fromB64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const std = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
}

export const workerSecretKeyProvider = {
  name: "worker-secret",
  /** Is encryption configured? false when CONTENT_MASTER_KEY_VERSION is unset; throws if it or its secret is malformed. */
  configured(env) {
    const v = currentMasterVersion(env);
    if (v === null) return false;
    masterKeyBytes(env, v).fill(0);
    return true;
  },
  /** The master version new data keys are wrapped under. */
  currentVersion(env) {
    const v = currentMasterVersion(env);
    if (v === null) throw configError("encryption_not_configured", `Content encryption is not configured (${VERSION_VAR} is unset)`);
    return v;
  },
  /** Wrap 32 raw data-key bytes under master version ctx.masterVersion: base64url(IV ‖ ciphertext ‖ tag). */
  async wrap(env, raw, ctx) {
    const master = await importMasterKey(env, ctx.masterVersion);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: dataKeyAad(ctx) }, master, raw));
    const out = new Uint8Array(IV_BYTES + ct.length);
    out.set(iv);
    out.set(ct, IV_BYTES);
    return b64url(out);
  },
  /** Unwrap straight to a non-extractable HKDF CryptoKey (usages ["deriveKey"]); fails unless ctx matches the wrap. */
  async unwrap(env, wrapped, ctx) {
    const master = await importMasterKey(env, ctx.masterVersion);
    const failed = () => new HttpError(500, "key_unwrap_failed", `Workspace key ${ctx.keyId} could not be unwrapped`);
    const buf = fromB64url(wrapped);
    if (!buf || buf.length !== IV_BYTES + DATA_KEY_BYTES + TAG_BYTES) throw failed();
    try {
      return await crypto.subtle.unwrapKey("raw", buf.subarray(IV_BYTES), master, { name: "AES-GCM", iv: buf.subarray(0, IV_BYTES), additionalData: dataKeyAad(ctx) }, "HKDF", false, ["deriveKey"]);
    } catch { throw failed(); }
  }
};
