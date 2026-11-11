// D1 over all real migrations; R2 inputs are released on read and outputs counted/discarded, never retained.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { withAdapters, defaultAdapters } from "../packages/core/src/adapters.js";
import { csvFixture, MAX } from "./formats-memory-fixtures.mjs";
import { jsonFixture } from "./formats-json-memory-fixtures.mjs";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = shape => shape === "ascii" ? "x".repeat(MAX) : shape === "two-byte" ? "x".repeat(MAX - 2) + "Ā" : shape === "csv" ? csvFixture("tiny").text : shape === "json" ? jsonFixture("ordinary").text : " ".repeat(MAX - 1) + "{";
export async function runTextUploadMemory(shape, copies) {
  const { uploadBegin, uploadFinish } = await import("../packages/core/src/uploads.js");
  const counts = { reads: 0, writes: 0, written_bytes: 0, bound_bytes: 0 }, peak = { heap: 0, arrayBuffers: 0, external: 0, rss: 0 };
  // Collect at boundaries so ceilings measure retained copies, not variable GC scheduling between equal workloads.
  const sample = () => { global.gc(); const m = process.memoryUsage(); for (const [k, n] of Object.entries({ heap: m.heapUsed, arrayBuffers: m.arrayBuffers, external: m.external, rss: m.rss })) peak[k] = Math.max(peak[k], n); };
  const worlds = [];
  for (let n = 0; n < copies; n++) {
    const sql = new DatabaseSync(":memory:");
    for (const f of readdirSync(root + "/migrations").filter(f => f.endsWith(".sql")).sort()) sql.exec(readFileSync(root + "/migrations/" + f, "utf8"));
    const stmt = (q, p = []) => ({
      async first(c) { sample(); const r = sql.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; },
      async all() { sample(); return { results: sql.prepare(q).all(...p) }; },
      runSync() { sample(); const r = sql.prepare(q).run(...p); return { meta: { changes: Number(r.changes) } }; },
      async run() { return this.runSync(); }
    });
    const DB = { prepare(q) { return { ...stmt(q), bind: (...p) => { counts.bound_bytes += p.reduce((n, v) => n + (typeof v === "string" ? Buffer.byteLength(v) : 8), 0); return stmt(q, p); } }; }, async batch(ss) { sample(); sql.exec("BEGIN"); try { const out = ss.map(s => s.runSync()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
    let raw = new TextEncoder().encode(source(shape));
    const size = raw.byteLength, sha = createHash("sha256").update(raw).digest("hex");
    const digest = Uint8Array.from(Buffer.from(sha, "hex")).buffer;
    const BLOBS = {
      async head() { sample(); return { size, checksums: { sha256: digest } }; },
      async get() { counts.reads++; sample(); return { async arrayBuffer() { const b = raw.buffer; raw = null; sample(); return b; } }; },
      async put(k, bytes) { counts.writes++; counts.written_bytes += bytes.byteLength; sample(); await new Promise(setImmediate); sample(); return { size: bytes.byteLength }; },
      async delete() { sample(); }
    };
    const at = new Date().toISOString();
    sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_memory', 'human', 'synthetic', 'memory', 'Synthetic memory owner', ?)").run(at);
    sql.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES ('prj_memory', 'hum_memory', 'Synthetic memory', ?)").run(at);
    const env = withAdapters({ DB, BLOBS, APP_CONNECT_ENABLED: "1" }, defaultAdapters());
    const ctx = { env, principal: { id: "hum_memory", kind: "human", label: "Synthetic memory owner" }, requestId: "req_memory" };
    const kind = shape === "csv" ? "csv" : shape === "json" || shape === "invalid" ? "json" : "markdown";
    const mime = { markdown: "text/markdown", csv: "text/csv", json: "application/json" }[kind];
    const b = await uploadBegin(ctx, "prj_memory", { title: "Synthetic memory", mime, size, sha256: sha, ...shape === "json" ? { schema: "agentlib.measurements/1" } : {} }, "begin-memory", { allowText: true });
    // Seed the verified input, not an in-memory R2 Map or a second retained copy of the request body.
    sql.prepare("UPDATE uploads SET state = 'received', received_size = ?, received_sha256 = ? WHERE id = ?").run(size, sha, b.body.upload_id);
    worlds.push({ sql, ctx, id: b.body.upload_id });
  }
  sample(); const start = performance.now(), ticker = setInterval(sample, 1);
  const outcomes = await Promise.all(worlds.map(async w => {
    try { const r = await uploadFinish(w.ctx, "prj_memory", w.id, "finish-memory"); return r.status; }
    catch (e) { if (e.code === "invalid_content" || e.code === "text_finish_busy") return e.code; throw e; }
  }));
  clearInterval(ticker); sample();
  if (shape === "invalid") assert.deepEqual(outcomes, ["invalid_content"]);
  else if (copies === 1) assert.deepEqual(outcomes, [200]);
  else assert.ok(outcomes.includes(200));
  const report = { shape, copies, outcomes, ...peak, peak_resident: process.resourceUsage().maxRSS * 1024, wall_ms: Math.round(performance.now() - start), ...counts };
  for (const w of worlds) w.sql.close();
  return report;
}
