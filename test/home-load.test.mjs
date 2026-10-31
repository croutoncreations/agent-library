// Home list loading (browser HOME module, run in a VM against a mock API): the first page of every project is
// shown before older pages load, the final list is complete and access-checked, and the per-tab cache is
// scoped to one user. Synthetic data only; no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const START = "var HOME_JS = String.raw`", END = "`;\n\n// src/editor-bundle.ts\n";
const HOME_JS = src.slice(src.indexOf(START) + START.length, src.indexOf(END));

class Store {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
function home(sessionStorage = new Store()) {
  const ctx = { sessionStorage, localStorage: new Store() };
  return { HOME: vm.runInNewContext(HOME_JS + "\nHOME", ctx), sessionStorage };
}

// Newest-first pages of 50, like GET /api/projects/:id/artifacts.
const PAGE = 50;
function docs(pid, n, newest, step) {
  return Array.from({ length: n }, (_, i) => ({ id: `${pid}-${i}`, project_id: pid, title: `${pid} doc ${i}`, kind: "markdown",
    trashed: false, revision: 1, updated_at: new Date(Date.UTC(2026, 9, 12) - (newest + i * step) * 60000).toISOString() }));
}
function api({ projects, data, errors = {}, finalProjects = projects }) {
  const log = []; let listed = 0;
  async function call(method, path) {
    await new Promise((r) => setImmediate(r));
    log.push(path);
    if (path === "/api/projects") return { projects: listed++ ? finalProjects : projects };
    const m = /^\/api\/projects\/([^/]+)\/artifacts\?include=mime(?:&cursor=(\d+))?$/.exec(path);
    const pid = decodeURIComponent(m[1]), off = Number(m[2] ?? 0);
    if (errors[pid]) throw Object.assign(new Error("fail"), { status: errors[pid] });
    const all = data[pid] ?? [];
    return { artifacts: all.slice(off, off + PAGE), next_cursor: off + PAGE < all.length ? String(off + PAGE) : null };
  }
  return { call, log };
}
const P = (...ids) => ids.map((id) => ({ id, title: `Project ${id}` }));
const ids = (rows) => rows.map((r) => r.id);

test("home: first pages are shown before older pages, and already hold the newest documents overall", async () => {
  const { HOME } = home();
  // "big" has 130 documents spread over a long period; "small" has 10 recent ones interleaved with big's newest.
  const data = { big: docs("big", 130, 0, 10), small: docs("small", 10, 5, 10) };
  const { call, log } = api({ projects: P("big", "small", "hidden"), data, errors: { hidden: 403 } });
  let early = null, earlyAt = -1;
  const result = await HOME.load(call, () => true, (r) => { early = r; earlyAt = log.length; });

  assert.ok(early, "early result delivered");
  const firstPages = log.slice(0, earlyAt);
  assert.deepEqual(firstPages.slice(1).sort(), ["/api/projects/big/artifacts?include=mime", "/api/projects/hidden/artifacts?include=mime", "/api/projects/small/artifacts?include=mime"]);
  assert.ok(log.slice(earlyAt).includes("/api/projects/big/artifacts?include=mime&cursor=50"), "older pages load after the early result");
  assert.equal(early.rows.length, 60);
  assert.equal(result.rows.length, 140);
  assert.equal(result.failed, 0, "403 is not a failure");
  // The 50 newest are identical whether taken from the first pages or the complete list.
  assert.deepEqual(ids(HOME.order(early.rows, "newest").slice(0, 50)), ids(HOME.order(result.rows, "newest").slice(0, 50)));
  assert.equal(result.rows.find((r) => r.pid === "small").project_title, "Project small");
  assert.equal(log.filter((p) => p === "/api/projects").length, 2, "access is re-checked once at the end");
});

test("home: a timestamp tie across the first page boundary is fetched before the early result", async () => {
  const { HOME } = home();
  // 60 documents saved at the same moment (a publisher batch), then older ones. The API breaks the tie by id,
  // the list by title, and the titles run opposite to the ids, so page 2 holds rows that sort into the top 50.
  const T = "2026-10-12T09:00:00.000Z";
  const batch = Array.from({ length: 60 }, (_, i) => ({ id: `big-${String(i).padStart(3, "0")}`, project_id: "big", title: `Batch ${String(99 - i).padStart(3, "0")}`,
    kind: "markdown", trashed: false, revision: 1, updated_at: T }));
  const data = { big: batch.concat(docs("old", 60, 600, 1).map((a) => ({ ...a, project_id: "big" }))), small: docs("small", 5, 5000, 1) };
  const { call, log } = api({ projects: P("big", "small"), data });
  let early = null, earlyAt = -1;
  const result = await HOME.load(call, () => true, (r) => { early = r; earlyAt = log.length; });
  assert.ok(early, "early result still delivered once the tie is resolved");
  assert.ok(log.slice(0, earlyAt).includes("/api/projects/big/artifacts?include=mime&cursor=50"), "the tied page is fetched first");
  assert.ok(!log.slice(0, earlyAt).includes("/api/projects/big/artifacts?include=mime&cursor=100"), "but no further than needed");
  assert.deepEqual(ids(HOME.order(early.rows, "newest").slice(0, HOME.EARLY)), ids(HOME.order(result.rows, "newest").slice(0, HOME.EARLY)));
  assert.equal(result.rows.length, 125);
});

test("home: a first page shortened by client-side filtering is fetched further before the early result", async () => {
  const { HOME } = home();
  // "big"'s first page has 20 trashed rows the list drops, so its last kept row is newer than the 50th row overall.
  const big = docs("big", 120, 0, 10).map((a, i) => (i >= 30 && i < 50 ? { ...a, trashed: true } : a));
  const { call, log } = api({ projects: P("big", "small"), data: { big, small: docs("small", 30, 600, 1) } });
  let early = null, earlyAt = -1;
  const result = await HOME.load(call, () => true, (r) => { early = r; earlyAt = log.length; });
  assert.ok(log.slice(0, earlyAt).includes("/api/projects/big/artifacts?include=mime&cursor=50"));
  assert.deepEqual(ids(HOME.order(early.rows, "newest").slice(0, HOME.EARLY)), ids(HOME.order(result.rows, "newest").slice(0, HOME.EARLY)));
});

test("home: no early result when every project fits on one page", async () => {
  const { HOME } = home();
  const { call } = api({ projects: P("a", "b"), data: { a: docs("a", 3, 0, 1), b: docs("b", 50, 0, 1) } });
  let early = 0;
  const result = await HOME.load(call, () => true, () => early++);
  assert.equal(early, 0);
  assert.equal(result.rows.length, 53);
});

test("home: a project whose access is revoked during the scan is dropped entirely; server errors are counted", async () => {
  const { HOME } = home();
  const { call } = api({ projects: P("keep", "gone", "broken"), finalProjects: P("keep", "broken"),
    data: { keep: docs("keep", 60, 0, 1), gone: docs("gone", 70, 0, 1) }, errors: { broken: 500 } });
  let early = null;
  const result = await HOME.load(call, () => true, (r) => { early = r; });
  assert.ok(early.rows.some((r) => r.pid === "gone"), "first pages are from projects the API allowed at fetch time");
  assert.deepEqual([...new Set(result.rows.map((r) => r.pid))], ["keep"]);
  assert.equal(result.rows.length, 60);
  assert.equal(result.failed, 1);
  assert.deepEqual([...result.failedPids], ["broken"]);
});

test("home: leaving the page cancels the load; 401 is not swallowed", async () => {
  const { HOME } = home();
  let live = true;
  const { call } = api({ projects: P("a"), data: { a: docs("a", 120, 0, 1) } });
  await assert.rejects(HOME.load(call, () => live, () => { live = false; }), (e) => e.cancelled === true);
  const denied = api({ projects: P("a"), data: {}, errors: { a: 401 } });
  await assert.rejects(HOME.load(denied.call, () => true), (e) => e.status === 401);
});

test("home cache: per user, per tab, cleared on demand, tolerant of bad or blocked storage", () => {
  const { HOME, sessionStorage } = home();
  const result = { rows: [{ pid: "p", id: "a", title: "T", project_title: "P", updated_at: "2026-10-12T00:00:00Z", revision: 1 }], projects: P("p") };
  assert.equal(HOME.cacheRead("u1"), null);
  HOME.cacheWrite("u1", result); HOME.cacheWrite("u2", result);
  assert.equal(JSON.stringify(HOME.cacheRead("u1").rows), JSON.stringify(result.rows));
  assert.equal(HOME.cacheRead("u1").uid, "u1");
  assert.equal(HOME.cacheRead("u3"), null);
  HOME.cacheClear("u1");
  assert.ok(HOME.cacheRead("u1")); assert.equal(HOME.cacheRead("u2"), null);
  sessionStorage.setItem("al:draft:keep", "x");
  HOME.cacheClear(null);
  assert.equal(HOME.cacheRead("u1"), null);
  assert.equal(sessionStorage.getItem("al:draft:keep"), "x", "only home cache keys are removed");
  // A cache entry stored under one user's key but naming another user is ignored.
  sessionStorage.setItem("al:homecache:u1", JSON.stringify({ uid: "u2", rows: [], projects: [], at: 1 }));
  assert.equal(HOME.cacheRead("u1"), null);
  sessionStorage.setItem("al:homecache:u1", "{not json");
  assert.equal(HOME.cacheRead("u1"), null);
  const blocked = { get length() { throw new Error("blocked"); }, getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const b = home(blocked).HOME;
  assert.equal(b.cacheRead("u1"), null);
  assert.doesNotThrow(() => b.cacheWrite("u1", result));
  assert.doesNotThrow(() => b.cacheClear(null));
});
