// Every stored-bytes access goes through src/content-store.js (the encryption seam; docs/encryption.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

function jsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "web" ? [] : jsFiles(p);
    return p.endsWith(".js") ? [p] : [];
  });
}

test("only src/content-store.js touches the R2 binding", () => {
  const offenders = jsFiles(join(ROOT, "src"))
    .filter((f) => !f.endsWith("content-store.js"))
    .filter((f) => /\bBLOBS\b/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length + 1));
  assert.deepEqual(offenders, []);
});
