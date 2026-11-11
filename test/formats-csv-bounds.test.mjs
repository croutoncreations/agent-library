import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFile, parseCsv, spreadsheetSafeCsv, CSV_CELL_CHUNK_CHARS } from "../packages/core/src/formats.js";

const header = count => Array.from({ length: count }, (_, i) => `c${i}`).join(",");
const exactError = (line, detail) => e => {
  assert.deepEqual({ status: e.status, code: e.code, format: e.extra.format, line: e.extra.line, detail: e.extra.detail },
    { status: 422, code: "invalid_content", format: "csv", line, detail });
  return true;
};
test("CSV column limit: boundary, syntax precedence, header precedence and legacy export refusal", () => {
  const at = header(16384), over = header(16385);
  assert.equal(checkFile("csv", at).row_count, 0);
  assert.equal(parseCsv(at).header.length, 16384);
  assert.equal(spreadsheetSafeCsv(at).length, at.length + 2);
  for (const fn of [t => checkFile("csv", t), parseCsv, spreadsheetSafeCsv, t => spreadsheetSafeCsv(t, { headOnly: true })]) {
    for (const text of [over, over.replace("c1,", "c0,"), over.replace("c1,", ",")]) {
      assert.throws(() => fn(text), exactError(1, "more than 16384 columns"));
    }
    assert.throws(() => fn(over + '\n"open'), exactError(2, "unterminated quoted field"));
  }
});

test("CSV exports retain common checks for legacy or imported content, including HEAD", () => {
  for (const [text, detail] of [["\ufeffh", "byte order mark not allowed"], ["h\n\ud800", "invalid UTF-16 surrogate (not encodable as UTF-8)"]]) {
    for (const headOnly of [false, true]) assert.throws(() => spreadsheetSafeCsv(text, { headOnly }), exactError(undefined, detail));
  }
});

test("CSV escaped quote chunks preserve pair parity and astral boundaries exactly", () => {
  const size = CSV_CELL_CHUNK_CHARS;
  const values = [
    ...[-1, 0, 1].map(delta => "a".repeat(size + delta) + '"tail'),
    '"'.repeat(size * 3),
    "a".repeat(size - 1) + '🙂"end',
    "a".repeat(size - 3) + '"'.repeat(size * 2 + 1) + "\nend"
  ];
  for (const value of values) {
    const encoded = '"' + value.replace(/"/g, '""') + '"';
    const text = "h\n" + encoded;
    assert.deepEqual(parseCsv(text).rows[0].cells, [value]);
    assert.equal(checkFile("csv", text).row_count, 1);
    const bytes = new TextEncoder().encode("h\r\n" + encoded + "\r\n");
    assert.deepEqual(spreadsheetSafeCsv(text), bytes);
    assert.deepEqual(spreadsheetSafeCsv(text, { headOnly: true }), { length: bytes.length });
  }
});
