// Unit tests (real packages/core/src/ bundle, every migration on node:sqlite, no server): the cron's retention deletes
// (cleanup.js pruneExpiredRows: expired sessions, idempotency records past 30 days, audits past AUDIT_RETENTION_DAYS,
// bounded per run), the per-address sign-in email limit (identity/browser.js limitSigninStart) and the UTF-8 byte cap
// on request bodies (util.js readTextCapped). Synthetic rows only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";

const lib = await loadWorker({ "cleanup.js": ["pruneExpiredRows"], "identity/browser.js": ["limitSigninStart"], "util.js": ["readTextCapped"] });
const DAY = 864e5;

function world() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const stmt = (q, p) => ({ async first(c) { const r = db.prepare(q).get(...p); return c ? r?.[c] ?? null : r ?? null; }, async all() { return { results: db.prepare(q).all(...p) }; },
    async run() { return { meta: { changes: Number(db.prepare(q).run(...p).changes) } }; } });
  const DB = { prepare(q) { return { bind: (...p) => stmt(q, p), ...stmt(q, []) }; } };
  db.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_r', 'human', 'synthetic', 'r', 'R', ?)").run(new Date().toISOString());
  return { db, DB, count: (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n };
}
const iso = (ms) => new Date(ms).toISOString();
function seed(w, { old, fresh }) {
  const now = Date.now();
  const s = w.db.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, 'hum_r', 'c', ?)");
  const i = w.db.prepare("INSERT INTO idempotency (principal_id, project_id, op, key, digest, status, response, created_at) VALUES ('hum_r', 'p', 'op', ?, 'd', 201, '{}', ?)");
  const a = w.db.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, 'hum_r', NULL, 'synthetic', NULL, 'ok', 'req')");
  for (let n = 0; n < old; n++) { s.run(`old${n}`, now - DAY - n); i.run(`old${n}`, iso(now - 31 * DAY - n)); a.run(iso(now - 366 * DAY - n)); }
  for (let n = 0; n < fresh; n++) { s.run(`new${n}`, now + DAY); i.run(`new${n}`, iso(now - 29 * DAY)); a.run(iso(now - 364 * DAY)); }
}

test("retention: expired sessions, idempotency past 30 days and audits past 365 days go; newer rows stay", async () => {
  const w = world();
  seed(w, { old: 7, fresh: 3 });
  const r = await lib.pruneExpiredRows({ DB: w.DB });
  assert.deepEqual(r, { sessions: 7, idempotency: 7, audits: 7 });
  assert.deepEqual([w.count("sessions"), w.count("idempotency"), w.count("audits")], [3, 3, 3]);
  assert.deepEqual(await lib.pruneExpiredRows({ DB: w.DB }), { sessions: 0, idempotency: 0, audits: 0 }, "idempotent");
});

test("retention: bounded per run (oldest first), and a full batch is logged", async () => {
  const w = world();
  seed(w, { old: 12, fresh: 2 });
  const warn = [], orig = console.warn;
  console.warn = (m) => warn.push(JSON.parse(m));
  try {
    assert.deepEqual(await lib.pruneExpiredRows({ DB: w.DB }, { batch: 5 }), { sessions: 5, idempotency: 5, audits: 5 });
    assert.deepEqual(warn.map((x) => x.table).sort(), ["audits", "idempotency", "sessions"]);
    assert.deepEqual(warn[0], { event: "retention_cleanup_batch_full", table: "sessions", deleted: 5, limit: 5 });
    // The oldest went first (largest n = oldest in seed()).
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id_hash IN ('old11','old10','old9','old8','old7')").get().n, 0);
    await lib.pruneExpiredRows({ DB: w.DB }, { batch: 5 });
    assert.deepEqual(await lib.pruneExpiredRows({ DB: w.DB }, { batch: 5 }), { sessions: 2, idempotency: 2, audits: 2 });
  } finally { console.warn = orig; }
  assert.deepEqual([w.count("sessions"), w.count("idempotency"), w.count("audits")], [2, 2, 2]);
});

test("retention: AUDIT_RETENTION_DAYS sets the audit window; \"0\" keeps audits forever", async () => {
  const w = world();
  seed(w, { old: 2, fresh: 2 }); // audits at 366+ and 364 days old
  assert.equal((await lib.pruneExpiredRows({ DB: w.DB, AUDIT_RETENTION_DAYS: "0" })).audits, 0);
  assert.equal(w.count("audits"), 4);
  assert.equal((await lib.pruneExpiredRows({ DB: w.DB, AUDIT_RETENTION_DAYS: "100" })).audits, 4);
});

test("retention deletes use their indexes (migration 0026), not full scans", () => {
  const w = world();
  for (const [t, c] of [["sessions", "expires_at"], ["idempotency", "created_at"], ["audits", "at"]]) {
    const plan = w.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM ${t} WHERE ${c} < ? ORDER BY ${c} LIMIT 5`).all(1).map((r) => r.detail).join(" | ");
    assert.match(plan, /USING (COVERING )?INDEX/, `${t}: ${plan}`);
  }
});

test("sign-in emails per address: RATE_SIGNIN_EMAIL_PER_ADDRESS_PER_MIN (default 2) × OAUTH_RATE_MULTIPLIER, not capped by the per-IP limit", async () => {
  const req = (ip) => new Request("https://example.test/auth/signin", { headers: { "cf-connecting-ip": ip } });
  let net = 0; // a fresh range of synthetic IPs per scenario, so per-IP counters never carry over
  const count = async (env, email) => {
    let ok = 0;
    net++;
    for (let i = 0; i < 20; i++) {
      try { await lib.limitSigninStart(env, req(`198.51.${net}.${i}`), email); ok++; } catch (e) { assert.equal(e.status, 429); }
    }
    return ok;
  };
  const w = world();
  assert.equal(await count({ DB: w.DB }, "a@example.test"), 2, "default 2 per address");
  assert.equal(await count({ DB: w.DB, OAUTH_RATE_MULTIPLIER: "3" }, "b@example.test"), 6, "2 × multiplier 3");
  // Per-address above the per-IP email limit: the per-IP limit no longer lowers it (each try comes from a new IP).
  assert.equal(await count({ DB: w.DB, RATE_SIGNIN_EMAIL_PER_ADDRESS_PER_MIN: "7", RATE_SIGNIN_EMAIL_PER_MIN: "1" }, "c@example.test"), 7);
  assert.equal(await count({ DB: w.DB, RATE_SIGNIN_EMAIL_PER_ADDRESS_PER_MIN: "4", OAUTH_RATE_MULTIPLIER: "2" }, "d@example.test"), 8);
});

test("request bodies are capped in UTF-8 bytes: Content-Length first, then the counted stream", async () => {
  const cap = 1000;
  const euro = "€".repeat(400); // 400 characters, 1200 bytes
  assert.equal(await lib.readTextCapped(new Request("https://example.test/", { method: "POST", body: euro }), cap), null, "over by bytes, under by characters");
  assert.equal(await lib.readTextCapped(new Request("https://example.test/", { method: "POST", body: "€".repeat(333) }), cap), "€".repeat(333));
  const stream = (s) => new ReadableStream({ start(c) { const b = new TextEncoder().encode(s); c.enqueue(b.slice(0, 500)); c.enqueue(b.slice(500)); c.close(); } });
  assert.equal(await lib.readTextCapped(new Request("https://example.test/", { method: "POST", body: stream(euro), duplex: "half" }), cap), null, "no Content-Length: counted as it streams");
  assert.equal(await lib.readTextCapped(new Request("https://example.test/", { method: "POST", body: stream("€".repeat(300)), duplex: "half" }), cap), "€".repeat(300), "multi-byte characters split across chunks decode");
  const lying = new Request("https://example.test/", { method: "POST", body: "x".repeat(10), headers: { "content-length": String(cap + 1) } });
  assert.equal(await lib.readTextCapped(lying, cap), null, "a declared length over the cap is refused before reading");
  assert.equal(await lib.readTextCapped(new Request("https://example.test/", { method: "POST" }), cap), "");
});
