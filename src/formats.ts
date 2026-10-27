// JSON / CSV validation and the agentlib.measurements/1 schema (contract app-connect §3).
// Content is stored byte-exact; nothing here rewrites stored bytes. Source timestamps (`recorded_at`) are
// never parsed or converted; `date` is never derived.
import { HttpError } from "./util";

export const MEASUREMENTS = "agentlib.measurements/1";
export const SCHEMAS = new Set([MEASUREMENTS]);
export const MAX_FILE_BYTES = 1024 * 1024;
export const CSV_MEASUREMENT_COLUMNS = ["id", "recorded_at", "date", "metric", "value", "unit", "source_id"];
const MAX_RECORDS = 100_000;
const MAX_DEPTH = 64;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/**
 * Source-provided calendar date check (proleptic Gregorian, years 0000-9999): format AND day-in-month,
 * including leap years. Applies ONLY to the optional `date` field; `recorded_at` is never parsed and no
 * date is ever derived.
 */
export function isCalendarDate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}
const METRIC_RE = /^[a-z][a-z0-9_]{0,39}$/;
const NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export type InvalidExtra = { format: "json" | "csv" | "schema"; file?: string; line?: number; path?: string; detail: string };
export const invalid = (x: InvalidExtra) => new HttpError(422, "invalid_content", `Invalid ${x.format}: ${x.detail}`, x);

export function byteLength(s: string) { return new TextEncoder().encode(s).length; }

function checkCommon(text: string, format: "json" | "csv", file?: string) {
  if (typeof text !== "string") throw new HttpError(400, "invalid_input", "content must be a string");
  if (byteLength(text) > MAX_FILE_BYTES) throw new HttpError(413, "too_large", `${format} file exceeds 1 MiB`, file ? { file } : undefined);
  if (text.charCodeAt(0) === 0xfeff) throw invalid({ format, file, detail: "byte order mark not allowed" });
  // Lone surrogates cannot be encoded as UTF-8 faithfully.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) throw invalid({ format, file, detail: "invalid UTF-16 surrogate (not encodable as UTF-8)" });
}

function depthOk(text: string): boolean {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") { if (++depth > MAX_DEPTH) return false; }
    else if (c === "}" || c === "]") depth--;
  }
  return true;
}

export function parseJson(text: string, file?: string): unknown {
  checkCommon(text, "json", file);
  if (!depthOk(text)) throw invalid({ format: "json", file, detail: `nesting deeper than ${MAX_DEPTH} levels` });
  try { return JSON.parse(text); } catch (e) { throw invalid({ format: "json", file, detail: "not valid JSON" }); }
}

/** RFC 4180 parse (comma, CRLF or LF, quoted fields). Returns rows with the 1-based line each starts on. */
export function parseCsv(text: string, file?: string): { header: string[]; rows: { line: number; cells: string[] }[] } {
  checkCommon(text, "csv", file);
  const rows: { line: number; cells: string[] }[] = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    const cells: string[] = [];
    for (;;) {
      let cell = "";
      if (text[i] === '"') {
        i++;
        for (;;) {
          if (i >= n) throw invalid({ format: "csv", file, line: startLine, detail: "unterminated quoted field" });
          const c = text[i];
          if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } i++; break; }
          if (c === "\n") line++;
          cell += c; i++;
        }
        if (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") throw invalid({ format: "csv", file, line, detail: "unexpected character after closing quote" });
      } else {
        while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          if (text[i] === '"') throw invalid({ format: "csv", file, line, detail: "quote inside unquoted field" });
          cell += text[i++];
        }
      }
      cells.push(cell);
      if (i >= n) break;
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "\r") { if (text[i + 1] !== "\n") throw invalid({ format: "csv", file, line, detail: "bare CR line ending" }); i += 2; line++; break; }
      if (text[i] === "\n") { i++; line++; break; }
    }
    rows.push({ line: startLine, cells });
  }
  if (!rows.length) throw invalid({ format: "csv", file, line: 1, detail: "header row required" });
  const header = rows.shift()!.cells;
  const seen = new Set<string>();
  for (const h of header) {
    if (!h.trim()) throw invalid({ format: "csv", file, line: 1, detail: "empty header name" });
    if (seen.has(h)) throw invalid({ format: "csv", file, line: 1, detail: `duplicate header "${h.slice(0, 40)}"` });
    seen.add(h);
  }
  for (const r of rows) if (r.cells.length !== header.length)
    throw invalid({ format: "csv", file, line: r.line, detail: `expected ${header.length} columns, found ${r.cells.length}` });
  return { header, rows };
}

function strField(v: unknown, min: number, max: number) { return typeof v === "string" && v.length >= min && v.length <= max; }

/** Validates agentlib.measurements/1 JSON. Returns the record count. Records are never modified. */
export function checkMeasurementsJson(doc: any, file?: string): number {
  const bad = (path: string, detail: string) => invalid({ format: "schema", file, path, detail });
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw bad("$", "top level must be an object");
  for (const k of Object.keys(doc)) if (!["schema", "records", "meta"].includes(k)) throw bad(k, "unexpected top-level key");
  if (doc.schema !== MEASUREMENTS) throw bad("schema", `must be "${MEASUREMENTS}"`);
  if (doc.meta !== undefined && (typeof doc.meta !== "object" || doc.meta === null || Array.isArray(doc.meta))) throw bad("meta", "must be an object");
  if (!Array.isArray(doc.records)) throw bad("records", "must be an array");
  if (doc.records.length > MAX_RECORDS) throw bad("records", `more than ${MAX_RECORDS} records`);
  const ids = new Set<string>();
  doc.records.forEach((r: any, i: number) => {
    const p = `records[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw bad(p, "must be an object");
    if (!strField(r.id, 1, 128)) throw bad(`${p}.id`, "string of 1-128 chars required");
    if (ids.has(r.id)) throw bad(`${p}.id`, "duplicate id");
    ids.add(r.id);
    if (!strField(r.recorded_at, 1, 64)) throw bad(`${p}.recorded_at`, "source timestamp string of 1-64 chars required");
    if (r.date !== undefined && !isCalendarDate(r.date)) throw bad(`${p}.date`, "must be a real calendar date YYYY-MM-DD when present");
    if (!(typeof r.metric === "string" && METRIC_RE.test(r.metric))) throw bad(`${p}.metric`, "must match [a-z][a-z0-9_]{0,39}");
    if (!(typeof r.value === "number" && Number.isFinite(r.value))) throw bad(`${p}.value`, "finite number required");
    if (!strField(r.unit, 1, 16)) throw bad(`${p}.unit`, "string of 1-16 chars required");
    if (r.source_id !== undefined && !strField(r.source_id, 0, 128)) throw bad(`${p}.source_id`, "string of at most 128 chars");
  });
  return doc.records.length;
}

/** Validates the CSV form of agentlib.measurements/1. Returns the data row count. */
export function checkMeasurementsCsv(csv: { header: string[]; rows: { line: number; cells: string[] }[] }, file?: string): number {
  const bad = (line: number, detail: string) => invalid({ format: "schema", file, line, detail });
  CSV_MEASUREMENT_COLUMNS.forEach((c, i) => {
    if (csv.header[i] !== c) throw bad(1, `header must begin with ${CSV_MEASUREMENT_COLUMNS.join(",")}`);
  });
  const ids = new Set<string>();
  for (const r of csv.rows) {
    const [id, recordedAt, date, metric, value, unit, sourceId] = r.cells;
    if (!(id.length >= 1 && id.length <= 128)) throw bad(r.line, "id must be 1-128 chars");
    if (ids.has(id)) throw bad(r.line, "duplicate id");
    ids.add(id);
    if (!(recordedAt.length >= 1 && recordedAt.length <= 64)) throw bad(r.line, "recorded_at must be 1-64 chars");
    if (date !== "" && !isCalendarDate(date)) throw bad(r.line, "date must be empty or a real calendar date YYYY-MM-DD");
    if (!METRIC_RE.test(metric)) throw bad(r.line, "metric must match [a-z][a-z0-9_]{0,39}");
    if (!NUM_RE.test(value) || !Number.isFinite(Number(value))) throw bad(r.line, "value must be a finite decimal number");
    if (!(unit.length >= 1 && unit.length <= 16)) throw bad(r.line, "unit must be 1-16 chars");
    if (sourceId.length > 128) throw bad(r.line, "source_id must be at most 128 chars");
  }
  return csv.rows.length;
}

export type Checked = { kind: "json" | "csv"; schema: string | null; record_count: number | null; row_count: number | null };

/** Validate one file of kind json|csv with an optional registered schema. */
export function checkFile(kind: string, content: unknown, schema: unknown, file?: string): Checked {
  if (kind !== "json" && kind !== "csv") throw new HttpError(422, "unsupported_kind", "kind must be json or csv");
  if (typeof content !== "string") throw new HttpError(400, "invalid_input", "content must be a string");
  const sch = schema === undefined || schema === null ? null : String(schema);
  if (sch !== null && !SCHEMAS.has(sch)) throw new HttpError(400, "invalid_input", `unknown schema (supported: ${[...SCHEMAS].join(", ")})`);
  if (kind === "json") {
    const doc = parseJson(content, file);
    return { kind, schema: sch, record_count: sch ? checkMeasurementsJson(doc, file) : null, row_count: null };
  }
  const csv = parseCsv(content, file);
  if (sch) checkMeasurementsCsv(csv, file);
  return { kind, schema: sch, record_count: null, row_count: csv.rows.length };
}

/** Spreadsheet-safe CSV download (never stored): prefix ' to cells starting with = + - @ TAB CR. */
export function spreadsheetSafeCsv(text: string): string {
  const { header, rows } = parseCsv(text);
  const cell = (v: string) => {
    const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows.map((r) => r.cells)].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export const MIME: Record<string, string> = { json: "application/json", csv: "text/csv" };
export const CONTENT_TYPE: Record<string, string> = {
  "application/json": "application/json; charset=utf-8",
  "text/csv": "text/csv; charset=utf-8; header=present",
  "text/markdown": "text/plain; charset=utf-8",
};
