// The contentless index (migration 0031) must be smaller than the stored-copy index it replaces (migration 0014) for
// ordinary 10 KB documents; scripts/search/measure-index-size.mjs prints the numbers for any N. Node SQLite only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measure } from "../scripts/search/measure-index-size.mjs";

test("contentless FTS5 for 300 synthetic 10 KB documents is under 60% of the stored-copy index, with the same matches", () => {
  const rows = measure(300), [stored, contentless] = Object.values(rows);
  console.log("INDEX_SIZE", JSON.stringify(rows));
  assert.equal(contentless.matches_for_the_AND_of, stored.matches_for_the_AND_of);
  assert.ok(contentless.bytes < stored.bytes * 0.6, JSON.stringify(rows));
});
