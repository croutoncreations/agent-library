// Pure-format checks for src/formats.ts (no server). Strips the TS module's types with the repo's esbuild.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

let F;
before(async () => {
  const dir = join(ROOT, "tmp", "fmt-test");
  mkdirSync(dir, { recursive: true });
  for (const f of ["util", "formats"]) {
    const out = transformSync(readFileSync(join(ROOT, "src", `${f}.ts`), "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
    writeFileSync(join(dir, `${f}.mjs`), out.replace(/from "\.\/util"/g, 'from "./util.mjs"'));
  }
  F = await import(join(dir, "formats.mjs") + "?t=" + Date.now());
});
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

test("spreadsheet-safe export only prefixes risky cells; canonical text untouched", () => {
  const src = "a,b\n=1+1,ok\n@x,\"-2\"\n";
  assert.equal(F.spreadsheetSafeCsv(src), "a,b\r\n'=1+1,ok\r\n'@x,'-2\r\n");
});
