// servedContentType (packages/core/src/service.js), from the real bundle: the content type a stored version is served
// with, for every text type, every supported file type, and names every plain object inherits (the previous Worker,
// through 4f43f26, stored uploads whose mime was "constructor", "toString", "valueOf" or "toLocaleString"). Also a
// source check that no CONTENT_TYPE lookup keyed by anything but one string literal bypasses it. Synthetic values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorker } from "./load-worker.mjs";
import { ROOT } from "./helpers.mjs";

const lib = await loadWorker({ "service.js": ["servedContentType", "BINARY_TYPES"], "formats.js": ["CONTENT_TYPE"] });
const INHERITED = ["constructor", "toString", "valueOf", "toLocaleString", "__proto__", "hasOwnProperty"];

/** Line numbers of every CONTENT_TYPE[...] / CONTENT_TYPE?.[...] whose key is not one double-quoted literal, except servedContentType's own guarded line. */
function unguardedContentTypeLookups(text) {
  const hits = [];
  for (const m of text.matchAll(/\bCONTENT_TYPE\s*(?:\?\.)?\[(?!\s*"[^"\n]*"\s*\])/g)) {
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, (text.indexOf("\n", m.index) + 1 || text.length + 1) - 1);
    if (!/^\s*if \(Object\.hasOwn\(CONTENT_TYPE, mime\)\) return CONTENT_TYPE\[mime\];$/.test(line)) hits.push(text.slice(0, m.index).split("\n").length);
  }
  return hits;
}

test("servedContentType: text types mapped, supported file types as stored, anything else application/octet-stream", () => {
  for (const [mime, served] of Object.entries(lib.CONTENT_TYPE)) assert.equal(lib.servedContentType(mime), served, mime);
  for (const mime of Object.keys(lib.BINARY_TYPES)) assert.equal(lib.servedContentType(mime), mime, mime);
  for (const mime of [...INHERITED, "", "text/x-unknown"]) assert.equal(lib.servedContentType(mime), "application/octet-stream", mime);
  assert.deepEqual(["text/html", "text/markdown", "image/png", "application/octet-stream"].map(lib.servedContentType),
    ["text/plain; charset=utf-8", "text/plain; charset=utf-8", "image/png", "application/octet-stream"]);
});

test("the CONTENT_TYPE lookup check catches optional, fallback and split keys, and allows a literal and the helper", () => {
  const bad = 'a = CONTENT_TYPE?.[r.mime];\nb = CONTENT_TYPE[r.mime || "x"];\nc = CONTENT_TYPE[\n r.mime];\n';
  assert.deepEqual(unguardedContentTypeLookups(bad), [1, 2, 3]);
  const fine = 'x = CONTENT_TYPE["text/csv"];\n  if (Object.hasOwn(CONTENT_TYPE, mime)) return CONTENT_TYPE[mime];\n';
  assert.deepEqual(unguardedContentTypeLookups(fine), []);
});

test("packages/core/src looks up CONTENT_TYPE by a stored value only through servedContentType", () => {
  const src = join(ROOT, "packages", "core", "src"), hits = [];
  for (const f of readdirSync(src, { recursive: true }).filter((f) => f.endsWith(".js")))
    for (const n of unguardedContentTypeLookups(readFileSync(join(src, f), "utf8"))) hits.push(`${f}:${n}`);
  assert.deepEqual(hits, []);
});
