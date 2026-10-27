// Deterministic synthetic measurements (agentlib.measurements/1). Fake values only. recorded_at covers the
// timestamp shapes a source app may use (offset, Z, epoch ms, offset-less local); `date` is included only on
// some records, as a source-provided field. Nothing here derives a date from recorded_at.
export function synthMeasurements(n, { seed = 1 } = {}) {
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const shapes = [
    (i) => ({ recorded_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T07:${String(10 + (i % 50)).padStart(2, "0")}:00-07:00`, date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}` }),
    (i) => ({ recorded_at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T14:00:00Z` }),
    (i) => ({ recorded_at: String(1693552440000 + i * 86_400_000) }),
    (i) => ({ recorded_at: `2026-07-${String((i % 28) + 1).padStart(2, "0")} 06:30`, date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}` }),
  ];
  return Array.from({ length: n }, (_, i) => ({
    id: `syn-${seed}-${i}`,
    ...shapes[i % shapes.length](i),
    metric: i % 3 === 2 ? "waist_cm" : "weight_kg",
    value: Math.round((i % 3 === 2 ? 85 + rnd() * 10 : 70 + rnd() * 15) * 10) / 10,
    unit: i % 3 === 2 ? "cm" : "kg",
    source_id: `synthetic-${seed}-${i}`,
  }));
}

/** CSV derived from the same records (JSON authoritative): fixed column order, CRLF, RFC 4180 quoting. */
export function toCsv(records) {
  const cols = ["id", "recorded_at", "date", "metric", "value", "unit", "source_id"];
  const cell = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(","), ...records.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
