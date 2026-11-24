#!/usr/bin/env node
// Print the test files for one CI shard: `node scripts/test-shard.mjs <index> <count> [--exclude file ...]`.
//
// Every test/*.test.mjs file lands in exactly one shard. Files are spread greedily by their recorded run time
// (scripts/test-weights.json, seconds, measured on CI), heaviest first, onto the least-loaded shard; a file without a
// recorded weight counts as 10 s. The assignment depends only on the file list and the weights, so it is the same on
// every runner. `--check` verifies the partition (each file once, nothing lost) and prints the shard totals.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WEIGHT = 10;

export function shards(files, weights, count) {
  const sorted = [...files].sort((a, b) => (weights[b] ?? DEFAULT_WEIGHT) - (weights[a] ?? DEFAULT_WEIGHT) || a.localeCompare(b));
  const bins = Array.from({ length: count }, () => ({ total: 0, files: [] }));
  for (const f of sorted) {
    const bin = bins.reduce((min, b) => (b.total < min.total ? b : min), bins[0]);
    bin.total += weights[f] ?? DEFAULT_WEIGHT;
    bin.files.push(f);
  }
  return bins.map((b) => ({ total: b.total, files: b.files.sort() }));
}

function main(argv) {
  const check = argv.includes("--check");
  const ex = argv.indexOf("--exclude");
  const exclude = new Set(ex >= 0 ? argv.slice(ex + 1).map((f) => f.replace(/^test\//, "")) : []);
  const [index, count] = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  if (!count || index === undefined || index < 1 || index > count) {
    console.error("usage: node scripts/test-shard.mjs <index 1..count> <count> [--check] [--exclude file ...]");
    process.exit(2);
  }
  const files = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs") && !exclude.has(f));
  const weights = JSON.parse(readFileSync(join(ROOT, "scripts/test-weights.json"), "utf8"));
  const bins = shards(files, weights, count);
  if (check) {
    const all = bins.flatMap((b) => b.files);
    if (all.length !== files.length || new Set(all).size !== files.length) { console.error("shards do not partition the test files"); process.exit(1); }
    bins.forEach((b, i) => console.log(`shard ${i + 1}/${count}: ${b.files.length} files, ~${b.total} s`));
    return;
  }
  console.log(bins[index - 1].files.map((f) => "test/" + f).join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
