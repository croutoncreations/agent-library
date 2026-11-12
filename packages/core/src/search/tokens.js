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
import { encryptionEnabled } from "../crypto/keys.js";
import { workspaceSearchKey } from "../crypto/search-key.js";
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
const parseCount = (v) => typeof v === "number" ? (Number.isSafeInteger(v) && v >= 0 ? v : null)
  : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : null;
/** Vars already logged as invalid in this isolate (by name, never the value). */
const invalidVarsLogged = new Set();
/** A SEARCH_* var as a count, or null when unset; a value that is not accepted logs search_var_invalid once and is null. */
function varCount(env, name) {
  const v = env?.[name];
  if (v === undefined || v === null || v === "") return null;
  const n = parseCount(v);
  if (n === null && !invalidVarsLogged.has(name)) {
    invalidVarsLogged.add(name);
    console.error(JSON.stringify({ event: "search_var_invalid", name }));
  }
  return n;
}
/** SEARCH_TERMS_MAX: 0–20000 (lower only; default 20000). 0 = no body tokens and no extraction. */
export const searchTermsMax = (env) => Math.min(varCount(env, "SEARCH_TERMS_MAX") ?? SEARCH_TERMS_CEILING, SEARCH_TERMS_CEILING);
/** The three bounds in charged units; `limits` is the workspace's entitlements (its `search_terms`, if any). */
export function searchScopeBounds(env, limits = {}) {
  const plan = limits?.search_terms;
  return {
    workspace: Number.isSafeInteger(plan) && plan >= 0 ? plan : varCount(env, "SEARCH_WORKSPACE_TERMS_MAX") ?? SEARCH_BOUNDS_DEFAULT.workspace,
    owner: varCount(env, "SEARCH_OWNER_TERMS_MAX") ?? SEARCH_BOUNDS_DEFAULT.owner,
    installation: Math.min(varCount(env, "SEARCH_INSTALLATION_TERMS_MAX") ?? SEARCH_BOUNDS_DEFAULT.installation, SEARCH_BOUNDS_DEFAULT.installation),
  };
}
/** SEARCH_SWEEP_WRITES_MAX: b-tree rows the sweep writes per cron run (lower only, default 10000; 0 off; 1–49 as 50). */
export function searchSweepWritesMax(env) {
  const n = Math.min(varCount(env, "SEARCH_SWEEP_WRITES_MAX") ?? 10000, 10000);
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
/**
 * SEARCH_PHASE_LOG: the per-run search_phase lines are written only when it is exactly "1". Any other value, unset or
 * empty, is off (never an error). The anomaly phases (deadline, detached) are always written.
 */
export const searchPhaseLog = (env) => env?.SEARCH_PHASE_LOG === "1";
/** Per-document cap: min(SEARCH_TERMS_MAX, 256 + floor(bytes / 8)). */
export const searchDocCap = (env, textBytes) => Math.min(searchTermsMax(env), 256 + Math.floor(textBytes / 8));
/** The target's own truncation when extraction stopped at `cap`: off, cap (the var) or size (the text's size). */
const capReason = (env, cap) => cap === 0 ? "off" : cap === searchTermsMax(env) ? "cap" : "size";

// --- Extraction ---------------------------------------------------------------------------------------------------
/**
 * u61FoldToken, stopping as soon as the folded result exceeds `max` code units (then null). Equal to u61FoldToken for
 * every result of `max` units or fewer: folding is per code point (dropped marks removed, case and accents folded).
 * Self-contained: the regular-expression statics are reset before it returns, so it never keeps `word` reachable.
 */
export function u61FoldTokenBounded(word, max = SEARCH_TERM_UNITS_MAX) {
  try { return foldBounded(word, max); } finally { forgetLastMatch(); }
}
/** u61FoldTokenBounded without its reset: the scanner calls this per piece and resets once in its own finally. */
function foldBounded(word, max) {
  if (isAscii(word)) return word.length <= max ? word.toLowerCase() : null;
  let out = "";
  for (const ch of word) {
    out += u61FoldToken(ch);
    if (out.length > max) return null;
  }
  return out;
}
/** True if every unit is below 0x80 (a loop, so no regular expression keeps the word reachable). */
function isAscii(word) {
  for (let i = 0; i < word.length; i++) if (word.charCodeAt(i) > 0x7f) return false;
  return true;
}
/** Calls add(term) for each distinct folded term, in text order, up to `cap`. Returns true if a further one was cut. */
function scanTerms(text, cap, add, fold = foldBounded) {
  if (cap <= 0 || !text) return false;
  try { return scanTermsIn(text, cap, add, fold); } finally { forgetLastMatch(); }
}
/**
 * The index's token rule (unicode61.js U61_TOKEN) with surrogate code units added to both of its excluded classes, so
 * a match never contains a surrogate unit. With the "u" flag a valid surrogate pair is one code point, matched as a
 * whole by the classes (a supplementary code point is never a surrogate unit), so on well-formed text every match is
 * unchanged. A lone surrogate is neither: it separates tokens, as SQLite's U+FFFD replacement does. The scanner never
 * runs this pattern itself (one unbounded match costs regex stack in proportion to the word, and overflows on a few Mi
 * units): it runs the bounded head and continuation patterns below, made of this pattern's own two classes.
 */
export const U61_TOKEN_WELLFORMED = new RegExp(U61_TOKEN.source.replaceAll("[^", "[^\\u{d800}-\\u{dfff}"), U61_TOKEN.flags);
/**
 * The legacy RegExp statics (RegExp.input, lastMatch, …) keep the last subject a regular expression matched alive, so
 * after scanning a large text the text itself would stay reachable. One match on an empty string replaces them.
 */
const EMPTY_MATCH = /(?:)/;
const forgetLastMatch = () => {
  EMPTY_MATCH.exec("");
  WORD_HEAD.lastIndex = 0;
  WORD_MORE.lastIndex = 0;
};
/**
 * Longest regular-expression match the scanner runs, in code points: at most 2,048 code units (a piece of astral
 * pairs). Time and peak memory were
 * the same for 256 to 4,096 units (Node 24: 1 MiB of prose about 26 ms, one 10 Mi-unit word about 160 ms); the regex
 * engine's stack grows with the match, so the smaller end of that flat range is taken.
 */
export const SEARCH_SCAN_PIECE_UNITS = 1024;
/** The token pattern's two classes, as written in U61_TOKEN_WELLFORMED: `[^…first][^…rest]*`. */
function tokenClasses(source) {
  const cut = source.indexOf("][^");
  if (!source.startsWith("[^") || !source.endsWith("]*") || cut < 0 || source.indexOf("][^", cut + 1) >= 0)
    throw new Error("search token pattern is not one first class followed by one repeated class");
  return { first: source.slice(0, cut + 1), rest: source.slice(cut + 1, -1) };
}
const TOKEN_CLASSES = tokenClasses(U61_TOKEN_WELLFORMED.source);
/** A word's first piece: the next word start, then at most one piece. Global: it searches forward from lastIndex. */
const WORD_HEAD = new RegExp(`${TOKEN_CLASSES.first}${TOKEN_CLASSES.rest}{0,${SEARCH_SCAN_PIECE_UNITS - 1}}`, "gu");
/** A continuation piece of the same word: sticky, so it matches only exactly where the previous piece ended. */
const WORD_MORE = new RegExp(`${TOKEN_CLASSES.rest}{1,${SEARCH_SCAN_PIECE_UNITS}}`, "yu");
/**
 * True if a matched piece holds the full SEARCH_SCAN_PIECE_UNITS code points, so the word may go on. A piece of fewer
 * units has fewer code points; a piece of P..2P units is counted (it holds no lone surrogate, so every high surrogate
 * starts a pair). A shorter piece ended because the rest class failed or the text ended: no continuation to try.
 */
function pieceIsFull(piece) {
  if (piece.length < SEARCH_SCAN_PIECE_UNITS) return false;
  let points = piece.length;
  for (let i = 0; i < piece.length; i++) if ((piece.charCodeAt(i) & 0xfc00) === 0xd800) points--;
  return points >= SEARCH_SCAN_PIECE_UNITS;
}
/**
 * Calls onWord(start, end, term) for each word in text order, where [start, end) is exactly a U61_TOKEN_WELLFORMED
 * match: the greedy run `first rest*` is the head piece followed by continuation pieces while the rest class goes on,
 * and with the "u" flag no piece ends inside a surrogate pair. onWord returning false stops the scan.
 *
 * With `fold`, term is the folded word or null: fold(piece, max) folds one piece, or returns null if its result would
 * be longer than max. Folding is per code point (each one is folded, or dropped as a mark, on its own), so folding the
 * pieces and joining equals folding the whole word. The word is never concatenated: the term grows to at most
 * SEARCH_TERM_UNITS_MAX units, and once it would pass that the word is dead and its remaining pieces are only matched
 * and skipped. Memory per word: one piece plus 200 units. Without fold, term is null.
 *
 * Memory per word is a small fixed bound: at most the head match and one continuation match at a time (each at most
 * SEARCH_SCAN_PIECE_UNITS code points) plus the term of at most 200 units, whatever the word's length.
 *
 * Every match sets lastIndex itself first: the patterns are shared by every scan in the isolate (and a scan may run
 * inside another's onWord), so their position is never trusted. The caller resets the RegExp statics afterwards.
 */
function scanWordsIn(text, fold, onWord) {
  let pos = 0;
  for (;;) {
    WORD_HEAD.lastIndex = pos;
    const head = WORD_HEAD.exec(text);
    if (!head) return;
    const start = head.index;
    let end = WORD_HEAD.lastIndex;
    let term = fold ? fold(head[0], SEARCH_TERM_UNITS_MAX) : null;
    let full = pieceIsFull(head[0]);
    while (full) {
      WORD_MORE.lastIndex = end;
      const more = WORD_MORE.exec(text);
      if (!more) break;
      end = WORD_MORE.lastIndex;
      full = pieceIsFull(more[0]);
      if (term === null) continue;   // a dead word's pieces are only consumed
      const folded = fold(more[0], SEARCH_TERM_UNITS_MAX - term.length);
      term = folded === null ? null : term + folded;
    }
    pos = end;
    if (onWord(start, end, term) === false) return;
  }
}
/** Word boundaries: onWord(start, end) for each word of the index's token rule, in order; false stops (tests). */
export function scanSearchWords(text, onWord) {
  try { scanWordsIn(text, null, onWord); } finally { forgetLastMatch(); }
}
function scanTermsIn(text, cap, add, fold) {
  const seen = new Set();
  let truncated = false;
  try {
    scanWordsIn(text, fold, (_start, _end, t) => {
      if (!t || seen.has(t)) return true;
      if (seen.size >= cap) { truncated = true; return false; }
      seen.add(t);
      add(t);
      return true;
    });
  } finally {
    seen.clear();   // the scan's working set is released here, not left to whatever still references this frame
  }
  return truncated;
}
/** Distinct index terms of a text, at most `cap` (tests and small callers; runs use the packed forms). */
export function extractSearchTerms(text, cap) {
  return extractSearchTermsWith(text, cap, foldBounded);
}
/** extractSearchTerms with the piece fold given (fold(piece, max), as u61FoldTokenBounded; tests count through it). */
export function extractSearchTermsWith(text, cap, fold) {
  const terms = [];
  const truncated = scanTerms(text, cap, (t) => terms.push(t), fold);
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
  const result = { units: units.slice(0, used), offsets: Uint32Array.from(offsets), count: offsets.length - 1, truncated };
  offsets.length = 0;   // the growable list is released with the result built
  return result;
}
/**
 * Private storage of flat terms, keyed by the opaque handle extractSearchTermsFlat returned: { bytes, offsets }. The
 * arrays never leave this module, so no caller can rewrite, detach, share or decorate them. searchJob accepts a flat
 * job only for a handle present here; the entry is deleted when its job takes the terms, finishes or is dropped
 * (dropFlat), so the storage does not outlive the run because the caller still holds the handle.
 */
const FLAT_STORE = new WeakMap();
/** Entries put in FLAT_STORE and not yet dropped (an entry whose handle is collected without a job is not counted down). */
let flatHeld = 0;
/** Handles held by an admitted job of any live run: a handle is used by one job only. */
const FLAT_ADMITTED = new WeakSet();
/** Deletes a handle's private storage (no-op for an unknown or already dropped handle). */
function dropFlat(handle) {
  if (!handle) return;
  FLAT_ADMITTED.delete(handle);
  if (FLAT_STORE.delete(handle)) flatHeld--;
}
/** Drops a handle that no admitted job holds (a refused or never-admitted job's own storage). */
const dropUnadmittedFlat = (handle) => { if (handle && !FLAT_ADMITTED.has(handle)) dropFlat(handle); };
/** Test-only: the number of flat storages created and not yet dropped. */
export const searchFlatHeld = () => flatHeld;
/** Test-only: the terms behind a live handle, decoded into new strings (the arrays are never exposed). */
export function searchFlatTerms(handle) {
  const store = FLAT_STORE.get(handle);
  if (!store) throw new HttpError(500, "search_job_invalid", "A search job is invalid: flat container");
  const dec = new TextDecoder(), out = [];
  for (let i = 0; i + 1 < store.offsets.length; i++) out.push(dec.decode(store.bytes.subarray(store.offsets[i], store.offsets[i + 1])));
  return out;
}
/**
 * Terms packed as UTF-8 bytes and offsets (upload finish: extracted before its response, then the text is dropped),
 * held privately. Returns an opaque frozen handle { count, truncated, byteLength } (plain data); pass it unchanged, once,
 * as a job's `flat`. byteLength <= min(12,000,000, 3 × text.length).
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
  // Exact copies (slice and from allocate fresh buffers they cover whole), kept only in FLAT_STORE.
  const store = { bytes: bytes.slice(0, used), offsets: Uint32Array.from(offsets) };
  offsets.length = 0;   // the growable list is released with the result built
  const handle = Object.freeze({ count: store.offsets.length - 1, truncated, byteLength: store.bytes.byteLength });
  FLAT_STORE.set(handle, store);
  flatHeld++;
  return handle;
}
/** Bytes a packed term list holds. */
const packedBytes = (p) => (p.units ? p.units.byteLength : p.bytes.byteLength) + p.offsets.byteLength;
/** Most storage one folded term (at most 200 UTF-16 units) can occupy: 200 units, or 600 UTF-8 bytes. */
const TERM_UNITS_SPAN = SEARCH_TERM_UNITS_MAX, TERM_BYTES_SPAN = 3 * SEARCH_TERM_UNITS_MAX;
/**
 * UTF-8 inputs for terms [from, to) of a packed list (one HMAC chunk's input buffers). Every interval is checked before
 * anything is allocated: integers with 0 <= a <= b <= the storage's length and b − a within one term's maximum, else
 * 500 search_terms_invalid. Unreachable through the public surface (the storage is private); an assertion against
 * our own bugs, so one chunk can never copy more than 1,000 terms' worth.
 */
function termInputs(p, from, to) {
  const store = p.units ?? p.bytes, span = p.units ? TERM_UNITS_SPAN : TERM_BYTES_SPAN;
  for (let i = from; i < to; i++) {
    const a = p.offsets[i], b = p.offsets[i + 1];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b > store.length || b - a > span)
      throw new HttpError(500, "search_terms_invalid", "Packed search terms are invalid");
  }
  const enc = new TextEncoder(), out = [];
  for (let i = from; i < to; i++) {
    const a = p.offsets[i], b = p.offsets[i + 1];
    out.push(p.units ? enc.encode(String.fromCharCode.apply(null, Array.from(p.units.subarray(a, b)))) : p.bytes.slice(a, b));
  }
  return out;
}
/** termInputs, for its bounds test. */
export const searchTermInputs = termInputs;

// --- Keys and tokens ----------------------------------------------------------------------------------------------
const HEX32 = /^[0-9a-f]{32}$/;
const hex16 = (buf) => {
  const b = new Uint8Array(buf, 0, 16);
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16);
  return s;
};
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
 * The workspace's search key: { keyId, key, encrypted }. Encryption on: crypto/search-key.js derives it (key_id is the
 * active workspace key's). Off: the workspace_search_keys row, created on first use in one batch (insert-or-keep, then
 * read).
 */
export async function searchTokenKey(env, workspaceId) {
  if (await encryptionEnabled(env)) {
    const { keyId, key } = await workspaceSearchKey(env, workspaceId);
    return { keyId, key, encrypted: true };
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  let read;
  try {
    [, read] = await env.DB.batch([
      env.DB.prepare("INSERT INTO workspace_search_keys (workspace_id, key_id, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id) DO NOTHING")
        .bind(workspaceId, randomId("sk"), b64urlEncode(fresh), Date.now()),
      env.DB.prepare("SELECT key_id, secret FROM workspace_search_keys WHERE workspace_id = ?").bind(workspaceId),
    ]);
  } finally { fresh.fill(0); }
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
WHERE artifact_id = ?A AND revision_id <> '' AND workspace_id = ?W AND owner_id = ?O AND ${H} AND ${LIVE}
  AND NOT (revision_id = ?R AND key_id = ?K AND token_digest = ?DIGEST)`),
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

/** A row at '' held by a writer (not a lifecycle lease): its term_count says nothing about its tokens. */
const WRITER_HELD = "revision_id = '' AND substr(writer, 1, 6) <> 'purge:'";
// Lifecycle deletes (purge, sweep paths, and K/Kc for a writer's oversize path). `eligible` is a named fragment.
const lifecycleCache = new Map();
/** { L, K, Kc, X, Xc } for one eligibility fragment (named placeholders). */
export function lifecycleStatements(eligible) {
  let s = lifecycleCache.get(eligible);
  if (!s) {
    const held = "AND revision_id = '' AND writer = ?PN";
    s = Object.freeze({
      // L counts a row's tokens once, when it takes the row from a writer (a dead writer may have added tokens beyond
      // term_count). Complete rows carry an exact term_count and purge-held rows an upper bound (tokens only shrink
      // under a lifecycle lease, and term_count is never lowered), so the selections never read search_tokens.
      // The count runs at most once per row: after L the row is purge-held, so every later L keeps term_count.
      L: named(`UPDATE search_token_docs SET revision_id = '', writer = ?PN, gen = gen + 1,
  term_count = CASE WHEN ${WRITER_HELD} THEN (SELECT COUNT(*) FROM (SELECT 1 FROM search_tokens WHERE doc_id = ?D LIMIT ${SET_READ_LIMIT}))
                    ELSE term_count END
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
/** Phases logged whatever SEARCH_PHASE_LOG says: they are anomalies, not progress. */
const ANOMALY_PHASES = new Set(["deadline", "detached"]);
/**
 * search_phase, at most once per run and phase; never content. Progress phases only when the run's env has
 * SEARCH_PHASE_LOG = "1" (run.phaseLog). A log line that throws is ignored: logging never changes what a run does.
 */
function phase(run, name) {
  if (run.phases.has(name)) return;
  run.phases.add(name);
  if (!run.phaseLog && !ANOMALY_PHASES.has(name)) return;
  try { logEvent("search_phase", { phase: name, run: run.id, ms: Date.now() - run.admittedAt }); } catch { /* ignored */ }
}

// --- Runs ---------------------------------------------------------------------------------------------------------
/** A byte or call amount: a finite non-negative integer, else 500 search_amount_invalid (nothing is stored). */
function amount(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(500, "search_amount_invalid", "A search reservation amount is invalid");
  return n;
}
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
  // Each job's flat handle is dropped from FLAT_STORE here too: settle() and detach() both come through this.
  for (const job of holder.jobs ?? []) { dropFlat(job.flat); job.text = null; job.flat = null; job.terms = null; job.tokens = null; job.removes = null; job.adds = null; }
  holder.jobs = null; holder.plan = null; holder.set = null; holder.pending = null;
}

// --- Admission per isolate ---------------------------------------------------------------------------------------
/** Active total (envelopes and payloads of unsettled, undetached runs), active-run ceiling, detached set, horizon. */
export const SEARCH_ACTIVE_MAX_BYTES = 32 * MiB;
export const SEARCH_ACTIVE_RUNS_MAX = 16;
export const SEARCH_DETACHED_MAX = 4;
export const SEARCH_DETACH_AFTER_MS = 120000;
/**
 * This isolate's indexing reservations. A run leaves `active` only by settling or by detachment; a detached run keeps
 * its envelope counted in `detached` until it settles (exactly once). No timer frees capacity. Counted bytes are at
 * most SEARCH_ACTIVE_MAX_BYTES + SEARCH_DETACHED_MAX × SEARCH_CALL_ENVELOPE_BYTES (48 MiB).
 */
const isolate = { active: new Set(), activeBytes: 0, detached: new Set(), refused: 0 };
/** Started runs, for drainSearchIndexing. */
const running = new Map();
/** A snapshot of this isolate's admission state (counts and bytes only). */
export function searchAdmissionState() {
  return { active: isolate.active.size, activeBytes: isolate.activeBytes, detached: isolate.detached.size,
    detachedBytes: isolate.detached.size * SEARCH_CALL_ENVELOPE_BYTES, refused: isolate.refused, running: running.size };
}
/** Detach every unsettled run admitted at least SEARCH_DETACH_AFTER_MS ago, while the detached set has room. */
function detachExpired(now, except = null) {
  for (const run of [...isolate.active]) {
    if (isolate.detached.size >= SEARCH_DETACHED_MAX) return;
    if (run !== except && now - run.admittedAt >= SEARCH_DETACH_AFTER_MS) run.detach(now);
  }
}
/**
 * Open a run reservation (envelope + base) if this isolate has room, after detaching expired runs; null if not. A
 * refusal while the detached set is full logs search_admission_stuck (the caller logs it at most once per request).
 */
export function openSearchRun({ declaredCalls = 0 } = {}) {
  amount(declaredCalls);
  const now = Date.now();
  detachExpired(now);
  const bytes = SEARCH_CALL_ENVELOPE_BYTES + SEARCH_RUN_BASE_BYTES;
  if (isolate.active.size >= SEARCH_ACTIVE_RUNS_MAX || isolate.activeBytes + bytes > SEARCH_ACTIVE_MAX_BYTES) { isolate.refused++; return null; }
  return new SearchRun({ declaredCalls, now });
}

/**
 * One indexing run: its holder (everything large), its payload reservation and its budgets. The envelope (the largest
 * single call in flight with its result) is held from admission to settlement. Create runs with openSearchRun.
 */
export class SearchRun {
  constructor({ declaredCalls = 0, now = Date.now() } = {}) {
    this.id = randomId("sr", 6);
    this.holder = { jobs: [], plan: null, set: null, pending: null, detached: false };
    this.envelope = SEARCH_CALL_ENVELOPE_BYTES;
    this.payload = SEARCH_RUN_BASE_BYTES;
    isolate.active.add(this);
    isolate.activeBytes += this.envelope + this.payload;
    this.callBudget = Math.max(0, Math.min(SEARCH_RUN_LIMITS.calls, 1000 - declaredCalls - 20));
    this.calls = 0; this.tokenOps = 0; this.textUnits = 0; this.removeValues = 0; this.maxRemoveValues = 0;
    this.admittedAt = now; this.startedAt = 0; this.deadline = Infinity;
    this.detached = false; this.settled = false;
    this.nonce = randomId("sw", 9);
    this.phases = new Set();
    this.phaseLog = false;   // set from the env that admits or starts the run (searchPhaseLog)
    this.skipped = {};
    this.completed = 0;
    this.unchanged = 0;
  }
  /** Add `bytes` to the payload if the run (26 MiB) and the isolate (32 MiB) stay within their limits; else false. */
  reserve(bytes) {
    amount(bytes);
    if (this.detached || this.settled) return false;
    if (this.envelope + this.payload + bytes > SEARCH_RUN_MAX_BYTES) return false;
    detachExpired(Date.now(), this);
    if (isolate.activeBytes + bytes > SEARCH_ACTIVE_MAX_BYTES) return false;
    this.payload += bytes;
    isolate.activeBytes += bytes;
    return true;
  }
  release(bytes) {
    amount(bytes);
    if (this.detached || this.settled) return;
    const n = Math.min(bytes, this.payload);
    this.payload -= n;
    isolate.activeBytes -= n;
  }
  /** Lower (never raise) a job's charge to `bytes`. */
  lower(job, bytes) { amount(bytes); if (bytes < job.charge) { this.release(job.charge - bytes); job.charge = bytes; } }
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
  /**
   * At the horizon: null the holder, release the payload, keep the envelope counted in the detached set. The run's
   * next step after any await stops (before/after), storing nothing.
   */
  detach(now = Date.now()) {
    if (this.detached || this.settled) return;
    this.detached = true;
    this.holder.detached = true;
    clearHolder(this.holder);
    isolate.active.delete(this);
    isolate.activeBytes -= this.envelope + this.payload;
    this.payload = 0;
    isolate.detached.add(this);
    phase(this, "detached");
    logError("search_run_detached", { run: this.id, age: now - this.admittedAt });
  }
  /** Settle once: nulls every holder field and releases the reservation (or frees its detached entry). */
  settle() {
    if (this.settled) return;
    clearHolder(this.holder);
    if (this.detached) isolate.detached.delete(this);
    else {
      isolate.active.delete(this);
      isolate.activeBytes -= this.envelope + this.payload;
    }
    this.payload = 0;
    this.settled = true;
  }
  /** Bytes this run holds in the isolate's accounting (envelope + payload; the envelope only once detached). */
  get counted() { return this.settled ? 0 : this.detached ? this.envelope : this.envelope + this.payload; }
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
/**
 * A job as the holder keeps it, from a descriptor { artifactId, projectId, revisionId } plus either { text, textBytes }
 * (textBytes: the stored UTF-8 size, required; admission never scans the text) or { flat, textBytes, textUnits }
 * (upload finish: flat from extractSearchTermsFlat). Anything else is 500 search_job_invalid, thrown before any
 * reservation changes.
 */
export function searchJob(env, input) {
  const invalid = (why) => new HttpError(500, "search_job_invalid", "A search job is invalid: " + why);
  // Each descriptor property is read exactly once, here.
  const { artifactId, projectId, revisionId, text = null, flat = null, textBytes, textUnits, ticket = null } = input ?? {};
  // A descriptor refused here drops its flat handle's storage (unless an admitted job holds that handle).
  try { return validJob(env, invalid, { artifactId, projectId, revisionId, text, flat, textBytes, textUnits, ticket }); }
  catch (e) { dropUnadmittedFlat(flat); throw e; }
}
function validJob(env, invalid, { artifactId, projectId, revisionId, text, flat, textBytes, textUnits, ticket }) {
  if (typeof artifactId !== "string" || typeof projectId !== "string" || typeof revisionId !== "string") throw invalid("ids");
  // A ticket (reserveUploadTerms) only with a flat handle; its run and state are checked at admission.
  if (ticket !== null && (flat === null || !UPLOAD_TICKETS.has(ticket))) throw invalid("ticket");
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  if ((text === null) === (flat === null)) throw invalid("exactly one of text and flat");
  if (!count(textBytes)) throw invalid("textBytes");
  if (text !== null && typeof text !== "string") throw invalid("text");
  if (text !== null && textUnits !== undefined && textUnits !== text.length) throw invalid("textUnits");
  if (flat !== null && !count(textUnits)) throw invalid("textUnits");
  const cap = searchDocCap(env, textBytes);
  const units = text !== null ? text.length : textUnits;
  if (flat !== null) {
    // Only a live handle from extractSearchTermsFlat: its storage is private, so the job retains exactly what
    // extraction made. The handle is frozen plain data; each field is read once, and checked against the storage.
    const store = FLAT_STORE.get(flat);
    if (!store) throw invalid("flat container");
    const { bytes, offsets } = store, n = flat.count, byteLength = flat.byteLength;
    // The caller's size context must agree: at most `cap` terms, consistent offsets, within 3 × units.
    if (!count(n) || offsets.length !== n + 1 || byteLength !== bytes.byteLength
      || offsets[0] !== 0 || offsets[n] !== bytes.byteLength || bytes.byteLength > Math.min(12000000, 3 * units)) throw invalid("flat");
    for (let i = 0; i < n; i++) if (offsets[i + 1] < offsets[i]) throw invalid("flat offsets");
    if (n > cap && cap > 0) throw invalid("flat count");
  }
  // SEARCH_TERMS_MAX = 0: no extraction; the text is never kept (the row is written complete as `off`). An off job's
  // handle was still validated above (its offsets are inspected); admitSearchJobs drops its storage once the call's
  // handles are known to be distinct.
  const off = cap === 0;
  return {
    // The handle (nothing the caller attached to the descriptor is carried into the job).
    meta: { artifactId, projectId, revisionId }, text: off ? null : text,
    flat, ticket, terms: null, tokens: null, removes: null, adds: null,
    cap, units: off ? 0 : units, charge: 0, reason: "", digest: "",
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
  // The jobs array is reached only through run.holder (never a local across an await), so detaching releases it.
  for (let i = 0; i < run.holder.jobs.length; i += SEARCH_BATCH_STATEMENTS_MAX) {
    const stmts = run.holder.jobs.slice(i, i + SEARCH_BATCH_STATEMENTS_MAX).map((j) => bindNamed(db, SEARCH_SQL.PLAN, { A: j.meta.artifactId, P: j.meta.projectId, R: j.meta.revisionId }));
    const results = await db.DB.batch(stmts);
    run.holder.jobs.slice(i, i + SEARCH_BATCH_STATEMENTS_MAX).forEach((j, k) => { j.row = results[k]?.results?.[0] ?? null; });
  }
  run.holder.plan = { workspaces: new Map(), installationFullLogged: false };
  for (const j of run.holder.jobs) {
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
    const bounds = searchScopeBounds(db, await step(run, () => workspaceLimits(db, W)));
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
  run.current = job.meta.artifactId;
  const ws = await workspaceSetup(db, run, job);
  if (job.text !== null) {
    const p = extractSearchTermsUnits(job.text, job.cap);
    job.text = null;
    job.terms = p;
    job.reason = p.truncated ? capReason(db, job.cap) : "";
    run.lower(job, packedBytes(p) + SEARCH_TOKEN_BYTES * job.cap);
  } else if (job.flat !== null) {
    // The job takes the private storage and the handle is spent: a second use of it is refused.
    const handle = job.flat, store = FLAT_STORE.get(handle);
    dropFlat(handle);
    job.flat = null;
    if (!store) throw new HttpError(500, "search_terms_invalid", "Packed search terms are invalid");
    job.terms = { bytes: store.bytes, offsets: store.offsets, count: handle.count, truncated: handle.truncated };
    job.reason = job.terms.truncated ? capReason(db, job.cap) : "";
    run.lower(job, packedBytes(job.terms) + SEARCH_TOKEN_BYTES * job.cap);
  } else if (job.cap === 0) {
    job.terms = { units: new Uint16Array(0), offsets: Uint32Array.of(0), count: 0, truncated: false };
  } else {
    // Neither text nor flat and not off: the job lost its input (a bug). Never index it as complete and empty.
    throw new HttpError(500, "search_terms_invalid", "A search job has no terms to index");
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
  dropFlat(job.flat);
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
  // A re-plan is not started without the calls to finish it: the lease batch, the lease read and one write.
  if (job.replanned && run.callBudget - run.calls < 3) { finishJob(run, job, "budget"); return; }
  try {
    // A re-planned row may be complete again (T1r); exactly one of the two can change it. T1r leaves a row that is
    // already correct for this head, key and target alone, and the job then ends unchanged.
    leased = await db.DB.batch(job.replanned ? [bindNamed(db, SEARCH_SQL.T1u, v), bindNamed(db, SEARCH_SQL.T1r, v), fence] : [bindNamed(db, SEARCH_SQL.T1u, v), fence]);
  } catch (e) {
    if (e instanceof RunStop) throw e;
    logError("search_index_failed", { artifactId: job.meta.artifactId, code: fenceRefusal(e)?.code ?? e?.code ?? "error" });
    throw new RunStop("error");
  }
  if (!(leased[0]?.meta?.changes > 0) && !(job.replanned && leased[1]?.meta?.changes > 0)) {
    if (job.replanned && await rowIsCurrent(db, job)) { run.unchanged++; finishJob(run, job); return; }
    finishJob(run, job, "lost");
    return;
  }
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

/** Is the job's row complete for its head, key and target (another writer finished the same work)? */
async function rowIsCurrent(db, job) {
  const r = await db.DB.prepare("SELECT revision_id, key_id, token_digest FROM search_token_docs WHERE artifact_id = ?").bind(job.meta.artifactId).first();
  return !!r && r.revision_id === job.meta.revisionId && r.key_id === job.keyId && r.token_digest === job.digest;
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

/**
 * Stable group: the pinned read, then (no await) the diffs of as many members as can be charged; set nulled after.
 * Every member's diff is built before any is packed (a deviation from the design's one-current-document remainder).
 * The bound still holds: a group holds at most 20,000 stored tokens, so its removes are at most 20,000, each charged
 * before it is retained, plus at most one pending batch (10,000) from earlier documents: at most 30,000 charged.
 */
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
  // Jobs are read through run.holder at each step (never a local array across an await), so detaching releases them.
  const at = (i) => run.holder.jobs[i];
  for (let i = 0; i < run.holder.jobs.length;) {
    const job = at(i);
    if (job.done) { i++; continue; }
    if (job.kind === "stable") {
      const group = [];
      let tokens = 0;
      while (i < run.holder.jobs.length && group.length < STABLE_GROUP_DOCS) {
        const j = at(i);
        if (j.done) { i++; continue; }
        if (j.kind !== "stable") break;
        if (group.length && tokens + j.row.term_count > STABLE_GROUP_TOKENS) break;
        await prepareTokens(db, run, j);
        i++;
        if (j.row.revision_id === j.meta.revisionId && j.row.key_id === j.keyId && j.row.token_digest === j.digest) { run.unchanged++; finishJob(run, j); continue; }
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
      if (!diffInto(run, job, () => "", 0)) { finishJob(run, job, "charge"); continue; }
      await writeJob(db, run, job, [SEARCH_SQL.T1z, SEARCH_SQL.T1nc], queue);
      continue;
    }
    if (!diffInto(run, job, () => "", 0)) { finishJob(run, job, "charge"); continue; }
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
  // A run settled before it started (dropped by startDeferredWork) logs nothing here: its skips were logged once.
  let quiet = false;
  run.running = true;   // from here on admitSearchJobs refuses this run (the writer owns holder.jobs)
  try {
    await nextTurn();
    if (run.detached) return;
    if (run.settled) { quiet = true; return; }
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
      logError("search_index_failed", { run: run.id, ...run.current ? { artifactId: run.current } : {}, code: fenceRefusal(e)?.code ?? e?.code ?? "error" });
      for (const job of run.holder.jobs ?? []) if (!job.done) run.skip("error");
    }
  } finally {
    if (!quiet) {
      const skipped = Object.values(run.skipped).reduce((a, b) => a + b, 0);
      if (skipped) logEvent("search_index_skipped", { run: run.id, skipped, reasons: run.skipped });
      if (!run.detached) phase(run, "deferred_end");
      run.settle();
    }
  }
}

/**
 * Index `jobs` now, as one run (awaited; never rejects). Each job is { artifactId, projectId, revisionId, text } or,
 * for upload finish, { …, flat, textBytes, textUnits }. Jobs beyond the run's limits (100 documents, 10 Mi code units,
 * 26 MiB) are skipped. Returns the run's tally.
 */
export async function indexSearchJobs(env, jobs, { declaredCalls = 0 } = {}) {
  const run = openSearchRun({ declaredCalls });
  if (!run) return { run: null, calls: 0, completed: 0, unchanged: 0, skipped: { admission: jobs.length }, tokenOps: 0, maxRemoveValues: 0 };
  // A descriptor that throws settles the run (holder cleared, reservation released) before the error goes on.
  try { admitSearchJobs(env, run, jobs); } catch (e) { run.settle(); throw e; }
  await track(run, runSearchIndexing(env, run));
  return runTally(run);
}
/** Keep a started run's promise until it settles (drainSearchIndexing). */
function track(run, promise) {
  const p = promise.catch(() => {}).finally(() => running.delete(run));
  running.set(run, p);
  return p;
}

// --- Deferral (createWorker's fetch wrapper and the publishing paths use these; wired in a later commit) -----------
const DEFERRED = Symbol("agent-library.deferred-work");
/** A request's env with its own deferred-work queue. createWorker attaches one per fetch. */
export const withDeferredWork = (env) => ({ ...env, [DEFERRED]: { run: null, started: false, discarded: false, skipped: {}, stuckLogged: false } });
const skipCount = (skipped) => Object.values(skipped).reduce((a, b) => a + b, 0);
/**
 * Hand index jobs ({ artifactId, projectId, revisionId, text } or, for upload finish, { …, flat, textBytes, textUnits })
 * of a successful publication to this request's run. The request's first job opens the run reservation; each job is
 * admitted if it fits, else dropped and counted. Never awaited, never throws, returns nothing; the work starts only
 * after the handler's Response (startDeferredWork).
 */
export function deferSearchIndexing(env, jobs) {
  const q = env?.[DEFERRED];
  try {
    if (!Array.isArray(jobs) || !jobs.length) return;
    if (!q) { logEvent("search_index_skipped", { skipped: jobs.length, reasons: { unwired: jobs.length } }); return; }
    if (q.started || q.discarded) { q.skipped.late = (q.skipped.late ?? 0) + jobs.length; return; }
    if (!requestRun(q, jobs.length)) return;
    admitSearchJobs(env, q.run, jobs);
  } catch (e) {
    if (q) q.skipped.error = (q.skipped.error ?? 0) + (Array.isArray(jobs) ? jobs.length : 1);
    logError("search_index_failed", { code: e?.code ?? "error" });
  }
}
/** The request's run, opened on first use; null (the jobs counted as admission skips) when the isolate refuses one. */
function requestRun(q, n) {
  if (q.run) return q.run;
  q.run = openSearchRun();
  if (q.run) return q.run;
  q.skipped.admission = (q.skipped.admission ?? 0) + n;
  if (!q.stuckLogged && isolate.detached.size >= SEARCH_DETACHED_MAX) {
    q.stuckLogged = true;
    logError("search_admission_stuck", { active: isolate.active.size, activeBytes: isolate.activeBytes, detached: isolate.detached.size, refused: isolate.refused });
  }
  return null;
}

// --- Upload finish: the payload reservation is taken before extraction ----------------------------------------------
/** Ticket → { run, amount, units, state: "held" | "consumed" | "released" }. Tickets are opaque frozen objects. */
const UPLOAD_TICKETS = new WeakMap();
function releaseTicket(t) {
  if (t.state !== "held") return;
  t.state = "released";
  t.run.release(t.amount);   // a no-op once the run detached or settled (its payload is gone with it)
}
/**
 * Upload finish, inside its slot and before extraction: reserve in this request's run the payload an upload job of
 * `text` (the decoded upload; its .length is the job's textUnits) and `textBytes` (the stored size) will be charged:
 * min(12,000,000, 3 × units) + 96 B × docCap. The same limits as admission (the run's 26 MiB and documents and code
 * units, the isolate's 32 MiB). Returns an opaque ticket for the job's `ticket`, or null with nothing reserved: off
 * (docCap 0), no deferred-work queue, the run already started, or no room (counted as one `admission` skip). Never throws.
 */
export function reserveUploadTerms(env, text, textBytes) {
  const q = env?.[DEFERRED];
  try {
    if (typeof text !== "string" || !Number.isSafeInteger(textBytes) || textBytes < 0) return null;
    const cap = searchDocCap(env, textBytes);
    if (cap === 0) return null;
    if (!q) { logEvent("search_index_skipped", { skipped: 1, reasons: { unwired: 1 } }); return null; }
    if (q.started || q.discarded) { q.skipped.late = (q.skipped.late ?? 0) + 1; return null; }
    const run = requestRun(q, 1);
    if (!run) return null;
    const units = text.length, amount = searchJobCharge({ cap, units }, { upload: true });
    if (run.startedAt || run.settled || run.detached || run.running || run.holder.jobs.length >= SEARCH_RUN_LIMITS.docs
      || run.textUnits + units > SEARCH_RUN_LIMITS.textUnits || !run.reserve(amount)) {
      q.skipped.admission = (q.skipped.admission ?? 0) + 1;
      return null;
    }
    const ticket = Object.freeze({});
    UPLOAD_TICKETS.set(ticket, { run, amount, units, state: "held" });
    return ticket;
  } catch {
    if (q) q.skipped.error = (q.skipped.error ?? 0) + 1;
    return null;
  }
}
/**
 * Every exit of an upload finish's text branch (in its finally): release the ticket's reservation unless its job was
 * admitted, and drop the flat handle's storage unless an admitted job holds it. `reason` (optional) counts the
 * document as skipped (an extraction failure). Idempotent; never throws.
 */
export function releaseUploadTerms(env, ticket, handle, reason) {
  try {
    const t = ticket ? UPLOAD_TICKETS.get(ticket) : null;
    if (t) releaseTicket(t);
    if (handle) dropUnadmittedFlat(handle);
    const q = env?.[DEFERRED];
    if (reason && q) q.skipped[reason] = (q.skipped[reason] ?? 0) + 1;
  } catch { /* never fails the finish */ }
}

/** Log the request's skipped jobs when it has no run (a run logs its own, once, when it ends). */
function logRequestSkips(q) {
  const n = skipCount(q.skipped);
  if (n) logEvent("search_index_skipped", { skipped: n, reasons: q.skipped });
  q.skipped = {};
}
/**
 * After the handler's Response has resolved: start the request's run with ctx.waitUntil (one promise that never
 * rejects). The run begins with `await scheduler.wait(0)`.
 */
export function startDeferredWork(env, ctx) {
  const q = env?.[DEFERRED];
  if (!q || q.started || q.discarded) return;
  q.started = true;
  const run = q.run;
  q.run = null;
  // From here until ctx.waitUntil(p) has returned, any throw (a throwing waitUntil getter, a log line, …) drops and
  // settles the run: it never stays registered without a runner, and nothing escapes to the wrapper.
  try {
    if (!run || !run.holder.jobs?.length) {
      if (run) { for (const [k, n] of Object.entries(run.skipped)) q.skipped[k] = (q.skipped[k] ?? 0) + n; run.settle(); }
      logRequestSkips(q);
      return;
    }
    for (const [k, n] of Object.entries(q.skipped)) run.skip(k, n);
    q.skipped = {};
    // Read once: a getter is not trusted twice. Without a usable waitUntil the run is never started.
    const waitUntil = ctx?.waitUntil;
    if (typeof waitUntil !== "function") { dropRun(q, run, "unstarted"); return; }
    phase(run, "handler_done");
    // The run has not done anything yet (it begins with scheduler.wait(0)): if anything below throws, it is settled
    // now, and runSearchIndexing returns quietly when it finds it settled after its first yield.
    const p = track(run, runSearchIndexing(env, run));
    waitUntil.call(ctx, p);
  } catch {
    if (run) dropRun(q, run, "unstarted");
  }
}
/** Settle a run that never started: count its jobs as skipped for `reason` and log the request's skips. */
function dropRun(q, run, reason) {
  try {
    for (const [k, n] of Object.entries(run.skipped)) q.skipped[k] = (q.skipped[k] ?? 0) + n;
    const n = run.holder.jobs?.length ?? 0;
    if (n) q.skipped[reason] = (q.skipped[reason] ?? 0) + n;
  } finally {
    // Settling never depends on the tally or the log line succeeding.
    run.settle();
  }
  try { logRequestSkips(q); } catch { /* a log line never fails the request */ }
}
/** In the fetch wrapper's `finally`: a run that was not started is dropped (holder nulled, reservation released). */
export function discardDeferredWork(env) {
  try {
    const q = env?.[DEFERRED];
    if (!q || q.started || q.discarded) return;
    q.discarded = true;
    const run = q.run;
    q.run = null;
    if (run) dropRun(q, run, "discarded");
    else logRequestSkips(q);
  } catch { /* never throws into the fetch wrapper's finally */ }
}
/** Resolves when every run started in this isolate so far has settled (tests and local tools). */
export async function drainSearchIndexing() {
  while (running.size) await Promise.all([...running.values()]);
}
/**
 * Admit jobs into a run's holder, in order, while it stays within its limits (100 documents, 10 Mi code units, 26 MiB,
 * the isolate's free bytes); the rest are counted as skipped (admission). Rejected jobs never enter the holder.
 */
export function admitSearchJobs(env, run, jobs) {
  // Only a run that has not started may take jobs: once started, the writer iterates holder.jobs.
  if (!run || run.startedAt || run.settled || run.detached || run.running)
    throw new HttpError(500, "search_run_invalid", "Search jobs can only be added to a run that has not started");
  run.phaseLog = searchPhaseLog(env);
  // Every descriptor is checked before anything is reserved, so a bad one changes no counter. A flat handle is used by
  // one job only: one already held by an admitted job (of any live run) or given twice in this call is refused. A
  // refused call drops the storage of every handle it read that no admitted job holds.
  const all = [];
  try {
    for (const input of jobs) all.push(searchJob(env, input));
    const inCall = new Set();
    for (const j of all) {
      if (j.flat === null) continue;
      if (FLAT_ADMITTED.has(j.flat) || inCall.has(j.flat)) throw new HttpError(500, "search_job_invalid", "A search job is invalid: flat container");
      inCall.add(j.flat);
    }
    // A ticket must be held (not consumed or released), belong to this run, appear once, and match the job's charge.
    const tickets = new Set();
    for (const j of all) {
      if (j.ticket === null) continue;
      const t = UPLOAD_TICKETS.get(j.ticket);
      if (t.state !== "held" || t.run !== run || tickets.has(j.ticket) || t.units !== j.units || t.amount !== searchJobCharge(j, { upload: true }))
        throw new HttpError(500, "search_job_invalid", "A search job is invalid: ticket");
      tickets.add(j.ticket);
    }
  } catch (e) {
    for (const j of all) dropUnadmittedFlat(j.flat);
    throw e;
  }
  // Off jobs (SEARCH_TERMS_MAX = 0) keep no storage.
  for (const j of all) if (j.cap === 0 && j.flat !== null) { dropFlat(j.flat); j.flat = null; }
  // Within one call, only the last job of each artifact is admitted.
  const last = new Map(all.map((j, i) => [j.meta.artifactId, i]));
  // An earlier job of the same artifact in this call is never admitted: its flat storage is dropped now.
  all.forEach((j, i) => { if (last.get(j.meta.artifactId) !== i) { dropFlat(j.flat); j.flat = null; } });
  for (const job of all.filter((j, i) => last.get(j.meta.artifactId) === i)) {
    // The same artifact twice: the later job replaces the earlier one (its charge released, its text dropped).
    const prev = run.holder.jobs.findIndex((j) => j.meta.artifactId === job.meta.artifactId);
    if (prev >= 0) {
      const old = run.holder.jobs[prev];
      run.release(old.charge);
      run.textUnits -= old.units;
      run.holder.jobs.splice(prev, 1);
      dropFlat(old.flat);
      old.text = null; old.flat = null;
    }
    const charge = searchJobCharge(job, { upload: job.flat !== null });
    const ticket = job.ticket === null ? null : UPLOAD_TICKETS.get(job.ticket);
    job.ticket = null;
    // A ticket's bytes are already in this run's payload: admitting its job is a transfer, not a second reservation.
    if (run.holder.jobs.length >= SEARCH_RUN_LIMITS.docs || run.textUnits + job.units > SEARCH_RUN_LIMITS.textUnits || !(ticket ? true : run.reserve(charge))) {
      // A job this one replaced is gone too: count it, not silently drop it.
      if (prev >= 0) run.skip("replaced");
      run.skip("admission");
      if (ticket) releaseTicket(ticket);
      dropFlat(job.flat);
      job.flat = null;
      continue;
    }
    if (ticket) ticket.state = "consumed";
    job.charge = charge;
    run.textUnits += job.units;
    if (job.flat !== null) FLAT_ADMITTED.add(job.flat);
    run.holder.jobs.push(job);
  }
}
export const runTally = (run) => ({ run: run.id, calls: run.calls, completed: run.completed, unchanged: run.unchanged, skipped: { ...run.skipped }, tokenOps: run.tokenOps, maxRemoveValues: run.maxRemoveValues });

// --- Lifecycle: the project-purge step and the orphan sweep --------------------------------------------------------
const PURGE_DOCS_PER_ROUND = 20;
const LIFECYCLE_CHUNK_MAX = 5000;
/**
 * Tokens left in a selected row, read from the row alone: term_count (exact for a complete row, an upper bound for a
 * purge-held row), or NULL (unknown) for a row a writer holds, which L counts when it takes it.
 */
const TOKENS_LEFT = `CASE WHEN d.revision_id = '' AND substr(d.writer, 1, 6) <> 'purge:' THEN NULL ELSE d.term_count END`;
/** A selected row's token count, or Infinity when unknown (a writer's row: its chunk is what is left of the share). */
const tokensLeft = (d) => d.n === null || d.n === undefined ? Infinity : Number(d.n);
const DOC_FIELDS = "d.doc_id, d.workspace_id, d.owner_id, d.project_id, d.artifact_id";
/** The purge's per-round selection (search_token_docs_project). */
export const PURGE_SELECT_SQL = `SELECT ${DOC_FIELDS}, ${TOKENS_LEFT} AS n FROM search_token_docs d WHERE d.project_id = ?1 LIMIT ${PURGE_DOCS_PER_ROUND}`;
/** The purge step's eligibility: purge.js STILL_DUE with ?P (project) and ?NOW. */
export const PURGE_ELIGIBLE = "EXISTS (SELECT 1 FROM projects d WHERE d.id = ?P AND d.deleted_at IS NOT NULL AND d.purged_at IS NULL AND d.purge_at <= ?NOW)";

/**
 * Give out up to `total` token deletions in selection order: each document with tokens gets min(its tokens, what is
 * left), so the first document with tokens gets at least 1. Documents with tokens but no share are left out; every
 * included document also carries X and Xc (gated on no tokens left, so they change nothing while tokens remain).
 */
function chunkInOrder(docs, total, values) {
  const out = [];
  let left = total;
  for (const d of docs) {
    const n = tokensLeft(d);
    if (n > 0 && left <= 0) continue;
    const chunk = Math.min(n, left);
    left -= chunk;
    out.push({ doc_id: d.doc_id, workspace_id: d.workspace_id, owner_id: d.owner_id, chunk, final: true, values: values(d) });
  }
  return out;
}

/**
 * One round of the project-purge step: select up to 20 of the project's rows (one call), then one packed
 * deleteSearchDocs batch with STILL_DUE as eligibility (one call). Returns { selected, tokens, docs }.
 */
export async function purgeSearchTokensRound(env, projectId, { now, purgeNonce: pn, rowBudget }) {
  const docs = (await env.DB.prepare(PURGE_SELECT_SQL).bind(projectId).all()).results;
  if (!docs.length) return { selected: 0, tokens: 0, docs: 0 };
  const batch = chunkInOrder(docs, Math.min(LIFECYCLE_CHUNK_MAX, rowBudget), () => ({}));
  const r = await deleteSearchDocs(env, batch, { eligible: PURGE_ELIGIBLE, values: { PN: pn, P: projectId, NOW: now } });
  return { selected: docs.length, tokens: r.tokens, docs: r.docs };
}

// Sweep paths: A purged projects (by projects_purged), C deleting workspaces, B rows whose artifact is gone.
const SWEEP_CALLS = 10;
const SWEEP_DELETE_CALLS = 8;
const SWEEP_PATH_DOCS = SWEEP_DELETE_CALLS * PURGE_DOCS_PER_ROUND;
const SWEEP_WINDOW = { A: 20, C: 500, B: 1000 };
/** b-tree rows written per document besides its tokens (2 each: table and index): L 1, Kc 3, X 4, Xc 3. */
const SWEEP_DOC_ROWS = 11;
const SWEEP_EMPTY_DOC_ROWS = 8;
const SWEEP_CURSOR_ROWS = 2;
const SWEEP_ROTATION_MS = 900000;
const SWEEP_ORDERS = [["A", "C", "B"], ["C", "B", "A"], ["B", "A", "C"]];
const SWEEP_ELIGIBLE = {
  A: "EXISTS (SELECT 1 FROM projects WHERE id = ?P AND purged_at IS NOT NULL)",
  B: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ?A)",
  C: "EXISTS (SELECT 1 FROM workspaces WHERE id = ?W AND status = 'deleting')",
};
const STATE = "(SELECT %s FROM search_tokens_state WHERE id = 1)";
const st = (col) => STATE.replace("%s", col);
// Path A's cursor is '' or '<purged_at>:<project id>'.
const A_AFTER_T = `(SELECT CASE WHEN sweep_purged_after = '' THEN -1 ELSE CAST(substr(sweep_purged_after, 1, instr(sweep_purged_after, ':') - 1) AS INTEGER) END FROM search_tokens_state WHERE id = 1)`;
const A_AFTER_ID = `(SELECT CASE WHEN sweep_purged_after = '' THEN '' ELSE substr(sweep_purged_after, instr(sweep_purged_after, ':') + 1) END FROM search_tokens_state WHERE id = 1)`;
const A_WINDOW = `SELECT purged_at, id FROM projects WHERE purged_at IS NOT NULL
  AND (purged_at > ${A_AFTER_T} OR (purged_at = ${A_AFTER_T} AND id > ${A_AFTER_ID})) ORDER BY purged_at, id LIMIT ${SWEEP_WINDOW.A}`;
const C_WINDOW = `SELECT id FROM workspaces WHERE status = 'deleting' AND id > ${st("sweep_workspace_after")} ORDER BY id LIMIT ${SWEEP_WINDOW.C}`;
const B_WINDOW = `SELECT doc_id FROM search_token_docs WHERE doc_id > ${st("sweep_doc_after")} ORDER BY doc_id LIMIT ${SWEEP_WINDOW.B}`;
/** The sweep's one read batch (exported for the query-plan test). Every window statement returns exactly one row. */
export function sweepReadSql() {
  const docs = (where) => `SELECT ${DOC_FIELDS}, ${TOKENS_LEFT} AS n FROM search_token_docs d WHERE ${where} LIMIT ${SWEEP_PATH_DOCS + 1}`;
  return {
    state: "SELECT sweep_doc_after, sweep_purged_after, sweep_workspace_after FROM search_tokens_state WHERE id = 1",
    aWindow: `WITH w AS (${A_WINDOW}) SELECT (SELECT purged_at FROM w ORDER BY purged_at DESC, id DESC LIMIT 1) AS end_t,
  (SELECT id FROM w ORDER BY purged_at DESC, id DESC LIMIT 1) AS end_id, (SELECT COUNT(*) FROM w) AS n`,
    aDocs: docs(`d.project_id IN (SELECT id FROM (${A_WINDOW}))`),
    cWindow: `SELECT MAX(id) AS end, COUNT(*) AS n FROM (${C_WINDOW})`,
    cDocs: docs(`d.workspace_id IN (SELECT id FROM (${C_WINDOW}))`),
    bWindow: `SELECT MAX(doc_id) AS end, COUNT(*) AS n FROM (${B_WINDOW})`,
    bDocs: docs(`d.doc_id IN (SELECT doc_id FROM (${B_WINDOW})) AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.id = d.artifact_id)`),
  };
}

/**
 * Orphan sweep (cron only): delete token rows of purged projects (A), deleting workspaces (C) and gone artifacts (B).
 * At most 10 D1 calls and `writes` b-tree rows written (SEARCH_SWEEP_WRITES_MAX; 0 = off). One read batch, then at
 * most 8 packed deleteSearchDocs calls, then one cursor write only when a cursor changed. The starting path rotates
 * with floor(scheduledTime / 15 min) mod 3; no rotation state is stored. Returns a tally.
 */
export async function sweepSearchTokenOrphans(env, { scheduledTime, writes = searchSweepWritesMax(env) } = {}) {
  const tally = { calls: 0, rows: 0, tokens: 0, docs: 0, paths: [], cursor: false };
  if (writes <= 0) return tally;
  const t = typeof scheduledTime === "number" && Number.isFinite(scheduledTime) ? scheduledTime : Date.now();
  const order = SWEEP_ORDERS[Math.floor(t / SWEEP_ROTATION_MS) % 3];
  const q = sweepReadSql();
  const names = ["state", "aWindow", "aDocs", "cWindow", "cDocs", "bWindow", "bDocs"];
  const res = await env.DB.batch(names.map((n) => env.DB.prepare(q[n])));
  tally.calls++;
  const row = (n) => res[names.indexOf(n)]?.results?.[0] ?? {};
  const rows = (n) => res[names.indexOf(n)]?.results ?? [];
  const state = row("state");
  const cursors = { A: state.sweep_purged_after ?? "", B: state.sweep_doc_after ?? 0, C: state.sweep_workspace_after ?? "" };
  const paths = {
    A: { docs: rows("aDocs"), window: row("aWindow"), size: SWEEP_WINDOW.A, next: (w) => w.n ? `${w.end_t}:${w.end_id}` : "" },
    C: { docs: rows("cDocs"), window: row("cWindow"), size: SWEEP_WINDOW.C, next: (w) => w.n ? w.end : "" },
    B: { docs: rows("bDocs"), window: row("bWindow"), size: SWEEP_WINDOW.B, next: (w) => w.n ? w.end : 0 },
  };
  const pn = purgeNonce();
  // A row listed by two paths (a purged project's rows have no artifacts, so B lists them too) is A's or C's work,
  // never B's (B is the catch-all for rows whose artifact is gone), whatever the rotation.
  const claimed = new Set();
  for (const p of ["A", "C", "B"]) {
    const own = paths[p].docs.slice(0, SWEEP_PATH_DOCS).filter((d) => !claimed.has(d.doc_id));
    for (const d of own) claimed.add(d.doc_id);
    paths[p].work = own;
  }
  const active = order.filter((p) => paths[p].work.length);
  let callsLeft = SWEEP_DELETE_CALLS, rowsLeft = writes - SWEEP_CURSOR_ROWS;
  for (const [k, p] of active.entries()) {
    const later = active.length - k - 1;
    const path = paths[p];
    const calls = Math.max(0, callsLeft - 2 * later);
    let rowShare = Math.floor(rowsLeft / (later + 1));
    const queue = path.work.map((d) => ({ ...d, left: tokensLeft(d), done: false }));
    let used = 0, stop = false;
    while (!stop && used < calls && queue.some((d) => !d.done)) {
      const batch = [];
      for (const d of queue) {
        if (d.done || batch.length >= PURGE_DOCS_PER_ROUND) continue;
        if (d.left === 0) {
          if (rowShare < SWEEP_EMPTY_DOC_ROWS) { stop = true; break; }
          rowShare -= SWEEP_EMPTY_DOC_ROWS; tally.rows += SWEEP_EMPTY_DOC_ROWS;
          batch.push({ d, chunk: 0 });
          continue;
        }
        const chunk = Math.min(d.left, LIFECYCLE_CHUNK_MAX, Math.floor((rowShare - SWEEP_DOC_ROWS) / 2));
        if (chunk < 1) { stop = true; break; }
        rowShare -= SWEEP_DOC_ROWS + 2 * chunk; tally.rows += SWEEP_DOC_ROWS + 2 * chunk;
        batch.push({ d, chunk });
        // A document that keeps tokens after this chunk is finished in a later batch; nothing after it fits a share.
        if (chunk < d.left) break;
      }
      if (!batch.length) break;
      const r = await deleteSearchDocs(env, batch.map(({ d, chunk }) => ({ doc_id: d.doc_id, workspace_id: d.workspace_id, owner_id: d.owner_id, chunk, final: true,
        values: { A: d.artifact_id, P: d.project_id } })), { eligible: SWEEP_ELIGIBLE[p], values: { PN: pn } });
      used++; tally.calls++;
      tally.tokens += r.tokens; tally.docs += r.docs;
      // Per document: X (5th statement when chunk > 0, 3rd otherwise) tells whether its row is gone.
      let i = 0;
      for (const { d, chunk } of batch) {
        const k2 = chunk > 0 ? r.results[i + 1]?.meta?.changes ?? 0 : 0;
        const x = r.results[i + (chunk > 0 ? 3 : 1)]?.meta?.changes ?? 0;
        i += chunk > 0 ? 5 : 3;
        d.left = Math.max(0, d.left - k2);
        if (x > 0) d.done = true;
        // Gated out (no longer eligible, or another run's lease) or miscounted: left for a later run.
        else if (d.left === 0 || (chunk > 0 && k2 === 0)) { d.done = true; d.stuck = true; }
      }
    }
    callsLeft -= used;
    // Unused share passes on to the later paths.
    rowsLeft = writes - SWEEP_CURSOR_ROWS - tally.rows;
    // The window advances only when every orphan found in it was deleted in this run.
    const complete = path.docs.length <= SWEEP_PATH_DOCS && queue.every((d) => d.done && !d.stuck);
    path.complete = complete;
    tally.paths.push({ path: p, calls: used, found: path.docs.length, complete });
  }
  const next = { ...cursors };
  for (const p of ["A", "B", "C"]) {
    const path = paths[p];
    if (path.docs.length && !path.complete) continue;
    const w = path.window;
    next[p] = (Number(w.n) || 0) < path.size ? (p === "B" ? 0 : "") : path.next(w);
  }
  if (next.A !== cursors.A || next.B !== cursors.B || next.C !== cursors.C) {
    await env.DB.prepare("UPDATE search_tokens_state SET sweep_doc_after = ?1, sweep_purged_after = ?2, sweep_workspace_after = ?3 WHERE id = 1")
      .bind(next.B, next.A, next.C).run();
    tally.calls++; tally.cursor = true; tally.rows += SWEEP_CURSOR_ROWS;
  }
  if (tally.calls > SWEEP_CALLS) throw new HttpError(500, "search_sweep_budget", "The sweep exceeded its call budget");
  return tally;
}
