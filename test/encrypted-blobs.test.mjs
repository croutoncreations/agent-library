// Slice 3b, encrypted binary file versions: the read side (content-store.js blobRef/readBlob/readBlobBytes) through
// the production serveContent, backup export and restoreRevision, in the World of test/upload-world.mjs (node:sqlite
// over every migration, an R2 double that keeps customMetadata and answers ranged gets with the whole-object size).
// No listener. Encrypted objects are written with the real encryptChunkedStream straight into the R2 double, under a
// workspace key made by the real key layer from synthetic random master-key settings; nothing prints key material.
// Design tests: 3 (World), 13, 14, 15, 17 (World).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { P, lib, world } from "./upload-world.mjs";
import { CHUNKED_CHUNK_BYTES, CHUNKED_HEADER_BYTES, CHUNKED_TAG_BYTES, chunkedStoredLength, encryptChunkedStream, planChunkedRange } from "../packages/core/src/crypto/chunked.js";

const WS = "wsp_hum_synthetic";
const CHUNK = CHUNKED_CHUNK_BYTES, STORED_CHUNK = CHUNKED_CHUNK_BYTES + CHUNKED_TAG_BYTES;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const b64url = (b) => Buffer.from(b).toString("base64url");
const at = () => new Date().toISOString();

/** A World with synthetic key settings, its env with the default adapters, a human ctx, and statement/batch spies. */
function setup({ encryption = true } = {}) {
  const w = world({ encryption });
  const queries = [], batches = [];
  const prepare = w.env.DB.prepare;
  // Tag every statement with its SQL so batches can be inspected.
  w.env.DB.prepare = (q) => { queries.push(q); const o = prepare(q); const bind = o.bind; return { ...o, q, bind: (...p) => ({ ...bind(...p), q }) }; };
  const batch = w.env.DB.batch;
  w.env.DB.batch = (ss) => { batches.push(ss.map((s) => s.q)); return batch.call(w.env.DB, ss); };
  const env = lib.withAdapters(w.env, lib.defaultAdapters());
  const ctx = { ...w.ctx, env };
  let n = 0;
  const artifact = () => {
    const id = `art_e${++n}`;
    w.sql.prepare("INSERT INTO artifacts (id, project_id, kind, title, created_at, updated_at) VALUES (?, ?, 'binary', 'Synthetic file', ?, ?)").run(id, P, at(), at());
    return id;
  };
  /** Store bytes as the next version of art: encrypted with the real codec under the workspace key, or plaintext. */
  const version = async (art, bytes, { encrypted = true, key } = {}) => {
    const revNo = w.sql.prepare("SELECT head_rev FROM artifacts WHERE id = ?").get(art).head_rev + 1;
    const revId = `rev_e${++n}`;
    const blobKey = key ?? `blobs/${P}/${art}/${revId}`;
    let keyId = null, header = null;
    if (encrypted) {
      const dk = await lib.workspaceDataKey(env, WS);
      const stored = await encrypt(bytes, dk.key, blobKey);
      keyId = dk.keyId; header = b64url(stored.subarray(0, CHUNKED_HEADER_BYTES));
      w.blobs.set(blobKey, stored);
      w.meta.set(blobKey, { customMetadata: { "al-enc": "1", "al-key": keyId }, httpMetadata: { contentType: "application/octet-stream" } });
    } else {
      w.blobs.set(blobKey, Buffer.from(bytes));
      w.meta.set(blobKey, { customMetadata: {}, httpMetadata: { contentType: "image/png" } });
    }
    w.sql.prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, blob_key_id, blob_header, size, sha256, mime, created_at)
      VALUES (?, ?, ?, ?, 'hum_synthetic', NULL, NULL, ?, ?, ?, ?, ?, 'image/png', ?)`).run(revId, art, P, revNo, blobKey, keyId, header, bytes.length, sha(bytes), at());
    w.sql.prepare("UPDATE artifacts SET head_rev = ?, head_revision_id = ? WHERE id = ?").run(revNo, revId, art);
    return { revNo, revId, blobKey, keyId, header };
  };
  const get = (art, { rev, range } = {}) => lib.serveContent(ctx, new Request(`https://example.test/content${rev ? `?rev=${rev}` : ""}`, { headers: range ? { range } : {} }), P, art, rev ? String(rev) : undefined);
  const keyQueries = () => queries.filter((q) => /\bworkspace_keys\b/.test(q)).length;
  return { w, env, ctx, artifact, version, get, queries, batches, keyQueries };
}
async function encrypt(bytes, dataKey, objectKey) {
  const input = new Blob([bytes]).stream();
  return new Uint8Array(await new Response(encryptChunkedStream(input, { plaintextLength: bytes.length, dataKey, objectKey })).arrayBuffer());
}
/** Read a response body to its end or its first error. */
async function drain(stream) {
  const reader = stream.getReader();
  const parts = [];
  let error = null;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); } } catch (e) { error = e; }
  return { bytes: Buffer.concat(parts), error };
}
const status = (status, code) => (e) => e?.status === status && e?.code === code;
const flip = (w, key, offset) => { const b = Buffer.from(w.blobs.get(key)); b[offset] ^= 0x01; w.blobs.set(key, b); };

test("full read: one R2 get of the whole object, plaintext out, headers as for plaintext; the object is not plaintext", async () => {
  const s = setup();
  const art = s.artifact();
  const bytes = randomBytes(Math.floor(3.5 * CHUNK));
  const v = await s.version(art, bytes);
  const stored = s.w.blobs.get(v.blobKey);
  assert.equal(stored.length, chunkedStoredLength(bytes.length));
  assert.equal(Buffer.from(stored).indexOf(bytes.subarray(1000, 1016)), -1, "no 16-byte window of the plaintext in the stored object");
  s.w.r2.gets.length = 0;
  const r = await s.get(art);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-length"), String(bytes.length));
  assert.equal(r.headers.get("etag"), `"${sha(bytes)}"`);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes));
  assert.deepEqual(s.w.r2.gets, [null], "exactly one whole-object R2 get");
});

test("design test 3 (World): each Range makes exactly one R2 get with the planned offset and length, and returns the right bytes", async () => {
  const s = setup();
  const art = s.artifact();
  const n = Math.floor(3.5 * CHUNK);
  const bytes = randomBytes(n);
  await s.version(art, bytes);
  const cases = [["0-0", 0, 0], ["65535-65536", 65535, 65536], ["65536-65551", 65536, 65551], [`${n - 1}-${n - 1}`, n - 1, n - 1], ["-100", n - 100, n - 1], ["1000-140000", 1000, 140000]];
  for (const [spec, start, end] of cases) {
    s.w.r2.gets.length = 0;
    const r = await s.get(art, { range: `bytes=${spec}` });
    assert.equal(r.status, 206, spec);
    assert.equal(r.headers.get("content-range"), `bytes ${start}-${end}/${n}`, spec);
    assert.equal(r.headers.get("content-length"), String(end - start + 1), spec);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes.subarray(start, end + 1)), `bytes of ${spec}`);
    const plan = planChunkedRange(n, start, end);
    assert.deepEqual(s.w.r2.gets, [{ offset: plan.storedStart, length: plan.storedEnd - plan.storedStart + 1 }], `one planned R2 get for ${spec}`);
  }
});

test("design test 13: a flipped byte in chunk 0 is a clean 500; in chunk 2 the body errors after the authenticated chunks; a range over chunk 0 still reads; export is 500", async () => {
  const s = setup();
  const art = s.artifact();
  const bytes = randomBytes(Math.floor(3.5 * CHUNK));
  const v = await s.version(art, bytes);
  const pristine = Buffer.from(s.w.blobs.get(v.blobKey));

  flip(s.w, v.blobKey, CHUNKED_HEADER_BYTES + 10);
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "chunk 0 flipped: full read");
  await assert.rejects(s.get(art, { range: "bytes=0-10" }), status(500, "blob_corrupt"), "chunk 0 flipped: range over chunk 0");

  s.w.blobs.set(v.blobKey, pristine);
  flip(s.w, v.blobKey, CHUNKED_HEADER_BYTES + 2 * STORED_CHUNK + 5);
  s.w.r2.gets.length = 0;
  const r = await s.get(art);
  assert.equal(r.status, 200, "the first chunk authenticated, so the response starts");
  const { bytes: got, error } = await drain(r.body);
  assert.ok(error, "the body errors");
  assert.equal(got.length, 2 * CHUNK, "only the two authenticated chunks were released, no byte of the bad chunk");
  assert.ok(got.equals(bytes.subarray(0, 2 * CHUNK)));
  assert.deepEqual(s.w.r2.gets, [null], "one R2 get");

  const r0 = await s.get(art, { range: "bytes=0-100" });
  assert.ok(Buffer.from(await r0.arrayBuffer()).equals(bytes.subarray(0, 101)), "a range over chunk 0 only still succeeds");
  const r1 = await s.get(art, { range: `bytes=${CHUNK - 5}-${2 * CHUNK + 10}` });
  const span = await drain(r1.body);
  assert.ok(span.error, "a range reaching the bad chunk errors after its authenticated chunk");
  assert.ok(span.bytes.equals(bytes.subarray(CHUNK - 5, 2 * CHUNK)), "only the authenticated chunk's bytes were released");
  await assert.rejects(lib.exportBackup(s.ctx, P), status(500, "blob_corrupt"), "export of a project with a corrupt chunk");
});

test("design test 13: a range whose first chunk is the bad one is refused before any byte is sent", async () => {
  const s = setup();
  const art = s.artifact();
  const bytes = randomBytes(Math.floor(3.5 * CHUNK));
  const v = await s.version(art, bytes);
  flip(s.w, v.blobKey, CHUNKED_HEADER_BYTES + 2 * STORED_CHUNK + 5);
  await assert.rejects(s.get(art, { range: `bytes=${2 * CHUNK}-${2 * CHUNK + 10}` }), status(500, "blob_corrupt"));
});

test("design test 14: a header from another write, an object key id unlike the row's, and a half-present column pair are 500 blob_corrupt", async () => {
  const s = setup();
  const art = s.artifact();
  const bytes = randomBytes(CHUNK + 100);
  const v = await s.version(art, bytes);
  // Another write of the same bytes under the same key and storage key: a different salt, so a different header.
  const dk = await lib.workspaceDataKey(s.env, WS);
  const other = await encrypt(bytes, dk.key, v.blobKey);
  const otherHeader = b64url(other.subarray(0, CHUNKED_HEADER_BYTES));
  assert.notEqual(otherHeader, v.header);
  const setRow = (cols) => s.w.sql.prepare(`UPDATE revisions SET ${Object.keys(cols).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(cols), v.revId);

  setRow({ blob_header: otherHeader });
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "full read pinned to the row's header");
  await assert.rejects(s.get(art, { range: "bytes=0-9" }), status(500, "blob_corrupt"), "range read pinned to the row's header");
  setRow({ blob_header: v.header });
  assert.equal((await s.get(art)).status, 200);

  s.w.meta.get(v.blobKey).customMetadata["al-key"] = "wk_other";
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "al-key differs from the row");
  s.w.meta.get(v.blobKey).customMetadata = {};
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "encrypted row, object without al-enc");
  s.w.meta.get(v.blobKey).customMetadata = { "al-enc": "1", "al-key": v.keyId };

  setRow({ blob_header: null });
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "key id without header");
  setRow({ blob_header: v.header, blob_key_id: null });
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "header without key id");
  setRow({ blob_key_id: v.keyId });

  setRow({ size: bytes.length - 1 });
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "header plaintext length differs from the row's size");
  setRow({ size: bytes.length });
  s.w.blobs.set(v.blobKey, Buffer.concat([s.w.blobs.get(v.blobKey), Buffer.from([0])]));
  await assert.rejects(s.get(art), status(500, "blob_corrupt"), "stored size differs from chunkedStoredLength(size)");
});

test("a plaintext row whose object carries the encryption marker is 500 blob_corrupt; a plaintext version reads as today, with no key lookup", async () => {
  const s = setup();
  const art = s.artifact();
  const bytes = randomBytes(5000);
  const v = await s.version(art, bytes, { encrypted: false });
  const before = s.keyQueries();
  s.w.r2.gets.length = 0;
  const r = await s.get(art, { range: "bytes=10-19" });
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes.subarray(10, 20)));
  assert.deepEqual(s.w.r2.gets, [{ offset: 10, length: 10 }]);
  assert.ok(Buffer.from(await (await s.get(art)).arrayBuffer()).equals(bytes));
  assert.equal(s.keyQueries(), before, "no workspace_keys query for a plaintext version");
  s.w.meta.get(v.blobKey).customMetadata = { "al-enc": "1", "al-key": "wk_x" };
  await assert.rejects(s.get(art), status(500, "blob_corrupt"));
});

test("design test 15: a storage key outside the version's own prefix is refused before the key is looked up or R2 is read", async () => {
  const s = setup();
  const art = s.artifact(), other = s.artifact();
  const bytes = randomBytes(2000);
  // An encrypted object of another document in the same workspace, and a row of this document pointing at it.
  const foreign = await s.version(other, bytes);
  const v = await s.version(art, bytes);
  s.w.sql.prepare("UPDATE revisions SET blob_key = ?, blob_key_id = ?, blob_header = ? WHERE id = ?").run(foreign.blobKey, foreign.keyId, foreign.header, v.revId);
  const before = s.keyQueries();
  s.w.r2.gets.length = 0;
  const logs = [];
  const real = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    await assert.rejects(s.get(art), status(500, "blob_corrupt"));
    await assert.rejects(s.get(art, { range: "bytes=0-0" }), status(500, "blob_corrupt"));
  } finally { console.error = real; }
  assert.equal(s.keyQueries(), before, "dataKeyById was never called (no workspace_keys query)");
  assert.deepEqual(s.w.r2.gets, [], "no R2 read");
  assert.ok(logs.some((l) => /"event":"blob_corrupt"/.test(l) && /"reason":"prefix"/.test(l)), "logged");
  assert.ok(logs.every((l) => !l.includes(foreign.blobKey) && !l.includes(foreign.header)), "the log names no storage key or header");
});

test("a shredded key answers 410 key_shredded on read", async () => {
  const s = setup();
  const art = s.artifact();
  await s.version(art, randomBytes(100));
  await lib.shredWorkspaceKeys(s.env, WS);
  await assert.rejects(s.get(art), status(410, "key_shredded"));
  await assert.rejects(s.get(art, { range: "bytes=0-0" }), status(410, "key_shredded"));
});

test("readBlobBytes authenticates the whole object: a later bad chunk is 500 blob_corrupt, and a 0-byte version reads", async () => {
  const s = setup();
  const art = s.artifact();
  const bytes = randomBytes(2 * CHUNK + 7);
  const v = await s.version(art, bytes);
  const row = () => s.w.sql.prepare("SELECT blob_key, size, blob_key_id, blob_header FROM revisions WHERE id = ?").get(v.revId);
  const ref = await lib.blobRef(s.env, row(), { projectId: P, artifactId: art });
  assert.equal(ref.workspaceId, WS, "the workspace comes from the server-side project");
  assert.ok(Buffer.from(await lib.readBlobBytes(s.env, ref)).equals(bytes));
  flip(s.w, v.blobKey, CHUNKED_HEADER_BYTES + 2 * STORED_CHUNK);
  await assert.rejects(lib.readBlobBytes(s.env, ref), status(500, "blob_corrupt"));
  const empty = await s.version(s.artifact(), new Uint8Array(0));
  const emptyRow = s.w.sql.prepare("SELECT blob_key, size, blob_key_id, blob_header, artifact_id FROM revisions WHERE id = ?").get(empty.revId);
  assert.equal((await lib.readBlobBytes(s.env, await lib.blobRef(s.env, emptyRow, { projectId: P, artifactId: emptyRow.artifact_id }))).length, 0);
});

test("backup export decrypts encrypted versions, keeps plaintext ones, and strips blob_key_id and blob_header", async () => {
  const s = setup();
  const art = s.artifact();
  const plain = randomBytes(3000), secret = randomBytes(CHUNK + 3000);
  await s.version(art, plain, { encrypted: false });
  const v2 = await s.version(art, secret);
  const bk = await lib.exportBackup(s.ctx, P);
  for (const r of bk.revisions) {
    assert.ok(!("blob_key_id" in r) && !("blob_header" in r), "encryption columns are not exported");
  }
  assert.ok(Buffer.from(bk.blobs[v2.blobKey].data, "base64").equals(secret), "encrypted version exported as plaintext");
  assert.equal(bk.blobs[v2.blobKey].sha256, sha(secret));
  const v1 = bk.revisions.find((r) => r.rev_no === 1);
  assert.ok(Buffer.from(bk.blobs[v1.blob_key].data, "base64").equals(plain));
  assert.ok(!JSON.stringify(bk).includes(v2.header), "no header anywhere in the backup");
});

test("design test 17 (World): restoring an encrypted version copies its columns and carries a key fence last", async () => {
  const s = setup();
  const art = s.artifact();
  const first = randomBytes(CHUNK + 10);
  const v1 = await s.version(art, first);
  await s.version(art, randomBytes(500));
  s.batches.length = 0;
  const res = await lib.restoreRevision(s.ctx, P, art, { from_revision: 1, expected_revision: 2 }, "idem-restore-enc");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = s.w.sql.prepare("SELECT blob_key, blob_key_id, blob_header, size, sha256, restored_from FROM revisions WHERE artifact_id = ? AND rev_no = 3").get(art);
  assert.deepEqual({ ...row }, { blob_key: v1.blobKey, blob_key_id: v1.keyId, blob_header: v1.header, size: first.length, sha256: sha(first), restored_from: 1 });
  const publish = s.batches.find((b) => /^\s*INSERT INTO revisions/.test(b[0]));
  assert.ok(publish, "the publishing batch starts with the revision INSERT");
  assert.match(publish.at(-1), /content_fences/, "the fence is the last statement");
  assert.match(publish.at(-1), /key_active/, "a key fence");
  assert.equal(publish.filter((q) => /content_fences/.test(q)).length, 1);
  assert.ok(Buffer.from(await (await s.get(art, { rev: 3 })).arrayBuffer()).equals(first), "the restored version reads");
});

test("design test 17 (World): restoring an encrypted version after its key was shredded answers 410 key_shredded and adds no revision", async () => {
  const s = setup();
  const art = s.artifact();
  await s.version(art, randomBytes(100));
  await s.version(art, randomBytes(100));
  await lib.shredWorkspaceKeys(s.env, WS);
  await assert.rejects(lib.restoreRevision(s.ctx, P, art, { from_revision: 1, expected_revision: 2 }, "idem-restore-shred"), status(410, "key_shredded"));
  assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = ?").get(art).n, 2);
  assert.equal(s.w.sql.prepare("SELECT head_rev FROM artifacts WHERE id = ?").get(art).head_rev, 2);
});

test("design test 17 (World): restoring a legacy plaintext version with encryption on succeeds with no fence and stays plaintext", async () => {
  const s = setup();
  const art = s.artifact();
  const plain = randomBytes(700);
  const v1 = await s.version(art, plain, { encrypted: false });
  await s.version(art, randomBytes(800)); // encrypted: a real key row now exists, so a plaintext fence would refuse
  s.batches.length = 0;
  const res = await lib.restoreRevision(s.ctx, P, art, { from_revision: 1, expected_revision: 2 }, "idem-restore-plain");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = s.w.sql.prepare("SELECT blob_key, blob_key_id, blob_header FROM revisions WHERE artifact_id = ? AND rev_no = 3").get(art);
  assert.deepEqual({ ...row }, { blob_key: v1.blobKey, blob_key_id: null, blob_header: null });
  const publish = s.batches.find((b) => /^\s*INSERT INTO revisions/.test(b[0]));
  assert.equal(publish.filter((q) => /content_fences/.test(q)).length, 0, "no fence");
  assert.ok(Buffer.from(await (await s.get(art, { rev: 3 })).arrayBuffer()).equals(plain));
});

test("publishRevision binds NULL encryption columns when a caller passes none (text versions)", async () => {
  const s = setup({ encryption: false });
  const c = await lib.createMarkdown(s.ctx, P, { title: "Doc", body: "synthetic body" }, "idem-md-1");
  const row = s.w.sql.prepare("SELECT blob_key, blob_key_id, blob_header FROM revisions WHERE artifact_id = ?").get(c.body.artifact_id);
  assert.deepEqual({ ...row }, { blob_key: null, blob_key_id: null, blob_header: null });
});
