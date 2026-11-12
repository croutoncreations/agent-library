// Unit checks of the App Files and publisher-liveness helpers, on the real bundled source (test/load-worker.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./load-worker.mjs";

const W = await loadWorker({
  "oauth/server.js": ["DISABLED_CLIENT_BLOCKS", "clientAllows", "clientLiveSql"],
  "api/app-files.js": ["parseAppPath", "reservedAppPath", "conflictCheck", "etagMatches", "createSlotTable", "APP_FILES_SLOT_RECLAIM_MS", "APP_FILES_OVERRUN_MAX"],
  "api/publisher.js": ["testHooksOn"],
});

test("disabled-client rule: 'writes' (shipped) blocks writes only; 'all' blocks everything; an enabled client is never blocked", () => {
  assert.equal(W.DISABLED_CLIENT_BLOCKS, "writes");
  const on = { client_disabled: null }, off = { client_disabled: "2026-11-11T00:00:00Z" };
  for (const mode of ["writes", "all"]) for (const write of [false, true]) assert.equal(W.clientAllows(on, write, mode), true, `${mode} ${write}`);
  assert.equal(W.clientAllows(off, false, "writes"), true);
  assert.equal(W.clientAllows(off, true, "writes"), false);
  assert.equal(W.clientAllows(off, false, "all"), false);
  assert.equal(W.clientAllows(off, true, "all"), false);
  assert.equal(W.clientAllows(off, false), true, "default is the shipped setting");
  assert.equal(W.clientLiveSql(false, "writes"), "1");
  assert.equal(W.clientLiveSql(true, "writes"), "ac.disabled_at IS NULL");
  assert.equal(W.clientLiveSql(false, "all"), "ac.disabled_at IS NULL");
  assert.equal(W.clientLiveSql(true, "all"), "ac.disabled_at IS NULL");
});

test("parseAppPath: kinds come only from the four text extensions (no inherited object keys)", () => {
  assert.deepEqual(W.parseAppPath("a/b.md"), { path: "a/b.md", kind: "markdown" });
  assert.deepEqual(W.parseAppPath("x.MD"), { path: "x.MD", kind: "markdown" });
  assert.deepEqual(W.parseAppPath("x.Markdown"), { path: "x.Markdown", kind: "markdown" });
  assert.deepEqual(W.parseAppPath("x.htm"), { path: "x.htm", kind: "html" });
  assert.deepEqual(W.parseAppPath("x.JSON"), { path: "x.JSON", kind: "json" });
  assert.deepEqual(W.parseAppPath("x.csv"), { path: "x.csv", kind: "csv" });
  // The manifest name is reserved by meaning: any path whose first segment, lowercased, is manifest.json.
  for (const r of ["manifest.json", "Manifest.json", "MANIFEST.JSON", "manifest.json/x.md", "Manifest.JSON/a/b.csv"]) assert.equal(W.reservedAppPath(r), true, r);
  for (const r of ["x/manifest.json", "manifest.json.md", "manifests.json", "a.md"]) assert.equal(W.reservedAppPath(r), false, r);
  for (const bad of ["x.constructor", "x.toString", "x.__proto__", "x.hasOwnProperty", "x.valueOf", "x.txt", "x", "constructor"])
    assert.throws(() => W.parseAppPath(bad), (e) => e.status === 400 && e.code === "invalid_path", bad);
});

test("If-None-Match: '*', weak tags, lists; weak comparison", () => {
  const e = '"' + "a".repeat(64) + '"';
  for (const h of ["*", e, `W/${e}`, `"x", ${e}`, `W/"x" , W/${e}`, ` ${e} `]) assert.equal(W.etagMatches(h, e), true, h);
  for (const h of [null, "", '"x"', `W/"x"`, e.slice(1, -1), `${e}x`]) assert.equal(W.etagMatches(h, e), false, String(h));
});

test("test hooks: only with AC_TEST_HOOKS = '1' AND a localhost or 127.0.0.1 host (A4)", () => {
  const req = (u) => new Request(u);
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("http://127.0.0.1:21076/v1/app/files")), true);
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("http://localhost:21076/v1/app/files")), true);
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("https://files.example.test/v1/app/files")), false, "non-local host, flag on");
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("http://localhost.example.test/v1/app/files")), false);
  assert.equal(W.testHooksOn({}, req("http://localhost:21076/v1/app/files")), false, "localhost, flag off");
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "true" }, req("http://localhost:21076/v1/app/files")), false);
});

/** A slot table with a movable clock and captured log events. */
function table() {
  let t = 1_000_000;
  const events = [];
  const T = W.createSlotTable({ now: () => t, log: (e) => events.push(e) });
  return { T, events, advance: (ms) => { t += ms; } };
}
const code = (f) => { try { f(); return null; } catch (e) { return `${e.status} ${e.code} ${e.extra?.retry_after_seconds}`; } };

test("slots: 4 per isolate (503 app_files_busy), 2 per workspace and 2 per creator (429 app_files_concurrency), Retry-After 1", () => {
  const { T } = table();
  const a = T.admit("w1", "alice"), b = T.admit("w1", "bob");
  assert.equal(code(() => T.admit("w1", "carol")), "429 app_files_concurrency 1", "third in one workspace");
  const c = T.admit("w2", "carol");
  const c2 = T.admit("w3", "carol");
  T.release(b);
  assert.equal(code(() => T.admit("w4", "carol")), "429 app_files_concurrency 1", "third for one creator across workspaces");
  T.release(c2);
  T.admit("w1", "bob"); T.admit("w4", "erin");
  assert.equal(T.inUse(), 4);
  assert.equal(code(() => T.admit("w9", "dave")), "503 app_files_busy 1", "isolate full: checked before the per-caller limits");
  T.release(a); T.release(a);
  assert.equal(T.inUse(), 3, "release is idempotent");
  T.admit("w9", "dave");
  T.release(c);
  assert.equal(T.inUse(), 3);
});

test("slots: reclaim moves at most 2 stale slots to overrun; they still count for workspace and creator; at most 6 bodies ever", () => {
  const { T, events, advance } = table();
  const held = ["w1", "w2", "w3", "w4"].map((w, i) => T.admit(w, `p${i}`));
  advance(W.APP_FILES_SLOT_RECLAIM_MS);
  // The next admission moves two stale slots (overrun has room for two), freeing two isolate places.
  const n1 = T.admit("w5", "p5");
  assert.deepEqual(T.sizes().overrun, 2);
  assert.equal(events.filter((e) => e.event === "app_files_slot_reclaimed").length, 2, "one event per moved token");
  const n2 = T.admit("w6", "p6");
  assert.equal(T.inUse(), 6);
  assert.equal(code(() => T.admit("w7", "p7")), "503 app_files_busy 1", "4 active and overrun full");
  assert.equal(events.filter((e) => e.event === "app_files_slots_stuck").length, 1);
  // Within one reclaim horizon a stuck table logs once; each later horizon it is still stuck logs once more.
  for (let k = 0; k < 5; k++) { advance(1000); assert.equal(code(() => T.admit(`y${k}`, `r${k}`)), "503 app_files_busy 1"); }
  assert.equal(events.filter((e) => e.event === "app_files_slots_stuck").length, 1, "at most once per horizon");
  // Many more horizons with promises that never settle: never more than 6 bodies; one stuck event per horizon.
  for (let k = 0; k < 10; k++) { advance(W.APP_FILES_SLOT_RECLAIM_MS); assert.equal(code(() => T.admit(`x${k}`, `q${k}`)), "503 app_files_busy 1"); assert.ok(T.inUse() <= 6); }
  assert.equal(events.filter((e) => e.event === "app_files_slots_stuck").length, 11, "a later recurrence is logged again");
  assert.equal(events.filter((e) => e.event === "app_files_slot_reclaimed").length, 2);
  for (const e of events) assert.deepEqual(Object.keys(e), ["event"], "log events carry no ids or paths");
  // Overrun entries keep their workspace and creator counted: the moved ones were w1/p0 and w2/p1.
  T.release(n1); T.release(n2);
  T.admit("w1", "other");
  assert.equal(code(() => T.admit("w1", "other2")), "429 app_files_concurrency 1", "overrun w1 slot still counts for w1");
  assert.equal(code(() => T.admit("w8", "p0")) , null, "p0 has one overrun slot: one more is allowed");
  assert.equal(code(() => T.admit("w9", "p0")) , "503 app_files_busy 1");
  // Releasing an overrun entry frees it.
  T.release(held[0]);
  assert.equal(T.sizes().overrun, 1);
});

test("path conflicts: exact and ancestor names are bound lowercased (at most 8 values); descendants are a lowercased range", () => {
  const c = W.conflictCheck("pub_x", "Notes/Day/A.md");
  assert.match(c.sql, /lower\(c\.export_name\) IN \(\?, \?, \?\)/);
  assert.deepEqual(c.params, ["pub_x", "notes/day/a.md", "notes", "notes/day", "pub_x", "notes/day/a.md/", "notes/day/a.md0"]);
  const deep = W.conflictCheck("pub_x", "1/2/3/4/5/6/7/8.md");
  assert.equal(deep.params.length, 1 + 8 + 1 + 2);
});

// The App Files drain (early answers, and an undeclared body past 1 MiB): read and discard, at most DRAIN_BYTES from the
// body's first byte, within the receive deadlines; cancel past either bound; keep nothing.
const D = await loadWorker({ "api/app-files.js": ["drainBody", "APP_FILES_RECEIVE_MS", "APP_FILES_IDLE_MS", "createDrainTable", "drainWithBudget", "withDrain",
  "APP_FILES_DRAINS_MAX", "APP_FILES_DRAINS_PER_WORKSPACE", "APP_FILES_DRAINS_PER_CREATOR", "APP_FILES_DRAIN_SKIP_LOG_MS", "APP_FILES_DRAIN_RECLAIM_MS"], "util.js": ["DRAIN_BYTES", "HttpError"] });
/** A synthetic body: `count` chunks of `size` bytes, each after `gapMs`; records reads, cancels and WeakRefs to the chunks. */
function body({ size = 65536, count = Infinity, gapMs = 0 } = {}) {
  const s = { pulled: 0, cancelled: false, refs: [] };
  s.reader = new ReadableStream({
    async pull(ctl) {
      if (s.pulled >= count) { ctl.close(); return; }
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      if (s.cancelled) return;
      const c = new Uint8Array(size); s.refs.push(new WeakRef(c)); s.pulled++; ctl.enqueue(c);
    },
    cancel() { s.cancelled = true; }
  }, { highWaterMark: 0 }).getReader();
  return s;
}
const LONG = { receiveMs: 15e3, idleMs: 5e3 };

test("drain: the constants are the shared ones (util DRAIN_BYTES 16 MiB; the receive's 15 s total and 5 s idle)", () => {
  assert.equal(D.DRAIN_BYTES, 16 * 1024 * 1024);
  assert.equal(D.APP_FILES_RECEIVE_MS, 15e3); assert.equal(D.APP_FILES_IDLE_MS, 5e3);
});

test("drain: a body within 16 MiB is read to its end and not cancelled", async () => {
  const b = body({ count: 256 }); // exactly 16 MiB
  assert.equal(await D.drainBody(b.reader, 0, LONG), "done");
  assert.equal(b.pulled, 256); assert.equal(b.cancelled, false);
});

test("drain: stops after 16 MiB in total (counting bytes already received) and cancels", async () => {
  const b = body();
  assert.equal(await D.drainBody(b.reader, 0, LONG), "bytes");
  assert.equal(b.cancelled, true); assert.equal(b.pulled, 257, "16 MiB plus the chunk that passed it, no more");
  const c = body();
  assert.equal(await D.drainBody(c.reader, 15 * 1024 * 1024, LONG), "bytes");
  assert.equal(c.pulled, 17, "1 MiB more after 15 MiB already received");
});

test("drain: cancels on the idle limit and on the total limit", async () => {
  const idle = body({ count: 3, gapMs: 400 });
  let t = Date.now();
  assert.equal(await D.drainBody(idle.reader, 0, { receiveMs: 5000, idleMs: 150 }), "time");
  assert.ok(Date.now() - t < 400, "gave up at the idle limit"); assert.equal(idle.cancelled, true);
  const slow = body({ gapMs: 50 });
  t = Date.now();
  assert.equal(await D.drainBody(slow.reader, 0, { receiveMs: 300, idleMs: 200 }), "time");
  const took = Date.now() - t;
  assert.ok(took >= 280 && took < 450, `gave up at the total limit (${took} ms)`); assert.equal(slow.cancelled, true);
  // The total limit counts from the given start (receiveBody passes its own start time).
  const late = body({ gapMs: 50 });
  t = Date.now();
  assert.equal(await D.drainBody(late.reader, 0, { receiveMs: 300, idleMs: 200 }, Date.now() - 200), "time");
  assert.ok(Date.now() - t < 200, "only the remaining 100 ms of the total limit");
});

test("drain: keeps no chunk (every chunk read is collectable afterwards)", async () => {
  const { setFlagsFromString } = await import("node:v8");
  const { runInNewContext } = await import("node:vm");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const b = body({ size: 1024 * 1024 });
  assert.equal(await D.drainBody(b.reader, 0, LONG), "bytes");
  await new Promise((r) => setTimeout(r, 0));
  gc(); gc();
  const alive = b.refs.filter((r) => r.deref() !== undefined).length;
  assert.equal(b.refs.length, 17);
  assert.ok(alive <= 1, `${alive} of ${b.refs.length} chunks still reachable after the drain`);
});

test("drain: bounds are checked before reading: an expired total deadline or an excessive seen reads nothing and cancels", async () => {
  const late = body();
  assert.equal(await D.drainBody(late.reader, 0, { receiveMs: 300, idleMs: 200 }, Date.now() - 301), "time");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(late.pulled, 0, "zero reads"); assert.equal(late.cancelled, true);
  const big = body();
  assert.equal(await D.drainBody(big.reader, D.DRAIN_BYTES + 1, LONG), "bytes");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(big.pulled, 0, "zero reads"); assert.equal(big.cancelled, true);
});

test("drain: an always-readable endless source stops at the total deadline (elapsed time is re-checked in the loop)", async () => {
  // Tiny chunks, so the byte bound is far away; reads resolve as microtasks, so timers alone would never fire.
  const s = { pulled: 0, cancelled: false };
  const reader = new ReadableStream({ pull(ctl) { s.pulled++; ctl.enqueue(new Uint8Array(1)); }, cancel() { s.cancelled = true; } }).getReader();
  const t = Date.now();
  assert.equal(await D.drainBody(reader, 0, { receiveMs: 200, idleMs: 200 }), "time");
  const took = Date.now() - t;
  assert.ok(took >= 190 && took < 600, `stopped at the total deadline (${took} ms, ${s.pulled} reads)`); assert.equal(s.cancelled, true);
});

/** A drain table with an injectable clock and log. */
function drains() {
  let t = 1_000_000;
  const events = [];
  return { T: D.createDrainTable({ now: () => t, log: (e) => events.push(e) }), events, advance: (ms) => { t += ms; } };
}

test("drain budget: 8 per isolate, 2 per workspace, 2 per creator; independent constants; release is idempotent", () => {
  assert.deepEqual([D.APP_FILES_DRAINS_MAX, D.APP_FILES_DRAINS_PER_WORKSPACE, D.APP_FILES_DRAINS_PER_CREATOR, D.APP_FILES_DRAIN_SKIP_LOG_MS], [8, 2, 2, 60e3]);
  const { T, events } = drains();
  const a = T.admit("w1", "alice"); T.admit("w1", "bob");
  assert.equal(T.admit("w1", "carol"), null, "third in one workspace");
  assert.deepEqual(events.at(-1), { event: "app_files_drain_skipped", scope: "workspace", count: 1 });
  T.admit("w2", "carol"); T.admit("w3", "carol");
  assert.equal(T.admit("w4", "carol"), null, "third for one creator across workspaces");
  for (let i = 0; i < 4; i++) assert.notEqual(T.admit(`x${i}`, `p${i}`), null);
  assert.equal(T.inUse(), 8);
  assert.equal(T.admit("w9", "dave"), null, "isolate full");
  assert.equal(T.skipped(), 2, "the two skips after the logged one are counted, not logged yet");
  T.release(a); T.release(a);
  assert.equal(T.inUse(), 7, "release is idempotent");
  assert.notEqual(T.admit("w1", "erin"), null);
});

test("drain budget: the skip line is logged at most once per minute with the skips since the last line; no ids", () => {
  const { T, events, advance } = drains();
  T.admit("w", "a"); T.admit("w", "b");
  for (let i = 0; i < 5; i++) { assert.equal(T.admit("w", `c${i}`), null); advance(1000); }
  assert.equal(events.length, 1, "once within a minute");
  advance(60e3);
  // A minute on, the two drains admitted first are reclaimed at this admission (that has its own log line); creator a
  // gets two fresh drains and the third is skipped.
  const skips = () => events.filter((e) => e.event === "app_files_drain_skipped");
  assert.notEqual(T.admit("z", "a"), null, "creator a's first drain");
  assert.notEqual(T.admit("y", "a"), null, "creator a's second drain");
  assert.equal(T.admit("z2", "a"), null, "creator a's third");
  assert.equal(skips().length, 2);
  assert.deepEqual(skips()[1], { event: "app_files_drain_skipped", scope: "creator", count: 5 }, "4 unlogged plus this one");
  for (const e of skips()) assert.deepEqual(Object.keys(e), ["event", "scope", "count"]);
});

test("drain budget: released when the drain ends, on the byte bound, on a time bound and on a read error; a skipped drain cancels the body", async () => {
  const { T } = drains();
  const who = { ws: "w", creator: "c" };
  const done = body({ count: 2 });
  const p = D.drainWithBudget(T, who, done.reader, 0, LONG);
  assert.equal(T.inUse(), 1, "held while draining");
  assert.equal(await p, "done"); assert.equal(T.inUse(), 0);
  assert.equal(await D.drainWithBudget(T, who, body().reader, 0, LONG), "bytes"); assert.equal(T.inUse(), 0);
  assert.equal(await D.drainWithBudget(T, who, body({ gapMs: 400 }).reader, 0, { receiveMs: 5000, idleMs: 100 }), "time"); assert.equal(T.inUse(), 0);
  const broken = new ReadableStream({ pull(ctl) { ctl.error(new Error("synthetic read error")); } }).getReader();
  await D.drainWithBudget(T, who, broken, 0, LONG); assert.equal(T.inUse(), 0, "released on a read error");
  // Fill the creator's two drains; a third is skipped: its body is cancelled at once and nothing is read.
  const h1 = body({ gapMs: 300, count: 1 }), h2 = body({ gapMs: 300, count: 1 }), third = body();
  const p1 = D.drainWithBudget(T, who, h1.reader, 0, LONG), p2 = D.drainWithBudget(T, who, h2.reader, 0, LONG);
  assert.equal(await D.drainWithBudget(T, who, third.reader, 0, LONG), "skipped");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third.cancelled, true); assert.equal(third.pulled, 0); assert.equal(T.skipped(), 0, "the first skip is logged at once");
  await Promise.all([p1, p2]); assert.equal(T.inUse(), 0);
});

test("withDrain: the drain never replaces the answer (getReader throws); a handed-over reader is drained after the work", async () => {
  const { T } = drains();
  const who = { ws: "w", creator: "c" };
  const refusal = new D.HttpError(412, "precondition_failed", "A file already exists at this path");
  const throwing = { body: { locked: false, getReader() { throw new TypeError("synthetic: stream errored"); } } };
  await assert.rejects(D.withDrain(throwing, LONG, who, null, async () => { throw refusal; }, T), (e) => e === refusal);
  const answer = { synthetic: "answer" };
  assert.equal(await D.withDrain(throwing, LONG, who, null, async () => answer, T), answer);
  // A body already locked (receiveBody took it) and not handed over: nothing is drained.
  const locked = { body: { locked: true, getReader() { throw new Error("must not be called"); } } };
  assert.equal(await D.withDrain(locked, LONG, who, null, async () => answer, T), answer);
  // Handed over (an undeclared body past the limit): drained after the work settles, under the budget.
  const rest = body({ count: 3, gapMs: 50 });
  let heldDuringWork = null;
  const tooLarge = new D.HttpError(413, "file_too_large", "synthetic");
  const run = D.withDrain(locked, LONG, who, null, async (handoff) => { heldDuringWork = T.inUse(); Object.assign(handoff, { reader: rest.reader, seen: 10, start: Date.now() }); throw tooLarge; }, T);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(T.inUse(), 1, "the handed-over reader is being drained");
  await assert.rejects(run, (e) => e === tooLarge);
  assert.equal(heldDuringWork, 0); assert.equal(rest.pulled, 3); assert.equal(T.inUse(), 0);
});

test("drain budget: a token older than 60 s is reclaimed at admission (logged once each); its late release changes nothing; never negative", () => {
  assert.equal(D.APP_FILES_DRAIN_RECLAIM_MS, 60e3);
  const { T, events, advance } = drains();
  const held = [];
  for (let i = 0; i < 8; i++) held.push(T.admit(`w${i}`, `p${i}`));
  assert.equal(T.inUse(), 8);
  advance(59_999);
  assert.equal(T.admit("x", "q"), null, "before 60 s nothing is reclaimed");
  assert.equal(events.filter((e) => e.event === "app_files_drain_reclaimed").length, 0);
  advance(1);
  const fresh = T.admit("w0", "p0");
  assert.notEqual(fresh, null, "a full table admits again after 60 s");
  assert.equal(events.filter((e) => e.event === "app_files_drain_reclaimed").length, 8, "one line per dropped token");
  for (const e of events.filter((x) => x.event === "app_files_drain_reclaimed")) assert.deepEqual(e, { event: "app_files_drain_reclaimed" });
  assert.equal(T.inUse(), 1);
  // Late releases of the reclaimed tokens are no-ops: w0/p0 still counts the fresh drain, and nothing goes negative.
  for (const t of held) T.release(t);
  assert.equal(T.inUse(), 1);
  assert.notEqual(T.admit("w0", "p0b"), null, "w0 has one drain (the fresh one): a second is allowed");
  assert.equal(T.admit("w0", "p0c"), null, "and a third is not: the count did not go negative");
  T.release(fresh); T.release(fresh);
  assert.equal(T.inUse(), 1);
});

test("drain budget: a skipped drain does not wait for cancel(); the answer comes at once and the skip is logged", async () => {
  const { T, events } = drains();
  const who = { ws: "w", creator: "c" };
  T.admit("w", "c"); T.admit("w", "c");
  let cancelCalled = false;
  const stuck = { cancel() { cancelCalled = true; return new Promise(() => {}); }, read() { throw new Error("must not read"); } };
  const r = await Promise.race([D.drainWithBudget(T, who, stuck, 0, LONG), new Promise((res) => setImmediate(() => res("waited for cancel")))]);
  assert.equal(r, "skipped");
  assert.equal(cancelCalled, true);
  assert.equal(events.at(-1).event, "app_files_drain_skipped");
  // A cancel() that rejects is not an unhandled rejection.
  const rejecting = { cancel: () => Promise.reject(new Error("synthetic cancel failure")) };
  assert.equal(await D.drainWithBudget(T, who, rejecting, 0, LONG), "skipped");
});
