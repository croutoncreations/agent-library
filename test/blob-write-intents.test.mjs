// The App Files binary PUT's write intents (content-store.js), driven over every migration on node:sqlite and the R2
// double: the cap on outstanding intents per project, and cleanup that can never delete an object a publish committed.
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./load-worker.mjs";
import { P, PNG, world } from "./upload-world.mjs";

const cs = await loadWorker({ "content-store.js": ["stageBlobWrite", "dropBlobWrite", "blobWriteFence"] });
const intents = (w) => w.sql.prepare("SELECT key, created_at FROM content_writes ORDER BY key").all();

test("stageBlobWrite caps outstanding file intents per project; text intents and other projects don't count", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) assert.equal(await cs.stageBlobWrite(w.env, P, `blobs/${P}/art_a/rev_${i}`, 3), true);
  assert.equal(await cs.stageBlobWrite(w.env, P, `blobs/${P}/art_a/rev_3`, 3), false, "the fourth is refused");
  w.sql.prepare("INSERT INTO content_writes (key, project_id, created_at) VALUES ('text/x', ?, ?)").run(P, Date.now());
  assert.equal(await cs.stageBlobWrite(w.env, "prj_other", "blobs/prj_other/art_b/rev_0", 3), true);
  assert.equal(intents(w).filter((r) => r.key.startsWith(`blobs/${P}/`)).length, 3);
});

test("dropBlobWrite: an unreferenced object and its intent go; the intent is expired before the object is deleted", async () => {
  const w = world();
  const key = `blobs/${P}/art_c/rev_c`;
  await cs.stageBlobWrite(w.env, P, key);
  await w.env.BLOBS.put(key, PNG);
  // When R2's delete runs, the intent must already fail the publish fence (a batch committing now is refused).
  let fenceAtDelete = null;
  const realDelete = w.env.BLOBS.delete.bind(w.env.BLOBS);
  w.env.BLOBS.delete = async (k) => { const f = cs.blobWriteFence(key); fenceAtDelete = w.sql.prepare(`SELECT ${f.sql} AS ok`).get(...f.params).ok; return realDelete(k); };
  await cs.dropBlobWrite(w.env, key);
  assert.equal(fenceAtDelete, 0, "the publish fence already fails when the object is deleted");
  assert.equal(await w.env.BLOBS.head(key), null);
  assert.deepEqual(intents(w), []);
});

test("dropBlobWrite keeps an object a revision references (a publish that committed despite an error)", async () => {
  const w = world();
  const key = `blobs/${P}/art_d/rev_d`;
  await cs.stageBlobWrite(w.env, P, key);
  await w.env.BLOBS.put(key, PNG);
  const at = new Date().toISOString();
  w.sql.prepare("INSERT INTO artifacts(id,project_id,kind,title,created_at,updated_at) VALUES ('art_d',?,'binary','Synthetic',?,?)").run(P, at, at);
  w.sql.prepare("INSERT INTO revisions(id,artifact_id,project_id,rev_no,blob_key,size,sha256,mime,author_id,created_at) VALUES ('rev_d','art_d',?,1,?,?,'x','image/png','hum_synthetic',?)").run(P, key, PNG.length, at);
  await cs.dropBlobWrite(w.env, key);
  assert.ok(await w.env.BLOBS.head(key), "the object stays");
  assert.equal(intents(w).length, 1, "the intent stays for textWriteComplete or the sweep");
});
