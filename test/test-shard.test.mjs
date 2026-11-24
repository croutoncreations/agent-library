// CI test shards (scripts/test-shard.mjs): every test file runs in exactly one shard, the split is deterministic, and
// the workflow's required "test" check depends on every shard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { shards, updatedWeights } from "../scripts/test-shard.mjs";

const files = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs"));
const weights = JSON.parse(readFileSync(join(ROOT, "scripts/test-weights.json"), "utf8"));

test("three shards partition every test file exactly once; a new file without a weight is still assigned", () => {
  const bins = shards([...files, "brand-new.test.mjs"], weights, 3);
  const all = bins.flatMap((b) => b.files);
  assert.equal(all.length, files.length + 1);
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.includes("brand-new.test.mjs"));
  const totals = bins.map((b) => b.total);
  assert.ok(Math.max(...totals) - Math.min(...totals) <= Math.max(...Object.values(weights)), `balanced: ${totals}`);
});

test("the CLI lists the same files on every run, and --exclude removes a file from every shard", () => {
  const run = (i) => execFileSync("node", ["scripts/test-shard.mjs", String(i), "3", "--exclude", "test/app-connect-phase3.test.mjs"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
  const first = [1, 2, 3].map(run), again = [1, 2, 3].map(run);
  assert.deepEqual(again, first);
  const all = first.flat();
  assert.equal(all.length, files.length - 1);
  assert.ok(!all.includes("test/app-connect-phase3.test.mjs"));
  assert.ok(all.every((f) => f.startsWith("test/") && files.includes(f.slice(5))));
});

test("the required 'test' check is the summary job that needs every shard", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const count = /shard: \[([\d, ]+)\]/.exec(ci)[1].split(",").map(Number);
  assert.deepEqual(count, count.map((_, i) => i + 1), "the matrix lists shards 1..N");
  assert.match(ci, /test-summary:\n\s+name: test\n\s+if: always\(\)\n\s+needs: test\n/);
  assert.match(ci, /needs\.test\.result \}\}" = success/);
  // The shard count comes from the matrix length, so adding a shard can't leave files unassigned.
  assert.match(ci, /scripts\/test-shard\.mjs \$\{\{ matrix\.shard \}\} \$\{\{ strategy\.job-total \}\}/);
  assert.match(ci, /scripts\/test-shard\.mjs 1 \$\{\{ strategy\.job-total \}\} --check/);
  assert.match(ci, /if: matrix\.shard == strategy\.job-total\n/);
});

test("every test file has a measured weight, and --update-weights takes CI timings", () => {
  assert.deepEqual(files.filter((f) => !(f in weights)), [], "add the new file's CI time to scripts/test-weights.json");
  assert.deepEqual(Object.keys(weights).filter((f) => !files.includes(f)), [], "weights for deleted files");
  const next = updatedWeights({ "b.test.mjs": 5, "a.test.mjs": 9 }, ['{"file":"a.test.mjs","seconds":12.4}', "", '{"file":"c.test.mjs","seconds":0.2}']);
  assert.deepEqual(next, { "a.test.mjs": 12, "b.test.mjs": 5, "c.test.mjs": 1 });
  assert.deepEqual(Object.keys(next), ["a.test.mjs", "b.test.mjs", "c.test.mjs"]);
  assert.throws(() => updatedWeights({}, ['{"file":"../x","seconds":1}']), /bad timing line/);
});
