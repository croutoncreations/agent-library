import { test } from "node:test";
import assert from "node:assert/strict";
import { P, lib, world } from "./upload-world.mjs";
import { createHash } from "node:crypto";

async function publishedWithRaw(failDelete = true) {
  const w = world(); w.ctx.env = lib.withAdapters(w.env, lib.defaultAdapters());
  const bytes = Buffer.from("synthetic cleanup");
  const b = await lib.uploadBegin(w.ctx, P, { title: "Cleanup", mime: "text/markdown", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, "begin", { allowText: true });
  await w.put(b.body.upload_id, bytes);
  const id = b.body.upload_id, raw = w.row(id).final_key, del = w.env.BLOBS.delete;
  w.env.BLOBS.delete = async k => { if (failDelete && k === raw) throw new Error("synthetic delete failure"); return del(k); };
  const seen = capture(w);
  await lib.uploadFinish(w.ctx, P, id, "finish"); w.env.BLOBS.delete = del;
  if (failDelete) { assert.equal(w.row(id).final_purged_at, null); assert.equal(w.row(id).staging_purged_at, null); }
  return { w, id, raw, seen };
}
function capture(w) {
  const seen = [], prepare = w.env.DB.prepare;
  w.env.DB.prepare = q => {
    const statement = prepare(q);
    return { ...statement, bind(...p) {
      const bound = statement.bind(...p);
      const entry = { q, p }; seen.push(entry);
      return { ...bound, async all() { const r = await bound.all(); entry.rows = r.results; return r; } };
    } };
  };
  return seen;
}

test("published text raw-delete failure remains in the indexed staging lane until both purges complete", async () => {
  const { w, id, raw } = await publishedWithRaw(), seen = capture(w);
  assert.ok(w.blobs.has(raw));
  await lib.reconcileUploads(w.env);
  assert.equal(w.blobs.has(raw), false);
  assert.ok(w.row(id).final_purged_at); assert.ok(w.row(id).staging_purged_at);
  assert.ok(w.blobs.has(w.sql.prepare("SELECT body_key FROM revisions").get().body_key));
  seen.length = 0; await lib.reconcileUploads(w.env);
  assert.deepEqual(seen.find(s => s.q.startsWith("SELECT id, staging_key")).rows, []);
});

test("published text with a live write count stays discoverable, then is purged once stale", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { w, id, raw } = await publishedWithRaw();
  w.sql.prepare("UPDATE uploads SET final_writes = 1 WHERE id = ?").run(id);
  await lib.reconcileUploads(w.env);
  assert.equal(w.row(id).staging_purged_at, null); assert.equal(w.row(id).final_purged_at, null); assert.ok(w.blobs.has(raw));
  t.mock.timers.setTime(w.row(id).expires_at + 660001);
  await lib.reconcileUploads(w.env);
  assert.ok(w.row(id).staging_purged_at); assert.ok(w.row(id).final_purged_at); assert.equal(w.row(id).final_writes, 0); assert.equal(w.blobs.has(raw), false);
});

test("published binary is never a final-key cleanup candidate, before or after staging cleanup", async () => {
  const w = world(), b = w.upload();
  await lib.uploadFinish(w.ctx, P, b.id, "binary");
  w.sql.prepare("UPDATE uploads SET staging_purged_at = NULL WHERE id = ?").run(b.id);
  for (let n = 0; n < 2; n++) { await lib.reconcileUploads(w.env); assert.ok(w.blobs.has(b.finalKey)); }
});

for (const projectId of [undefined, P]) test(`real cron upload SQL plans: ${projectId ? "project" : "global"}`, async () => {
  const w = world(), seen = capture(w);
  await lib.reconcileUploads(w.env, { projectId });
  const queries = seen.filter(s => /^(SELECT|UPDATE) .*\buploads\b/s.test(s.q) && !s.q.startsWith("SELECT a.id FROM artifacts"));
  assert.equal(queries.length, 7); // expiry x3, warning, staging, failed/conflict finals, late second delete
  for (const { q, p } of queries) {
    const plan = w.sql.prepare("EXPLAIN QUERY PLAN " + q).all(...p).map(r => r.detail);
    console.log(JSON.stringify({ scope: projectId ? "project" : "global", query: q, plan }));
    assert.ok(plan.some(d => /(?:SEARCH|SCAN) (?:u|uploads) USING/.test(d)), q);
    assert.ok(plan.every(d => !/^SCAN (?:u|uploads)$/.test(d)), q);
    const failureLane = q.startsWith("SELECT id, final_key") || q.startsWith("SELECT final_key");
    if (failureLane) assert.ok(plan.includes("SCAN r"), "pre-existing binary reference guard remains unchanged");
    else assert.ok(!plan.includes("SCAN r"), "no full revision scan on success paths");
    if (q.startsWith("SELECT id, staging_key")) assert.ok(plan.some(d => /uploads_cleanup \(state=\? AND staging_purged_at=\?\)/.test(d)));
  }
});

test("successful text immediate cleanup never prepares a revision-reference query", async () => {
  const { w, seen } = await publishedWithRaw(false);
  const cleanup = seen.filter(s => s.q.startsWith("SELECT 1 AS x FROM uploads") && s.q.includes("final_purged_at"));
  assert.equal(cleanup.length, 1);
  assert.ok(cleanup.every(s => !/\brevisions\b/.test(s.q)));
  for (const { q, p } of cleanup) {
    const plan = w.sql.prepare("EXPLAIN QUERY PLAN " + q).all(...p).map(r => r.detail);
    assert.ok(plan.some(d => /USING INDEX sqlite_autoindex_uploads_1/.test(d)));
    console.log(JSON.stringify({ scope: "immediate", query: q, plan }));
  }
});
