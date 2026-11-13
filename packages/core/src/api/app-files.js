// App Files API (/v1/app/files): an app's own text files, addressed by path, in its approved destination.
// A file's path is artifacts.export_name (unique per publisher); generation rows and the snapshot manifest are
// invisible here. Every request re-checks the publisher's current authorization (assertStillAuthorized).
import { authzSql } from "../auth.js";
import { MIME, checkFile } from "../formats.js";
import { explainLimit, limitGuard, projectLimitGuard } from "../limits.js";
import { audit, createMarkdown, idemInsert, idemLookup, mdBody, publishRevision, runBatch, servedContentType } from "../service.js";
import { metaBaselineInsert, metaVersionInsert } from "../history/service.js";
import { nowIso } from "../util.js";
import { appOrigin, artifactWebUrl, previewWebUrl } from "../links.js";
import { serveContent } from "../uploads.js";
import { DRAIN_BYTES, HttpError, b64url, idemKey, int, json, randomId, sha256Hex } from "../util.js";
import { assertStillAuthorized, pubCtx, testHooksOn, testPause } from "./publisher.js";

/**
 * SQL fence: the publisher is live, its app client enabled and its destination still valid. Params, in order:
 * publisher id, token epoch, project id, folder id (or null).
 */
export function baseSql(write) {
  return `EXISTS (SELECT 1 FROM publishers pb JOIN app_clients ac ON ac.id = pb.app_client_id
  WHERE pb.id = ? AND pb.token_epoch = ? AND pb.revoked_at IS NULL AND ac.disabled_at IS NULL
    AND pb.project_id = ? AND pb.folder_id IS ?
    AND (pb.folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id = pb.folder_id AND f.project_id = pb.project_id)))`;
}
/** Params for baseSql, for the publisher row `p`. */
export const baseParams = (p) => [p.id, p.token_epoch, p.project_id, p.folder_id ?? null];

export const APP_PATH_MAX_CHARS = 200;
export const APP_PATH_MAX_SEGMENTS = 8;
export const APP_PATH_SEGMENT_MAX_CHARS = 64;
export const APP_FILES_PAGE_MAX = 100;
/** A body sent to App Files: at most 1 MiB, received within 15 s with no gap over 5 s. */
export const APP_FILE_MAX_BYTES = 1048576;
export const APP_FILES_RECEIVE_MS = 15e3;
export const APP_FILES_IDLE_MS = 5e3;
/** Bodies held in memory: 4 per isolate, at most 2 per workspace and 2 per creator (per isolate), any size. */
export const APP_FILES_SLOTS_PER_ISOLATE = 4;
export const APP_FILES_SLOTS_PER_WORKSPACE = 2;
export const APP_FILES_SLOTS_PER_CREATOR = 2;
/** A slot held this long is taken to be dead; at most APP_FILES_OVERRUN_MAX such slots stop counting isolate-wide. */
export const APP_FILES_SLOT_RECLAIM_MS = 6e5;
export const APP_FILES_OVERRUN_MAX = 2;
/**
 * Drains (reading and discarding a refused body, so its answer reaches a client still sending) have their own budget,
 * independent of the upload slots: 8 per isolate, at most 2 per workspace and 2 per creator. A drain that is not
 * admitted cancels the body and the answer is sent anyway (the client may see a closed connection).
 */
export const APP_FILES_DRAINS_MAX = 8;
export const APP_FILES_DRAINS_PER_WORKSPACE = 2;
export const APP_FILES_DRAINS_PER_CREATOR = 2;
/** app_files_drain_skipped is logged at most once per this interval per isolate, with the skips since the last line. */
export const APP_FILES_DRAIN_SKIP_LOG_MS = 60e3;
/**
 * A drain token older than this is dropped at the next admission (logged app_files_drain_reclaimed). No drain lives
 * longer than the 15 s receive deadline, so this never frees a live one; it recovers a token whose finally never ran.
 */
export const APP_FILES_DRAIN_RECLAIM_MS = 60e3;
const tooLarge = () => new HttpError(413, "file_too_large", "A file sent to this API can be at most 1 MiB (1,048,576 bytes)");

/**
 * Slot admission for request bodies (one table per isolate). admit() checks and reserves synchronously; release() is
 * idempotent and is called only when the request's work settles. A slot older than the reclaim horizon moves to the
 * overrun set (while it has room) and stops counting isolate-wide, but still counts for its workspace and creator,
 * so at most SLOTS_PER_ISOLATE + OVERRUN_MAX bodies are ever held. `now` and `log` are injectable for tests.
 */
export function createSlotTable({ now = () => Date.now(), log = (e) => console.warn(JSON.stringify(e)) } = {}) {
  const slots = new Map(), overrun = new Map(), perWs = new Map(), perCreator = new Map();
  let stuckLoggedAt = -Infinity;
  const add = (m, k, t) => { let x = m.get(k); if (!x) m.set(k, x = new Set()); x.add(t); };
  const drop = (m, k, t) => { const x = m.get(k); if (!x) return; x.delete(t); if (!x.size) m.delete(k); };
  function admit(ws, creator, reclaimMs = APP_FILES_SLOT_RECLAIM_MS) {
    const t = now();
    for (const [token, slot] of slots) {
      if (slot.admittedAt + reclaimMs > t) continue;
      if (overrun.size < APP_FILES_OVERRUN_MAX) {
        slots.delete(token); overrun.set(token, slot);
        log({ event: "app_files_slot_reclaimed" });
      } else if (t - stuckLoggedAt >= APP_FILES_SLOT_RECLAIM_MS) {
        // At most once per reclaim horizon, so a later recurrence is visible too.
        stuckLoggedAt = t;
        log({ event: "app_files_slots_stuck" });
      }
    }
    if (slots.size >= APP_FILES_SLOTS_PER_ISOLATE)
      throw new HttpError(503, "app_files_busy", "This server is receiving as many files as it can; retry shortly with the same Idempotency-Key", { retry_after_seconds: 1 });
    if ((perWs.get(ws)?.size ?? 0) >= APP_FILES_SLOTS_PER_WORKSPACE || (perCreator.get(creator)?.size ?? 0) >= APP_FILES_SLOTS_PER_CREATOR)
      throw new HttpError(429, "app_files_concurrency", "This workspace or its owner is already sending 2 files to this server; wait for one to finish", { retry_after_seconds: 1 });
    const token = randomId("afs");
    slots.set(token, { ws, creator, admittedAt: t });
    add(perWs, ws, token); add(perCreator, creator, token);
    return token;
  }
  function release(token) {
    const slot = slots.get(token) ?? overrun.get(token);
    if (!slot) return;
    slots.delete(token); overrun.delete(token);
    drop(perWs, slot.ws, token); drop(perCreator, slot.creator, token);
  }
  return { admit, release, inUse: () => slots.size + overrun.size, sizes: () => ({ slots: slots.size, overrun: overrun.size, workspaces: perWs.size, creators: perCreator.size }) };
}
const SLOTS = createSlotTable();

/**
 * Drain admission (one table per isolate), in the slot table's style: admit() checks and reserves synchronously and
 * returns a token, or null when a bound is reached; release() is idempotent. A drain ends by its own deadlines (15 s
 * total from the body's start, 5 s idle, and a cancelled or failed read) and runs under execCtx.waitUntil, so its
 * `finally` normally runs even if the client goes away. If the runtime cuts it short anyway, its token is reclaimed at
 * an admission after APP_FILES_DRAIN_RECLAIM_MS (a late release of a reclaimed token is a no-op).
 */
export function createDrainTable({ now = () => Date.now(), log = (e) => console.warn(JSON.stringify(e)) } = {}) {
  const held = new Map(), perWs = new Map(), perCreator = new Map();
  let loggedAt = -Infinity, pending = 0;
  const bump = (m, k, d) => { const v = (m.get(k) ?? 0) + d; if (v > 0) m.set(k, v); else m.delete(k); };
  const skip = (scope) => {
    pending++;
    const t = now();
    if (t - loggedAt < APP_FILES_DRAIN_SKIP_LOG_MS) return null;
    loggedAt = t;
    log({ event: "app_files_drain_skipped", scope, count: pending });
    pending = 0;
    return null;
  };
  function admit(ws, creator) {
    const t0 = now();
    for (const [token, d] of held) {
      if (d.admittedAt + APP_FILES_DRAIN_RECLAIM_MS > t0) continue;
      release(token);
      log({ event: "app_files_drain_reclaimed" });
    }
    if (held.size >= APP_FILES_DRAINS_MAX) return skip("isolate");
    if ((perWs.get(ws) ?? 0) >= APP_FILES_DRAINS_PER_WORKSPACE) return skip("workspace");
    if ((perCreator.get(creator) ?? 0) >= APP_FILES_DRAINS_PER_CREATOR) return skip("creator");
    const token = randomId("afd");
    held.set(token, { ws, creator, admittedAt: t0 });
    bump(perWs, ws, 1); bump(perCreator, creator, 1);
    return token;
  }
  function release(token) {
    const d = held.get(token);
    if (!d) return;
    held.delete(token);
    bump(perWs, d.ws, -1); bump(perCreator, d.creator, -1);
  }
  return { admit, release, inUse: () => held.size, skipped: () => pending };
}
const DRAINS = createDrainTable();
/** Drains currently running in this isolate (for the x-test-drains-in-use test header). */
export const appFilesDrainsInUse = () => DRAINS.inUse();
/** drainBody under the drain budget: not admitted means cancel and return "skipped" at once. Released exactly once. */
export async function drainWithBudget(table, { ws, creator }, reader, seen, deadlines, start) {
  const token = table.admit(ws, creator);
  // Not admitted: cancel without waiting for it (a cancel that never settles must not hold the answer back).
  if (token === null) { Promise.resolve().then(() => reader.cancel()).catch(() => {}); return "skipped"; }
  try { return await drainBody(reader, seen, deadlines, start); }
  finally { table.release(token); }
}
/**
 * Run a PUT's work (after step 1), then drain what its body left, so an answer given before the body was received
 * reaches a client that is still sending. This is the one place: no early return in the work can skip it. The work may
 * hand over a reader it stopped keeping (an undeclared body past the limit) through `handoff`, which this wrapper owns:
 * that reader is drained here, after the work and so after its upload slot was released. Otherwise a body the work never
 * touched is drained. The drain never replaces the work's answer or error: every failure in it is swallowed.
 *
 * Replay window: an answer decided before the drain is sent up to the receive's total deadline later. If a request with
 * the same Idempotency-Key commits in between, the client gets this (older) refusal; a retry with the same key then
 * replays the committed answer.
 */
export async function withDrain(req, deadlines, who, execCtx, work, table = DRAINS) {
  const handoff = {};
  const drain = async () => {
    try {
      let run;
      if (handoff.reader) run = drainWithBudget(table, who, handoff.reader, handoff.seen, deadlines, handoff.start);
      // `locked` means currently locked (receiveBody took a reader and still holds it). Code that ever calls
      // releaseLock() on this body must revisit this check, or a received body could be drained a second time.
      else if (req.body && !req.body.locked) run = drainWithBudget(table, who, req.body.getReader(), 0, deadlines);
      else return;
      // Under waitUntil, like an upload slot: if the client goes away the runtime still runs the drain to its finally.
      execCtx?.waitUntil?.(run.catch(() => {}));
      await run;
    } catch {}
  };
  let res;
  try { res = await work(handoff); }
  catch (e) { await drain(); throw e; }
  await drain();
  return res;
}
/** Bodies currently held by this isolate (for the x-test-slots-in-use test header). */
export const appFilesSlotsInUse = () => SLOTS.inUse();

/** Test hooks (AC_TEST_HOOKS on localhost only): shorter deadlines and reclaim horizon, a held publish. */
function appHooks(env, req) {
  const on = testHooksOn(env, req);
  const n = (name, max) => {
    const v = on ? Number(req.headers.get(name)) : NaN;
    return Number.isSafeInteger(v) && v > 0 ? Math.min(v, max) : null;
  };
  const deadline = n("x-test-receive-deadline-ms", APP_FILES_RECEIVE_MS);
  return {
    receiveMs: deadline ?? APP_FILES_RECEIVE_MS, idleMs: Math.min(deadline ?? APP_FILES_IDLE_MS, APP_FILES_IDLE_MS),
    reclaimMs: n("x-test-slot-reclaim-ms", APP_FILES_SLOT_RECLAIM_MS) ?? APP_FILES_SLOT_RECLAIM_MS,
    holdMs: n("x-test-hold-publish-ms", 5e3) ?? 0
  };
}

/**
 * Run `work` holding one body slot. It runs under execCtx.waitUntil, so if the client goes away the runtime keeps it
 * going to its `finally` (the receive's idle deadline ends it), and the slot is released exactly then.
 */
async function withSlot(execCtx, ws, creator, reclaimMs, work) {
  const token = SLOTS.admit(ws, creator, reclaimMs);
  const run = (async () => {
    try { return await work(); } finally { SLOTS.release(token); }
  })();
  execCtx.waitUntil(run.catch(() => {}));
  return run;
}

/**
 * Read the whole body (at most `limit` bytes) with a total and an idle deadline. Timers only cancel the read; the
 * slot is released by withSlot. Returns { bytes, sha256 }.
 */
async function receiveBody(req, limit, declared, { receiveMs, idleMs }, handoff) {
  const start = Date.now();
  const reader = req.body?.getReader();
  const chunks = [];
  let n = 0, timedOut = false;
  const cancel = () => { timedOut = true; reader?.cancel().catch(() => {}); };
  const total = setTimeout(cancel, receiveMs);
  let idle = setTimeout(cancel, idleMs);
  try {
    if (reader) for (;;) {
      let r;
      try { r = await reader.read(); } catch (e) {
        if (timedOut) break;
        throw new HttpError(400, "incomplete_body", "Body ended before the declared size; PUT the whole file again");
      }
      if (timedOut) break;
      if (r.done) break;
      n += r.value.byteLength;
      if (n > limit) {
        // Keep nothing more and drop what was kept. The still-locked reader goes to the PUT wrapper (withDrain), which
        // drains it after this request's upload slot is released, within what is left of the same total deadline.
        chunks.length = 0; clearTimeout(total); clearTimeout(idle);
        Object.assign(handoff, { reader, seen: n, start });
        throw tooLarge();
      }
      chunks.push(r.value);
      clearTimeout(idle); idle = setTimeout(cancel, idleMs);
    }
  } finally { clearTimeout(total); clearTimeout(idle); }
  if (timedOut) { chunks.length = 0; throw new HttpError(408, "request_timeout", "The request body arrived too slowly; send it again with the same Idempotency-Key"); }
  if (declared !== null && n !== declared) throw new HttpError(400, "incomplete_body", "Body ended before the declared size; PUT the whole file again");
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.byteLength; }
  chunks.length = 0;
  return { bytes, sha256: await sha256Hex(bytes) };
}
/**
 * Read and discard the rest of a body so an early answer reaches a client that is still sending: about DRAIN_BYTES
 * (passed by at most the one chunk that crosses it) counted from the body's first byte (`seen` already received), within the receive's total (from `start`) and idle
 * deadlines. Past either bound the body is cancelled (the client may then see a closed connection). Nothing is kept.
 * Returns "done" (read to its end), "bytes" or "time".
 */
export async function drainBody(reader, seen, { receiveMs, idleMs }, start = Date.now()) {
  let n = seen, why = null;
  const stop = (w) => { why ??= w; reader.cancel().catch(() => {}); };
  // Bounds first: an expired deadline or an excessive count reads nothing.
  if (Date.now() - start >= receiveMs) { stop("time"); return why; }
  if (n > DRAIN_BYTES) { stop("bytes"); return why; }
  const total = setTimeout(() => stop("time"), Math.max(0, start + receiveMs - Date.now()));
  let idle = setTimeout(() => stop("time"), idleMs);
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (why) return why;
      if (done) return "done";
      n += value.byteLength;
      // The byte bound can be passed by the one chunk that crosses it (about 16 MiB, not an exact ceiling).
      if (n > DRAIN_BYTES) { stop("bytes"); return why; }
      // Re-checked here too: a source that is always readable at once could outrun the timer callbacks.
      if (Date.now() - start >= receiveMs) { stop("time"); return why; }
      clearTimeout(idle); idle = setTimeout(() => stop("time"), idleMs);
    }
  } finally { clearTimeout(total); clearTimeout(idle); }
}
const ROOT = "/v1/app/files";
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const KIND_BY_EXT = new Map([["md", "markdown"], ["markdown", "markdown"], ["html", "html"], ["htm", "html"], ["json", "json"], ["csv", "csv"]]);
const MANIFEST = "manifest.json";
const reserved = () => new HttpError(400, "invalid_input", "manifest.json is reserved for the server");
const invalidPath = () => new HttpError(400, "invalid_path", "File path must be 1-8 segments of letters, digits, '.', '_' or '-' (1-64 characters each, not starting with '.'), at most 200 characters, ending in .md, .markdown, .html, .htm, .json or .csv");
/**
 * Headers every App Files content answer carries, 304 included. A copy of serveContent's fixed set
 * (uploads.js, the non-spreadsheet branch); test/app-files.test.mjs checks a 304 and a 200 agree.
 */
export const APP_FILE_RESPONSE_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
  "cross-origin-resource-policy": "same-origin"
});

/** Is this an App Files request (list or file)? Matched on the parsed pathname; the raw path is checked later. */
export const isAppFilesPath = (pathname) => /^\/v1\/app\/files(\/|$)/.test(pathname);
/** Is this an App Files file (content) request? Its answers carry stored bytes and are never link-rewritten. */
export const isAppFileContentPath = (pathname) => pathname.startsWith(`${ROOT}/`);

/**
 * The request path exactly as sent: it must equal the parsed pathname (no dot segments, no '\', nothing the URL
 * parser would change) and be the list or a file below it. Returns "" for the list, else the path after the root.
 */
export function appFilesRawPath(req) {
  const raw = req.url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, "").split(/[?#]/, 1)[0];
  if (raw !== new URL(req.url).pathname || raw.includes("\\")) throw invalidPath();
  if (raw === ROOT) return "";
  if (!raw.startsWith(`${ROOT}/`) || raw.length === ROOT.length + 1) throw invalidPath();
  return raw.slice(ROOT.length + 1);
}

/** Is this path the server's manifest by meaning (first segment, any case, is manifest.json)? */
export const reservedAppPath = (path) => path.split("/", 1)[0].toLowerCase() === MANIFEST;

/**
 * SQL: no other file of this publisher conflicts with `path`, ignoring case. Considers every row of the publisher
 * with an export name (generation part files included), in any folder and whether trashed or not. Conflicts: the same
 * name; an existing file at an ancestor of `path` (a file where a folder is needed); an existing file below `path`
 * (a folder where a file is needed, as the range lower(path)/ .. lower(path)0, '0' following '/'). Written so the
 * artifacts_publisher_lname index (publisher_id, lower(export_name)) answers it.
 */
export function conflictCheck(publisherId, path) {
  const lp = path.toLowerCase();
  const segs = lp.split("/");
  const names = [lp, ...segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"))];
  // Two seeks, each pinned to the index (without statistics SQLite would read the publisher's rows through
  // artifacts_publisher_name instead); INDEXED BY also fails loudly if the index is missing.
  const own = "c.publisher_id = ? AND c.export_name IS NOT NULL";
  return {
    sql: `NOT EXISTS (SELECT 1 FROM artifacts c INDEXED BY artifacts_publisher_lname WHERE ${own} AND lower(c.export_name) IN (${names.map(() => "?").join(", ")}))
      AND NOT EXISTS (SELECT 1 FROM artifacts c INDEXED BY artifacts_publisher_lname WHERE ${own} AND lower(c.export_name) >= ? AND lower(c.export_name) < ?)`,
    params: [publisherId, ...names, publisherId, lp + "/", lp + "0"]
  };
}

const LNAME = "artifacts c INDEXED BY artifacts_publisher_lname";
const TWIN = (x) => `lower(c.export_name) = lower(${x})`;
const BELOW = (x) => `lower(c.export_name) >= lower(${x}) || '/' AND lower(c.export_name) < lower(${x}) || '0'`;
const PARTS = "publisher_generation_parts";

/** Snapshot gate: no row of the publisher twins a new name or sits below it. `names`: new names (not exact existing). */
export function newNameConflictSql(publisherId, names) {
  if (!names.length) return { sql: "1", params: [] };
  const j = JSON.stringify(names);
  return { sql: `NOT EXISTS (SELECT 1 FROM json_each(?) j CROSS JOIN ${LNAME} WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND ${TWIN("j.value")})
    AND NOT EXISTS (SELECT 1 FROM json_each(?) j CROSS JOIN ${LNAME} WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND ${BELOW("j.value")})`,
    params: [j, publisherId, j, publisherId] };
}
/** Snapshot result form: the first conflicting name in input order, against the lowest existing name. */
export function newNameConflictRows(publisherId, names) {
  const j = JSON.stringify(names);
  return { sql: `SELECT j.key AS pos, j.value AS name, c.export_name AS conflicts_with FROM json_each(?) j CROSS JOIN ${LNAME}
      WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND ${TWIN("j.value")}
    UNION ALL
    SELECT j.key, j.value, c.export_name FROM json_each(?) j CROSS JOIN ${LNAME}
      WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND ${BELOW("j.value")}
    ORDER BY pos, conflicts_with LIMIT 1`, params: [j, publisherId, j, publisherId] };
}
/** Generation gate: parts vs existing rows (twin, below), parts vs each other, mName vs existing rows (twin, below), mName vs parts. */
export function generationNameConflictSql(publisherId, generationId, mName) {
  return { sql: `NOT EXISTS (SELECT 1 FROM ${PARTS} t CROSS JOIN ${LNAME} WHERE t.publisher_id = ? AND t.generation_id = ? AND t.artifact_id IS NULL
        AND c.publisher_id = ? AND c.export_name IS NOT NULL AND ${TWIN("t.name")})
    AND NOT EXISTS (SELECT 1 FROM ${PARTS} t CROSS JOIN ${LNAME} WHERE t.publisher_id = ? AND t.generation_id = ? AND t.artifact_id IS NULL
        AND c.publisher_id = ? AND c.export_name IS NOT NULL AND ${BELOW("t.name")})
    AND NOT EXISTS (SELECT 1 FROM ${PARTS} WHERE publisher_id = ? AND generation_id = ? AND artifact_id IS NULL GROUP BY lower(name) HAVING COUNT(*) > 1)
    AND NOT EXISTS (SELECT 1 FROM ${LNAME} WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND ${TWIN("?")})
    AND NOT EXISTS (SELECT 1 FROM ${LNAME} WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND lower(c.export_name) >= lower(?) || '/' AND lower(c.export_name) < lower(?) || '0')
    AND NOT EXISTS (SELECT 1 FROM ${PARTS} WHERE publisher_id = ? AND generation_id = ? AND artifact_id IS NULL AND lower(name) = lower(?))`,
    params: [publisherId, generationId, publisherId, publisherId, generationId, publisherId, publisherId, generationId,
      publisherId, mName, publisherId, mName, mName, publisherId, generationId, mName] };
}
/** Generation result form without part pairs: grp 0 = a part against an existing row, 1 = the manifest name against an existing row, 2 = the manifest name against a part. */
export function generationNameConflictRows(publisherId, generationId, mName) {
  return { sql: `SELECT 0 AS grp, t.name AS name, c.export_name AS conflicts_with FROM ${PARTS} t CROSS JOIN ${LNAME}
      WHERE t.publisher_id = ? AND t.generation_id = ? AND t.artifact_id IS NULL AND c.publisher_id = ? AND c.export_name IS NOT NULL AND ${TWIN("t.name")}
    UNION ALL
    SELECT 0, t.name, c.export_name FROM ${PARTS} t CROSS JOIN ${LNAME}
      WHERE t.publisher_id = ? AND t.generation_id = ? AND t.artifact_id IS NULL AND c.publisher_id = ? AND c.export_name IS NOT NULL AND ${BELOW("t.name")}
    UNION ALL
    SELECT 1, ?, c.export_name FROM ${LNAME} WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND ${TWIN("?")}
    UNION ALL
    SELECT 1, ?, c.export_name FROM ${LNAME} WHERE c.publisher_id = ? AND c.export_name IS NOT NULL AND lower(c.export_name) >= lower(?) || '/' AND lower(c.export_name) < lower(?) || '0'
    UNION ALL
    SELECT 2, ?, t.name FROM ${PARTS} t WHERE t.publisher_id = ? AND t.generation_id = ? AND t.artifact_id IS NULL AND lower(t.name) = lower(?)
    ORDER BY grp, name, conflicts_with LIMIT 1`,
    params: [publisherId, generationId, publisherId, publisherId, generationId, publisherId,
      mName, publisherId, mName, mName, publisherId, mName, mName, mName, publisherId, generationId, mName] };
}
/** The first new name that differs only by case from an earlier one: { name: later, conflicts_with: earlier } or null. */
export function firstCaseTwin(names) {
  const seen = new Map();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) return { name: n, conflicts_with: seen.get(k) };
    seen.set(k, n);
  }
  return null;
}
/** The conflict a generation commit reports. `names`: its part names in binary order; `hit`: the row of generationNameConflictRows, or null. */
export function generationConflict(names, hit) {
  const pair = firstCaseTwin(names);
  if (pair && (!hit || hit.grp !== 0 || pair.name < hit.name)) return pair;
  return hit ? { name: hit.name, conflicts_with: hit.conflicts_with } : null;
}

/** Validate an App Files path; returns { path, kind }. */
export function parseAppPath(rest) {
  if (typeof rest !== "string" || rest.includes("%") || rest.length > APP_PATH_MAX_CHARS) throw invalidPath();
  const segments = rest.split("/");
  if (segments.length < 1 || segments.length > APP_PATH_MAX_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) throw invalidPath();
  const ext = /\.([A-Za-z]+)$/.exec(segments.at(-1))?.[1]?.toLowerCase();
  const kind = ext ? KIND_BY_EXT.get(ext) : void 0;
  if (!kind) throw invalidPath();
  if (reservedAppPath(rest)) throw reserved();
  return { path: rest, kind };
}

/** Every artifact lookup is confined to this publisher's files in its destination, excluding generation rows. */
const OWN = "a.publisher_id = ? AND a.project_id = ? AND a.folder_id IS ? AND a.generation_id IS NULL AND a.export_name IS NOT NULL AND a.head_rev > 0 AND a.trashed_at IS NULL";
const ownParams = (p) => [p.id, p.project_id, p.folder_id ?? null];

function fileItem(env, a) {
  const o = appOrigin(env.APP_HOST);
  return {
    path: a.export_name,
    file_id: a.id,
    kind: a.kind,
    content_type: servedContentType(a.mime),
    revision: a.head_rev,
    etag: `"${a.sha256}"`,
    sha256: a.sha256,
    size: a.size,
    created_at: a.created_at,
    updated_at: a.updated_at,
    ...o ? { web_url: artifactWebUrl(o, a.project_id, a.id), preview_url: previewWebUrl(o, a.project_id, a.id) } : {}
  };
}

function listParams(url) {
  const sp = url.searchParams;
  const prefix = sp.get("prefix") ?? "";
  if (!/^[A-Za-z0-9._/-]{0,200}$/.test(prefix)) throw new HttpError(400, "invalid_input", "prefix must be at most 200 characters of letters, digits, '.', '_', '-' or '/'");
  let after = "";
  const cursor = sp.get("cursor");
  if (cursor !== null) {
    const bad = () => new HttpError(400, "invalid_input", "cursor is not valid");
    if (!/^[A-Za-z0-9_-]{1,268}$/.test(cursor)) throw bad();
    try { after = atob(cursor.replace(/-/g, "+").replace(/_/g, "/")); } catch { throw bad(); }
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(after)) throw bad();
  }
  const limit = sp.get("limit") === null ? APP_FILES_PAGE_MAX : int(Number(sp.get("limit")), "limit", 1, APP_FILES_PAGE_MAX);
  return { prefix, after, limit };
}

/**
 * The list: keyset pagination on (publisher_id, export_name), the artifacts_publisher_name index; '~' sorts after every
 * character a path may contain. The manifest is excluded by meaning, as everywhere.
 */
export const LIST_SQL = `SELECT a.id, a.project_id, a.export_name, a.kind, a.head_rev, a.created_at, a.updated_at, r.sha256, r.size, r.mime
    FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id
    WHERE ${OWN} AND lower(a.export_name) <> '${MANIFEST}' AND lower(a.export_name) NOT LIKE '${MANIFEST}/%'
      AND a.export_name >= ? AND a.export_name < ? AND a.export_name > ?
    ORDER BY a.export_name LIMIT ?`;
async function list(env, p, url) {
  const { prefix, after, limit } = listParams(url);
  const rows = (await env.DB.prepare(LIST_SQL).bind(...ownParams(p), prefix, prefix + "~", after, limit + 1).all()).results;
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? b64url(new TextEncoder().encode(page.at(-1).export_name)) : null;
  return json({ files: page.map((a) => fileItem(env, a)), next_cursor: next });
}

/** If-None-Match against a strong etag: '*', or any listed tag under weak comparison (W/ ignored). */
export function etagMatches(header, etag) {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

async function read(req, env, p, requestId, rest) {
  if (reservedAppPath(rest)) throw new HttpError(404, "not_found", "File not found");
  const { path } = parseAppPath(rest);
  const a = await env.DB.prepare(`SELECT a.id, r.sha256 FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id WHERE ${OWN} AND a.export_name = ?`)
    .bind(...ownParams(p), path).first();
  if (!a) throw new HttpError(404, "not_found", "File not found");
  const etag = `"${a.sha256}"`;
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: { ...APP_FILE_RESPONSE_HEADERS, etag } });
  // Only Range reaches serveContent: format, download and rev never apply here.
  const range = req.headers.get("range");
  const clean = new Request(new URL(req.url).origin + "/content", { method: req.method, headers: range === null ? {} : { range } });
  return serveContent(pubCtx(env, p, requestId), clean, p.project_id, a.id, null);
}

/**
 * /v1/app/files and /v1/app/files/{path}. route() has already checked the token (livePublisher) and the rate limit;
 * execCtx (the request's execution context) and wsId (the project's workspace) are for the write routes.
 */
export async function routeAppFiles(req, env, execCtx, p, requestId, wsId) {
  const rest = appFilesRawPath(req);
  const m = req.method;
  if (m === "PUT" && rest !== "") return put(req, env, execCtx, p, requestId, wsId, rest);
  if (m === "DELETE" && rest !== "") return remove(req, env, p, requestId, rest);
  if (m !== "GET" && m !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed");
  await assertStillAuthorized(env, p, { read: true });
  return rest === "" ? list(env, p, new URL(req.url)) : read(req, env, p, requestId, rest);
}

/** Lifetime App Files caps per app (publisher): creations, revisions, bytes written. */
export const APP_FILES_MAX = 10000;
export const APP_REVISIONS_MAX = 100000;
export const APP_FILES_MAX_BYTES = 1073741824;
/** SQL: this write keeps the publisher within its lifetime caps. Params: publisher id, files added, bytes added. */
const capsSql = `EXISTS (SELECT 1 FROM publishers WHERE id = ?
  AND app_files_created + ? <= ${APP_FILES_MAX} AND app_revisions_written + 1 <= ${APP_REVISIONS_MAX} AND app_bytes_written + ? <= ${APP_FILES_MAX_BYTES})`;
const quotaExceeded = () => new HttpError(413, "quota_exceeded", "This app has reached its storage quota in the library; ask the owner",
  { max_files: APP_FILES_MAX, max_revisions: APP_REVISIONS_MAX, max_bytes: APP_FILES_MAX_BYTES });
const TEXT_TYPES = new Map([["text/markdown", "markdown"], ["text/html", "html"], ["application/json", "json"], ["text/csv", "csv"]]);
const unsupportedType = () => new HttpError(415, "unsupported_type", "Allowed: " + [...TEXT_TYPES.keys()].join(", "));
const trashedErr = (path, id) => new HttpError(409, "destination_file_trashed", "The owner moved this app's file to trash; ask the owner to restore it", { name: path, file_id: id });
const PATH_CONFLICT_MESSAGE = "This path conflicts with another file of this app (the same path in another case, a file where a folder is needed, or a reserved export file)";
const pathConflict = () => new HttpError(409, "path_conflict", PATH_CONFLICT_MESSAGE);
export const pathConflictAt = (name, conflictsWith) => new HttpError(409, "path_conflict", PATH_CONFLICT_MESSAGE, { name, conflicts_with: conflictsWith });
const exists = () => new HttpError(412, "precondition_failed", "A file already exists at this path");
const missing = () => new HttpError(412, "precondition_failed", "No file exists at this path");
const stale = (row) => new HttpError(412, "precondition_failed", "If-Match does not match the file's current version", { current_revision: row.head_rev, current_etag: `"${row.sha256}"` });
const kindChanged = () => new HttpError(400, "invalid_input", "kind and schema of an exported file cannot change");

/** Content-Type of a create or replace: one of the four text types, matching the path's kind; charset only utf-8. */
function contentKind(req, kind) {
  const [type, ...params] = (req.headers.get("content-type") ?? "").split(";").map((x) => x.trim().toLowerCase());
  const t = TEXT_TYPES.get(type);
  if (!t) throw unsupportedType();
  for (const p of params) {
    const [k, v] = p.split("=").map((x) => x?.trim());
    if (k === "charset" && v?.replace(/^"|"$/g, "") !== "utf-8") throw unsupportedType();
  }
  if (t !== kind) throw new HttpError(415, "unsupported_type", "Content-Type does not match the file extension");
}
/** If-Match ("<sha256>" or rev:N) or If-None-Match: * (create). Returns { create, etag?, rev?, cond }. */
function parsePrecondition(req) {
  const im = req.headers.get("if-match"), inm = req.headers.get("if-none-match");
  if (im === null && inm === null) throw new HttpError(428, "precondition_required", "PUT and DELETE need If-Match (an ETag or rev:N), or If-None-Match: * to create");
  const bad = () => new HttpError(400, "invalid_input", "If-Match must be one quoted SHA-256 ETag or rev:N; If-None-Match must be *; not both");
  if (im !== null && inm !== null) throw bad();
  if (inm !== null) { if (inm.trim() !== "*") throw bad(); return { create: true, cond: "*" }; }
  const v = im.trim();
  let m;
  if (m = /^"([0-9a-f]{64})"$/.exec(v)) return { create: false, etag: m[1], cond: v };
  if ((m = /^"?rev:([1-9][0-9]{0,15})"?$/.exec(v)) && (v[0] === '"') === v.endsWith('"') && Number.isSafeInteger(Number(m[1]))) return { create: false, rev: Number(m[1]), cond: `rev:${Number(m[1])}` };
  throw bad();
}
const fileView = (path, id, kind, revision, sha256, size) => ({ path, file_id: id, kind, revision, etag: `"${sha256}"`, sha256, size });
/** A stored or fresh answer as App Files sends it (publishRevision stores its own shape; map it). */
function answer(res, path, kind, size) {
  const b = res.body;
  const body = b.file ? b : { file: fileView(path, b.artifact_id, kind, b.revision, b.sha256, size), ...b.idempotent_replay ? { idempotent_replay: true } : {} };
  return json(body, res.status, { etag: body.file.etag });
}

/**
 * PUT. Once step 1 (authorization) has passed, every answer and error given while the body was never received first
 * drains it (drainBody, no slot, nothing kept): this wrapper is the one place, so no early return can skip it. A body
 * that receiveBody started is never drained here (receiveBody drains its own over-limit case; a stalled one is a 408).
 */
async function put(req, env, execCtx, p, requestId, wsId, rest) {
  // 1. Authorization (route() already checked the token and the rate limit). A refusal here is not drained.
  await assertStillAuthorized(env, p);
  const h = appHooks(env, req);
  const who = { ws: wsId, creator: p.created_by ?? p.owner_principal_id };
  // See withDrain: the refusal may reach the client up to the receive deadline after it was decided (replay window).
  return withDrain(req, h, who, execCtx, (handoff) => putAuthorized(req, env, execCtx, p, requestId, wsId, rest, h, handoff));
}
async function putAuthorized(req, env, execCtx, p, requestId, wsId, rest, h, handoff) {
  // 2. Parse: nothing below reads the body.
  const { path, kind } = parseAppPath(rest);
  contentKind(req, kind);
  const key = idemKey(req.headers.get("idempotency-key"));
  const pre = parsePrecondition(req);
  const cl = req.headers.get("content-length");
  if (cl !== null && !/^\d+$/.test(cl)) throw new HttpError(400, "invalid_input", "Content-Length must be a non-negative integer");
  const declared = cl === null ? null : Number(cl);
  if (declared !== null && declared > APP_FILE_MAX_BYTES) throw tooLarge();
  const claimed = req.headers.get("x-content-sha256");
  if (claimed !== null && !/^[0-9a-f]{64}$/.test(claimed)) throw new HttpError(400, "invalid_input", "X-Content-SHA256 must be 64 lowercase hex chars");
  const ctx = pubCtx(env, p, requestId);
  const creator = p.created_by ?? p.owner_principal_id;
  const op = "app.put";
  const idemFor = async (r) => ({ op, key, projectId: p.project_id, digest: await sha256Hex(JSON.stringify([op, path, pre.cond, kind, r.sha256])) });
  const hasRecord = async () => !!await env.DB.prepare("SELECT 1 AS x FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = ? AND key = ?")
    .bind(p.principal_id, p.project_id, op, key).first("x");
  // The body is received at most once, under one slot; everything after a receive runs inside that slot's work.
  let received = null;
  const receive = async () => {
    const r = await receiveBody(req, declared ?? APP_FILE_MAX_BYTES, declared, h, handoff);
    if (claimed !== null && claimed !== r.sha256)
      throw new HttpError(422, "integrity_mismatch", "Byte length or SHA-256 does not match declaration", { received_size: r.bytes.byteLength, received_sha256: r.sha256 });
    return received = r;
  };
  const slot = (work) => withSlot(execCtx, wsId, creator, h.reclaimMs, work);
  // A mutable-state refusal is answered only after checking that a same-key request has not committed meanwhile.
  const refuse = async (err) => {
    if (!await hasRecord()) throw err;
    const replayOr = async () => {
      const prior = await idemLookup(ctx, await idemFor(received));
      if (prior) return answer(prior, path, kind, received.bytes.byteLength);
      throw err;
    };
    return received ? replayOr() : slot(async () => { await receive(); return replayOr(); });
  };
  const readRow = () => env.DB.prepare(`SELECT a.id, a.kind, a.schema_id, a.head_rev, a.trashed_at, a.generation_id, r.sha256, r.size FROM artifacts a
    LEFT JOIN revisions r ON r.id = a.head_revision_id
    WHERE a.publisher_id = ? AND a.project_id = ? AND a.folder_id IS ? AND a.export_name = ? AND a.head_rev > 0`).bind(...ownParams(p), path).first();
  const { sql: conflictSql, params: conflictParams } = conflictCheck(p.id, path);
  /** Row and precondition checks (the design's table). Returns the row to replace, or null to create. */
  const rowChecks = async () => {
    const row = await readRow();
    if (pre.create) {
      if (row?.generation_id) throw pathConflict();
      if (row?.trashed_at) throw trashedErr(path, row.id);
      if (row) throw exists();
      if (!await env.DB.prepare(`SELECT ${conflictSql} AS ok`).bind(...conflictParams).first("ok")) throw pathConflict();
      return null;
    }
    if (!row) throw missing();
    if (row.generation_id) throw pathConflict();
    if (row.trashed_at) throw trashedErr(path, row.id);
    if (pre.etag !== undefined ? pre.etag !== row.sha256 : pre.rev !== row.head_rev) throw stale(row);
    if (row.kind !== kind) throw kindChanged();
    return row;
  };
  const caps = async (addFiles, bytes) => {
    const c = await env.DB.prepare("SELECT app_files_created AS f, app_revisions_written AS r, app_bytes_written AS b FROM publishers WHERE id = ?").bind(p.id).first();
    if (!c || c.f + addFiles > APP_FILES_MAX || c.r + 1 > APP_REVISIONS_MAX || c.b + bytes > APP_FILES_MAX_BYTES) throw quotaExceeded();
    // An early refusal only: wsId is the workspace route() resolved for this project (it must equal the project's
    // workspace). The guard inside the publishing batch (projectLimitGuard, in createMarkdown / publishRevision) is the
    // authority.
    const lg = wsId ? { ...await limitGuard(env, wsId, { storage_bytes: bytes }, p.project_id), workspaceId: wsId } : await projectLimitGuard(env, p.project_id, { storage_bytes: bytes });
    if (lg.workspaceId && !await env.DB.prepare(`SELECT ${lg.sql} AS ok`).bind(...lg.params).first("ok"))
      await explainLimit(env, lg.workspaceId, { storage_bytes: bytes }, lg.limits);
  };
  const guard = async (f) => { try { return { v: await f() }; } catch (e) { if (e instanceof HttpError) return { res: await refuse(e) }; throw e; } };
  const unchanged = (row) => json({ file: fileView(path, row.id, row.kind, row.head_rev, row.sha256, row.size), unchanged: true }, 200, { etag: `"${row.sha256}"` });

  // 3. A same-key record first: replay it (receiving the body once, under a slot), before any mutable-state check.
  const recorded = await hasRecord();
  await testPause(env, req, "x-test-pause-after-record-check-ms");
  if (recorded) {
    return slot(async () => {
      await receive();
      const prior = await idemLookup(ctx, await idemFor(received));
      if (prior) return answer(prior, path, kind, received.bytes.byteLength);
      return afterReceive(); // the record was pruned meanwhile: a new request, with these bytes
    });
  }
  // 4. Row and precondition checks.
  const c4 = await guard(rowChecks);
  if (c4.res) return c4.res;
  const row = c4.v;
  // Early unchanged: the declared hash already equals the head's; nothing is kept, reserved or written (put() drains
  // the body).
  if (row && claimed === row.sha256) return unchanged(row);
  // 5. Caps and workspace storage, from the declared size, before any byte is kept or a slot taken.
  const c5 = await guard(() => caps(row ? 0 : 1, declared ?? APP_FILE_MAX_BYTES));
  if (c5.res) return c5.res;
  // 6-10 under one slot.
  return slot(async () => { await receive(); return afterReceive(); });

  /** Steps 7-10 with the received bytes (inside the request's slot). */
  async function afterReceive() {
    const size = received.bytes.byteLength;
    const i = await idemFor(received);
    // 7. Idempotency: replay, or 422 for the same key with a different request.
    const prior = await idemLookup(ctx, i);
    if (prior) return answer(prior, path, kind, size);
    // A path that arrived here from the replay check skipped steps 4 and 5: run them on these bytes.
    const r4 = await guard(rowChecks);
    if (r4.res) return r4.res;
    const cur = r4.v;
    // 8. Late identical PUT: same bytes as the head; re-check authorization and the row, write nothing.
    if (cur && cur.sha256 === received.sha256) {
      await assertStillAuthorized(env, p);
      const again = await guard(rowChecks);
      if (again.res) return again.res;
      if (again.v && again.v.sha256 === received.sha256) return unchanged(again.v);
      return refuse(stale(again.v ?? cur));
    }
    const r5 = await guard(() => caps(cur ? 0 : 1, size));
    if (r5.res) return r5.res;
    // 9. Validate: strict UTF-8, then the kind's own checks.
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(received.bytes); }
    catch { throw new HttpError(422, "invalid_content", `Invalid ${kind}: bytes are not valid UTF-8`, { format: kind, detail: "bytes are not valid UTF-8" }); }
    if (kind === "markdown" || kind === "html") mdBody(text, kind);
    else checkFile(kind, text, cur ? cur.schema_id : null, path);
    await testPause(env, req, "x-test-hold-publish-ms");
    await testPause(env, req);
    // 10. Publish, fenced: liveness and destination, caps, and the row (replace) or no conflicting path (create).
    const revId = randomId("rev");
    const counterUpdate = (addFiles) => env.DB.prepare(`UPDATE publishers SET app_files_created = app_files_created + ?, app_revisions_written = app_revisions_written + 1,
      app_bytes_written = app_bytes_written + ? WHERE id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)`).bind(addFiles, size, p.id, revId);
    const base = { sql: `${baseSql(true)} AND ${capsSql}`, params: [...baseParams(p), p.id, cur ? 0 : 1, size] };
    try {
      if (!cur) {
        const res = await createMarkdown(ctx, p.project_id,
          { title: path, folder: "", folder_id: p.folder_id ?? null, [kind === "markdown" || kind === "html" ? "body" : "content"]: text, schema: null }, key, kind,
          { publisherId: p.id, exportName: path, idem: i, revId, extra: [counterUpdate(1)],
            fence: { sql: `${base.sql} AND ${conflictSql}`, params: [...base.params, ...conflictParams] },
            body: (x) => ({ file: fileView(path, x.artId, kind, 1, x.sha256, x.size) }) });
        return answer(res, path, kind, size);
      }
      const rowFence = { sql: `${base.sql} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id = ? AND project_id = ? AND folder_id IS ?
        AND export_name = ? AND generation_id IS NULL AND trashed_at IS NULL)`, params: [...base.params, cur.id, ...ownParams(p), path] };
      const res = await publishRevision(ctx, p.project_id, cur.id, cur.head_rev, i,
        { revId, body: text, size, sha256: received.sha256, mime: MIME[kind] ?? (kind === "html" ? "text/html" : "text/markdown"), fence: rowFence }, [counterUpdate(0)]);
      return answer(res, path, kind, size);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return publishRefusal(e, cur);
    }
  }
  /** Map a refused publish: authorization first, then the row and path, then caps and storage. */
  async function publishRefusal(e, cur) {
    // Server-side outcomes and content refusals pass through unchanged.
    if (e.status === 503 || e.status === 422 || e.status === 410 || e.status === 500) throw e;
    // Anything else may be an authorization change during the request: that answer comes first.
    await assertStillAuthorized(env, p);
    if (e.status !== 402 && e.status !== 413) {
      const r = await guard(rowChecks);
      if (r.res) return r.res;
      if (cur && r.v && r.v.head_rev !== cur.head_rev) return refuse(stale(r.v));
      const k = await guard(() => caps(cur ? 0 : 1, received.bytes.byteLength));
      if (k.res) return k.res;
      return refuse(e.status === 409 ? e : new HttpError(409, "conflict", "Concurrent modification"));
    }
    return refuse(e);
  }
}

/**
 * DELETE: move the file to the owner's trash. It keeps publisher_id (still the app's data, read-only for the owner),
 * loses export_name (the path is free again), and changes no counter. No body is read, so no slot is taken.
 */
async function remove(req, env, p, requestId, rest) {
  await assertStillAuthorized(env, p);
  const { path } = parseAppPath(rest);
  const key = idemKey(req.headers.get("idempotency-key"));
  const pre = parsePrecondition(req);
  if (pre.create) throw new HttpError(400, "invalid_input", "If-Match must be one quoted SHA-256 ETag or rev:N; If-None-Match must be *; not both");
  const ctx = pubCtx(env, p, requestId);
  const i = { op: "app.delete", key, projectId: p.project_id, digest: await sha256Hex(JSON.stringify(["app.delete", path, pre.cond])) };
  // The stored answer first: replay, or 422 for the same key with a different request.
  const prior = await idemLookup(ctx, i);
  await testPause(env, req, "x-test-pause-after-record-check-ms");
  if (prior) return json(prior.body, prior.status);
  // Mutable-state refusals re-check for a same-key request that committed meanwhile.
  const refuse = async (err) => {
    const again = await idemLookup(ctx, i);
    if (again) return json(again.body, again.status);
    throw err;
  };
  const load = () => env.DB.prepare(`SELECT a.*, r.sha256 FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id
    WHERE a.publisher_id = ? AND a.project_id = ? AND a.folder_id IS ? AND a.export_name = ? AND a.head_rev > 0`).bind(...ownParams(p), path).first();
  const check = (row) => {
    if (!row) return missing();
    if (row.generation_id) return pathConflict();
    if (row.trashed_at) return trashedErr(path, row.id);
    if (pre.etag !== undefined ? pre.etag !== row.sha256 : pre.rev !== row.head_rev) return stale(row);
    return null;
  };
  const a = await load();
  const bad = check(a);
  if (bad) return refuse(bad);
  await testPause(env, req);
  const az = authzSql(ctx, p.project_id);
  const next = a.meta_version + 1;
  const now = nowIso();
  const gate = "EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND meta_version = ? AND meta_request_id = ?)";
  const gp = [a.id, next, requestId];
  const body = { file: { path, file_id: a.id, trashed: true, revision: a.head_rev } };
  const out = await runBatch(ctx, [
    env.DB.prepare(`UPDATE artifacts SET trashed_at = ?, export_name = NULL, meta_version = ?, meta_request_id = ?, updated_at = ?
      WHERE id = ? AND publisher_id = ? AND project_id = ? AND folder_id IS ? AND export_name = ? AND generation_id IS NULL AND trashed_at IS NULL
        AND head_rev = ? AND meta_version = ? AND ${baseSql(true)} AND ${az.sql}`)
      .bind(now, next, requestId, now, a.id, ...ownParams(p), path, a.head_rev, a.meta_version, ...baseParams(p), ...az.params),
    metaBaselineInsert(ctx, a, gate, gp),
    metaVersionInsert(ctx, a, next, { title: a.title, folder: a.folder, tags: a.tags, trashed: true, description: a.template_description, restoredFrom: null }, {}, gate, gp),
    idemInsert(ctx, i, 200, body, gate, gp),
    audit(ctx, p.project_id, "artifact.trash", a.id, null, "ok", gate, gp)
  ], i);
  if (!Array.isArray(out)) return json(out.body, out.status);
  if (!out[0].meta.changes) {
    // Authorization first, then the row as it is now.
    await assertStillAuthorized(env, p);
    return refuse(check(await load()) ?? new HttpError(409, "conflict", "Concurrent modification"));
  }
  return json(body, 200);
}
