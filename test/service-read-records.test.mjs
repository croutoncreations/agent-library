// The exact pure page function called by service.readRecords, with the shipped iterator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRecordsPage } from "../packages/core/src/service.js";

const schema = "agentlib.measurements/1";
test("readRecordsPage retains legacy large records and last duplicate top-level members", () => {
  const records = [{ id: "large", metric: "m", extra: "x".repeat(20000) }, { id: "dated", metric: "m", date: "2026-01-02", extra: { nested: ["[,]{}:\"\\", 1] } }, { id: "other", metric: "n" }];
  const text = ` { "records":[], "meta":{"ignored":1}, "rec\\u006frds" : ${JSON.stringify(records, null, 2)} } `;
  assert.deepEqual(readRecordsPage(text, { limit: 1 }), { records: [records[0]], undated_excluded: 0, next_cursor: "1" });
  assert.deepEqual(readRecordsPage(text, { metric: "m", from: "2026-01-01", limit: 1 }), { records: [records[1]], undated_excluded: 1, next_cursor: null });
  assert.deepEqual(readRecordsPage(text, { offset: 2, limit: 1 }), { records: [records[2]], undated_excluded: 0, next_cursor: null });
  assert.deepEqual(readRecordsPage(text, { offset: 100 }), { records: [], undated_excluded: 0, next_cursor: null });
  assert.deepEqual(readRecordsPage(`{"schema":"${schema}","records":[null],"records":[]}`), { records: [], undated_excluded: 0, next_cursor: null });
});
