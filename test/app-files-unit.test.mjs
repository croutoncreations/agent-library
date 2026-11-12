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
