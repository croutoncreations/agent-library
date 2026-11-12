// uploadFinish records a failed outcome before its `finally` releases the finalize lease. On real D1 two statements sent
// back to back may run in either order, so the outcome UPDATE is held here (a few microtask turns, or until the
// lease-clearing UPDATE has been sent, whichever is first). No timers. Drives the bundled production code over
// upload-world.mjs. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { P, lib, world } from "./upload-world.mjs";

const OUTCOME = /SET state = \?, result = \?/;
const LEASE_CLEAR = /SET finalize_token = NULL, finalize_until = NULL WHERE id = \? AND finalize_token = \?/;

// Holds every outcome-recording UPDATE until the lease-clearing UPDATE has been sent (or 50 microtask turns passed).
function holdOutcome(w) {
  const seen = { clearSentBeforeOutcome: false, outcomes: 0 };
  let clearSent = false;
  w.hooks.beforeRun = async (q) => {
    if (LEASE_CLEAR.test(q) && !/state =/.test(q)) { clearSent = true; return; }
    if (!OUTCOME.test(q)) return;
    seen.outcomes++;
    for (let i = 0; i < 50 && !clearSent; i++) await Promise.resolve();
    if (clearSent) seen.clearSentBeforeOutcome = true;
  };
  return seen;
}

async function begin(w, mime, bytes) {
  return lib.uploadBegin(w.ctx, P, { title: "Synthetic order", mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, "begin-" + randomBytes(4).toString("hex"), { allowText: true });
}

for (const c of [
  { name: "binary whose bytes fail the type signature", mime: "image/png", bytes: Buffer.from("synthetic bytes, not a PNG"), status: 415, code: "signature_mismatch" },
  { name: "Markdown whose bytes are not valid UTF-8", mime: "text/markdown", bytes: Buffer.from([0x23, 0x20, 0x53, 0xff, 0xfe, 0x0a]), status: 422, code: "invalid_content" },
]) {
  test(`uploadFinish, ${c.name}: the outcome is recorded before the lease is released (${c.status} ${c.code})`, async () => {
    const w = world();
    w.ctx.env = lib.withAdapters(w.env, lib.defaultAdapters());
    const b = await begin(w, c.mime, c.bytes);
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const id = b.body.upload_id;
    assert.equal((await w.put(id, c.bytes)).status, 200);
    const seen = holdOutcome(w);
    const isValidation = (e) => (assert.deepEqual([e.status, e.code], [c.status, c.code], `finish answered ${e.status} ${e.code}: ${e.message}`), true);
    await assert.rejects(lib.uploadFinish(w.ctx, P, id, "finish-1"), isValidation);
    // Without this the test would pass with nothing held, if the outcome UPDATE's SQL text ever stops matching OUTCOME.
    assert.ok(seen.outcomes >= 1, "the outcome UPDATE was seen and held (OUTCOME matches the real SQL)");
    assert.equal(seen.clearSentBeforeOutcome, false, "lease-clearing UPDATE was sent before the outcome was recorded");
    w.hooks.beforeRun = null;
    const row = w.row(id);
    assert.equal(row.state, "failed");
    assert.deepEqual([JSON.parse(row.result).status, JSON.parse(row.result).code], [c.status, c.code]);
    assert.deepEqual([row.finalize_token, row.finalize_until], [null, null]);
    await assert.rejects(lib.uploadFinish(w.ctx, P, id, "finish-1"), isValidation);
    await assert.rejects(lib.uploadFinish(w.ctx, P, id, "finish-2"), isValidation);
    const next = await begin(w, c.mime, Buffer.from("synthetic next upload"));
    assert.equal(next.status, 201, JSON.stringify(next.body));
  });
}
