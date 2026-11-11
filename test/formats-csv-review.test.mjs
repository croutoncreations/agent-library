// CSV review characterisation against the shipped module; keep these cases unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFile, parseCsv, spreadsheetSafeCsv } from "../packages/core/src/formats.js";

const M = "agentlib.measurements/1";
const H = "id,recorded_at,date,metric,value,unit,source_id";
function result(fn) {
  try { return fn(); } catch (e) {
    return { status: e.status, code: e.code, format: e.extra?.format, line: e.extra?.line, detail: e.extra?.detail };
  }
}
const error = (format, line, detail) => ({ status: 422, code: "invalid_content", format, line, detail });

test("CSV review: exact structural and measurements precedence", () => {
  const headerDetail = "header must begin with " + H;
  for (const [text, schema, expected] of [
    ["a,a\n1\n", null, error("csv", 1, 'duplicate header "a"')],
    [" ,b\n1,2\n", null, error("csv", 1, "empty header name")],
    ["x".repeat(50) + "," + "x".repeat(50) + "\n", null, error("csv", 1, 'duplicate header "' + "x".repeat(40) + '"')],
    ["a,b\n1\n1,2,3\n", null, error("csv", 2, "expected 2 columns, found 1")],
    ['a,b\n"x\ny",1\nz\n', null, error("csv", 4, "expected 2 columns, found 1")],
    ["id,x\n1,2,3\n", M, error("csv", 2, "expected 2 columns, found 3")],
    ["id,date,recorded_at,metric,value,unit,source_id\nr1,x,,m,no,u,\n", M, error("schema", 1, headerDetail)],
    ["id,x\nr1,2\n", M, error("schema", 1, headerDetail)],
    ["a,b\n1,2\n\n", null, error("csv", 3, "expected 2 columns, found 1")],
    ["", null, error("csv", 1, "header row required")],
    ["a,,b\n1,2,3\n", null, error("csv", 1, "empty header name")],
    ["a,b,a\n1,2\n", null, error("csv", 1, 'duplicate header "a"')]
  ]) {
    assert.deepEqual(result(() => checkFile("csv", text, schema)), expected);
    if (!schema) assert.deepEqual(result(() => parseCsv(text)), expected);
  }
  for (const [text, schema, count] of [[H, M, 0], ["a\n1\n\n", null, 2], ["a,b", null, 0]]) {
    assert.equal(checkFile("csv", text, schema).row_count, count);
    if (!schema) assert.equal(parseCsv(text).rows.length, count);
  }
});

test("CSV review: wide invalid data rows still count all cells and discover later syntax", () => {
  const text = "a\n" + ",".repeat(100000) + "\n";
  for (const fn of [t => checkFile("csv", t), parseCsv]) {
    assert.deepEqual(result(() => fn(text)), error("csv", 2, "expected 1 columns, found 100001"));
    assert.deepEqual(result(() => fn(text + 'bad"')), error("csv", 3, "quote inside unquoted field"));
  }
});

test("CSV review: escaped quote runs preserve parsed values and exact export bytes", () => {
  for (const value of ['"'.repeat(100000), '"start', 'end"', '"both"', '"\nfirst"\r\nlast"\n']) {
    const encoded = '"' + value.replace(/"/g, '""') + '"';
    const text = "h\n" + encoded;
    assert.deepEqual(parseCsv(text), { header: ["h"], rows: [{ line: 2, cells: [value] }] });
    assert.equal(checkFile("csv", text).row_count, 1);
    assert.deepEqual(spreadsheetSafeCsv(text), new TextEncoder().encode("h\r\n" + encoded + "\r\n"));
  }
});
