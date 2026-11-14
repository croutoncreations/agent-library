// Unit tests (real packages/core/src/ bundle, no server): the cron's database-size step (cleanup.js recordDbSize,
// migration 0031_db_size_samples.sql, DB_SIZE_WARN_BYTES). Stub D1 handles return meta.size_after; samples go to a real
// SQLite table built from the migration. Synthetic values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";

const GB = 1024 ** 3;

function world(sizeAfter) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(ROOT, "migrations", "0031_db_size_samples.sql"), "utf8"));
  const queries = [];
  const DB = { prepare(q) {
    queries.push(q);
    const run = async (...p) => {
      if (q === "SELECT 1") return { results: [{ 1: 1 }], meta: sizeAfter === undefined ? {} : { size_after: sizeAfter } };
      return { meta: { changes: Number(db.prepare(q).run(...p).changes) } };
    };
    return { bind: (...p) => ({ run: () => run(...p) }), run: () => run() };
  } };
  return { db, DB, queries, samples: () => db.prepare("SELECT day, size_bytes, sampled_at FROM db_size_samples ORDER BY day").all() };
}

// Captures console.log / warn / error as parsed JSON events while fn runs.
async function capture(fn) {
  const out = { log: [], warn: [], error: [] };
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(out)) console[k] = (...a) => out[k].push(JSON.parse(a.join(" ")));
  try { await fn(); } finally { Object.assign(console, orig); }
  return out;
}

const lib = await loadWorker({ "cleanup.js": ["recordDbSize"], "adapters.js": ["defaultAdapters"] });

test("db_size: logs the size from meta.size_after and no warning when DB_SIZE_WARN_BYTES is unset", async () => {
  const w = world(123456);
  const out = await capture(() => lib.recordDbSize({ DB: w.DB }));
  assert.deepEqual(out.log, [{ event: "db_size", size_bytes: 123456 }]);
  assert.deepEqual([out.warn, out.error], [[], []]);
});

test("db_size: under the threshold logs no warning; at and over it logs db_size_warning", async () => {
  let w = world(3 * GB - 1);
  let out = await capture(() => lib.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: String(3 * GB) }));
  assert.deepEqual(out.log, [{ event: "db_size", size_bytes: 3 * GB - 1 }]);
  assert.deepEqual(out.warn, []);

  w = world(3 * GB);
  out = await capture(() => lib.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: String(3 * GB) }));
  assert.deepEqual(out.log, [{ event: "db_size", size_bytes: 3 * GB }]);
  assert.deepEqual(out.warn, [{ event: "db_size_warning", size_bytes: 3 * GB, warn_bytes: 3 * GB }]);

  w = world(5 * GB);
  out = await capture(() => lib.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: String(3 * GB) }));
  assert.deepEqual(out.warn, [{ event: "db_size_warning", size_bytes: 5 * GB, warn_bytes: 3 * GB }]);
});

test("db_size: an absent size logs size_bytes null, never throws, and records no sample or warning", async () => {
  const w = world(undefined);
  const out = await capture(() => lib.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: "1" }));
  assert.deepEqual(out.log, [{ event: "db_size", size_bytes: null }]);
  assert.deepEqual([out.warn, out.error], [[], []]);
  assert.deepEqual(w.samples(), []);
});

test("db_size: an invalid DB_SIZE_WARN_BYTES means no warning and logs one config error (once)", async () => {
  const fresh = await loadWorker({ "cleanup.js": ["recordDbSize"] });
  for (const bad of ["abc", "0", "-5", "1.5", "3GB", "1e9", "NaN", 0, -1, 1.5]) {
    const w = world(10 * GB);
    const out = await capture(async () => { await fresh.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: bad }); await fresh.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: bad }); });
    assert.deepEqual(out.warn, [], `no warning for ${JSON.stringify(bad)}`);
    assert.equal(out.log.length, 2, "db_size is still logged every run");
    assert.ok(out.error.length <= 1, "config error is logged at most once per isolate");
  }
  const again = await loadWorker({ "cleanup.js": ["recordDbSize"] });
  const w = world(10 * GB);
  const out = await capture(async () => { await again.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: "oops" }); await again.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: "oops" }); });
  assert.equal(out.error.length, 1);
  assert.equal(out.error[0].event, "db_size_config_invalid");
  assert.equal(out.error[0].var, "DB_SIZE_WARN_BYTES");
});

test("db_size: unset or empty DB_SIZE_WARN_BYTES is not a config error", async () => {
  const fresh = await loadWorker({ "cleanup.js": ["recordDbSize"] });
  const w = world(1);
  const out = await capture(async () => { await fresh.recordDbSize({ DB: w.DB }); await fresh.recordDbSize({ DB: w.DB, DB_SIZE_WARN_BYTES: "" }); });
  assert.deepEqual([out.warn, out.error], [[], []]);
});

test("db_size: keeps one sample per UTC day and prunes samples older than 400 days", async () => {
  const w = world(1000);
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 401 * 864e5).toISOString().slice(0, 10);
  const edge = new Date(Date.now() - 399 * 864e5).toISOString().slice(0, 10);
  const ins = w.db.prepare("INSERT INTO db_size_samples (day, size_bytes, sampled_at) VALUES (?, ?, ?)");
  ins.run(old, 1, "x"); ins.run(edge, 2, "y");
  await capture(() => lib.recordDbSize({ DB: w.DB }));
  assert.deepEqual(w.samples().map((s) => [s.day, s.size_bytes]), [[edge, 2], [today, 1000]]);
  // A second run on the same day keeps the first sample of the day.
  const later = (sizeAfter) => ({ prepare: (q) => q === "SELECT 1" ? { run: async () => ({ meta: { size_after: sizeAfter } }) } : w.DB.prepare(q) });
  await capture(() => lib.recordDbSize({ DB: later(2000) }));
  assert.deepEqual(w.samples().filter((s) => s.day === today).map((s) => s.size_bytes), [1000]);
});

test("db_size: a failing step logs db_size_failed and resolves (never throws)", async () => {
  const boom = () => { throw new Error("synthetic D1 failure"); };
  for (const DB of [{ prepare: boom }, { prepare: () => ({ run: async () => { throw new Error("synthetic D1 failure"); } }) }]) {
    const out = await capture(() => lib.recordDbSize({ DB }));
    assert.equal(out.error.length, 1);
    assert.equal(out.error[0].event, "db_size_failed");
    assert.match(out.error[0].message, /synthetic D1 failure/);
  }
  // A missing table (migration not yet applied) after a successful measurement is also contained.
  const w = world(5);
  w.db.exec("DROP TABLE db_size_samples");
  const out = await capture(() => lib.recordDbSize({ DB: w.DB }));
  assert.deepEqual(out.log, [{ event: "db_size", size_bytes: 5 }]);
  assert.equal(out.error[0].event, "db_size_failed");
});

test("cron: the database-size step runs alongside the other steps, and its failure does not stop them", async () => {
  const w = world(7 * GB);
  const logs = [], errors = [], waits = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => errors.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
  try {
    const worker = (await loadWorker({ "adapters.js": ["defaultAdapters"] })).default;
    // Every statement except SELECT 1 fails: the other steps reject or log their own failure; the size step still reports.
    const fail = () => { throw new Error("synthetic D1 failure"); };
    const DB = { prepare: (q) => q === "SELECT 1" ? w.DB.prepare(q) : ({ bind: () => ({ run: fail, all: fail, first: fail }), run: fail, all: fail, first: fail }), batch: fail };
    await worker.scheduled({}, { DB, DB_SIZE_WARN_BYTES: String(5 * GB) }, { waitUntil: (p) => waits.push(p) });
    const settled = await Promise.allSettled(waits);
    assert.equal(waits.length, 6, "cleanup, reconcile, retention, project purge, workspace purge, db size");
    assert.ok(logs.some((l) => /"event":"db_size"/.test(l) && /"size_bytes":7516192768/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /"event":"db_size_warning"/.test(l)), logs.join("\n"));
    assert.ok(errors.some((e) => /"event":"retention_failed"/.test(e)), "retention ran and reported its own failure");
    assert.equal(settled[5].status, "fulfilled");

    // And the reverse: the size step fails, every other step still runs to its own outcome.
    waits.length = 0; logs.length = 0; errors.length = 0;
    const DB2 = { prepare: (q) => q === "SELECT 1" ? fail() : ({ bind: () => ({ run: fail, all: fail, first: fail }), run: fail, all: fail, first: fail }), batch: fail };
    await worker.scheduled({}, { DB: DB2 }, { waitUntil: (p) => waits.push(p) });
    const settled2 = await Promise.allSettled(waits);
    assert.ok(errors.some((e) => /"event":"db_size_failed"/.test(e)));
    assert.ok(errors.some((e) => /"event":"retention_failed"/.test(e)));
    assert.equal(settled2[5].status, "fulfilled");
  } finally { Object.assign(console, orig); }
});
