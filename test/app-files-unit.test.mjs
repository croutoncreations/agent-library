// Unit checks of the App Files and publisher-liveness helpers, on the real bundled source (test/load-worker.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";

const W = await loadWorker({
  "api/app-files.js": ["parseAppPath", "etagMatches"],
  "api/app-auth.js": ["testHooksOn"],
});

function jsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "web" ? [] : jsFiles(p);
    return p.endsWith(".js") ? [p] : [];
  });
}

test("livePublisher call sites: exactly the three known callers, each checking revoked and disabled", () => {
  const sites = jsFiles(join(ROOT, "packages", "core", "src")).flatMap((f) => {
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/function livePublisher\(/g, "");
    return [...src.matchAll(/\blivePublisher\(/g)].map((m) => ({ file: f.slice(ROOT.length + 1), after: src.slice(m.index, m.index + 600) }));
  });
  // oauth/server.js: refresh and code exchange; api/app.js: the request gate.
  assert.deepEqual(sites.map((s) => s.file).sort(), ["packages/core/src/api/app.js", "packages/core/src/oauth/server.js", "packages/core/src/oauth/server.js"]);
  for (const s of sites) assert.match(s.after, /\.disabled\b/, `${s.file}: a livePublisher caller checks disabled`);
});

test("parseAppPath: lowercase [a-z0-9._-] segments, 1-8 of them, kind and type from the last segment's extension", () => {
  const kindOf = (p) => { const r = W.parseAppPath(p); return [r.kind, r.mime]; };
  assert.deepEqual(W.parseAppPath("a/b.md"), { path: "a/b.md", kind: "markdown", mime: "text/markdown", folders: ["a"], name: "b.md" });
  assert.deepEqual(W.parseAppPath("x.html"), { path: "x.html", kind: "html", mime: "text/html", folders: [], name: "x.html" });
  assert.deepEqual(kindOf("summary/steps.json"), ["json", "application/json"]);
  assert.deepEqual(kindOf("x_y-1.v2.csv"), ["csv", "text/csv"]);
  assert.equal(W.parseAppPath("a/b/c/d/e/f/g/h.md").kind, "markdown");
  // Binaries: a fixed type per extension; any other short [a-z0-9] extension is application/octet-stream.
  for (const [p, mime] of [["test/sub/a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.jpeg", "image/jpeg"], ["a.webp", "image/webp"], ["a.gif", "image/gif"],
    ["r/2026-11-22.pdf", "application/pdf"], ["v.mp4", "video/mp4"], ["v.webm", "video/webm"], ["data.bin", "application/octet-stream"], ["a.tar.gz", "application/octet-stream"], ["x.valueof", "application/octet-stream"]])
    assert.deepEqual(kindOf(p), ["binary", mime], p);
  const bad = ["", "X.md", "a/B.md", ".hidden.md", "a/.x/b.md", "a//b.md", "a/", "/a.md", "x.txt", "x", "x.markdown", "x.htm", "x.MD", "a.md/b.md", "a.json/b.csv", "x.svg", "x.svgz", "x.xhtml",
    "x.__proto__", "x.constructor", "x.toolongextension", "a%2Fb.md", "a b.md", "é.md", "a/b/c/d/e/f/g/h/i.md", "a".repeat(198) + ".md", "A.png", "a/B/c.png", ".png", "f".repeat(81) + "/a.png"];
  assert.equal(W.parseAppPath("f".repeat(80) + "/a.png").folders[0].length, 80, "a folder segment is a folder name: 1-80 characters");
  for (const p of bad) assert.throws(() => W.parseAppPath(p), (e) => e.status === 400 && e.code === "invalid_path", JSON.stringify(p));
  assert.equal(W.parseAppPath("a".repeat(197) + ".md").kind, "markdown", "200 characters is allowed");
  // A folder may end in a dot-extension that is not one of the four.
  assert.equal(W.parseAppPath("v1.0/a.md").kind, "markdown");
});

test("If-None-Match: '*', weak tags, lists; weak comparison", () => {
  const e = '"' + "a".repeat(64) + '"';
  for (const h of ["*", e, `W/${e}`, `"x", ${e}`, `W/"x" , W/${e}`, ` ${e} `]) assert.equal(W.etagMatches(h, e), true, h);
  for (const h of [null, "", '"x"', `W/"x"`, e.slice(1, -1), `${e}x`]) assert.equal(W.etagMatches(h, e), false, String(h));
});

test("test hooks: only with AC_TEST_HOOKS = '1' AND a localhost or 127.0.0.1 host", () => {
  const req = (u) => new Request(u);
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("http://127.0.0.1:21076/v1/app/files")), true);
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("http://localhost:21076/v1/app/files")), true);
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("https://files.example.test/v1/app/files")), false, "non-local host, flag on");
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "1" }, req("http://localhost.example.test/v1/app/files")), false);
  assert.equal(W.testHooksOn({}, req("http://localhost:21076/v1/app/files")), false, "localhost, flag off");
  assert.equal(W.testHooksOn({ AC_TEST_HOOKS: "true" }, req("http://localhost:21076/v1/app/files")), false);
});
