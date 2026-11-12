// Blind-index search tokens (slice 4a). Nothing reads the tokens until slice 4b; search results do not change.
//
// For each current text version, D1 stores a 16-byte HMAC-SHA-256 of each distinct folded word (the index's own
// unicode61 tokenizer, search/unicode61.js), keyed per workspace (encryption on: HKDF from the workspace data key,
// info "al-search/1" ‖ 0x00 ‖ workspaceId; off: a random per-workspace secret in workspace_search_keys). Every token
// write is a fenced batch (keyFence / plaintextFence, last), gated by the head ($H), a live project ($LIVE), the run's
// writer lease ($MINE) and the row's own immutable scopes ($SCOPE), and counted in the same transaction in three exact
// counters of charged units (tokens + 5 per document row): workspace, owner and installation.
//
// Memory (rule b): one holder per run owns everything large (texts, extracted terms, tokens, the set being diffed, the
// charged removes and the packed batch). Processing is a loop of bounded steps; across an `await` only the call in flight
// holds large data. Every D1 call goes through runEnv(), which checks the deadline, the call budget and detachment before
// and after the call, so a late result is never stored.
import { fenceRefusal, keyFence, plaintextFence } from "../content-store.js";
import { encryptionEnabled, workspaceDataKey } from "../crypto/keys.js";
import { workspaceLimits } from "../limits.js";
import { HttpError, randomId } from "../util.js";
import { U61_TOKEN, u61FoldToken } from "./unicode61.js";

const MiB = 1048576;
/** Most distinct words stored per text version (SEARCH_TERMS_MAX can only lower it). */
export const SEARCH_TERMS_CEILING = 20000;
/** Folded words longer than this (UTF-16 code units) are skipped; queries are at most 200 characters. */
export const SEARCH_TERM_UNITS_MAX = 200;
/** Accounting per capped term, token or remove value (the value, its hex string and its JSON share). */
export const SEARCH_TOKEN_BYTES = 96;
/** Token values bound in one D1 batch, summed over every statement, and statements per batch. */
export const SEARCH_BATCH_TOKENS_MAX = 10000;
export const SEARCH_BATCH_STATEMENTS_MAX = 100;
/** Per document and batch: at most this many removes and this many adds. */
const DOC_SIDE_MAX = 5000;
/** A stable read groups at most this many documents (two bound values each) and this many stored tokens. */
const STABLE_GROUP_DOCS = 40;
const STABLE_GROUP_TOKENS = SEARCH_TERMS_CEILING;
const SET_READ_LIMIT = SEARCH_TERMS_CEILING + 1;
const HMAC_CHUNK = 1000;
/** Run budgets: D1 calls (clamped to 1000 − declared − 20), documents, token operations, text code units. */
export const SEARCH_RUN_LIMITS = Object.freeze({ calls: 18, docs: 100, tokenOps: 50000, textUnits: 10 * MiB });
/** Run deadline after it starts. */
export const SEARCH_RUN_DEADLINE_MS = 20000;
/** Per-run payload accounting: the run (envelope + base + payload) never exceeds this. */
export const SEARCH_CALL_ENVELOPE_BYTES = 4 * MiB;
export const SEARCH_RUN_BASE_BYTES = 64 * 1024;
export const SEARCH_RUN_MAX_BYTES = 26 * MiB;
/** Default scope bounds in charged units (workspace: entitlements `search_terms`, else SEARCH_WORKSPACE_TERMS_MAX). */
export const SEARCH_BOUNDS_DEFAULT = Object.freeze({ workspace: 1000000, owner: 3000000, installation: 50000000 });
const DOC_ROW_UNITS = 5;
const SCOPE_REASONS = ["workspace", "owner", "installation"];

// --- Worker vars --------------------------------------------------------------------------------------------------
const varCount = (v) => typeof v === "number" ? (Number.isSafeInteger(v) && v >= 0 ? v : null)
  : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : null;
/** SEARCH_TERMS_MAX: 0–20000 (lower only; default 20000). 0 = no body tokens and no extraction. */
export const searchTermsMax = (env) => Math.min(varCount(env?.SEARCH_TERMS_MAX) ?? SEARCH_TERMS_CEILING, SEARCH_TERMS_CEILING);
/** The three bounds in charged units; `limits` is the workspace's entitlements (its `search_terms`, if any). */
export function searchScopeBounds(env, limits = {}) {
  const plan = limits?.search_terms;
  return {
    workspace: Number.isSafeInteger(plan) && plan >= 0 ? plan : varCount(env?.SEARCH_WORKSPACE_TERMS_MAX) ?? SEARCH_BOUNDS_DEFAULT.workspace,
    owner: varCount(env?.SEARCH_OWNER_TERMS_MAX) ?? SEARCH_BOUNDS_DEFAULT.owner,
    installation: Math.min(varCount(env?.SEARCH_INSTALLATION_TERMS_MAX) ?? SEARCH_BOUNDS_DEFAULT.installation, SEARCH_BOUNDS_DEFAULT.installation),
  };
}
/** SEARCH_SWEEP_WRITES_MAX: b-tree rows the sweep writes per cron run (lower only, default 10000; 0 off; 1–49 as 50). */
export function searchSweepWritesMax(env) {
  const n = Math.min(varCount(env?.SEARCH_SWEEP_WRITES_MAX) ?? 10000, 10000);
  return n === 0 ? 0 : Math.max(n, 50);
}
/** UTF-8 length of a string without encoding it (a lone surrogate counts as U+FFFD, 3 bytes). */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n++;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
/** Per-document cap: min(SEARCH_TERMS_MAX, 256 + floor(bytes / 8)). */
export const searchDocCap = (env, textBytes) => Math.min(searchTermsMax(env), 256 + Math.floor(textBytes / 8));
/** The target's own truncation when extraction stopped at `cap`: off, cap (the var) or size (the text's size). */
const capReason = (env, cap) => cap === 0 ? "off" : cap === searchTermsMax(env) ? "cap" : "size";

// --- Extraction ---------------------------------------------------------------------------------------------------
/**
 * u61FoldToken, stopping as soon as the folded result exceeds `max` code units (then null). Equal to u61FoldToken for
 * every result of `max` units or fewer: folding is per code point (dropped marks removed, case and accents folded).
 */
export function u61FoldTokenBounded(word, max = SEARCH_TERM_UNITS_MAX) {
  if (/^[\x00-\x7f]*$/.test(word)) return word.length <= max ? word.toLowerCase() : null;
  let out = "";
  for (const ch of word) {
    out += u61FoldToken(ch);
    if (out.length > max) return null;
  }
  return out;
}
/** Calls add(term) for each distinct folded term, in text order, up to `cap`. Returns true if a further one was cut. */
function scanTerms(text, cap, add) {
  if (cap <= 0 || !text) return false;
  const seen = new Set();
  for (const m of text.matchAll(U61_TOKEN)) {
    const t = u61FoldTokenBounded(m[0]);
    if (!t || seen.has(t)) continue;
    if (seen.size >= cap) return true;
    seen.add(t);
    add(t);
  }
  return false;
}
/** Distinct index terms of a text, at most `cap` (tests and small callers; runs use the packed forms). */
export function extractSearchTerms(text, cap) {
  const terms = [];
  const truncated = scanTerms(text, cap, (t) => terms.push(t));
  return { terms, truncated };
}
/**
 * Terms packed as UTF-16 code units (2 bytes per unit, as the reservation counts them) and offsets. The result holds
 * no reference to `text` (V8 sliced strings would keep the whole text alive).
 */
function extractSearchTermsUnits(text, cap) {
  let units = new Uint16Array(Math.max(1, Math.min(text.length, 4096))), used = 0;
  const offsets = [0];
  const truncated = scanTerms(text, cap, (t) => {
    if (used + t.length > units.length) {
      const next = new Uint16Array(Math.max(used + t.length, Math.min(text.length, units.length * 2)));
      next.set(units.subarray(0, used));
      units = next;
    }
    for (let i = 0; i < t.length; i++) units[used++] = t.charCodeAt(i);
    offsets.push(used);
  });
  return { units: units.slice(0, used), offsets: Uint32Array.from(offsets), count: offsets.length - 1, truncated };
}
/**
 * Terms packed as UTF-8 bytes and offsets (upload finish: extracted before its response, then the text is dropped).
 * bytes.byteLength <= min(12,000,000, 3 × text.length).
 */
export function extractSearchTermsFlat(text, cap) {
  const max = Math.min(12000000, 3 * text.length), enc = new TextEncoder();
  let bytes = new Uint8Array(Math.max(1, Math.min(max, 65536))), used = 0;
  const offsets = [0];
  const truncated = scanTerms(text, cap, (t) => {
    const need = used + 3 * t.length;
    if (need > bytes.length) {
      const next = new Uint8Array(Math.max(need, Math.min(max, bytes.length * 2)));
      next.set(bytes.subarray(0, used));
      bytes = next;
    }
    used += enc.encodeInto(t, bytes.subarray(used)).written;
    offsets.push(used);
  });
  return { bytes: bytes.slice(0, used), offsets: Uint32Array.from(offsets), count: offsets.length - 1, truncated };
}
/** Bytes a packed term list holds. */
const packedBytes = (p) => (p.units ? p.units.byteLength : p.bytes.byteLength) + p.offsets.byteLength;
/** UTF-8 inputs for terms [from, to) of a packed list (one HMAC chunk's input buffers). */
function termInputs(p, from, to) {
  const enc = new TextEncoder(), out = [];
  for (let i = from; i < to; i++) {
    const a = p.offsets[i], b = p.offsets[i + 1];
    out.push(p.units ? enc.encode(String.fromCharCode.apply(null, Array.from(p.units.subarray(a, b)))) : p.bytes.slice(a, b));
  }
  return out;
}

// --- Keys and tokens ----------------------------------------------------------------------------------------------
const SEARCH_INFO = "al-search/1";
const HEX32 = /^[0-9a-f]{32}$/;
const hex16 = (buf) => {
  const b = new Uint8Array(buf, 0, 16);
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16);
  return s;
};
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
/** HMAC-SHA-256 key for sign only, derived from a workspace data key (HKDF-SHA-256, empty salt, searchKeyInfo). */
export function deriveSearchKey(dataKey, workspaceId) {
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: searchKeyInfo(workspaceId) },
    dataKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}
const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64urlEncode = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** The plaintext-mode secret, decoded; exactly 32 bytes or 500 search_key_invalid. */
export function decodeSearchSecret(secret) {
  let raw;
  try { raw = typeof secret === "string" && /^[A-Za-z0-9_-]+$/.test(secret) ? b64urlDecode(secret) : null; } catch { raw = null; }
  if (!raw || raw.length !== 32) throw new HttpError(500, "search_key_invalid", "A workspace search key record is invalid");
  return raw;
}
/**
 * The workspace's search key: { keyId, key, encrypted }. Encryption on: derived from the active data key (key_id is the
 * data key's). Off: the workspace_search_keys row, created on first use in one batch (insert-or-keep, then read).
 */
export async function searchTokenKey(env, workspaceId) {
  if (await encryptionEnabled(env)) {
    const dk = await workspaceDataKey(env, workspaceId);
    let p = derivedKeys.get(dk.key);
    if (!p) { p = deriveSearchKey(dk.key, workspaceId); derivedKeys.set(dk.key, p); }
    return { keyId: dk.keyId, key: await p, encrypted: true };
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  const [, read] = await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_search_keys (workspace_id, key_id, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id) DO NOTHING")
      .bind(workspaceId, randomId("sk"), b64urlEncode(fresh), Date.now()),
    env.DB.prepare("SELECT key_id, secret FROM workspace_search_keys WHERE workspace_id = ?").bind(workspaceId),
  ]);
  fresh.fill(0);
  const row = read?.results?.[0];
  if (!row) throw new HttpError(500, "search_key_invalid", "A workspace search key record is missing");
  const raw = decodeSearchSecret(row.secret);
  try {
    return { keyId: row.key_id, key: await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encrypted: false };
  } finally { raw.fill(0); }
}
/** One HMAC chunk: the first 16 bytes of HMAC-SHA-256 of each input, as lower-case hex. */
async function signChunk(key, inputs) {
  return (await Promise.all(inputs.map((b) => crypto.subtle.sign("HMAC", key, b)))).map(hex16);
}
/** Tokens of plain terms (tests and small callers): sorted, distinct, lower-case hex. */
export async function searchTokensFor(key, terms) {
  const enc = new TextEncoder();
  return sortedDistinct(await signChunk(key, terms.map((t) => enc.encode(t))));
}
function sortedDistinct(tokens) {
  tokens.sort();
  let w = 0;
  for (let i = 0; i < tokens.length; i++) if (i === 0 || tokens[i] !== tokens[i - 1]) tokens[w++] = tokens[i];
  tokens.length = w;
  for (const t of tokens) if (!HEX32.test(t)) throw new HttpError(500, "search_token_invalid", "A search token is malformed");
  return tokens;
}
/** Digest of a target: SHA-256 of reason ‖ ":" ‖ the sorted tokens joined by ",", lower-case hex. */
export async function searchTokenDigest(tokens, reason) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reason + ":" + tokens.join(",")));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// --- Statements -----------------------------------------------------------------------------------------------------
// Written with ?NAME placeholders (see the design's Bindings table); named() maps each name to one numbered ?NNN
// placeholder, reusing the number wherever the name repeats in the statement.
/** { template, sql, names }: sql uses ?1…?n in order of first appearance of each name. */
export function named(template) {
  const names = [];
  const sql = template.replace(/\?([A-Z][A-Z0-9_]*)/g, (_, n) => {
    let i = names.indexOf(n);
    if (i < 0) { names.push(n); i = names.length - 1; }
    return "?" + (i + 1);
  });
  return Object.freeze({ template, sql, names: Object.freeze(names) });
}
/** A D1 statement for a named template, bound from `values` by name (every name must be present). */
export function bindNamed(env, stmt, values) {
  return env.DB.prepare(stmt.sql).bind(...stmt.names.map((n) => {
    if (!(n in values) || values[n] === undefined) throw new HttpError(500, "search_bind_missing", `Missing binding ${n}`);
    return values[n];
  }));
}
const H = "EXISTS (SELECT 1 FROM artifacts WHERE id = ?A AND head_revision_id = ?R)";
const LIVE = "EXISTS (SELECT 1 FROM projects p WHERE p.id = ?P AND p.deleted_at IS NULL AND p.purged_at IS NULL)"
  + " AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = (SELECT COALESCE(workspace_id, 'wsp_' || owner_id) FROM projects WHERE id = ?P)"
  + " AND w.status = 'deleting')";
const DOC_OF_ARTIFACT = "(SELECT doc_id FROM search_token_docs WHERE artifact_id = ?A)";
const MINE = (d) => `EXISTS (SELECT 1 FROM search_token_docs WHERE doc_id = ${d} AND revision_id = '' AND writer = ?NONCE)`;
const SCOPE = (d) => `EXISTS (SELECT 1 FROM search_token_docs WHERE doc_id = ${d} AND workspace_id = ?W AND owner_id = ?O)`;
const used = (scope) => `COALESCE((SELECT terms FROM search_term_counters WHERE scope = ${scope}), 0)`;
const LEFT = `min(?WB - ${used("'w:' || ?W")}, ?OB - ${used("'o:' || ?O")}, ?IB - ${used("'i'")})`;
const FULLSCOPE = `CASE WHEN ?WB - ${used("'w:' || ?W")} <= 0 THEN 'workspace' WHEN ?OB - ${used("'o:' || ?O")} <= 0 THEN 'owner' ELSE 'installation' END`;
const SCOPES = "scope IN ('w:' || ?W, 'o:' || ?O, 'i')";
const DOC_COLUMNS = "artifact_id, project_id, workspace_id, owner_id, revision_id, key_id, token_digest, writer, gen, term_count, truncated, truncated_by, updated_at";
/** Writer statements, for an existing row ($D = ?D) and for a new row ($D = its doc_id by artifact). */
const writerStatements = (d) => ({
  R: named(`DELETE FROM search_tokens WHERE doc_id = ${d} AND token IN (SELECT unhex(value) FROM json_each(?REM))
  AND ${H} AND ${LIVE} AND ${MINE(d)} AND ${SCOPE(d)}`),
  A: named(`WITH fresh AS (SELECT unhex(j.value) AS t, row_number() OVER (ORDER BY j.key) AS n FROM json_each(?ADD) j
  WHERE NOT EXISTS (SELECT 1 FROM search_tokens s WHERE s.doc_id = ${d} AND s.token = unhex(j.value)))
INSERT INTO search_tokens (doc_id, token) SELECT ${d}, t FROM fresh WHERE n <= ${LEFT} AND ${H} AND ${LIVE} AND ${MINE(d)} AND ${SCOPE(d)}
ON CONFLICT (doc_id, token) DO NOTHING`),
  T4: named(`UPDATE search_token_docs SET revision_id = ?R, writer = '', gen = gen + 1, updated_at = ?NOW, term_count = c.n,
  truncated = CASE WHEN c.n = ?N AND ?REASON = '' AND truncated_by = '' THEN 0 ELSE 1 END,
  truncated_by = CASE WHEN c.n = ?N AND truncated_by = '' THEN ?REASON
                      WHEN truncated_by <> '' THEN truncated_by ELSE ${FULLSCOPE} END,
  token_digest = CASE WHEN c.n = ?N THEN ?DIGEST ELSE '' END
FROM (SELECT COUNT(*) AS n FROM search_tokens WHERE doc_id = ${d}) AS c
WHERE artifact_id = ?A AND revision_id = '' AND writer = ?NONCE AND key_id = ?K AND ${H} AND ${LIVE}
  AND (c.n = ?N OR truncated_by <> '' OR ${LEFT} <= 0)`),
});
/** Every writer and lifecycle statement, compiled (exported for the statement tests). */
export const SEARCH_SQL = Object.freeze({
  T0: named("INSERT INTO search_term_counters (scope, terms) VALUES ('w:' || ?W, 0), ('o:' || ?O, 0), ('i', 0) ON CONFLICT (scope) DO NOTHING"),
  T1n: named(`INSERT INTO search_token_docs (${DOC_COLUMNS})
SELECT ?A, ?P, ?W, ?O, '', ?K, '', ?NONCE, 1, 0, 0, '', ?NOW WHERE ${H} AND ${LIVE} AND ${LEFT} >= ${DOC_ROW_UNITS}
ON CONFLICT (artifact_id) DO NOTHING`),
  T1z: named(`INSERT INTO search_token_docs (${DOC_COLUMNS})
SELECT ?A, ?P, ?W, ?O, ?R, ?K, ?DIGEST, '', 1, 0, CASE WHEN ?REASON = '' THEN 0 ELSE 1 END, ?REASON, ?NOW
WHERE ${H} AND ${LIVE} AND ${LEFT} >= ${DOC_ROW_UNITS}
ON CONFLICT (artifact_id) DO NOTHING`),
  T1nc: named(`UPDATE search_term_counters SET terms = terms + ${DOC_ROW_UNITS} * changes() WHERE ${SCOPES} AND changes() > 0`),
  T1s: named(`UPDATE search_token_docs SET revision_id = '', writer = ?NONCE, gen = gen + 1, key_id = ?K, token_digest = '',
  truncated = 0, truncated_by = '', updated_at = ?NOW
WHERE doc_id = ?SEEN_DOC AND artifact_id = ?A AND gen = ?SEEN_GEN AND revision_id <> ''
  AND workspace_id = ?W AND owner_id = ?O AND ${H} AND ${LIVE}`),
  T1u: named(`UPDATE search_token_docs SET writer = ?NONCE, gen = gen + 1, key_id = ?K, truncated = 0, truncated_by = '',
  updated_at = ?NOW
WHERE artifact_id = ?A AND revision_id = '' AND workspace_id = ?W AND owner_id = ?O AND ${H} AND ${LIVE}`),
  // T1r (re-plan of a row that is complete again: a stable read or T1s that lost to another writer's T4, a T1n that
  // met a completed row, a stored count that is wrong). Not in the design's list: T1u matches only rows at ''. Leases
  // any complete row under the same gates; the set is then read under the lease, so no gen pin is needed.
  T1r: named(`UPDATE search_token_docs SET revision_id = '', writer = ?NONCE, gen = gen + 1, key_id = ?K, token_digest = '',
  truncated = 0, truncated_by = '', updated_at = ?NOW
WHERE artifact_id = ?A AND revision_id <> '' AND workspace_id = ?W AND owner_id = ?O AND ${H} AND ${LIVE}`),
  LEASE_READ: named(`SELECT d.writer, lower(hex(s.token)) AS t FROM search_token_docs d LEFT JOIN search_tokens s ON s.doc_id = d.doc_id
  WHERE d.artifact_id = ?A ORDER BY s.token LIMIT ${SET_READ_LIMIT}`),
  Rc: named(`UPDATE search_term_counters SET terms = terms - changes() WHERE ${SCOPES}`),
  Ac: named(`UPDATE search_term_counters SET terms = terms + changes() WHERE ${SCOPES}`),
  Am: named(`UPDATE search_token_docs SET truncated = 1, truncated_by = ${FULLSCOPE}
WHERE artifact_id = ?A AND revision_id = '' AND writer = ?NONCE AND ${LEFT} <= 0`),
  existing: Object.freeze(writerStatements("?D")),
  fresh: Object.freeze(writerStatements(DOC_OF_ARTIFACT)),
  PLAN: named(`SELECT x.*,
  (SELECT terms FROM search_term_counters WHERE scope = 'w:' || COALESCE(x.row_ws, x.ws)) AS cw,
  (SELECT terms FROM search_term_counters WHERE scope = 'o:' || COALESCE(x.row_owner, x.owner)) AS co,
  (SELECT terms FROM search_term_counters WHERE scope = 'i') AS ci
FROM (SELECT p.id AS project_id, COALESCE(p.workspace_id, 'wsp_' || p.owner_id) AS ws,
    COALESCE((SELECT created_by FROM workspaces WHERE id = COALESCE(p.workspace_id, 'wsp_' || p.owner_id)), p.owner_id) AS owner,
    a.head_revision_id = ?R AS head, (${LIVE}) AS live,
    d.doc_id, d.gen, d.revision_id, d.key_id, d.token_digest, d.writer, d.truncated_by, d.term_count,
    d.workspace_id AS row_ws, d.owner_id AS row_owner
  FROM artifacts a JOIN projects p ON p.id = a.project_id LEFT JOIN search_token_docs d ON d.artifact_id = a.id
  WHERE a.id = ?A AND a.project_id = ?P) x`),
});
/** The stable read for n documents: pairs (doc_id, gen) pinned in the statement, LIMIT Σ term_count + n. */
export function stableReadSql(n) {
  const pairs = Array.from({ length: n }, (_, i) => `(d.doc_id = ?${2 * i + 1} AND d.gen = ?${2 * i + 2})`).join(" OR ");
  return `SELECT d.doc_id, d.gen, lower(hex(s.token)) AS t FROM search_token_docs d LEFT JOIN search_tokens s ON s.doc_id = d.doc_id
  WHERE ${pairs} ORDER BY d.doc_id, s.token LIMIT ?${2 * n + 1}`;
}

// Lifecycle deletes (purge, sweep paths, and K/Kc for a writer's oversize path). `eligible` is a named fragment.
const lifecycleCache = new Map();
/** { L, K, Kc, X, Xc } for one eligibility fragment (named placeholders). */
export function lifecycleStatements(eligible) {
  let s = lifecycleCache.get(eligible);
  if (!s) {
    const held = "AND revision_id = '' AND writer = ?PN";
    s = Object.freeze({
      L: named(`UPDATE search_token_docs SET revision_id = '', writer = ?PN, gen = gen + 1
  WHERE doc_id = ?D AND workspace_id = ?W AND owner_id = ?O AND ${eligible}`),
      K: named(`DELETE FROM search_tokens WHERE doc_id = ?D AND token IN (SELECT token FROM search_tokens WHERE doc_id = ?D LIMIT ?CHUNK)
  AND EXISTS (SELECT 1 FROM search_token_docs WHERE doc_id = ?D AND workspace_id = ?W AND owner_id = ?O
              ${held}) AND ${eligible}`),
      Kc: named(`UPDATE search_term_counters SET terms = terms - changes() WHERE ${SCOPES} AND changes() > 0`),
      X: named(`DELETE FROM search_token_docs WHERE doc_id = ?D AND workspace_id = ?W AND owner_id = ?O
  ${held} AND ${eligible}
  AND NOT EXISTS (SELECT 1 FROM search_tokens WHERE doc_id = ?D)`),
      Xc: named(`UPDATE search_term_counters SET terms = terms - ${DOC_ROW_UNITS} * changes() WHERE ${SCOPES} AND changes() > 0`),
    });
    lifecycleCache.set(eligible, s);
  }
  return s;
}
/** The writer's oversize-path eligibility ($H AND $LIVE). */
export const SEARCH_WRITER_ELIGIBLE = `${H} AND ${LIVE}`;
/** A new purge or sweep lease nonce. */
export const purgeNonce = () => "purge:" + randomId("sp", 9);

/**
 * One packed lifecycle batch for `docs` ({ doc_id, workspace_id, owner_id, chunk, final, ...eligibility values }):
 * per document L, then K and Kc when chunk > 0, then X and Xc when final. `values` are the bindings every statement
 * shares (PN, and whatever `eligible` names), merged with each document's own (D, W, O, CHUNK, and its own A, P, R…).
 * Returns { tokens, docs, results } (token rows K deleted, document rows X deleted).
 */
export async function deleteSearchDocs(env, docs, { eligible, values }) {
  const s = lifecycleStatements(eligible), stmts = [], marks = [];
  for (const doc of docs) {
    const v = { ...values, ...doc.values, D: doc.doc_id, W: doc.workspace_id, O: doc.owner_id, CHUNK: doc.chunk };
    stmts.push(bindNamed(env, s.L, v));
    if (doc.chunk > 0) { marks.push(["k", stmts.length]); stmts.push(bindNamed(env, s.K, v), bindNamed(env, s.Kc, v)); }
    if (doc.final) { marks.push(["x", stmts.length]); stmts.push(bindNamed(env, s.X, v), bindNamed(env, s.Xc, v)); }
  }
  if (stmts.length > SEARCH_BATCH_STATEMENTS_MAX) throw new HttpError(500, "search_batch_too_large", "Too many statements in one batch");
  if (!stmts.length) return { tokens: 0, docs: 0, results: [] };
  const results = await env.DB.batch(stmts);
  let tokens = 0, rows = 0;
  for (const [kind, i] of marks) {
    const n = results[i]?.meta?.changes ?? 0;
    if (kind === "k") tokens += n; else rows += n;
  }
  return { tokens, docs: rows, results };
}

// --- Logs -------------------------------------------------------------------------------------------------------
const logEvent = (event, detail) => console.log(JSON.stringify({ event, ...detail }));
const logError = (event, detail) => console.error(JSON.stringify({ event, ...detail }));
/** search_phase, at most once per run and phase; never content. */
function phase(run, name) {
  if (run.phases.has(name)) return;
  run.phases.add(name);
  logEvent("search_phase", { phase: name, run: run.id, ms: Date.now() - run.admittedAt });
}

// --- Runs ---------------------------------------------------------------------------------------------------------
/** Thrown to end a run without storing anything further: deadline, budget, detached, or an error already logged. */
class RunStop extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const nextTurn = () => {
  const s = /** @type {any} */ (globalThis).scheduler;
  return typeof s?.wait === "function" ? s.wait(0) : new Promise((r) => setTimeout(r, 0));
};
/** Every large field of a holder and its jobs set to null. */
function clearHolder(holder) {
  for (const job of holder.jobs ?? []) { job.text = null; job.flat = null; job.terms = null; job.tokens = null; job.removes = null; job.adds = null; }
  holder.jobs = null; holder.plan = null; holder.set = null; holder.pending = null;
}

/**
 * One indexing run: its holder (everything large), its payload reservation and its budgets. The envelope (the largest
 * single call in flight with its result) is held from creation to settlement.
 */
export class SearchRun {
  constructor({ declaredCalls = 0 } = {}) {
    this.id = randomId("sr", 6);
    this.holder = { jobs: [], plan: null, set: null, pending: null };
    this.envelope = SEARCH_CALL_ENVELOPE_BYTES;
    this.payload = SEARCH_RUN_BASE_BYTES;
    this.callBudget = Math.max(0, Math.min(SEARCH_RUN_LIMITS.calls, 1000 - declaredCalls - 20));
    this.calls = 0; this.tokenOps = 0; this.textUnits = 0; this.removeValues = 0; this.maxRemoveValues = 0;
    this.admittedAt = Date.now(); this.startedAt = 0; this.deadline = Infinity;
    this.detached = false; this.settled = false;
    this.nonce = randomId("sw", 9);
    this.phases = new Set();
    this.skipped = {};
    this.completed = 0;
  }
  /** Add `bytes` to the payload if the run stays within its limit; false (nothing reserved) otherwise. */
  reserve(bytes) {
    if (this.detached || this.settled) return false;
    if (this.envelope + this.payload + bytes > SEARCH_RUN_MAX_BYTES) return false;
    this.payload += bytes;
    return true;
  }
  release(bytes) { this.payload = Math.max(0, this.payload - bytes); }
  /** Lower (never raise) a job's charge to `bytes`. */
  lower(job, bytes) { if (bytes < job.charge) { this.release(job.charge - bytes); job.charge = bytes; } }
  skip(reason, n = 1) { this.skipped[reason] = (this.skipped[reason] ?? 0) + n; }
  /** Before any call or bounded step: refuse if detached, past the deadline or (for D1 calls) out of calls. */
  before(isCall) {
    if (this.detached) throw new RunStop("detached");
    if (Date.now() > this.deadline) throw new RunStop("deadline");
    if (isCall) {
      if (this.calls >= this.callBudget) throw new RunStop("budget");
      this.calls++;
    }
  }
  /** After a call returns: its result is discarded unless the run is within its deadline and not detached. */
  after() {
    if (this.detached) throw new RunStop("detached");
    if (Date.now() > this.deadline) throw new RunStop("deadline");
  }
  /** Settle once: nulls every holder field and releases the reservation. */
  settle() {
    if (this.settled) return;
    clearHolder(this.holder);
    this.settled = true;
    this.payload = 0;
  }
}

/** The env a run uses: every D1 call is counted and checked (deadline, budget, detachment) before and after. */
function runEnv(env, run) {
  const db = env.DB;
  const gate = async (exec) => { run.before(true); const out = await exec(); run.after(); return out; };
  const wrap = (s) => ({
    inner: s,
    bind: (...b) => wrap(s.bind(...b)),
    first: (c) => gate(() => s.first(c)),
    all: () => gate(() => s.all()),
    run: () => gate(() => s.run()),
  });
  return { ...env, DB: { prepare: (q) => wrap(db.prepare(q)), batch: (list) => gate(() => db.batch(list.map((s) => s.inner ?? s))) } };
}
/** A bounded non-D1 step (HMAC chunk, key provider): checked before and after like a call, not counted. */
async function step(run, work) {
  run.before(false);
  const out = await work();
  run.after();
  return out;
}

/** A job as the holder keeps it: meta is small; text, flat, terms, tokens, removes and adds are the large fields. */
export function searchJob(env, { artifactId, projectId, revisionId, text = null, flat = null, textBytes, textUnits }) {
  if (typeof artifactId !== "string" || typeof projectId !== "string" || typeof revisionId !== "string")
    throw new HttpError(500, "search_job_invalid", "A search job needs artifact, project and revision ids");
  const bytes = textBytes ?? (text === null ? 0 : utf8Length(text));
  return {
    meta: { artifactId, projectId, revisionId }, text, flat, terms: null, tokens: null, removes: null, adds: null,
    cap: searchDocCap(env, bytes), units: textUnits ?? (text === null ? 0 : text.length), charge: 0, reason: "", digest: "",
    kind: null, row: null, scope: null, done: false, replanned: false,
  };
}
/** Admission charge of a job: 2 × text units (+ the flat terms for upload finish) + 96 B per capped term. */
export function searchJobCharge(job, { upload = false } = {}) {
  const tokens = SEARCH_TOKEN_BYTES * job.cap;
  return (upload ? Math.min(12000000, 3 * job.units) : 2 * job.units) + tokens;
}

/** Plan rows and counts for every job, in batches of at most 100 statements (one call for a run's 100 jobs). */
async function planRun(db, run) {
  const jobs = run.holder.jobs;
  for (let i = 0; i < jobs.length; i += SEARCH_BATCH_STATEMENTS_MAX) {
    const part = jobs.slice(i, i + SEARCH_BATCH_STATEMENTS_MAX);
    const results = await db.DB.batch(part.map((j) => bindNamed(db, SEARCH_SQL.PLAN, { A: j.meta.artifactId, P: j.meta.projectId, R: j.meta.revisionId })));
    part.forEach((j, k) => { j.row = results[k]?.results?.[0] ?? null; });
  }
  run.holder.plan = { workspaces: new Map(), installationFullLogged: false };
  for (const j of jobs) {
    const r = j.row;
    if (!r || !r.head || !r.live) { j.done = true; run.skip("refused"); continue; }
    const W = r.doc_id == null ? r.ws : r.row_ws, O = r.doc_id == null ? r.owner : r.row_owner;
    if (!W || !O) { j.done = true; run.skip("owner"); logError("search_owner_missing", { artifactId: j.meta.artifactId }); continue; }
    j.scope = { W, O, used: { w: r.cw ?? 0, o: r.co ?? 0, i: r.ci ?? 0 } };
    j.kind = r.doc_id == null ? "new" : r.revision_id !== "" ? "stable" : "unstable";
  }
}

/** Key and bounds for the job's workspace, once per run (setup calls: encryption probe, key, limits). */
async function workspaceSetup(db, run, job) {
  const plan = run.holder.plan, W = job.scope.W;
  let ws = plan.workspaces.get(W);
  if (!ws) {
    const key = await step(run, () => searchTokenKey(db, W));
    const bounds = searchScopeBounds(db, await workspaceLimits(db, W));
    ws = { key, bounds };
    plan.workspaces.set(W, ws);
  }
  const { bounds } = ws, u = job.scope.used;
  job.scope.left = Math.min(bounds.workspace - u.w, bounds.owner - u.o, bounds.installation - u.i);
  if (bounds.installation - u.i <= 0 && !plan.installationFullLogged) {
    plan.installationFullLogged = true;
    logError("search_terms_installation_full", { terms: u.i, bound: bounds.installation });
  }
  return ws;
}

/** Extract (if needed) and HMAC one job's terms into job.tokens, then its digest. Text and terms are released. */
async function prepareTokens(db, run, job) {
  const ws = await workspaceSetup(db, run, job);
  if (job.text !== null) {
    const p = extractSearchTermsUnits(job.text, job.cap);
    job.text = null;
    job.terms = p;
    job.reason = p.truncated ? capReason(db, job.cap) : "";
    run.lower(job, 2 * (p.units.length + p.offsets.length) + SEARCH_TOKEN_BYTES * job.cap);
  } else if (job.flat !== null) {
    job.terms = job.flat;
    job.flat = null;
    job.reason = job.terms.truncated ? capReason(db, job.cap) : "";
    run.lower(job, packedBytes(job.terms) + SEARCH_TOKEN_BYTES * job.cap);
  } else {
    job.terms = { units: new Uint16Array(0), offsets: Uint32Array.of(0), count: 0, truncated: false };
  }
  if (job.cap === 0) job.reason = "off";
  phase(run, "extract_done");
  job.tokens = [];
  for (let at = 0; at < job.terms.count;) {
    const end = Math.min(job.terms.count, at + HMAC_CHUNK);
    // The declared in-flight chunk: its input buffers live only in this call.
    let inputs = termInputs(job.terms, at, end);
    at = end;
    const out = await step(run, () => signChunk(ws.key.key, inputs));
    inputs = null;
    if (!job.tokens) return;
    for (const t of out) job.tokens.push(t);
  }
  job.terms = null;
  sortedDistinct(job.tokens);
  run.lower(job, SEARCH_TOKEN_BYTES * job.cap);
  phase(run, "hmac_done");
  job.digest = await step(run, () => searchTokenDigest(job.tokens, job.reason));
  job.keyId = ws.key.keyId;
  job.fence = ws.key.encrypted ? { kind: "key", keyId: ws.key.keyId, workspaceId: job.scope.W } : { kind: "plain" };
  job.bounds = ws.bounds;
}

/** Releases a job's token charge and every large field (its last batch has returned, or it is skipped). */
function finishJob(run, job, skipReason) {
  if (job.removes) for (const c of job.removes) { run.release(SEARCH_TOKEN_BYTES * c.length); run.removeValues -= c.length; }
  run.release(job.charge);
  job.charge = 0;
  job.text = null; job.flat = null; job.terms = null; job.tokens = null; job.removes = null; job.adds = null;
  job.done = true;
  if (skipReason) run.skip(skipReason);
}

/**
 * Charge first, then keep: count the removes (base \ target) in one pass keeping nothing, reserve 96 B each, and only
 * then build the remove and add chunks (arrays of at most 5,000 values; adds are the job's own, already charged,
 * tokens). base(i) gives the i-th sorted base token, n of them. Returns false (nothing kept) if the charge does not fit.
 */
function diffInto(run, job, base, n) {
  const target = job.tokens;
  let removes = 0;
  for (let i = 0, j = 0; i < n;) {
    const b = base(i);
    if (j >= target.length || b < target[j]) { removes++; i++; } else if (b === target[j]) { i++; j++; } else j++;
  }
  if (!run.reserve(SEARCH_TOKEN_BYTES * removes)) return false;
  run.removeValues += removes;
  run.maxRemoveValues = Math.max(run.maxRemoveValues, run.removeValues);
  const rem = [], add = [];
  let r = [], a = [];
  const pushR = (v) => { r.push(v); if (r.length === DOC_SIDE_MAX) { rem.push(r); r = []; } };
  const pushA = (v) => { a.push(v); if (a.length === DOC_SIDE_MAX) { add.push(a); a = []; } };
  let adds = 0;
  for (let i = 0, j = 0; i < n || j < target.length;) {
    const b = i < n ? base(i) : null;
    if (b !== null && (j >= target.length || b < target[j])) { pushR(b); i++; }
    else if (b !== null && b === target[j]) { i++; j++; }
    else { pushA(target[j]); adds++; j++; }
  }
  if (r.length) rem.push(r);
  if (a.length) add.push(a);
  job.removes = rem;
  job.adds = job.noAdds ? [] : add;
  job.removeCount = removes;
  job.removesPacked = 0;
  job.addsPacked = 0;
  job.addCount = job.noAdds ? 0 : adds;
  job.growth = Math.max(0, target.length - n);
  return true;
}

/** Values bound in a list of statement descriptors. */
const newPending = () => ({ stmts: [], values: 0, pieces: [], t0: new Set(), fences: new Map(), side: new Map() });
function fenceKey(job) { return job.fence.kind === "key" ? `k:${job.fence.workspaceId}:${job.fence.keyId}` : "plain"; }

/**
 * Packs every remaining piece of one job into holder.pending, sending the pending batch whenever the next piece would
 * take it past 10,000 token values or 100 statements. Removes go first; adds only within the size invariant
 * (adds so far <= removes so far + max(0, |target| − |base|)). The last piece carries T4; others with adds carry Am.
 */
async function packJob(db, run, job, t1) {
  let first = t1;
  for (;;) {
    if (job.done || job.leaseFailed) return;
    const h = run.holder;
    if (!h.pending) h.pending = newPending();
    const p = h.pending;
    const valuesLeft = SEARCH_BATCH_TOKENS_MAX - p.values;
    const removesLeft = job.removeCount - job.removesPacked, addsLeft = job.addCount - job.addsPacked;
    // Per document and batch: at most 5,000 removes and 5,000 adds.
    const side = p.side.get(job) ?? { r: 0, a: 0 };
    const r = Math.min(DOC_SIDE_MAX - side.r, removesLeft, valuesLeft, job.removes[0]?.length ?? 0);
    const allowance = job.removesPacked + r + job.growth - job.addsPacked;
    const a = Math.min(DOC_SIDE_MAX - side.a, addsLeft, valuesLeft - r, allowance, job.adds[0]?.length ?? 0);
    const final = removesLeft - r === 0 && addsLeft - a === 0;
    const t4 = final && job.kind !== "empty";
    const scopeKey = job.scope.W + "\u0000" + job.scope.O;
    const need = (first ? first.length : 0) + (r ? 2 : 0) + (a ? 2 : 0) + (t4 || a ? 1 : 0)
      + (p.t0.has(scopeKey) ? 0 : 1) + (p.fences.has(fenceKey(job)) ? 0 : 1);
    const empty = !first && !r && !a && !final;
    if (p.stmts.length + p.fences.size + need > SEARCH_BATCH_STATEMENTS_MAX || empty || (r + a > 0 && run.tokenOps + r + a > SEARCH_RUN_LIMITS.tokenOps)) {
      if (!p.stmts.length) {
        if (run.tokenOps + r + a > SEARCH_RUN_LIMITS.tokenOps) throw new RunStop("budget");
        throw new HttpError(500, "search_pack_stuck", "A search batch piece does not fit an empty batch");
      }
      await sendPending(db, run);
      continue;
    }
    const v = jobValues(run, job);
    // $D: the planning doc_id for a stable row (T1s pins it); otherwise the row the lease holds, by artifact.
    const s = job.kind === "stable" ? SEARCH_SQL.existing : SEARCH_SQL.fresh;
    if (!p.t0.has(scopeKey)) { p.t0.add(scopeKey); p.stmts.push(bindNamed(db, SEARCH_SQL.T0, v)); }
    if (!p.fences.has(fenceKey(job))) p.fences.set(fenceKey(job), job.fence.kind === "key" ? keyFence(db, { keyId: job.fence.keyId, workspaceId: job.fence.workspaceId }) : plaintextFence(db));
    const piece = { job, t1At: -1, t4At: -1, removeBytes: 0, removeValues: 0, final };
    if (first) { piece.t1At = p.stmts.length; for (const st of first) p.stmts.push(bindNamed(db, st, v)); first = null; }
    if (r) {
      // Clearing rule: the packed values leave job.removes now (shift or splice), never by advancing an index.
      let sent = job.removes[0].length === r ? job.removes.shift() : job.removes[0].splice(0, r);
      p.stmts.push(bindNamed(db, s.R, { ...v, REM: JSON.stringify(sent) }), bindNamed(db, SEARCH_SQL.Rc, v));
      sent = null;
      piece.removeBytes = SEARCH_TOKEN_BYTES * r;
      piece.removeValues = r;
      job.removesPacked += r;
    }
    if (a) {
      let sent = job.adds[0].length === a ? job.adds.shift() : job.adds[0].splice(0, a);
      p.stmts.push(bindNamed(db, s.A, { ...v, ADD: JSON.stringify(sent) }), bindNamed(db, SEARCH_SQL.Ac, v));
      sent = null;
      job.addsPacked += a;
    }
    if (t4) { piece.t4At = p.stmts.length; p.stmts.push(bindNamed(db, s.T4, v)); }
    else if (a) p.stmts.push(bindNamed(db, SEARCH_SQL.Am, v));
    p.values += r + a;
    p.side.set(job, { r: side.r + r, a: side.a + a });
    run.tokenOps += r + a;
    p.pieces.push(piece);
    if (final) return;
  }
}
function jobValues(run, job) {
  const b = job.bounds;
  return {
    A: job.meta.artifactId, P: job.meta.projectId, R: job.meta.revisionId, W: job.scope.W, O: job.scope.O,
    WB: b.workspace, OB: b.owner, IB: b.installation, NONCE: run.nonce, K: job.keyId, NOW: Date.now(),
    D: job.row?.doc_id ?? null, N: job.tokens?.length ?? 0, REASON: job.reason, DIGEST: job.digest,
    SEEN_DOC: job.row?.doc_id ?? null, SEEN_GEN: job.row?.gen ?? null,
  };
}

/**
 * Sends holder.pending (fences last). After it returns: each piece's remove charge is released (its values were
 * already cleared from job.removes when packed), and a job whose last piece was in it is finished (token charge
 * released). A piece whose T1 changed nothing marks its job for one re-plan as unstable.
 */
async function sendPending(db, run) {
  const p = run.holder.pending;
  if (!p || !p.stmts.length) return;
  run.holder.pending = null;
  for (const f of p.fences.values()) p.stmts.push(f);
  let results;
  try {
    results = await db.DB.batch(p.stmts);
  } catch (e) {
    if (e instanceof RunStop) throw e;
    const code = fenceRefusal(e)?.code ?? e?.code ?? "error";
    for (const piece of p.pieces) logError("search_index_failed", { artifactId: piece.job.meta.artifactId, code });
    throw new RunStop("error");
  } finally { p.stmts = null; }
  for (const piece of p.pieces) {
    const job = piece.job;
    run.release(piece.removeBytes);
    run.removeValues -= piece.removeValues;
    if (job.done || job.leaseFailed) continue;
    if (piece.t1At >= 0 && !(results[piece.t1At]?.meta?.changes > 0)) { job.leaseFailed = true; continue; }
    if (piece.final) {
      const doneAt = piece.t4At >= 0 ? piece.t4At : piece.t1At;
      if (results[doneAt]?.meta?.changes > 0) run.completed++; else run.skip("incomplete");
      finishJob(run, job);
    }
  }
}

/** Abandon a job's unsent work (its lease failed): drop its remaining chunks; re-plan once as unstable or skip. */
function abandon(run, job, queue) {
  if (job.removes) for (const c of job.removes) { run.release(SEARCH_TOKEN_BYTES * c.length); run.removeValues -= c.length; }
  job.removes = null; job.adds = null; job.leaseFailed = false;
  // A new row refused because a scope had no room for it (planning saw < 5 units left) stays missing.
  if ((job.kind === "new" || job.kind === "empty") && job.scope.left < DOC_ROW_UNITS) { finishJob(run, job, "capacity"); return; }
  if (job.replanned) { finishJob(run, job, "lost"); return; }
  job.replanned = true;
  job.kind = "unstable";
  queue.push(job);
}

/** Pack and send-as-needed one diffed job; if its lease failed, abandon it. */
async function writeJob(db, run, job, t1, queue) {
  await packJob(db, run, job, t1);
  if (job.leaseFailed) abandon(run, job, queue);
}


/** Sends everything pending and settles lease failures it reveals. */
async function flush(db, run, queue) {
  await sendPending(db, run);
  for (const job of run.holder.jobs) if (!job.done && job.leaseFailed) abandon(run, job, queue);
}

/** The unstable path: [T1u, FENCE], then the lease read (its own call), then diff and write. */
async function writeUnstable(db, run, job, queue) {
  const v = jobValues(run, job);
  const fence = job.fence.kind === "key" ? keyFence(db, { keyId: job.fence.keyId, workspaceId: job.fence.workspaceId }) : plaintextFence(db);
  let leased;
  try {
    // A re-planned row may be complete again (T1r); exactly one of the two can change it.
    leased = await db.DB.batch(job.replanned ? [bindNamed(db, SEARCH_SQL.T1u, v), bindNamed(db, SEARCH_SQL.T1r, v), fence] : [bindNamed(db, SEARCH_SQL.T1u, v), fence]);
  } catch (e) {
    if (e instanceof RunStop) throw e;
    logError("search_index_failed", { artifactId: job.meta.artifactId, code: fenceRefusal(e)?.code ?? e?.code ?? "error" });
    throw new RunStop("error");
  }
  if (!(leased[0]?.meta?.changes > 0) && !(job.replanned && leased[1]?.meta?.changes > 0)) { finishJob(run, job, "lost"); return; }
  for (let attempt = 0; ; attempt++) {
    run.holder.set = (await db.DB.prepare(SEARCH_SQL.LEASE_READ.sql).bind(job.meta.artifactId).all()).results;
    const h = run.holder;
    if (!h.set.length || h.set[0].writer !== run.nonce) { h.set = null; finishJob(run, job, "lost"); return; }
    if (h.set.length >= SET_READ_LIMIT) { h.set = null; await oversize(db, run, job); return; }
    const ok = diffInto(run, job, (i) => h.set[i].t, h.set[0].t === null ? 0 : h.set.length);
    h.set = null;
    if (ok) break;
    if (attempt > 0) { finishJob(run, job, "charge"); return; }
    await flush(db, run, queue);
  }
  await writeJob(db, run, job, null, queue);
}

/** Oversize path: delete the set under this run's own lease with K/Kc ($H AND $LIVE), log, leave the row at ''. */
async function oversize(db, run, job) {
  logError("search_set_oversize", { artifactId: job.meta.artifactId });
  const doc = { doc_id: null, workspace_id: job.scope.W, owner_id: job.scope.O, chunk: DOC_SIDE_MAX, final: false };
  doc.doc_id = (await db.DB.prepare("SELECT doc_id FROM search_token_docs WHERE artifact_id = ?").bind(job.meta.artifactId).first("doc_id"));
  if (doc.doc_id === null) { finishJob(run, job, "lost"); return; }
  const s = lifecycleStatements(SEARCH_WRITER_ELIGIBLE);
  const v = { PN: run.nonce, A: job.meta.artifactId, R: job.meta.revisionId, P: job.meta.projectId, D: doc.doc_id, W: doc.workspace_id, O: doc.owner_id, CHUNK: DOC_SIDE_MAX };
  for (;;) {
    const r = await db.DB.batch([bindNamed(db, s.K, v), bindNamed(db, s.Kc, v)]);
    if ((r[0]?.meta?.changes ?? 0) < DOC_SIDE_MAX) break;
  }
  finishJob(run, job, "oversize");
}

/** Stable group: the pinned read, then (no await) the diffs of as many members as can be charged; set nulled after. */
async function writeStableGroup(db, run, group, queue) {
  const params = [];
  let rows = 0;
  for (const j of group) { params.push(j.row.doc_id, j.row.gen); rows += j.row.term_count; }
  run.holder.set = (await db.DB.prepare(stableReadSql(group.length)).bind(...params, rows + group.length).all()).results;
  // The set is reached only through the holder (h.set), so nulling h.set releases it; no local names it.
  const h = run.holder;
  const byDoc = new Map();
  for (let i = 0; i < h.set.length; i++) {
    const d = h.set[i].doc_id;
    const e = byDoc.get(d);
    if (e) e.n++; else byDoc.set(d, { from: i, n: 1 });
  }
  const diffed = [];
  let failed = -1;
  for (let k = 0; k < group.length; k++) {
    const j = group[k], e = byDoc.get(j.row.doc_id);
    if (!e || e.n !== Math.max(j.row.term_count, 1)) { j.kind = "unstable"; j.replanned = true; queue.push(j); continue; }
    const n = h.set[e.from].t === null ? 0 : e.n;
    if (!diffInto(run, j, (i) => h.set[e.from + i].t, n)) { failed = k; break; }
    diffed.push(j);
  }
  h.set = null;
  const t1 = [SEARCH_SQL.T1s];
  for (const j of diffed) await writeJob(db, run, j, t1, queue);
  if (failed < 0) return [];
  // The failed member: flush, re-read its set alone (pinned by gen), charge again; members after it are re-grouped.
  const j = group[failed];
  await flush(db, run, queue);
  run.holder.set = (await db.DB.prepare(stableReadSql(1)).bind(j.row.doc_id, j.row.gen, j.row.term_count + 1).all()).results;
  if (h.set.length !== Math.max(j.row.term_count, 1)) { h.set = null; j.kind = "unstable"; j.replanned = true; queue.push(j); return group.slice(failed + 1); }
  const ok = diffInto(run, j, (i) => h.set[i].t, h.set[0].t === null ? 0 : h.set.length);
  h.set = null;
  if (!ok) finishJob(run, j, "charge");
  else await writeJob(db, run, j, t1, queue);
  return group.slice(failed + 1);
}

/** Process every planned job in order: new, stable groups, unstable; then the re-plans, once each. */
async function writeRun(db, run) {
  const queue = [];
  const jobs = run.holder.jobs;
  for (let i = 0; i < jobs.length;) {
    const job = jobs[i];
    if (job.done) { i++; continue; }
    if (job.kind === "stable") {
      const group = [];
      let tokens = 0;
      while (i < jobs.length && group.length < STABLE_GROUP_DOCS) {
        const j = jobs[i];
        if (j.done) { i++; continue; }
        if (j.kind !== "stable") break;
        if (group.length && tokens + j.row.term_count > STABLE_GROUP_TOKENS) break;
        await prepareTokens(db, run, j);
        i++;
        if (j.row.revision_id === j.meta.revisionId && j.row.key_id === j.keyId && j.row.token_digest === j.digest) { finishJob(run, j); continue; }
        j.noAdds = SCOPE_REASONS.includes(j.row.truncated_by) && j.scope.left <= 0;
        tokens += j.row.term_count;
        group.push(j);
      }
      let rest = group;
      while (rest.length) rest = await writeStableGroup(db, run, rest, queue);
      continue;
    }
    i++;
    await prepareTokens(db, run, job);
    if (job.kind === "unstable") { await writeUnstable(db, run, job, queue); continue; }
    // New document: base empty. No tokens (empty text or off): T1z, complete at once.
    if (!job.tokens.length) {
      job.kind = "empty";
      diffInto(run, job, () => "", 0);
      await writeJob(db, run, job, [SEARCH_SQL.T1z, SEARCH_SQL.T1nc], queue);
      continue;
    }
    diffInto(run, job, () => "", 0);
    await writeJob(db, run, job, [SEARCH_SQL.T1n, SEARCH_SQL.T1nc], queue);
  }
  await flush(db, run, queue);
  while (queue.length) {
    while (queue.length) {
      const job = queue.shift();
      if (job.done) continue;
      if (!job.tokens) await prepareTokens(db, run, job);
      await writeUnstable(db, run, job, queue);
    }
    await flush(db, run, queue);
  }
}

/**
 * Run the indexing of a run's holder. Starts with `await scheduler.wait(0)`; never rejects. In `finally` the holder
 * is cleared and the run settled.
 */
export async function runSearchIndexing(env, run) {
  try {
    await nextTurn();
    if (run.detached) return;
    run.startedAt = Date.now();
    run.deadline = run.startedAt + SEARCH_RUN_DEADLINE_MS;
    phase(run, "deferred_start");
    const db = runEnv(env, run);
    await planRun(db, run);
    await writeRun(db, run);
  } catch (e) {
    if (e instanceof RunStop) {
      if (e.reason === "deadline") phase(run, "deadline");
      for (const job of run.holder.jobs ?? []) if (!job.done) run.skip(e.reason);
    } else {
      logError("search_index_failed", { run: run.id, code: fenceRefusal(e)?.code ?? e?.code ?? "error" });
      for (const job of run.holder.jobs ?? []) if (!job.done) run.skip("error");
    }
  } finally {
    const skipped = Object.values(run.skipped).reduce((a, b) => a + b, 0);
    if (skipped) logEvent("search_index_skipped", { run: run.id, skipped, reasons: run.skipped });
    if (!run.detached) phase(run, "deferred_end");
    run.settle();
  }
}

/**
 * Index `jobs` now, as one run (awaited; never rejects). Each job is { artifactId, projectId, revisionId, text } or,
 * for upload finish, { …, flat, textBytes, textUnits }. Jobs beyond the run's limits (100 documents, 10 Mi code units,
 * 26 MiB) are skipped. Returns the run's tally.
 */
export async function indexSearchJobs(env, jobs, { declaredCalls = 0 } = {}) {
  const run = new SearchRun({ declaredCalls });
  admitJobs(env, run, jobs);
  await runSearchIndexing(env, run);
  return runTally(run);
}
/** Admit jobs into a run's holder within its limits; rejected jobs never enter the holder. */
function admitJobs(env, run, jobs) {
  for (const input of jobs) {
    const job = searchJob(env, input);
    const charge = searchJobCharge(job, { upload: job.flat !== null });
    if (run.holder.jobs.length >= SEARCH_RUN_LIMITS.docs || run.textUnits + job.units > SEARCH_RUN_LIMITS.textUnits || !run.reserve(charge)) { run.skip("admission"); continue; }
    job.charge = charge;
    run.textUnits += job.units;
    run.holder.jobs.push(job);
  }
}
const runTally = (run) => ({ run: run.id, calls: run.calls, completed: run.completed, skipped: { ...run.skipped }, tokenOps: run.tokenOps, maxRemoveValues: run.maxRemoveValues });
