import { TEXT_MAX_BYTES } from "./text-limits.js";
import { HttpError } from "./util.js";

function isCalendarDate(v) {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const leap = y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}
function byteLength(s) {
  return new TextEncoder().encode(s).length;
}
function checkCommon(text, format, file) {
  if (typeof text !== "string") throw new HttpError(400, "invalid_input", "content must be a string");
  if (byteLength(text) > MAX_FILE_BYTES) throw new HttpError(413, "too_large", `${format} file exceeds 10 MiB`, file ? { file } : void 0);
  if (text.charCodeAt(0) === 65279) throw invalid({ format, file, detail: "byte order mark not allowed" });
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) throw invalid({ format, file, detail: "invalid UTF-16 surrogate (not encodable as UTF-8)" });
}
function depthOk(text) {
  let depth = 0, inStr = false, esc4 = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc4) esc4 = false;
      else if (c === "\\") esc4 = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") {
      if (++depth > MAX_DEPTH) return false;
    } else if (c === "}" || c === "]") depth--;
  }
  return true;
}
function parseJson(text, file) {
  checkCommon(text, "json", file);
  if (!depthOk(text)) throw invalid({ format: "json", file, detail: `nesting deeper than ${MAX_DEPTH} levels` });
  try {
    return JSON.parse(text);
  } catch (e) {
    throw invalid({ format: "json", file, detail: "not valid JSON" });
  }
}
function parseCsv(text, file) {
  checkCommon(text, "csv", file);
  const rows = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    const cells = [];
    for (; ; ) {
      let cell = "";
      if (text[i] === '"') {
        i++;
        for (; ; ) {
          if (i >= n) throw invalid({ format: "csv", file, line: startLine, detail: "unterminated quoted field" });
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (c === "\n") line++;
          cell += c;
          i++;
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
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "\r") {
        if (text[i + 1] !== "\n") throw invalid({ format: "csv", file, line, detail: "bare CR line ending" });
        i += 2;
        line++;
        break;
      }
      if (text[i] === "\n") {
        i++;
        line++;
        break;
      }
    }
    rows.push({ line: startLine, cells });
  }
  if (!rows.length) throw invalid({ format: "csv", file, line: 1, detail: "header row required" });
  const header = rows.shift().cells;
  const seen = /* @__PURE__ */ new Set();
  for (const h of header) {
    if (!h.trim()) throw invalid({ format: "csv", file, line: 1, detail: "empty header name" });
    if (seen.has(h)) throw invalid({ format: "csv", file, line: 1, detail: `duplicate header "${h.slice(0, 40)}"` });
    seen.add(h);
  }
  for (const r of rows) if (r.cells.length !== header.length)
    throw invalid({ format: "csv", file, line: r.line, detail: `expected ${header.length} columns, found ${r.cells.length}` });
  return { header, rows };
}
function strField(v, min, max) {
  return typeof v === "string" && v.length >= min && v.length <= max;
}
function checkMeasurementsJson(doc, file) {
  const bad = (path, detail) => invalid({ format: "schema", file, path, detail });
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw bad("$", "top level must be an object");
  for (const k of Object.keys(doc)) if (!["schema", "records", "meta"].includes(k)) throw bad(k, "unexpected top-level key");
  if (doc.schema !== MEASUREMENTS) throw bad("schema", `must be "${MEASUREMENTS}"`);
  if (doc.meta !== void 0 && (typeof doc.meta !== "object" || doc.meta === null || Array.isArray(doc.meta))) throw bad("meta", "must be an object");
  if (!Array.isArray(doc.records)) throw bad("records", "must be an array");
  if (doc.records.length > MAX_RECORDS) throw bad("records", `more than ${MAX_RECORDS} records`);
  const ids = /* @__PURE__ */ new Set();
  doc.records.forEach((r, i) => {
    const p = `records[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw bad(p, "must be an object");
    if (!strField(r.id, 1, 128)) throw bad(`${p}.id`, "string of 1-128 chars required");
    if (ids.has(r.id)) throw bad(`${p}.id`, "duplicate id");
    ids.add(r.id);
    if (!strField(r.recorded_at, 1, 64)) throw bad(`${p}.recorded_at`, "source timestamp string of 1-64 chars required");
    if (r.date !== void 0 && !isCalendarDate(r.date)) throw bad(`${p}.date`, "must be a real calendar date YYYY-MM-DD when present");
    if (!(typeof r.metric === "string" && METRIC_RE.test(r.metric))) throw bad(`${p}.metric`, "must match [a-z][a-z0-9_]{0,39}");
    if (!(typeof r.value === "number" && Number.isFinite(r.value))) throw bad(`${p}.value`, "finite number required");
    if (!strField(r.unit, 1, 16)) throw bad(`${p}.unit`, "string of 1-16 chars required");
    if (r.source_id !== void 0 && !strField(r.source_id, 0, 128)) throw bad(`${p}.source_id`, "string of at most 128 chars");
  });
  return doc.records.length;
}
function checkMeasurementsCsv(csv, file) {
  const bad = (line, detail) => invalid({ format: "schema", file, line, detail });
  CSV_MEASUREMENT_COLUMNS.forEach((c, i) => {
    if (csv.header[i] !== c) throw bad(1, `header must begin with ${CSV_MEASUREMENT_COLUMNS.join(",")}`);
  });
  const ids = /* @__PURE__ */ new Set();
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
function checkFile(kind, content, schema, file) {
  if (kind !== "json" && kind !== "csv") throw new HttpError(422, "unsupported_kind", "kind must be json or csv");
  if (typeof content !== "string") throw new HttpError(400, "invalid_input", "content must be a string");
  const sch = schema === void 0 || schema === null ? null : String(schema);
  if (sch !== null && !SCHEMAS.has(sch)) throw new HttpError(400, "invalid_input", `unknown schema (supported: ${[...SCHEMAS].join(", ")})`);
  if (kind === "json") {
    const doc = parseJson(content, file);
    return { kind, schema: sch, record_count: sch ? checkMeasurementsJson(doc, file) : null, row_count: null };
  }
  const csv = parseCsv(content, file);
  if (sch) checkMeasurementsCsv(csv, file);
  return { kind, schema: sch, record_count: null, row_count: csv.rows.length };
}
function spreadsheetSafeCsv(text) {
  const { header, rows } = parseCsv(text);
  const cell = (v) => {
    const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows.map((r) => r.cells)].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
var MEASUREMENTS, SCHEMAS, MAX_FILE_BYTES, CSV_MEASUREMENT_COLUMNS, MAX_RECORDS, MAX_DEPTH, DATE_RE, METRIC_RE, NUM_RE, invalid, MIME, CONTENT_TYPE;
MEASUREMENTS = "agentlib.measurements/1";
SCHEMAS = /* @__PURE__ */ new Set([MEASUREMENTS]);
MAX_FILE_BYTES = TEXT_MAX_BYTES;
CSV_MEASUREMENT_COLUMNS = ["id", "recorded_at", "date", "metric", "value", "unit", "source_id"];
MAX_RECORDS = 1e5;
MAX_DEPTH = 64;
DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
METRIC_RE = /^[a-z][a-z0-9_]{0,39}$/;
NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
invalid = (x) => new HttpError(422, "invalid_content", `Invalid ${x.format}: ${x.detail}`, x);
MIME = { json: "application/json", csv: "text/csv" };
CONTENT_TYPE = {
  "application/json": "application/json; charset=utf-8",
  "text/csv": "text/csv; charset=utf-8; header=present",
  "text/markdown": "text/plain; charset=utf-8",
  // HTML source is served as plain text (download); it renders only through the sandboxed /render route.
  "text/html": "text/plain; charset=utf-8"
};

export { CONTENT_TYPE, MEASUREMENTS, MIME, byteLength, checkFile, isCalendarDate, parseCsv, spreadsheetSafeCsv };
