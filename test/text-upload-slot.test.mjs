// Deterministic clock and R2 gates against the real bundled upload module; no timers or source rewrites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { P, lib, world } from "./upload-world.mjs";
import { createHash } from "node:crypto";

async function textUpload(text = "synthetic slot", mime = "text/markdown") {
  const w = world(), bytes = Buffer.from(text);
  if (mime === "application/json") w.env.APP_CONNECT_ENABLED = "1";
  w.ctx.env = lib.withAdapters(w.env, lib.defaultAdapters());
  const b = await lib.uploadBegin(w.ctx, P, { title: "Slot", mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, "begin", { allowText: true });
  await w.put(b.body.upload_id, bytes);
  return { w, id: b.body.upload_id };
}
function block(w, hook) {
  let release, entered;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  w.r2[hook] = async () => { w.r2[hook] = null; entered(); await gate; };
  return { release, ready };
}
const busy = e => e.status === 503 && e.code === "text_finish_busy" && e.message === "Another text upload is being finalized on this server; retry the finish request shortly with the same idempotency key" && e.extra.retry_after_seconds === 1;

test("text finish slot expires with its lease; a late holder neither publishes nor releases its successor", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const a = await textUpload(), b = await textUpload(), c = await textUpload();
  const first = block(a.w, "onGet"), slow = lib.uploadFinish(a.w.ctx, P, a.id, "first");
  await first.ready;
  const expiry = a.w.row(a.id).finalize_until;
  t.mock.timers.setTime(expiry - 1);
  await assert.rejects(lib.uploadFinish(b.w.ctx, P, b.id, "second"), busy);
  const binary = world(), binaryUpload = binary.upload();
  assert.equal((await lib.uploadFinish(binary.ctx, P, binaryUpload.id, "binary")).status, 200);
  t.mock.timers.setTime(expiry);
  const second = block(b.w, "onGet"), fresh = lib.uploadFinish(b.w.ctx, P, b.id, "second");
  await second.ready;
  first.release();
  await assert.rejects(slow, e => e.code === "finish_in_progress");
  assert.equal(a.w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 0);
  await assert.rejects(lib.uploadFinish(c.w.ctx, P, c.id, "third"), busy);
  second.release(); assert.equal((await fresh).status, 200);
  assert.equal((await lib.uploadFinish(c.w.ctx, P, c.id, "third")).status, 200);
});

for (const text of ["{", "{}"]) test(`expired text read skips validation and leaves upload retryable: ${text}`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const a = await textUpload(text, "application/json"), read = block(a.w, "onGet");
  const slow = lib.uploadFinish(a.w.ctx, P, a.id, "expired").catch(e => e);
  await read.ready;
  t.mock.timers.setTime(a.w.row(a.id).finalize_until + 1);
  read.release();
  const error = await slow, row = a.w.row(a.id);
  assert.equal(row.state, "sealed", "expired read must not record a terminal validation result");
  assert.equal(row.result, null);
  assert.equal(row.finalize_token, null); assert.equal(row.finalize_until, null);
  assert.equal(a.w.sql.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 0);
  assert.equal(a.w.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0);
  assert.ok(a.w.blobs.has(row.final_key));
  assert.equal(error.status, 409); assert.equal(error.code, "finish_in_progress");
  assert.equal(error.message, "Another finish of this upload is in progress; retry shortly");
  assert.deepEqual(error.extra, { retry_after_seconds: 1 });
  // A real retry reads again: valid input publishes; invalid input is only now allowed to fail validation.
  if (text === "{}") assert.equal((await lib.uploadFinish(a.w.ctx, P, a.id, "expired")).status, 200);
  else await assert.rejects(lib.uploadFinish(a.w.ctx, P, a.id, "expired"), e => e.code === "invalid_content");
  assert.equal(a.w.r2.gets.length, 2);
});

test("text finish slot follows lease renewal through text staging", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const a = await textUpload(), b = await textUpload();
  const read = block(a.w, "onGet"), stage = block(a.w, "onPut");
  const slow = lib.uploadFinish(a.w.ctx, P, a.id, "renew"); await read.ready;
  const initial = a.w.row(a.id).finalize_until;
  t.mock.timers.setTime(initial - 1); read.release(); await stage.ready;
  assert.equal(a.w.row(a.id).finalize_until, initial + 59999);
  t.mock.timers.setTime(initial + 1);
  await assert.rejects(lib.uploadFinish(b.w.ctx, P, b.id, "contender"), busy);
  stage.release(); assert.equal((await slow).status, 200);
  assert.equal((await lib.uploadFinish(b.w.ctx, P, b.id, "contender")).status, 200);
});

test("text finish slot ends with the lease, not a stalled post-publication raw delete", async () => {
  const a = await textUpload(), b = await textUpload();
  let release, entered;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const del = a.w.env.BLOBS.delete, raw = a.w.row(a.id).final_key;
  a.w.env.BLOBS.delete = async k => { if (k === raw) { entered(); await gate; } return del(k); };
  const slow = lib.uploadFinish(a.w.ctx, P, a.id, "published"); await ready;
  assert.equal(a.w.row(a.id).finalize_until, null);
  try { assert.equal((await lib.uploadFinish(b.w.ctx, P, b.id, "next")).status, 200); }
  finally { release(); await slow; }
});

for (const failure of ["validation", "infrastructure", "normal"]) test(`text finish slot releases immediately after ${failure}`, async () => {
  const a = await textUpload(failure === "validation" ? Buffer.from([0xc0, 0xaf]) : "synthetic"), b = await textUpload();
  if (failure === "infrastructure") a.w.r2.onGet = async () => { throw new Error("synthetic read failure"); };
  const finish = lib.uploadFinish(a.w.ctx, P, a.id, "release");
  if (failure === "normal") assert.equal((await finish).status, 200);
  else await assert.rejects(finish, failure === "validation" ? e => e.code === "invalid_content" : /synthetic read failure/);
  assert.equal((await lib.uploadFinish(b.w.ctx, P, b.id, "next")).status, 200);
});
