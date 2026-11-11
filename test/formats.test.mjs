// Pure-format checks for packages/core/src/formats.js (no server), loaded from the shipped source.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { moduleScript } from "./module-source.mjs";
import { TEXT_MAX_BYTES } from "../packages/core/src/text-limits.js";
import { HttpError } from "../packages/core/src/util.js";



import { loadWorker } from "./load-worker.mjs";

let F;
before(async () => { F = await loadWorker({ "formats.js": ["checkFile", "parseCsv", "spreadsheetSafeCsv", "MEASUREMENTS", "MIME", "byteLength", "isCalendarDate"] }); });
const M = "agentlib.measurements/1";
const rec = (o = {}) => ({ id: "r1", recorded_at: "2026-02-28T23:59:00+14:00", metric: "weight_kg", value: 80, unit: "kg", ...o });
const json = (records) => JSON.stringify({ schema: M, records });
const csv = (rows) => "id,recorded_at,date,metric,value,unit,source_id\n" + rows.join("\n") + "\n";
const code = (fn) => { try { fn(); return "ok"; } catch (e) { return e.code; } };

test("optional source date is calendar-validated (format, day-in-month, leap years)", () => {
  for (const d of ["2026-02-30", "2026-04-31", "2025-02-29", "1900-02-29", "2026-13-01", "2026-00-10", "2026-1-01", "2026-02-00"]) {
    assert.equal(F.isCalendarDate(d), false, d);
    assert.equal(code(() => F.checkFile("json", json([rec({ date: d })]), M)), "invalid_content", `json ${d}`);
    assert.equal(code(() => F.checkFile("csv", csv([`r1,x,${d},weight_kg,80,kg,`]), M)), "invalid_content", `csv ${d}`);
  }
  for (const d of ["2024-02-29", "2000-02-29", "2026-12-31", "2026-04-30", "0001-01-01"]) {
    assert.equal(F.isCalendarDate(d), true, d);
    assert.equal(code(() => F.checkFile("json", json([rec({ date: d })]), M)), "ok", d);
  }
  try { F.checkFile("csv", csv(["r1,x,2026-02-30,weight_kg,80,kg,"]), M); } catch (e) { assert.equal(e.extra.line, 2); }
});

test("recorded_at is never parsed: any 1-64 char string accepted verbatim; date never required or derived", () => {
  for (const ra of ["2026-02-30T07:00", "1693552440000", "yesterday-ish", "2026-03-01T00:30:00+14:00", "2026-03-01 07:14"]) {
    const r = F.checkFile("json", json([rec({ recorded_at: ra })]), M);
    assert.equal(r.record_count, 1, ra);
  }
  assert.equal(code(() => F.checkFile("json", json([rec({ recorded_at: "" })]), M)), "invalid_content");
  assert.equal(code(() => F.checkFile("json", json([rec({ recorded_at: 1693552440000 })]), M)), "invalid_content", "must be a string");
  assert.equal(code(() => F.checkFile("json", json([rec({ recorded_at: "x".repeat(65) })]), M)), "invalid_content");
});

test("CSV structure: header, columns, quoting, BOM, line numbers; measurements header order", () => {
  assert.equal(F.checkFile("csv", 'a,b\r\n"x,1","he said ""hi"""\r\n', null).row_count, 1);
  const err = (t, s = null) => { try { F.checkFile("csv", t, s); return null; } catch (e) { return e; } };
  assert.equal(err("a,a\n1,2\n").extra.detail.startsWith("duplicate header"), true);
  assert.equal(err("a,b\n1\n").extra.line, 2);
  assert.equal(err("\uFEFFa,b\n1,2\n").code, "invalid_content");
  assert.equal(err('a,b\n"open,2\n').code, "invalid_content");
  assert.equal(err("id,date,recorded_at,metric,value,unit,source_id\n", M).extra.line, 1, "header order enforced");
  assert.equal(err(csv(["r1,x,,weight_kg,NaN,kg,"]), M).extra.line, 2);
  assert.equal(F.checkFile("csv", csv(["r1,1693552440000,,weight_kg,80.1,kg,", "r2,2024-02-29T08:00:00-08:00,2024-02-29,waist_cm,-1e2,cm,s"]), M).row_count, 2);
});

test("measurements JSON exact pre-streaming characterisation", () => {
  const good = JSON.stringify(rec());
  const bad = (path, detail, format = "schema") => ({ status: 422, code: "invalid_content", format, path, detail });
  const cases = [
    [json([]), 0], [json([rec()]), 1],
    ...["null", "[]", "1", '"x"', "true"].map(t => [t, bad("$", "top level must be an object")]),
    ['{"extra":0}', bad("extra", "unexpected top-level key")],
    ['{}', bad("schema", `must be "${M}"`)],
    ...["null", "[]", "1", '"x"', "true", "false"].map(t => [`{"schema":"${M}","meta":${t},"records":[]}`, bad("meta", "must be an object")]),
    [`{"schema":"${M}","meta":{},"records":[]}`, 0],
    ...["null", "{}", "1", '"x"', "true"].map(t => [`{"schema":"${M}","records":${t}}`, bad("records", "must be an array")]),
    [`{"schema":"${M}"}`, bad("records", "must be an array")],
    [json(Array.from({ length: 100001 }, () => rec())), bad("records", "more than 100000 records")],
    ...[[], 1, "x", null, true].map(r => [json([r]), bad("records[0]", "must be an object")]),
    ...[[{ id: "" }, "id", "string of 1-128 chars required"],
      [{ recorded_at: "" }, "recorded_at", "source timestamp string of 1-64 chars required"],
      [{ date: "2026-02-30" }, "date", "must be a real calendar date YYYY-MM-DD when present"],
      [{ metric: "Bad" }, "metric", "must match [a-z][a-z0-9_]{0,39}"],
      [{ value: "1" }, "value", "finite number required"],
      [{ unit: "" }, "unit", "string of 1-16 chars required"],
      [{ source_id: 1 }, "source_id", "string of at most 128 chars"]].map(([patch, field, detail]) => [json([rec(patch)]), bad(`records[0].${field}`, detail)]),
    [json([rec(), rec({ recorded_at: "" })]), bad("records[1].id", "duplicate id")],
    [`{"schema":"${M}","records":[${good.replace('80', '1e400')}]}`, bad("records[0].value", "finite number required")],
    [`{"schema":0,"schema":"${M}","meta":null,"meta":{},"records":0,"records":[${good}]}`, 1],
    [`{"schema":"${M}","schema":0,"records":[]}`, bad("schema", `must be "${M}"`)],
    [`{"schema":"${M}","records":[null],"records":[]}`, 0],
    [`{"schema":"${M}","records":[],"records":[null]}`, bad("records[0]", "must be an object")],
    [`{"schema":"${M}","records":[],"meta":{},"meta":null}`, bad("meta", "must be an object")],
    [JSON.stringify({ schema: M, records: [rec({ extra: '[,]:"\\', nested: { x: [1, {}] } })], meta: {} }, null, 2), 1],
    [` \t{ "sch\\u0065ma" \r:\n "${M}" , "rec\\u006frds" : [ ${good.replace('"id"', '"\\u0069d"')} ] }\r\n`, 1],
    [`{"schema":0,"records":[null],}`, bad(undefined, "not valid JSON", "json")]
  ];
  // Every pair of schema-error classes, with their members in both document orders.
  const classes = [
    ['"extra":0', bad("extra", "unexpected top-level key")],
    ['"schema":0', bad("schema", `must be "${M}"`)],
    ['"meta":null', bad("meta", "must be an object")],
    ['"records":0', bad("records", "must be an array")]
  ];
  for (let i = 0; i < classes.length; i++) for (let j = i + 1; j < classes.length; j++) {
    for (const order of [[i, j], [j, i]]) cases.push([`{"schema":"${M}","records":[],${order.map(k => classes[k][0]).join(",")}}`, classes[i][1]]);
  }
  for (const [text, expected] of cases) {
    let actual;
    try { actual = F.checkFile("json", text, M).record_count; }
    catch (e) { actual = { status: e.status, code: e.code, format: e.extra.format, path: e.extra.path, detail: e.extra.detail }; }
    assert.deepEqual(actual, expected, text.slice(0, 240));
  }
});

test("JSON structure and schema", () => {
  const err = (t, s = M) => { try { F.checkFile("json", t, s); return null; } catch (e) { return e; } };
  assert.equal(err("{").code, "invalid_content");
  assert.equal(err("[".repeat(65) + "]".repeat(65), null).extra.detail.includes("nesting"), true);
  assert.equal(err(JSON.stringify({ schema: M, records: [], extra: 1 })).extra.path, "extra");
  assert.equal(err(json([rec(), rec()])).extra.path, "records[1].id");
  assert.equal(err(json([rec({ value: "80" })])).extra.path, "records[0].value");
  assert.equal(err(json([rec({ metric: "Weight" })])).extra.path, "records[0].metric");
  assert.equal(F.checkFile("json", '{"anything":[1,2,3]}', null).record_count, null, "unschematized JSON allowed");
  assert.equal(F.checkFile("json", json([rec({ extra_field: { nested: true } })]), M).record_count, 1, "extra record keys preserved");
});

test("parseCsv exact characterisation before large-cell allocation optimisation", () => {
  const cases = [
    ["a,b\n1,2\n", { header: ["a", "b"], rows: [{ line: 2, cells: ["1", "2"] }] }],
    ['a\n""""', { header: ["a"], rows: [{ line: 2, cells: ['"'] }] }],
    ['a\n"""x"', { header: ["a"], rows: [{ line: 2, cells: ['"x'] }] }],
    ['a\n"x""y""""z"""', { header: ["a"], rows: [{ line: 2, cells: ['x"y""z"'] }] }],
    ['a,b\n"a""",b', { header: ["a", "b"], rows: [{ line: 2, cells: ['a"', "b"] }] }],
    ["a,b\r\n1,2", { header: ["a", "b"], rows: [{ line: 2, cells: ["1", "2"] }] }],
    ['a,b\n"x,y","line1\nline2"\n', { header: ["a", "b"], rows: [{ line: 2, cells: ["x,y", "line1\nline2"] }] }],
    ['a\n"he said ""hi"""', { header: ["a"], rows: [{ line: 2, cells: ['he said "hi"'] }] }],
    ['a,b\n"",\n', { header: ["a", "b"], rows: [{ line: 2, cells: ["", ""] }] }],
    ["a\n\n", { header: ["a"], rows: [{ line: 2, cells: [""] }] }],
    ["a\n", { header: ["a"], rows: [] }],
    ["a", { header: ["a"], rows: [] }],
    ['a\n"x\ry"', { header: ["a"], rows: [{ line: 2, cells: ["x\ry"] }] }],
    ['a\n"x\r\ny"\nz', { header: ["a"], rows: [{ line: 2, cells: ["x\r\ny"] }, { line: 4, cells: ["z"] }] }],
    ['a,b\né🙂,"漢🙂"', { header: ["a", "b"], rows: [{ line: 2, cells: ["é🙂", "漢🙂"] }] }]
  ];
  for (const [text, expected] of cases) assert.deepEqual(F.parseCsv(text), expected, JSON.stringify(text));
  for (const [text, line, detail] of [
    ["a\rb", 1, "bare CR line ending"],
    ["\ufeffa\n1", undefined, "byte order mark not allowed"],
    ['a\nx"y', 2, "quote inside unquoted field"],
    ['a\n"x', 2, "unterminated quoted field"],
    ['a\n"x"y', 2, "unexpected character after closing quote"],
    ["", 1, "header row required"],
    ["a,a", 1, 'duplicate header "a"'],
    ["a,b\n1", 2, "expected 2 columns, found 1"],
    ["a,b\n1,2,", 2, "expected 2 columns, found 3"],
    ["a,b\n1,2\n\n", 3, "expected 2 columns, found 1"],
    ['a\n"x"\r', 2, "bare CR line ending"],
    ['a\n"x\r\ny"\nz"', 4, "quote inside unquoted field"],
    ['a,a\n"open', 2, "unterminated quoted field"],
    ['a,b\n1\n1,2\n1,2\n"open', 5, "unterminated quoted field"]
  ]) assert.throws(() => F.parseCsv(text), e => e.code === "invalid_content" && e.extra.line === line && e.extra.detail === detail, JSON.stringify(text));
});

test("CSV measurements preserve syntax, header, columns, then schema error precedence", () => {
  for (const [text, format, line, detail] of [
    [csv(["r1,x,,m,no,u,", "r2,x"]), "csv", 3, "expected 7 columns, found 2"],
    [csv(["r1,x,,m,no,u,", '"open']), "csv", 3, "unterminated quoted field"],
    [csv(["r1,x,,m,1,u,", "r2,x,,m,2,u,", "r1,x,,m,3,u,"]), "schema", 4, "duplicate id"],
    [csv(["r1,x,,m,1,u,", "r1,x,,m,2,u,", '"open']), "csv", 4, "unterminated quoted field"]
  ]) assert.throws(() => F.checkFile("csv", text, M, "fixture.csv"), e =>
    e.status === 422 && e.code === "invalid_content" && e.extra.file === "fixture.csv" &&
    e.extra.format === format && e.extra.line === line && e.extra.detail === detail);
});

test("JSON value budget ignores commas, brackets and escaped quotes inside strings", () => {
  const text = JSON.stringify([',{}[]\\"'.repeat(1000000)]);
  assert.equal(F.checkFile("json", text).kind, "json");
});

test("JSON value budget also rejects measurements before schema validation", () => {
  const text = "[" + "0,".repeat(1000000) + "0]";
  assert.throws(() => F.checkFile("json", text, M), e => e.status === 422 && e.code === "invalid_content" && e.extra.format === "json" && e.extra.detail === "more than 1,000,000 values");
});

test("100,000 JSON measurement records with all seven fields use exactly 800,002 budget units", () => {
  const text = json(Array.from({ length: 100000 }, (_, i) => ({ id: i.toString(36), recorded_at: "x", date: "2000-01-01", metric: "m", value: 1, unit: "u", source_id: "" })));
  assert.equal(F.checkFile("json", text, M).record_count, 100000);
  // Execute the maintained module with a smaller budget to pin the scan's exact count.
  const atBudget = new Function("TEXT_MAX_BYTES", "HttpError", moduleScript("packages/core/src/formats.js") + "\nMAX_JSON_VALUES = 800002; return checkFile;")(TEXT_MAX_BYTES, HttpError);
  assert.equal(atBudget("json", text, M).record_count, 100000);
  const belowBudget = new Function("TEXT_MAX_BYTES", "HttpError", moduleScript("packages/core/src/formats.js") + "\nMAX_JSON_VALUES = 800001; return checkFile;")(TEXT_MAX_BYTES, HttpError);
  assert.throws(() => belowBudget("json", text, M), e => e.extra.detail === "more than 800,001 values");
});

test("CSV measurements enforce the documented 100,000-record cap after structure", () => {
  const text = csv(Array.from({ length: 100000 }, (_, i) => `${i},x,,m,1,u,`));
  assert.equal(F.checkFile("csv", text, M).row_count, 100000);
  const over = text + "extra,x,,m,1,u,\n";
  assert.throws(() => F.checkFile("csv", over, M), e => e.status === 422 && e.code === "invalid_content" && e.extra.format === "schema" && e.extra.line === 100002 && e.extra.detail === "more than 100000 records");
  assert.throws(() => F.checkFile("csv", over + '"open', M), e => e.extra.format === "csv" && e.extra.line === 100003 && e.extra.detail === "unterminated quoted field");
  assert.throws(() => F.checkFile("csv", text.replace("0,x,,m,1,u,", "0,x,,m,no,u,") + "extra,x,,m,1,u,\n", M), e => e.extra.line === 2 && e.extra.detail === "value must be a finite decimal number");
  assert.throws(() => F.checkFile("csv", over + "bad,row\n", M), e => e.extra.format === "csv" && e.extra.line === 100003 && e.extra.detail === "expected 7 columns, found 2");
});

test("spreadsheetSafeCsv preserves UTF-8 and doubled quotes across bounded piece edges", () => {
  const value = "x".repeat(16383) + '🙂é漢"' + "x".repeat(16383) + '"🙂';
  const quoted = '"' + value.replace(/"/g, '""') + '"';
  assert.deepEqual(F.parseCsv("h\n" + quoted).rows[0].cells, [value]);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(F.spreadsheetSafeCsv("h\n" + quoted)), "h\r\n" + quoted + "\r\n");
});

test("spreadsheetSafeCsv exact output characterisation", () => {
  for (const [text, expected] of [
    ["a,b\n=1+1,ok\n@x,\"-2\"\n", "a,b\r\n'=1+1,ok\r\n'@x,'-2\r\n"],
    ["a\n=x\n+x\n-x\n@x\n\tx\n\"\rx\"\n", "a\r\n'=x\r\n'+x\r\n'-x\r\n'@x\r\n'\tx\r\n\"'\rx\"\r\n"],
    ['a,b\n"a""b","x,y"\n"x\ny","x\r\ny"\n,\n', 'a,b\r\n"a""b","x,y"\r\n"x\ny","x\r\ny"\r\n,\r\n'],
    ["a\n", "a\r\n"],
    ['"=header"', "'=header\r\n"],
    ["a\n\n", "a\r\n\r\n"]
  ]) {
    const output = F.spreadsheetSafeCsv(text);
    assert.equal(new TextDecoder().decode(output), expected, JSON.stringify(text));
  }
});
