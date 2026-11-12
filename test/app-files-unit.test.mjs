// Unit checks of the App Files and publisher-liveness helpers, on the real bundled source (test/load-worker.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./load-worker.mjs";

const W = await loadWorker({
  "oauth/server.js": ["DISABLED_CLIENT_BLOCKS", "clientAllows", "clientLiveSql"],
  "api/app-files.js": ["parseAppPath", "etagMatches"],
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
  for (const bad of ["x.constructor", "x.toString", "x.__proto__", "x.hasOwnProperty", "x.valueOf", "x.txt", "x", "constructor"])
    assert.throws(() => W.parseAppPath(bad), (e) => e.status === 400 && e.code === "invalid_path", bad);
});

test("If-None-Match: '*', weak tags, lists; weak comparison", () => {
  const e = '"' + "a".repeat(64) + '"';
  for (const h of ["*", e, `W/${e}`, `"x", ${e}`, `W/"x" , W/${e}`, ` ${e} `]) assert.equal(W.etagMatches(h, e), true, h);
  for (const h of [null, "", '"x"', `W/"x"`, e.slice(1, -1), `${e}x`]) assert.equal(W.etagMatches(h, e), false, String(h));
});
