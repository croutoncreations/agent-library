// Upload finalization races (security review 2026-10-23, findings 1 and 3; single-pass uploads, PR2 slice 1). Drives
// the production uploadPut/uploadFinish/reconcileUploads in the in-memory world of upload-world.mjs, so each
// interleaving is scheduled exactly, not hoped for. Since single-pass uploads the only R2 write is the PUT's (to
// final_key); finish reads R2's recorded checksum and the first bytes, then publishes. Synthetic data only.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { P, PNG, lib, world } from "./upload-world.mjs";

// Defaults (cleanup.js / auth.js): UPLOAD_CLEANUP_GRACE_SECONDS 600 and PUT_MARGIN_MS 60 s. A write count on an upload
// that expired longer ago than both is stale: no PUT can still commit (uploadPut's deadline).
const GRACE = 600000, PUT_MARGIN = 60000;

test("finding 1: cleanup racing an expired sealed retry can no longer leave a revision without bytes", async () => {
  const w = world();
  const { id, art } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  // Cleanup runs right before the publication batch, as in the review's reproduction.
  w.hooks.beforeBatch = () => lib.reconcileUploads(w.env);
  const res = await lib.uploadFinish(w.ctx, P, id, "expired-key-1");
  assert.equal(res.status, 200);
  const [rev] = w.revisions(art);
  assert.ok(rev, "published");
  assert.ok(w.blobs.has(rev.blob_key), "published bytes exist");
  assert.equal(w.row(id).state, "published");
  assert.equal(w.row(id).finalize_token, null, "lease released");
});

test("finding 1: cleanup that wins first (lease expired) fails the upload and the late finisher never publishes", async () => {
  const w = world();
  const { id, art } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  // Between finish's checks (its read of the first bytes) and the publication, its lease lapses and cleanup ends the upload.
  w.r2.onGet = async (k) => {
    if (!k.startsWith("blobs/")) return;
    w.r2.onGet = null;
    w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id);
    await lib.reconcileUploads(w.env);
  };
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "late-key-1"), (e) => e.status === 500 && e.code === "finish_abandoned");
  assert.deepEqual(w.revisions(art), [], "no revision");
  assert.deepEqual(w.finals(), [], "no orphaned final object (the finisher removes the unreferenced object)");
  assert.equal(w.row(id).state, "failed");
});

test("finding 1: a live lease protects a sealed upload from cleanup", async () => {
  const w = world();
  const { id } = w.upload({ state: "sealed", expiresAt: Date.now() - 3600000 });
  w.sql.prepare("UPDATE uploads SET finalize_token = 'fin_other', finalize_until = ? WHERE id = ?").run(Date.now() + 60000, id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(id).state, "sealed");
  w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(id).state, "failed", "an expired lease no longer protects it");
  assert.equal(w.row(id).finalize_token, null);
});

test("finding 3: concurrent same-key finishes publish once and leave exactly one final object", async () => {
  const w = world();
  const { id, art } = w.upload();
  // Hold the first finisher inside its R2 read until the second has started.
  let release; const gate = new Promise((r) => (release = r));
  w.r2.onGet = async (k) => { if (k.startsWith("blobs/")) { w.r2.onGet = null; await gate; } };
  const a = lib.uploadFinish(w.ctx, P, id, "same-key-123");
  await new Promise((r) => setTimeout(r, 20));
  const b = lib.uploadFinish(w.ctx, P, id, "same-key-123");
  await new Promise((r) => setTimeout(r, 300));
  release();
  const res = await Promise.all([a, b]);
  assert.deepEqual(res.map((r) => r.status), [200, 200]);
  assert.equal(res[0].body.revision_id, res[1].body.revision_id, "both report the one revision");
  const revs = w.revisions(art);
  assert.equal(revs.length, 1);
  assert.deepEqual(w.finals(), [revs[0].blob_key], "one final object, the published one");
  await lib.reconcileUploads(w.env);
  assert.deepEqual(w.finals(), [revs[0].blob_key]);
});

test("finding 3: a finisher stuck past its lease is taken over without a second object", async () => {
  const w = world();
  const { id, art } = w.upload();
  let release; const gate = new Promise((r) => (release = r));
  w.r2.onGet = async (k) => { if (k.startsWith("blobs/")) { w.r2.onGet = null; await gate; } };
  const slow = lib.uploadFinish(w.ctx, P, id, "slow-key-1");
  await new Promise((r) => setTimeout(r, 20));
  const key = w.row(id).final_key;
  w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id); // lease lapses
  const fresh = await lib.uploadFinish(w.ctx, P, id, "fresh-key-1");
  assert.equal(fresh.status, 200);
  release();
  const late = await slow;
  assert.equal(late.status, 200);
  assert.equal(late.body.revision_id, fresh.body.revision_id, "the stale finisher replays the takeover's result");
  const revs = w.revisions(art);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].blob_key, key, "the final key was fixed at upload begin");
  assert.deepEqual(w.finals(), [key]);
});

test("conflict at publication removes the unpublished object and records the conflict once", async () => {
  const w = world();
  const { id, art } = w.upload();
  w.sql.prepare("UPDATE artifacts SET head_rev = 3 WHERE id = ?").run(art); // base_rev 0 is stale
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "conflict-key-1"), (e) => e.status === 409 && e.code === "revision_conflict");
  assert.deepEqual(w.finals(), []);
  assert.equal(w.row(id).state, "conflict");
  assert.ok(w.row(id).final_purged_at);
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "conflict-key-1"), (e) => e.status === 409 && e.code === "revision_conflict");
});

test("a PUT still in flight when cleanup expires the upload: the object is purged only after the write settles", async () => {
  const w = world();
  const { id, art } = w.upload({ state: "pending" });
  // The PUT's R2 write is in flight; meanwhile the upload expires past the grace (not yet past the PUT deadline, so the
  // count is live) and cleanup fails it. Cleanup must not
  // purge (and stop tracking) the key while the write can still commit.
  w.r2.beforeCommit = async (k) => {
    if (!k.startsWith("blobs/")) return;
    w.r2.beforeCommit = null;
    w.sql.prepare("UPDATE uploads SET expires_at = ? WHERE id = ?").run(Date.now() - GRACE - 30000, id);
    await lib.reconcileUploads(w.env);
    assert.equal(w.row(id).state, "failed");
    assert.equal(w.row(id).final_writes, 1);
    assert.equal(w.row(id).final_purged_at, null, "not purged while a write is in flight");
  };
  await assert.rejects(w.put(id, PNG), (e) => e.status === 410 && e.code === "upload_expired");
  assert.equal(w.row(id).final_writes, 0, "write settled");
  assert.equal(w.row(id).state, "failed");
  // The late write committed; once it settled the PUT itself removed the now-unreferenced object (F5).
  assert.deepEqual(w.finals(), [], "removed once no write was in flight");
  assert.ok(w.row(id).final_purged_at);
  assert.equal(w.quota(), 0);
  await lib.reconcileUploads(w.env);
  assert.deepEqual(w.finals(), []);
  assert.deepEqual(w.revisions(art), []);
});

test("a Worker that dies mid-write leaves the object tracked and counted until the count is stale, never orphaned", async () => {
  const w = world();
  const { id } = w.upload({ state: "sealed", expiresAt: Date.now() - GRACE - 30000 });
  // Simulate termination: a write registered but never settled, object present, lease lapsed.
  const key = "blobs/" + P + "/" + w.row(id).artifact_id + "/rev_synthetic_dead";
  w.sql.prepare("UPDATE uploads SET final_key = ?, final_writes = 1, finalize_token = 'fin_dead', finalize_until = ? WHERE id = ?").run(key, Date.now() - 1, id);
  w.blobs.set(key, PNG);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(id).state, "failed");
  assert.ok(w.blobs.has(key));
  assert.equal(w.row(id).final_purged_at, null, "still tracked by cleanup");
  assert.equal(w.quota(), PNG.length, "still counted against quota");
});

// F1: the PUT owns final_writes; a request that dies never runs its finally. Past the PUT deadline (expires_at +
// PUT_MARGIN_MS) no put can commit, so after the cleanup grace as well the count is stale and the row is purged.
test("a PUT that never settles: past the deadline and grace, reconcile purges the key, releases quota and deletes the placeholder", async (t) => {
  const w = world();
  const { id, art } = w.upload({ state: "pending" });
  // The put stores the object, then hangs forever: the request died and its finally never runs. (Mocked timers, so
  // the PUT's deadline timer never fires either.)
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  w.r2.onPut = () => new Promise(() => {});
  void w.put(id, PNG).catch(() => {});
  for (let i = 0; i < 100 && !w.blobs.has(w.row(id).final_key); i++) await new Promise(setImmediate);
  const key = w.row(id).final_key;
  assert.ok(w.blobs.has(key), "the object was stored");
  assert.deepEqual([w.row(id).state, w.row(id).final_writes], ["receiving", 1]);
  // Inside the deadline plus grace: the count is live, so the object stays tracked and charged.
  w.sql.prepare("UPDATE uploads SET expires_at = ? WHERE id = ?").run(Date.now() - GRACE - PUT_MARGIN + 30000, id);
  await lib.reconcileUploads(w.env);
  assert.deepEqual([w.row(id).state, w.row(id).final_writes, w.row(id).final_purged_at], ["failed", 1, null]);
  assert.ok(w.blobs.has(key));
  assert.equal(w.quota(), PNG.length);
  // Past expires_at + grace + PUT_MARGIN_MS: stale, handled as if no write were in flight.
  w.sql.prepare("UPDATE uploads SET expires_at = ? WHERE id = ?").run(Date.now() - GRACE - PUT_MARGIN - 1000, id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.blobs.has(key), false, "final_key purged");
  assert.deepEqual([w.row(id).final_writes, w.row(id).final_purged_at > 0], [0, true]);
  assert.equal(w.quota(), 0, "quota released");
  // The placeholder goes once the upload expired over a day ago.
  w.sql.prepare("UPDATE uploads SET expires_at = ? WHERE id = ?").run(Date.now() - 2 * 864e5, id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE id = ?").get(art).n, 0, "placeholder deleted");
  assert.equal(w.row(id), undefined);
});

test("a stale write count does not keep an old placeholder alive (purged in the same run)", async () => {
  const w = world();
  const { id, art, finalKey } = w.upload({ state: "failed", expiresAt: Date.now() - 2 * 864e5 });
  w.sql.prepare("UPDATE uploads SET final_writes = 2, staging_purged_at = ? WHERE id = ?").run(Date.now(), id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.blobs.has(finalKey), false);
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE id = ?").get(art).n, 0);
});

test("uploadPut aborts a body still streaming at the deadline: nothing is stored and the write is released", async () => {
  const w = world();
  const { id } = w.upload({ state: "pending" });
  // Ten bytes, then the client stalls. Mocked clock and timers: advance past expires_at + PUT_MARGIN_MS.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(PNG.subarray(0, 10))); } });
    const req = new Request("https://example.test/api/transfers/" + id, { method: "PUT", body, duplex: "half" });
    const p = lib.uploadPut(req, w.env, w.ctx.requestId, id, w.ctx);
    let outcome = null;
    p.then(() => (outcome = "ok"), (e) => (outcome = e));
    for (let i = 0; i < 100 && w.row(id).state !== "receiving"; i++) await new Promise(setImmediate);
    assert.equal(w.row(id).state, "receiving");
    mock.timers.tick(w.row(id).expires_at - Date.now() - 1000);
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    assert.equal(outcome, null, "still streaming before the deadline");
    mock.timers.tick(2000);
    for (let i = 0; i < 100 && outcome === null; i++) await new Promise(setImmediate);
    assert.ok(outcome instanceof Error && outcome.status === 410 && outcome.code === "upload_expired", String(outcome?.message ?? outcome));
  } finally { mock.timers.reset(); }
  assert.deepEqual(w.finals(), [], "nothing stored");
  assert.equal(w.row(id).final_writes, 0, "write released");
});

// F5: a project purge must not delete an upload's rows while its PUT can still write final_key.
const deleteProject = (w) => w.sql.prepare("UPDATE projects SET deleted_at = 1, purge_at = 1 WHERE id = ?").run(P);
const purged = (w) => w.sql.prepare("SELECT purged_at FROM projects WHERE id = ?").get(P).purged_at;

test("a purge during a slow PUT waits for it, then removes its object: nothing untracked is left", async () => {
  const w = world();
  const { id } = w.upload({ state: "pending" });
  w.r2.beforeCommit = async (k) => {
    if (!k.startsWith("blobs/")) return;
    w.r2.beforeCommit = null;
    deleteProject(w);
    await lib.purgeDueProjects(w.env);
    assert.equal(purged(w), null, "the purge waits while the PUT is receiving");
    assert.ok(w.row(id), "upload row kept");
  };
  await w.put(id, PNG).catch(() => {});
  assert.equal(w.row(id).final_writes, 0);
  await lib.purgeDueProjects(w.env);
  assert.ok(purged(w) > 0, "purged once the PUT settled");
  assert.deepEqual([...w.blobs.keys()], [], "no object left");
});

test("a PUT whose upload row was removed mid-write deletes the object it stored", async () => {
  const w = world();
  const { id } = w.upload({ state: "pending" });
  w.r2.beforeCommit = async (k) => { if (k.startsWith("blobs/")) { w.r2.beforeCommit = null; w.sql.prepare("DELETE FROM uploads WHERE id = ?").run(id); } };
  await assert.rejects(w.put(id, PNG), (e) => e.status === 410 && e.code === "upload_expired");
  assert.deepEqual([...w.blobs.keys()], [], "the unreferenced object was removed");
});

test("purge waits for a live write count, but not for a stale one", async () => {
  const w = world();
  const { id } = w.upload({ state: "failed", expiresAt: Date.now() - GRACE - 30000 });
  w.sql.prepare("UPDATE uploads SET final_writes = 1 WHERE id = ?").run(id);
  deleteProject(w);
  await lib.purgeDueProjects(w.env);
  assert.equal(purged(w), null, "a live count holds the purge");
  w.sql.prepare("UPDATE uploads SET expires_at = ? WHERE id = ?").run(Date.now() - GRACE - PUT_MARGIN - 1000, id);
  await lib.purgeDueProjects(w.env);
  assert.ok(purged(w) > 0, "a stale count does not");
  assert.deepEqual([...w.blobs.keys()], []);
});

test("cleanup never deletes a final object a revision references", async () => {
  const w = world();
  const { id, art } = w.upload();
  const res = await lib.uploadFinish(w.ctx, P, id, "published-key-1");
  assert.equal(res.status, 200);
  const [rev] = w.revisions(art);
  // Even if the row were (wrongly) terminal with an old purge mark, a referenced key is kept.
  w.sql.prepare("UPDATE uploads SET state = 'failed' WHERE id = ?").run(id);
  await lib.reconcileUploads(w.env);
  assert.ok(w.blobs.has(rev.blob_key));
});

test("decrement failures preserve the PUT error and retained accounting is visible without private identifiers", async () => {
  const w = world();
  const { id } = w.upload({ state: "pending" });
  w.hooks.beforeRun = (q) => { if (q.includes("final_writes = final_writes - 1")) throw new Error("synthetic decrement failure"); };
  w.r2.beforeCommit = () => { throw new Error("synthetic original PUT failure"); };
  const warnings = [];
  const warn = console.warn;
  console.warn = (s) => warnings.push(JSON.parse(s));
  try {
    await assert.rejects(w.put(id, PNG), /synthetic original PUT failure/);
    assert.equal(w.row(id).final_writes, 1, "failure leaves accounting raised");
    assert.equal(w.row(id).state, "pending");
    w.sql.prepare("UPDATE uploads SET expires_at = ? WHERE id = ?").run(Date.now() - GRACE - 30000, id);
    await lib.reconcileUploads(w.env);
    assert.equal(w.row(id).state, "failed");
    assert.deepEqual(warnings[0], { event: "upload_final_write_release_failed" });
    assert.equal(warnings[1].event, "upload_final_writes_retained");
    assert.equal(warnings[1].count, 1);
    assert.ok(warnings[1].oldest_expiry_age_ms >= GRACE);
    assert.equal(JSON.stringify(warnings).includes(id), false, "warnings contain no upload identifier");
    assert.equal(w.row(id).final_purged_at, null, "still retained until the count is stale");
  } finally { console.warn = warn; }
});

test("a successful PUT with a failed decrement publishes safely and remains visible to reconciliation", async () => {
  const w = world();
  const { id, art } = w.upload({ state: "pending" });
  w.hooks.beforeRun = (q) => { if (q.includes("final_writes = final_writes - 1")) throw new Error("synthetic decrement failure"); };
  const warnings = [];
  const warn = console.warn;
  console.warn = (s) => warnings.push(JSON.parse(s));
  try {
    assert.equal((await w.put(id, PNG)).status, 200);
    assert.equal((await lib.uploadFinish(w.ctx, P, id, "published-release-failure")).status, 200);
    assert.equal(w.row(id).state, "published");
    assert.equal(w.row(id).final_writes, 1);
    assert.equal(w.quota(), 0, "published revision is not double-charged through the upload");
    const [rev] = w.revisions(art);
    await lib.reconcileUploads(w.env);
    assert.ok(w.blobs.has(rev.blob_key), "referenced bytes are never purged");
    assert.deepEqual(warnings[0], { event: "upload_final_write_release_failed" });
    assert.equal(warnings[1].event, "upload_final_writes_retained");
    assert.equal(warnings[1].count, 1, "published outstanding accounting is visible");
  } finally { console.warn = warn; }
});

test("a conflicting takeover replays the conflict to the stalled finisher and never deletes while a write is counted", async () => {
  const w = world();
  const { id, art } = w.upload();
  w.sql.prepare("UPDATE artifacts SET head_rev = 3 WHERE id = ?").run(art); // publication will conflict
  // A PUT whose release failed left final_writes raised (the PUT itself settled; see the decrement tests).
  w.sql.prepare("UPDATE uploads SET final_writes = 1 WHERE id = ?").run(id);
  // A is held in its R2 read; its lease lapses and B takes over and hits the conflict.
  let releaseA; const holdA = new Promise((r) => (releaseA = r));
  w.r2.onGet = async (k) => { if (k.startsWith("blobs/")) { w.r2.onGet = null; await holdA; } };
  const a = lib.uploadFinish(w.ctx, P, id, "takeover-a");
  await new Promise((r) => setTimeout(r, 20));
  w.sql.prepare("UPDATE uploads SET finalize_until = ? WHERE id = ?").run(Date.now() - 1, id);
  await assert.rejects(lib.uploadFinish(w.ctx, P, id, "takeover-b"), (e) => e.code === "revision_conflict");
  assert.equal(w.row(id).state, "conflict");
  assert.equal(w.row(id).final_purged_at, null, "B left the purge to cleanup: a write is still counted");
  releaseA();
  await assert.rejects(a, (e) => e.code === "revision_conflict", "A replays B's recorded outcome");
  assert.equal(w.finals().length, 1, "kept while counted");
  assert.equal(w.quota(), PNG.length, "still counted");
  w.sql.prepare("UPDATE uploads SET final_writes = 0 WHERE id = ?").run(id);
  await lib.reconcileUploads(w.env);
  assert.deepEqual(w.finals(), [], "cleanup purged it once idle");
  assert.equal(w.quota(), 0);
  assert.deepEqual(w.revisions(art), []);
});

test("orphan placeholders: a new file whose upload failed and expired over a day ago is deleted (it counted toward items_per_project)", async () => {
  const w = world();
  const items = () => w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NULL").get(P).n;
  // One active upload per identity: each pending one belongs to its own synthetic uploader.
  const by = (u, who) => { w.sql.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'synthetic', ?, 'Uploader', ?)").run(who, who, new Date().toISOString());
    w.sql.prepare("UPDATE uploads SET principal_id = ? WHERE id = ?").run(who, u.id); return u; };
  const old = by(w.upload({ state: "failed", expiresAt: Date.now() - 2 * 864e5 }), "agt_old");
  w.sql.prepare("UPDATE uploads SET state = 'pending' WHERE id = ?").run(old.id);
  const recent = by(w.upload({ state: "failed", expiresAt: Date.now() - 3600000 }), "agt_recent");
  w.sql.prepare("UPDATE uploads SET state = 'pending' WHERE id = ?").run(recent.id);
  const live = w.upload({ state: "received" });
  // A published file whose later version upload failed long ago: it has a revision, so it stays.
  const kept = w.upload({ state: "failed", expiresAt: Date.now() - 2 * 864e5 });
  w.sql.prepare("UPDATE artifacts SET head_rev = 1 WHERE id = ?").run(kept.art);
  assert.equal(items(), 4);
  // First run: the old upload is failed and its staging object purged; the placeholder goes in the same run.
  const r = await lib.reconcileUploads(w.env);
  assert.equal(r.deleted_placeholders, 1, JSON.stringify(r));
  assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE id = ?").get(old.art).n, 0);
  assert.equal(w.row(old.id), undefined, "its upload rows go with it");
  // Expired within the last day (finish still answers 410), still uploading, or published: kept.
  for (const u of [recent, live, kept]) assert.equal(w.sql.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE id = ?").get(u.art).n, 1);
  assert.equal(items(), 3);
  assert.equal((await lib.reconcileUploads(w.env)).deleted_placeholders, 0, "idempotent");
});
