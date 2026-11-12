// Slice 3b write primitives (content-store.js, design commit 3): writeUploadBlob, writeBlobBytes, isBlobWriteError,
// inspectUploadedBlob, blobKeyFits, dropUnreferencedBlobs, in the World of test/upload-world.mjs (no listener).
// Synthetic random bytes and key settings only; nothing prints key material.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { P, lib, world } from "./upload-world.mjs";
import { CHUNKED_HEADER_BYTES, CHUNKED_OBJECT_KEY_MAX_BYTES, chunkedStoredLength } from "../packages/core/src/crypto/chunked.js";

const WS = "wsp_hum_synthetic";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const at = () => new Date().toISOString();
const stream = (b, piece = 8192) => { let i = 0; return new ReadableStream({ pull(c) { if (i >= b.length) return c.close(); c.enqueue(new Uint8Array(b.subarray(i, i + piece))); i += piece; } }); };
function setup({ encryption = true } = {}) {
  const w = world({ encryption });
  const puts = [];
  const put = w.env.BLOBS.put;
  w.env.BLOBS.put = (k, b, o) => { puts.push({ k, o }); return put(k, b, o); };
  const env = lib.withAdapters(w.env, lib.defaultAdapters());
  return { w, env, puts };
}
const key = (n = 1) => `blobs/${P}/art_w/rev_w${n}`;

test("writeUploadBlob, encrypted: one put of exactly the stored length with al-enc/al-key and no checksum; header is base64url of the 48 bytes; it reads back", async () => {
  const s = setup();
  const bytes = randomBytes(200_000);
  const r = await lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS });
  assert.equal(s.puts.length, 1);
  const { o } = s.puts[0];
  assert.deepEqual(o.customMetadata, { "al-enc": "1", "al-key": r.keyId });
  assert.equal(o.httpMetadata.contentType, "application/octet-stream");
  assert.ok(!("sha256" in o) && !("md5" in o), "no R2 checksum on ciphertext");
  const stored = s.w.blobs.get(key());
  assert.equal(stored.length, chunkedStoredLength(bytes.length));
  assert.equal(r.size, bytes.length); assert.equal(r.sha256, sha(bytes));
  assert.match(r.header, /^[A-Za-z0-9_-]{64}$/, "48 bytes as base64url without padding");
  assert.ok(Buffer.from(r.header, "base64url").equals(Buffer.from(stored.subarray(0, CHUNKED_HEADER_BYTES))));
  const ref = { key: key(), size: bytes.length, keyId: r.keyId, header: r.header, projectId: P, artifactId: "art_w", workspaceId: WS };
  assert.ok(Buffer.from(await lib.readBlobBytes(s.env, ref)).equals(bytes));
});

test("writeUploadBlob, plaintext: exactly today's put (sha256 and httpMetadata only), NULL key id and header", async () => {
  const s = setup({ encryption: false });
  const bytes = randomBytes(5000);
  const r = await lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS });
  assert.equal(s.puts.length, 1);
  assert.deepEqual(s.puts[0].o, { sha256: sha(bytes), httpMetadata: { contentType: "image/png" } });
  assert.deepEqual(r, { size: bytes.length, sha256: sha(bytes), keyId: null, header: null });
  assert.ok(Buffer.from(s.w.blobs.get(key())).equals(bytes));
  assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM workspace_keys").get().n, 0, "no key row was created");
});

test("design test 4 (unit): a wrong SHA-256 at the right length is classified digest and stores nothing, at 1, 65,536, 131,072 and 200,000 bytes; the right one succeeds", async () => {
  for (const n of [1, 65_536, 131_072, 200_000]) {
    const s = setup();
    const bytes = randomBytes(n);
    await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: n, sha256: sha(randomBytes(4)), contentType: "image/png", workspaceId: WS }),
      (e) => lib.isBlobWriteError(e) === "digest", `size ${n}`);
    assert.equal(s.w.blobs.has(key()), false, `nothing stored at ${n}`);
    const ok = await lib.writeUploadBlob(s.env, { key: key(2), body: stream(bytes), size: n, sha256: sha(bytes), contentType: "image/png", workspaceId: WS });
    assert.equal(ok.size, n);
  }
});

test("design test 5 (unit): short and long bodies are classified from the tap's flags even when storage rejects with a generic message", async () => {
  const s = setup();
  const put = s.w.env.BLOBS.put;
  // A storage double that drains the stream, then rejects with a generic message whatever went wrong.
  s.w.env.BLOBS.put = async (k, b, o) => { try { await new Response(b).arrayBuffer(); } catch {} throw new Error("synthetic storage failure"); };
  const bytes = randomBytes(70_000);
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes.subarray(0, 1000)), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === "too_short");
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(Buffer.concat([bytes, Buffer.from([1])])), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === "too_long");
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(randomBytes(1)), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === "digest");
  // A generic storage failure with a correct body is not classified.
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === null && /synthetic storage failure/.test(e.message));
  s.w.env.BLOBS.put = put;
  // With the real double: short and long store nothing.
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(3), body: stream(bytes.subarray(0, 1000)), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === "too_short");
  assert.equal(s.w.blobs.has(key(3)), false);
  assert.equal(lib.isBlobWriteError(new Error("anything")), null);
});

test("plaintext writeUploadBlob classifies R2's digest and FixedLengthStream length errors", async () => {
  const s = setup({ encryption: false });
  const bytes = randomBytes(3000);
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(randomBytes(2)), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === "digest");
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes.subarray(0, 10)), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === "too_short");
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(Buffer.concat([bytes, bytes])), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS }), (e) => lib.isBlobWriteError(e) === "too_long");
});

test("writeUploadBlob after a shred answers 410 key_shredded and stores nothing; it never derives the workspace itself", async () => {
  const s = setup();
  await lib.shredWorkspaceKeys(s.env, WS);
  const bytes = randomBytes(100);
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: 100, sha256: sha(bytes), contentType: "image/png", workspaceId: WS }), (e) => e.status === 410 && e.code === "key_shredded");
  assert.equal(s.puts.length, 0);
  await assert.rejects(lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: 100, sha256: sha(bytes), contentType: "image/png" }), (e) => e.status === 500 && e.code === "invalid_workspace");
});

test("writeBlobBytes: encrypted under the given workspace and readable; plaintext is today's put; a 0-byte object round-trips", async () => {
  const s = setup();
  const bytes = randomBytes(70_000);
  const r = await lib.writeBlobBytes(s.env, { key: key(), bytes, contentType: "image/png", workspaceId: WS });
  assert.deepEqual(s.puts[0].o.customMetadata, { "al-enc": "1", "al-key": r.keyId });
  assert.equal(s.w.blobs.get(key()).length, chunkedStoredLength(bytes.length));
  assert.ok(Buffer.from(await lib.readBlobBytes(s.env, { key: key(), size: bytes.length, keyId: r.keyId, header: r.header, projectId: P, artifactId: "art_w", workspaceId: WS })).equals(bytes));
  const z = await lib.writeBlobBytes(s.env, { key: key(2), bytes: new Uint8Array(0), contentType: "image/png", workspaceId: WS });
  assert.equal((await lib.readBlobBytes(s.env, { key: key(2), size: 0, keyId: z.keyId, header: z.header, projectId: P, artifactId: "art_w", workspaceId: WS })).length, 0);
  const p = setup({ encryption: false });
  assert.deepEqual(await lib.writeBlobBytes(p.env, { key: key(), bytes, contentType: "image/png", workspaceId: WS }), { keyId: null, header: null });
  assert.equal(p.puts[0].o, undefined, "plaintext put with no options, as today");
});

test("blobKeyFits: at most 1,015 UTF-8 bytes", () => {
  assert.equal(CHUNKED_OBJECT_KEY_MAX_BYTES, 1015);
  assert.equal(lib.blobKeyFits("a".repeat(1015)), true);
  assert.equal(lib.blobKeyFits("a".repeat(1016)), false);
  assert.equal(lib.blobKeyFits("é".repeat(508)), false, "1,016 UTF-8 bytes");
  assert.equal(lib.blobKeyFits(""), false);
});

test("inspectUploadedBlob: encrypted ok reads one head and one ranged get of chunk 0; metadata, size, received values and chunk 0 are checked", async () => {
  const s = setup();
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(100_000)]);
  const r = await lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS });
  const args = { key: key(), projectId: P, artifactId: "art_w", workspaceId: WS, size: bytes.length, sha256: sha(bytes), keyId: r.keyId, header: r.header, receivedSize: r.size, receivedSha256: r.sha256 };
  s.w.r2.gets.length = 0;
  const ok = await lib.inspectUploadedBlob(s.env, args, 16);
  assert.equal(ok.ok, true);
  assert.ok(Buffer.from(ok.head).equals(bytes.subarray(0, 16)));
  assert.equal(s.w.r2.gets.length, 1);
  assert.ok(s.w.r2.gets[0].length <= 65_552, `chunk 0 only: ${JSON.stringify(s.w.r2.gets[0])}`);
  const wrong = sha(randomBytes(1));
  assert.deepEqual(await lib.inspectUploadedBlob(s.env, { ...args, receivedSha256: wrong }, 16), { ok: false, reason: "mismatch", size: r.size, sha256: wrong });
  const logs = []; const real = console.error; console.error = (...a) => logs.push(a.join(" "));
  try {
    s.w.meta.get(key()).customMetadata["al-key"] = "wk_other";
    assert.equal((await lib.inspectUploadedBlob(s.env, args, 16)).reason, "corrupt", "al-key differs");
    s.w.meta.get(key()).customMetadata["al-key"] = r.keyId;
    const pristine = Buffer.from(s.w.blobs.get(key()));
    const flipped = Buffer.from(pristine); flipped[CHUNKED_HEADER_BYTES + 3] ^= 1; s.w.blobs.set(key(), flipped);
    assert.equal((await lib.inspectUploadedBlob(s.env, args, 16)).reason, "corrupt", "chunk 0 does not authenticate");
    s.w.blobs.set(key(), Buffer.concat([pristine, Buffer.from([0])]));
    assert.equal((await lib.inspectUploadedBlob(s.env, args, 16)).reason, "corrupt", "stored size");
    s.w.blobs.set(key(), pristine);
    // A late write of the same key (another salt): chunk 0 does not authenticate under the recorded header.
    await lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS });
    assert.equal((await lib.inspectUploadedBlob(s.env, args, 16)).reason, "corrupt", "late write");
  } finally { console.error = real; }
  assert.ok(logs.every((l) => !l.includes(key()) && !l.includes(r.header)), "logs name no key or header");
  s.w.blobs.delete(key());
  assert.equal((await lib.inspectUploadedBlob(s.env, args, 16)).reason, "missing");
});

test("inspectUploadedBlob: a shredded key is 410; plaintext keeps today's checks (no checksum, mismatch) and refuses an encrypted-marked object", async () => {
  const s = setup();
  const bytes = randomBytes(1000);
  const r = await lib.writeUploadBlob(s.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS });
  await lib.shredWorkspaceKeys(s.env, WS);
  await assert.rejects(lib.inspectUploadedBlob(s.env, { key: key(), projectId: P, artifactId: "art_w", workspaceId: WS, size: 1000, sha256: sha(bytes), keyId: r.keyId, header: r.header, receivedSize: 1000, receivedSha256: sha(bytes) }, 16), (e) => e.status === 410 && e.code === "key_shredded");
  const p = setup({ encryption: false });
  await lib.writeUploadBlob(p.env, { key: key(), body: stream(bytes), size: bytes.length, sha256: sha(bytes), contentType: "image/png", workspaceId: WS });
  const args = { key: key(), projectId: P, artifactId: "art_w", workspaceId: WS, size: 1000, sha256: sha(bytes), keyId: null, header: null };
  const ok = await lib.inspectUploadedBlob(p.env, args, 16);
  assert.ok(ok.ok && Buffer.from(ok.head).equals(bytes.subarray(0, 16)));
  assert.equal((await lib.inspectUploadedBlob(p.env, { ...args, size: 999 }, 16)).reason, "mismatch");
  const head = p.w.env.BLOBS.head;
  p.w.env.BLOBS.head = async (k) => ({ ...(await head(k)), checksums: {} });
  assert.equal((await lib.inspectUploadedBlob(p.env, args, 16)).reason, "no_checksum");
  p.w.env.BLOBS.head = head;
  p.w.meta.get(key()).customMetadata = { "al-enc": "1" };
  assert.equal((await lib.inspectUploadedBlob(p.env, args, 16)).reason, "corrupt");
});

test("dropUnreferencedBlobs deletes only keys no revision refers to; a failed reference query deletes nothing and logs backup_cleanup_skipped", async () => {
  const s = setup({ encryption: false });
  for (const k of ["blobs/x/a/r1", "blobs/x/a/r2"]) s.w.blobs.set(k, Buffer.from("x"));
  s.w.sql.prepare("INSERT INTO artifacts (id, project_id, kind, title, created_at, updated_at) VALUES ('art_d', ?, 'binary', 'D', ?, ?)").run(P, at(), at());
  s.w.sql.prepare("INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, body_key, blob_key, blob_key_id, blob_header, size, sha256, mime, created_at) VALUES ('rev_d', 'art_d', ?, 1, 'hum_synthetic', NULL, NULL, 'blobs/x/a/r1', NULL, NULL, 1, ?, 'image/png', ?)").run(P, sha("x"), at());
  await lib.dropUnreferencedBlobs(s.env, ["blobs/x/a/r1", "blobs/x/a/r2"]);
  assert.deepEqual(s.w.r2.deletes, ["blobs/x/a/r2"]);
  assert.ok(s.w.blobs.has("blobs/x/a/r1"));
  const prepare = s.w.env.DB.prepare;
  s.w.env.DB.prepare = () => { throw new Error("synthetic D1 failure"); };
  const logs = []; const real = console.error; console.error = (...a) => logs.push(a.join(" "));
  s.w.r2.deletes.length = 0;
  try { await lib.dropUnreferencedBlobs(s.env, ["blobs/x/a/r1"]); } finally { console.error = real; s.w.env.DB.prepare = prepare; }
  assert.deepEqual(s.w.r2.deletes, []);
  assert.ok(logs.some((l) => /"event":"backup_cleanup_skipped"/.test(l)));
});
