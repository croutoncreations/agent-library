// Slice 3b backup import and restore (design commit 5) in the World of test/upload-world.mjs (no listener):
// re-encryption under an explicitly passed workspace, fences last, per-attempt restore keys, pre-write bind and key
// checks, and cleanup decided by the phase and source of a failure (beforeBatch rejects before the commit; afterBatch
// throws after it; r2.deletes records every delete). Synthetic data and synthetic key settings only.
// Design tests: 16 (import), 18 (World), 19, 20 (a), (b), (c), (c'), 21, 22, and the Addendum's restore-unchanged test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { P, PNG, lib, world, keyVars } from "./upload-world.mjs";
import { CHUNKED_HEADER_BYTES, chunkedStoredLength } from "../packages/core/src/crypto/chunked.js";

const OWNER = "hum_synthetic", WS = "wsp_hum_synthetic";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const at = () => new Date().toISOString();
const status = (s, code) => (e) => e?.status === s && e?.code === code;
const pngOf = (n) => { const b = randomBytes(n); PNG.copy(b, 0, 0, Math.min(16, n)); return b; };
const silent = async (fn) => { const logs = []; const real = console.error; console.error = (...a) => logs.push(a.map(String).join(" ")); try { return { value: await fn(), logs }; } catch (error) { return { error, logs }; } finally { console.error = real; } };

/** A World with the default adapters, a statement-tagging batch spy, and helpers to build a source store. */
function setup({ encryption = true, project = true } = {}) {
  const w = world({ encryption });
  if (!project) w.sql.prepare("DELETE FROM projects").run();
  const batches = [];
  const prepare = w.env.DB.prepare, batch = w.env.DB.batch;
  w.env.DB.prepare = (q) => { const o = prepare(q); const bind = o.bind; return { ...o, q, bind: (...p) => ({ ...bind(...p), q }) }; };
  // Publish-only hooks (the World's beforeBatch would fire on stageTextWrites' intent batch first): beforePublish runs
  // before the publishing batch's BEGIN (reject = nothing committed); afterPublish runs after its COMMIT.
  const hooks = { beforePublish: null, afterPublish: null };
  w.env.DB.batch = async (ss) => {
    const qs = ss.map((s) => s.q);
    batches.push(qs);
    const publishing = qs.some((q) => /INSERT INTO projects/.test(q));
    if (publishing && hooks.beforePublish) { const h = hooks.beforePublish; hooks.beforePublish = null; await h(); }
    const r = await batch.call(w.env.DB, ss);
    if (publishing && hooks.afterPublish) { const h = hooks.afterPublish; hooks.afterPublish = null; await h(r); }
    return r;
  };
  const env = lib.withAdapters(w.env, lib.defaultAdapters());
  w.ctx.env = env;
  const publishBatch = () => batches.filter((b) => b.some((q) => /INSERT INTO projects/.test(q))).at(-1);
  return { w, env, ctx: w.ctx, batches, publishBatch, hooks };
}

/** A backup (agent-library-backup/1) built directly: a file with two versions, a document with text, a comment. */
function makeBackup({ pid = "src-proj", files = [pngOf(3000), pngOf(70_000)], text = "# synthetic text\n", comment = "a synthetic comment", extraRevision = {} } = {}) {
  const fileArt = "art_file", docArt = "art_doc", t = at();
  const revisions = files.map((bytes, i) => ({ id: `rev_f${i + 1}`, artifact_id: fileArt, rev_no: i + 1, author_id: OWNER, body: null, blob_key: `blobs/${pid}/${fileArt}/rev_f${i + 1}`, size: bytes.length, sha256: sha(bytes), mime: "image/png", restored_from: null, created_at: t, via_kind: "browser", via_id: null, via_label: null, client_info: null, change_note: null, ...i === 0 ? extraRevision : {} }));
  const blobs = Object.fromEntries(files.map((bytes, i) => [`blobs/${pid}/${fileArt}/rev_f${i + 1}`, { sha256: sha(bytes), data: Buffer.from(bytes).toString("base64") }]));
  const artifacts = [{ id: fileArt, kind: "binary", title: "Synthetic.png", folder: "", tags: "[]", head_rev: files.length, head_revision_id: `rev_f${files.length}`, meta_version: 1, trashed_at: null, created_at: t, updated_at: t, is_template: 0, template_description: "" }];
  if (text !== null) {
    artifacts.push({ id: docArt, kind: "markdown", title: "Notes", folder: "", tags: "[]", head_rev: 1, head_revision_id: "rev_d1", meta_version: 1, trashed_at: null, created_at: t, updated_at: t, is_template: 0, template_description: "" });
    revisions.push({ id: "rev_d1", artifact_id: docArt, rev_no: 1, author_id: OWNER, body: text, blob_key: null, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)), mime: "text/markdown", restored_from: null, created_at: t, via_kind: "browser", via_id: null, via_label: null, client_info: null, change_note: null });
  }
  const comments = text !== null && comment !== null ? [{ id: "cmt_1", artifact_id: docArt, rev_no: 1, author_id: OWNER, body: comment, created_at: t }] : [];
  return { schema: "agent-library-backup/1", exported_at: t, project: { id: pid, title: "Synthetic source", created_at: t }, artifacts, revisions, comments, meta_versions: [], blobs };
}
const fileRows = (s, pid) => s.w.sql.prepare("SELECT r.id, r.artifact_id, r.rev_no, r.blob_key, r.blob_key_id, r.blob_header, r.size, r.sha256 FROM revisions r WHERE r.project_id = ? AND r.blob_key IS NOT NULL ORDER BY r.artifact_id, r.rev_no").all(pid);
async function download(s, pid, art, rev) {
  const r = await lib.serveContent(s.ctx, new Request(`https://example.test/c${rev ? `?rev=${rev}` : ""}`), pid, art, rev ? String(rev) : undefined);
  return Buffer.from(await r.arrayBuffer());
}
const objectsUnder = (s, pid) => [...s.w.blobs.keys()].filter((k) => k.startsWith(`blobs/${pid}/`));

// ---- Design test 18 (World), 16 (import) ----

test("design test 18 (World): an encrypted import re-encrypts every file under the target workspace, stages text and comments, res[0] is the project, nothing is deleted, and the fences come last", async () => {
  const s = setup();
  const bk = makeBackup();
  const res = await lib.importBackup(s.ctx, WS, { backup: bk }, "imp-enc-1");
  const rows = fileRows(s, res.project_id);
  assert.equal(rows.length, 2);
  const keyRow = s.w.sql.prepare("SELECT key_id FROM workspace_keys WHERE workspace_id = ? AND shredded_at IS NULL").get(WS);
  for (const r of rows) {
    assert.equal(r.blob_key_id, keyRow.key_id, "the target workspace's key");
    assert.match(r.blob_header, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(s.w.blobs.get(r.blob_key).length, chunkedStoredLength(r.size));
    assert.ok(r.blob_key.startsWith(`blobs/${res.project_id}/${r.artifact_id}/`));
  }
  const files = bk.revisions.filter((r) => r.blob_key);
  for (const [i, r] of rows.entries()) assert.ok((await download(s, res.project_id, r.artifact_id, r.rev_no)).equals(Buffer.from(bk.blobs[files[i].blob_key].data, "base64")));
  const doc = s.w.sql.prepare("SELECT id FROM artifacts WHERE project_id = ? AND kind = 'markdown'").get(res.project_id);
  assert.equal((await lib.getArtifact(s.ctx, res.project_id, doc.id)).body, "# synthetic text\n", "text version imported (the split loop staged it)");
  assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM comments WHERE project_id = ?").get(res.project_id).n, 1);
  assert.deepEqual(s.w.r2.deletes, [], "nothing deleted");
  const b = s.publishBatch();
  assert.match(b.find((q) => !/content_writes/.test(q)), /INSERT INTO projects/, "the project INSERT is the first statement after the text guard");
  const fences = b.filter((q) => /content_fences/.test(q));
  assert.equal(fences.length, 1, "one key fence for the one (key, workspace) pair");
  assert.match(b.at(-1), /content_fences/, "the fence is last");
});

test("design test 18 (World): a plaintext import writes as today and ends with a plaintext fence; a mixed source imports into either mode", async () => {
  const s = setup({ encryption: false });
  const res = await lib.importBackup(s.ctx, WS, { backup: makeBackup() }, "imp-plain-1");
  for (const r of fileRows(s, res.project_id)) assert.deepEqual([r.blob_key_id, r.blob_header], [null, null]);
  const b = s.publishBatch();
  assert.match(b.at(-1), /SELECT 0, NULL/, "plaintext fence last");
  assert.equal(b.filter((q) => /content_fences/.test(q)).length, 1);
});

test("design test 18 (World): forged blob_key_id / blob_header fields in the backup are ignored", async () => {
  const s = setup({ encryption: false });
  const bk = makeBackup({ extraRevision: { blob_key_id: "wk_forged", blob_header: "A".repeat(64) } });
  const res = await lib.importBackup(s.ctx, WS, { backup: bk }, "imp-forged");
  for (const r of fileRows(s, res.project_id)) assert.deepEqual([r.blob_key_id, r.blob_header], [null, null]);
  const e = setup();
  const r2 = await lib.importBackup(e.ctx, WS, { backup: bk }, "imp-forged-enc");
  for (const r of fileRows(e, r2.project_id)) { assert.notEqual(r.blob_key_id, "wk_forged"); assert.notEqual(r.blob_header, "A".repeat(64)); }
});

test("design test 16 (import): a 0-byte encrypted file version round-trips through import", async () => {
  const s = setup();
  const empty = new Uint8Array(0);
  const bk = makeBackup({ files: [empty], text: null });
  bk.revisions[0].mime = "application/octet-stream";
  const res = await lib.importBackup(s.ctx, WS, { backup: bk }, "imp-empty");
  const [r] = fileRows(s, res.project_id);
  assert.equal(r.size, 0);
  assert.equal(s.w.blobs.get(r.blob_key).length, chunkedStoredLength(0));
  assert.equal((await download(s, res.project_id, r.artifact_id)).length, 0);
});

test("design test 18 (World): export of an encrypted store, then import into another installation, round-trips with the new key", async () => {
  const a = setup();
  const res = await lib.importBackup(a.ctx, WS, { backup: makeBackup() }, "imp-a");
  const exported = await lib.exportBackup(a.ctx, res.project_id);
  assert.ok(exported.revisions.every((r) => !("blob_key_id" in r) && !("blob_header" in r)));
  const b = setup();
  const res2 = await lib.importBackup(b.ctx, WS, { backup: exported }, "imp-b");
  const keyA = a.w.sql.prepare("SELECT key_id FROM workspace_keys").get().key_id, keyB = b.w.sql.prepare("SELECT key_id FROM workspace_keys").get().key_id;
  assert.notEqual(keyA, keyB);
  for (const r of fileRows(b, res2.project_id)) {
    assert.equal(r.blob_key_id, keyB);
    const src = exported.revisions.find((x) => x.rev_no === r.rev_no && x.blob_key);
    assert.ok((await download(b, res2.project_id, r.artifact_id, r.rev_no)).equals(Buffer.from(exported.blobs[src.blob_key].data, "base64")));
  }
});

// ---- Design test 19: restore ----

test("design test 19: a single-owner restore with encryption on writes _restore_ keys under wsp_<principal>, readable, including text versions", async () => {
  const s = setup({ project: false });
  const bk = makeBackup();
  const out = await lib.restoreBackup(s.ctx, bk);
  assert.equal(out.restored_project, "src-proj");
  const rows = fileRows(s, "src-proj");
  const keyRow = s.w.sql.prepare("SELECT key_id FROM workspace_keys WHERE workspace_id = ?").get(WS);
  for (const r of rows) {
    assert.match(r.blob_key, /^blobs\/src-proj\/art_file\/rev_f\d_restore_[A-Za-z0-9_-]{16}$/);
    assert.equal(r.blob_key_id, keyRow.key_id);
  }
  for (const r of rows) {
    const src = bk.revisions.find((x) => x.id === r.id);
    assert.ok((await download(s, "src-proj", r.artifact_id, r.rev_no)).equals(Buffer.from(bk.blobs[src.blob_key].data, "base64")));
  }
  assert.equal((await lib.getArtifact(s.ctx, "src-proj", "art_doc")).body, "# synthetic text\n");
  assert.match(s.publishBatch().at(-1), /content_fences/);
  assert.deepEqual(s.w.r2.deletes, []);
});

test("design test 19: overlapping restores: one wins; the loser hits UNIQUE (settled), its own objects are deleted, the winner's are untouched", async () => {
  const s = setup({ project: false });
  const bk = makeBackup();
  // The loser's batch runs second: the winner's restore commits from inside the loser's beforeBatch.
  let winnerKeys = [];
  s.hooks.beforePublish = async () => {
    await lib.restoreBackup(s.ctx, bk);
    winnerKeys = fileRows(s, "src-proj").map((r) => r.blob_key);
  };
  const before = new Set(s.w.blobs.keys());
  const r = await silent(() => lib.restoreBackup(s.ctx, bk));
  assert.ok(status(409, "store_not_empty")(r.error), String(r.error));
  for (const k of winnerKeys) assert.ok(s.w.blobs.has(k), "winner's object untouched");
  const loserKeys = s.w.r2.deletes;
  assert.ok(loserKeys.length >= 2, "the loser's objects were deleted");
  assert.ok(loserKeys.every((k) => !winnerKeys.includes(k)));
  assert.ok(loserKeys.every((k) => !s.w.blobs.has(k)));
  void before;
});

// ---- Design test 20: cleanup by phase ----

for (const op of ["import", "restore"]) {
  const run = (s, bk, key) => op === "import" ? lib.importBackup(s.ctx, WS, { backup: bk }, key) : lib.restoreBackup(s.ctx, bk);
  const fresh = () => setup({ project: op !== "restore" });
  const projectsOf = (s) => s.w.sql.prepare("SELECT id FROM projects WHERE id <> ?").all(P).map((r) => r.id);

  test(`design test 20 (a), ${op}: the batch commits and then a transport error is thrown: NO delete call, backup_cleanup_skipped logged, everything reads back`, async () => {
    const s = fresh();
    const bk = makeBackup();
    s.hooks.afterPublish = async () => { throw new Error("synthetic network connection lost"); };
    const r = await silent(() => run(s, bk, `a-${op}`));
    assert.ok(r.error, "the caller sees an error");
    if (op === "restore") assert.ok(status(409, "store_not_empty")(r.error), String(r.error));
    assert.deepEqual(s.w.r2.deletes, [], "no delete call at all");
    assert.ok(r.logs.some((l) => /"event":"backup_cleanup_skipped"/.test(l)), r.logs.join("\n"));
    assert.ok(r.logs.every((l) => !/blobs\//.test(l)), "the log names no storage key");
    const [pid] = projectsOf(s);
    assert.ok(pid, "the project committed");
    const rows = fileRows(s, pid);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const src = bk.revisions.filter((x) => x.blob_key)[row.rev_no - 1];
      assert.ok((await download(s, pid, row.artifact_id, row.rev_no)).equals(Buffer.from(bk.blobs[src.blob_key].data, "base64")), "download reads back");
    }
  });

  test(`design test 20 (b), ${op}: the batch call rejects with a transport error before committing: NO delete call, objects remain, no project`, async () => {
    const s = fresh();
    s.hooks.beforePublish = async () => { throw new Error("synthetic network connection lost"); };
    const r = await silent(() => run(s, makeBackup(), `b-${op}`));
    assert.ok(r.error);
    assert.deepEqual(s.w.r2.deletes, [], "no delete call");
    assert.deepEqual(projectsOf(s), []);
    assert.ok([...s.w.blobs.keys()].filter((k) => k.startsWith("blobs/")).length >= 2, "objects remain (orphans accepted)");
    assert.ok(r.logs.some((l) => /"event":"backup_cleanup_skipped"/.test(l)));
  });

  test(`design test 20 (c), ${op}: a key-fence refusal (410) is settled: every written object is deleted, nothing is published`, async () => {
    const s = fresh();
    s.hooks.beforePublish = async () => { await lib.shredWorkspaceKeys(s.env, WS); };
    const r = await silent(() => run(s, makeBackup(), `c410-${op}`));
    assert.equal(r.error?.status, 410, String(r.error));
    assert.equal(r.error?.code, "key_shredded");
    assert.deepEqual(projectsOf(s), []);
    assert.equal([...s.w.blobs.keys()].filter((k) => k.startsWith("blobs/")).length, 0, "every written object deleted");
    assert.ok(s.w.r2.deletes.length >= 2);
  });

  test(`design test 20 (c), ${op}: a plaintext-fence refusal (409 encryption_started) is settled: every written object is deleted`, async () => {
    const s = setup({ encryption: false, project: op !== "restore" });
    s.hooks.beforePublish = async () => {
      await lib.workspaceDataKey(lib.withAdapters({ ...s.w.env, ...keyVars() }, lib.defaultAdapters()), "wsp_someone_else");
    };
    const r = await silent(() => run(s, makeBackup(), `c409-${op}`));
    assert.ok(status(409, "encryption_started")(r.error), String(r.error));
    assert.deepEqual(projectsOf(s), []);
    assert.equal([...s.w.blobs.keys()].filter((k) => k.startsWith("blobs/")).length, 0);
  });

  test(`design test 20 (c), ${op}: an expired text intent (text_write_expired) is settled: every written object is deleted`, async () => {
    const s = fresh();
    s.hooks.beforePublish = async () => { s.w.sql.prepare("UPDATE content_writes SET created_at = 0").run(); };
    const r = await silent(() => run(s, makeBackup(), `cexp-${op}`));
    assert.ok(status(503, "text_write_expired")(r.error), String(r.error));
    assert.deepEqual(projectsOf(s), []);
    assert.equal([...s.w.blobs.keys()].filter((k) => k.startsWith("blobs/")).length, 0);
  });

  test(`design test 20 (c), ${op}: a pre-send failure (the 2nd object write throws) deletes the first object unconditionally`, async () => {
    const s = fresh();
    let n = 0;
    const put = s.w.env.BLOBS.put;
    s.w.env.BLOBS.put = async (k, b, o) => { if (k.startsWith("blobs/") && ++n === 2) throw new Error("synthetic R2 put failure"); return put(k, b, o); };
    const r = await silent(() => run(s, makeBackup(), `cpre-${op}`));
    assert.ok(r.error);
    assert.equal(s.w.r2.deletes.filter((k) => k.startsWith("blobs/")).length, 1, "the first object deleted");
    assert.equal([...s.w.blobs.keys()].filter((k) => k.startsWith("blobs/")).length, 0);
    assert.deepEqual(projectsOf(s), []);
  });

  test(`design test 20 (c'), ${op}: a settled case whose reference query throws deletes nothing and logs`, async () => {
    const s = fresh();
    s.hooks.beforePublish = async () => {
      await lib.shredWorkspaceKeys(s.env, WS);
      // After the batch fails, make dropUnreferencedBlobs' reference query fail.
      const prepare = s.w.env.DB.prepare;
      s.w.env.DB.prepare = (q) => { if (/json_each/.test(q) && /revisions WHERE blob_key/.test(q)) throw new Error("synthetic D1 failure"); return prepare(q); };
    };
    const r = await silent(() => run(s, makeBackup(), `cq-${op}`));
    assert.ok(status(410, "key_shredded")(r.error), String(r.error));
    assert.equal(s.w.r2.deletes.filter((k) => k.startsWith("blobs/")).length, 0, "no blob delete");
    assert.ok(r.logs.some((l) => /"event":"backup_cleanup_skipped"/.test(l)));
  });

  test(`design test 22, ${op}: a build error after the writes (a throwing descriptor) is a pre-send failure: all written objects deleted, nothing published`, async () => {
    const s = fresh();
    // Break the revision INSERT's binding: a value D1 cannot bind (a symbol) surfaces when the statement is built.
    const prepare = s.w.env.DB.prepare;
    s.w.env.DB.prepare = (q) => {
      const o = prepare(q);
      if (!/^\s*INSERT INTO revisions/.test(q)) return o;
      return { ...o, bind: () => { throw new TypeError("synthetic bind failure"); } };
    };
    const r = await silent(() => run(s, makeBackup(), `build-${op}`));
    assert.ok(r.error);
    assert.equal([...s.w.blobs.keys()].filter((k) => k.startsWith("blobs/")).length, 0, "all written objects deleted");
    assert.ok(s.w.r2.deletes.filter((k) => k.startsWith("blobs/")).length >= 2);
    assert.deepEqual(projectsOf(s), []);
  });
}

test("design test 20 (c), import: a FOREIGN KEY failure (the importer's admin role removed just before the batch) is settled: every object deleted, 403", async () => {
  const s = setup();
  s.hooks.beforePublish = async () => { s.w.sql.prepare("DELETE FROM workspace_members WHERE principal_id = ?").run(OWNER); };
  const r = await silent(() => lib.importBackup(s.ctx, WS, { backup: makeBackup() }, "fk-1"));
  assert.ok(r.error && r.error.status === 403, String(r.error));
  assert.equal([...s.w.blobs.keys()].filter((k) => k.startsWith("blobs/")).length, 0);
});

test("design test 20 (c), import: a resolved batch with res[0].changes === 0 (an empty backup, admin lost) needs no deletes", async () => {
  const s = setup();
  const bk = { ...makeBackup({ files: [], text: null }), artifacts: [] };
  s.hooks.beforePublish = async () => { s.w.sql.prepare("DELETE FROM workspace_members WHERE principal_id = ?").run(OWNER); };
  const r = await silent(() => lib.importBackup(s.ctx, WS, { backup: bk }, "empty-1"));
  assert.ok(r.error && r.error.status === 403, String(r.error));
  assert.deepEqual(s.w.r2.deletes, []);
});

// ---- Design test 21: pre-write validation ----

const invalid = [
  ["revisions.restored_from an object", (b) => { b.revisions[0].restored_from = { x: 1 }; }],
  ["revisions.via_id an object", (b) => { b.revisions[0].via_id = { x: 1 }; }],
  ["revisions.artifact_id names no artifact", (b) => { b.revisions[0].artifact_id = "art_none"; }],
  ["meta_versions.tags not a string", (b) => { b.meta_versions.push({ id: "mv1", artifact_id: "art_file", version: 1, title: "t", folder: "", tags: ["x"], trashed: 0, author_id: OWNER, created_at: at() }); }],
  ["meta_versions.restored_from an object", (b) => { b.meta_versions.push({ id: "mv1", artifact_id: "art_file", version: 1, title: "t", folder: "", tags: "[]", trashed: 0, author_id: OWNER, created_at: at(), restored_from: {} }); }],
  ["meta_versions.artifact_id names no artifact", (b) => { b.meta_versions.push({ id: "mv1", artifact_id: "art_none", version: 1, title: "t", folder: "", tags: "[]", trashed: 0, author_id: OWNER, created_at: at() }); }],
  ["comments.id an object", (b) => { b.comments[0].id = { x: 1 }; }],
  ["project.title not a string", (b) => { b.project.title = { x: 1 }; }],
  ["author_id not a string", (b) => { b.revisions[0].author_id = { x: 1 }; }],
];
for (const op of ["import", "restore"]) {
  for (const [label, mutate] of invalid) {
    test(`design test 21, ${op}: ${label} is 400 bad_backup with no R2 put`, async () => {
      const s = setup({ project: op !== "restore" });
      const bk = makeBackup();
      mutate(bk);
      const puts = [];
      const put = s.w.env.BLOBS.put;
      s.w.env.BLOBS.put = (k, b, o) => { puts.push(k); return put(k, b, o); };
      const run = op === "import" ? lib.importBackup(s.ctx, WS, { backup: bk }, `bad-${label}`) : lib.restoreBackup(s.ctx, bk);
      await assert.rejects(run, status(400, "bad_backup"), label);
      assert.deepEqual(puts, [], "no R2 put");
    });
  }
}

test("design test 21: import refuses meta_versions.via_label over 200; restore does not gain that limit (no backup that restores today is refused)", async () => {
  const mk = () => { const b = makeBackup(); b.meta_versions.push({ id: "mv1", artifact_id: "art_file", version: 1, title: "t", folder: "", tags: "[]", trashed: 0, author_id: OWNER, created_at: at(), via_label: "x".repeat(201) }); return b; };
  const s = setup();
  // import's existing str() limit answers 413 too_large, as it does today for a version's via_label.
  await assert.rejects(lib.importBackup(s.ctx, WS, { backup: mk() }, "vl"), (e) => e.status === 413 && e.code === "too_large");
  const r = setup({ project: false });
  assert.equal((await lib.restoreBackup(r.ctx, mk())).restored_project, "src-proj");
});

test("design test 21: a resulting storage key over 1,015 bytes is 400 bad_backup \"A file key is too long\", before any R2 put, for import and restore", async () => {
  const name = "r".repeat(1000);
  const mk = () => {
    const b = makeBackup({ text: null, files: [pngOf(100)] });
    const old = b.revisions[0].blob_key, key = `blobs/src-proj/art_file/${name}`;
    b.revisions[0].blob_key = key; b.blobs[key] = b.blobs[old]; delete b.blobs[old];
    return b;
  };
  for (const op of ["import", "restore"]) {
    const s = setup({ project: op !== "restore" });
    const puts = [];
    const put = s.w.env.BLOBS.put;
    s.w.env.BLOBS.put = (k, b, o) => { puts.push(k); return put(k, b, o); };
    await assert.rejects(op === "import" ? lib.importBackup(s.ctx, WS, { backup: mk() }, "long") : lib.restoreBackup(s.ctx, mk()),
      (e) => e.status === 400 && e.code === "bad_backup" && e.message === "A file key is too long", op);
    assert.deepEqual(puts, [], op);
  }
});

// ---- Addendum: restore must not start refusing backups it accepts today ----

for (const encryption of [false, true]) {
  test(`Addendum: an export holding a trashed file, a template, a meta-version baseline, an OAuth-authored version and a file version restores unchanged (encryption ${encryption ? "on" : "off"})`, async () => {
    const src = setup({ encryption });
    const pid = P;
    // A file version through the real upload path.
    const bytes = pngOf(5000);
    const b = await lib.uploadBegin(src.ctx, pid, { mime: "image/png", size: bytes.length, sha256: sha(bytes), title: "Kept.png" }, "ub-1");
    assert.equal((await src.w.put(b.body.upload_id, bytes)).status, 200);
    const file = (await lib.uploadFinish(src.ctx, pid, b.body.upload_id, "uf-1")).body.artifact_id;
    // A trashed file.
    const b2 = await lib.uploadBegin(src.ctx, pid, { mime: "image/png", size: bytes.length, sha256: sha(bytes), title: "Trashed.png" }, "ub-2");
    assert.equal((await src.w.put(b2.body.upload_id, bytes)).status, 200);
    const trashed = (await lib.uploadFinish(src.ctx, pid, b2.body.upload_id, "uf-2")).body.artifact_id;
    src.w.sql.prepare("UPDATE artifacts SET trashed_at = ? WHERE id = ?").run(at(), trashed);
    // A template and a meta-version baseline.
    const doc = await lib.createMarkdown(src.ctx, pid, { title: "Doc", body: "# doc body" }, "md-1");
    await lib.updateMetadata(src.ctx, pid, doc.body.artifact_id, { expected_meta_version: 1, title: "Doc renamed" }, "meta-1");
    await lib.saveAsTemplate(src.ctx, pid, { source_artifact_id: doc.body.artifact_id, source_revision: 1, title: "Tpl" }, "tpl-1");
    // An OAuth-authored version (its provenance as the OAuth path records it, with a long client_info, which import
    // would refuse but restore does not limit).
    const oauthCtx = { ...src.ctx, principal: { id: OWNER, kind: "human", label: "Synthetic owner" } };
    await lib.saveMarkdown(oauthCtx, pid, doc.body.artifact_id, { expected_revision: 1, body: "# second" }, "md-2");
    src.w.sql.prepare("UPDATE revisions SET via_kind = 'oauth', via_id = 'oc_synth', via_label = 'Synthetic client', client_info = ? WHERE artifact_id = ? AND rev_no = 2").run("c".repeat(600), doc.body.artifact_id);
    const exported = await lib.exportBackup(src.ctx, pid);
    const dst = setup({ encryption, project: false });
    const out = await lib.restoreBackup(dst.ctx, structuredClone(exported));
    assert.equal(out.restored_project, pid);
    const shape = (s) => ({
      artifacts: s.w.sql.prepare("SELECT id, kind, title, head_rev, trashed_at IS NOT NULL AS trashed, is_template FROM artifacts WHERE project_id = ? ORDER BY id").all(pid).map((r) => ({ ...r })),
      revisions: s.w.sql.prepare("SELECT id, rev_no, size, sha256, mime, via_kind, via_label, client_info FROM revisions WHERE project_id = ? ORDER BY id").all(pid).map((r) => ({ ...r })),
      metas: s.w.sql.prepare("SELECT artifact_id, version, title FROM meta_versions WHERE project_id = ? ORDER BY artifact_id, version").all(pid).map((r) => ({ ...r })),
    });
    assert.deepEqual(shape(dst), shape(src));
    assert.ok((await download(dst, pid, file)).equals(bytes));
    // A trashed file is not served by the content route; read its restored object through the checked reader.
    const tr = dst.w.sql.prepare("SELECT blob_key, size, blob_key_id, blob_header FROM revisions WHERE artifact_id = ?").get(trashed);
    assert.ok(Buffer.from(await lib.readBlobBytes(dst.env, await lib.blobRef(dst.env, tr, { projectId: pid, artifactId: trashed }))).equals(bytes));
    assert.ok(dst.w.sql.prepare("SELECT trashed_at FROM artifacts WHERE id = ?").get(trashed).trashed_at);
    if (encryption) for (const r of fileRows(dst, pid)) assert.match(r.blob_key_id, /^wk_/);
  });
}

// ---- Review fixes for part 3 ----

// What the restore at b2d81c8 bound for these fields: revisions.restored_from raw (r.restored_from),
// meta_versions.restored_from as `v.restored_from ?? null`, meta_versions.trashed as `v.trashed ? 1 : 0`. The stored
// value is what SQLite keeps after the column's INTEGER affinity, so the expectation binds the old values into a
// scratch table with the same column types.
for (const encryption of [false, true]) {
  test(`review fix (part 3): restore stores the same rows as before for restored_from "1" and 1.5 and an object-valued trashed (encryption ${encryption ? "on" : "off"})`, async () => {
    const s = setup({ encryption, project: false });
    const bk = makeBackup();
    bk.revisions[0].restored_from = "1";
    bk.revisions[1].restored_from = 1.5;
    bk.meta_versions.push({ id: "mv1", artifact_id: "art_file", version: 1, title: "t", folder: "", tags: "[]", trashed: { odd: true }, author_id: OWNER, created_at: at(), restored_from: "2" });
    bk.meta_versions.push({ id: "mv2", artifact_id: "art_file", version: 2, title: "t", folder: "", tags: "[]", trashed: 0, author_id: OWNER, created_at: at(), restored_from: 2.5 });
    await lib.restoreBackup(s.ctx, bk);
    s.w.sql.exec("CREATE TEMP TABLE old_bind (id TEXT, restored_from INTEGER, trashed INTEGER)");
    const oldBind = s.w.sql.prepare("INSERT INTO old_bind (id, restored_from, trashed) VALUES (?, ?, ?)");
    oldBind.run("rev_f1", bk.revisions[0].restored_from, null);
    oldBind.run("rev_f2", bk.revisions[1].restored_from, null);
    for (const v of bk.meta_versions) oldBind.run(v.id, v.restored_from ?? null, v.trashed ? 1 : 0);
    const expected = (id) => ({ ...s.w.sql.prepare("SELECT restored_from, typeof(restored_from) AS t FROM old_bind WHERE id = ?").get(id) });
    for (const id of ["rev_f1", "rev_f2"]) assert.deepEqual({ ...s.w.sql.prepare("SELECT restored_from, typeof(restored_from) AS t FROM revisions WHERE id = ?").get(id) }, expected(id), id);
    for (const id of ["mv1", "mv2"]) {
      assert.deepEqual({ ...s.w.sql.prepare("SELECT restored_from, typeof(restored_from) AS t FROM meta_versions WHERE id = ?").get(id) }, expected(id), id);
      assert.equal(s.w.sql.prepare("SELECT trashed FROM meta_versions WHERE id = ?").get(id).trashed, s.w.sql.prepare("SELECT trashed FROM old_bind WHERE id = ?").get(id).trashed, id);
    }
    // Import keeps its stricter rules for the same values.
    const t = setup({ encryption });
    await assert.rejects(lib.importBackup(t.ctx, WS, { backup: structuredClone(bk) }, "strict-1"), status(400, "bad_backup"));
  });
}

/** A backup whose file revision for document A names a key under document B (export never produces this). */
function crossDocBackup() {
  const bk = makeBackup({ files: [pngOf(4000)] });
  bk.artifacts.push({ ...bk.artifacts[0], id: "art_other", title: "Other.png", head_revision_id: "rev_o1", head_rev: 1 });
  const bytes = pngOf(3000);
  const key = "blobs/src-proj/art_other/rev_o1";
  bk.revisions.push({ ...bk.revisions[0], id: "rev_o1", artifact_id: "art_other", rev_no: 1, blob_key: key, size: bytes.length, sha256: sha(bytes) });
  bk.blobs[key] = { sha256: sha(bytes), data: bytes.toString("base64") };
  // rev_f1 (document art_file) now points at art_other's key and bytes.
  Object.assign(bk.revisions[0], { blob_key: key, size: bytes.length, sha256: sha(bytes) });
  delete bk.blobs["blobs/src-proj/art_file/rev_f1"];
  return { bk, bytes };
}

test("review fix (part 3): import refuses a file version whose key lies in another document, before any write", async () => {
  const s = setup();
  const puts = [];
  const put = s.w.env.BLOBS.put;
  s.w.env.BLOBS.put = (k, b, o) => { puts.push(k); return put(k, b, o); };
  await assert.rejects(lib.importBackup(s.ctx, WS, { backup: crossDocBackup().bk }, "xdoc"), (e) => e.status === 400 && e.code === "bad_backup" && e.message === "A file key does not match its document");
  assert.deepEqual(puts, []);
});

for (const encryption of [false, true]) {
  test(`review fix (part 3): restore of a version whose key lies in another document still restores, under a key in its own document, and both versions read (encryption ${encryption ? "on" : "off"})`, async () => {
    const s = setup({ encryption, project: false });
    const { bk, bytes } = crossDocBackup();
    await lib.restoreBackup(s.ctx, bk);
    const rows = fileRows(s, "src-proj");
    for (const r of rows) assert.ok(r.blob_key.startsWith(`blobs/src-proj/${r.artifact_id}/`), `${r.id} under its own document`);
    assert.ok((await download(s, "src-proj", "art_file", 1)).equals(bytes), "the cross-document version reads");
    assert.ok((await download(s, "src-proj", "art_other", 1)).equals(bytes));
    assert.notEqual(rows.find((r) => r.id === "rev_f1").blob_key, rows.find((r) => r.id === "rev_o1").blob_key, "two objects");
  });
}

test("review fix (part 3): an exception from commitTextWrites after the batch resolved (constraint-looking text, batchError null) deletes no file and logs backup_cleanup_skipped", async () => {
  for (const op of ["import", "restore"]) {
    const s = setup({ project: op !== "restore" });
    const bk = makeBackup();
    const batch = s.w.env.DB.batch;
    s.w.env.DB.batch = async (ss) => {
      const r = await batch(ss);
      if (!ss.some((x) => /INSERT INTO projects/.test(x.q))) return r;
      // An array-like result whose slice (commitTextWrites strips its guard result with it) throws after the commit.
      return new Proxy(r, { get: (t, k) => k === "slice" ? () => { throw new Error("UNIQUE constraint failed: synthetic.helper"); } : t[k] });
    };
    const out = await silent(() => op === "import" ? lib.importBackup(s.ctx, WS, { backup: bk }, "helper-1") : lib.restoreBackup(s.ctx, bk));
    assert.ok(out.error, op);
    assert.deepEqual(s.w.r2.deletes.filter((k) => k.startsWith("blobs/")), [], `${op}: no file object deleted`);
    assert.ok(out.logs.some((l) => /"event":"backup_cleanup_skipped"/.test(l) && /outcome_unknown/.test(l)), out.logs.join("\n"));
    const pid = s.w.sql.prepare("SELECT id FROM projects WHERE id <> ?").get(P).id;
    for (const r of fileRows(s, pid)) {
      const src = bk.revisions.filter((x) => x.blob_key)[r.rev_no - 1];
      assert.ok((await download(s, pid, r.artifact_id, r.rev_no)).equals(Buffer.from(bk.blobs[src.blob_key].data, "base64")), `${op}: reads back`);
    }
  }
});

test("review fix (part 3): after a pre-send file-write failure, staged text objects and intents are left for the content-writes sweep, which reclaims them", async () => {
  const s = setup();
  const put = s.w.env.BLOBS.put;
  s.w.env.BLOBS.put = async (k, b, o) => { if (k.startsWith("blobs/")) throw new Error("synthetic R2 put failure"); return put(k, b, o); };
  await silent(() => lib.importBackup(s.ctx, WS, { backup: makeBackup() }, "pre-send-text"));
  const intents = s.w.sql.prepare("SELECT key FROM content_writes").all().map((r) => r.key);
  assert.ok(intents.length >= 2, "text and comment intents remain");
  for (const k of intents) {
    assert.ok(s.w.blobs.has(k), "the staged text object exists");
    assert.equal(s.w.sql.prepare("SELECT 1 AS x FROM revisions WHERE body_key = ? UNION ALL SELECT 1 FROM comments WHERE body_key = ?").get(k, k), undefined, "unreferenced");
  }
  s.w.env.BLOBS.put = put;
  s.w.sql.prepare("UPDATE content_writes SET created_at = 0").run();
  await lib.reconcileUploads(s.env);
  assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM content_writes").get().n, 0, "intents removed by the sweep");
  for (const k of intents) assert.equal(s.w.blobs.has(k), false, "text object reclaimed");
});

// ---- Review Lows for part 4: restore stores exactly what the restore at b2d81c8 stored ----

const commentBodies = (s, pid) => Promise.all(s.w.sql.prepare("SELECT id, body_key FROM comments WHERE project_id = ? ORDER BY id").all(pid).map(async (c) => [c.id, Buffer.from(s.w.blobs.get(c.body_key)).toString("utf8")]));

for (const encryption of [false, true]) {
  test(`review Lows (part 4): a comment body that is not a string is stored as its string form, as before (encryption ${encryption ? "on" : "off"}); import still refuses it`, async () => {
    const s = setup({ encryption, project: false });
    const bk = makeBackup();
    const base = bk.comments[0];
    bk.comments = [{ ...base, id: "cmt_obj", body: { odd: true } }, { ...base, id: "cmt_num", body: 5 }, { ...base, id: "cmt_list", body: [1, 2] }, { ...base, id: "cmt_bool", body: false }];
    await lib.restoreBackup(s.ctx, bk);
    // b2d81c8 wrote each comment with putText(new TextEncoder().encode(c.body)): the value's string form.
    assert.deepEqual(await commentBodies(s, "src-proj"), [["cmt_bool", "false"], ["cmt_list", "1,2"], ["cmt_num", "5"], ["cmt_obj", "[object Object]"]]);
    const t = setup({ encryption });
    await assert.rejects(lib.importBackup(t.ctx, WS, { backup: structuredClone(bk) }, "cbody"), status(400, "bad_backup"));
  });

  test(`review Lows (part 4): document references match as the database stores ids: a number and a string match exactly when their stored text is equal (encryption ${encryption ? "on" : "off"})`, async () => {
    // A TEXT column stores a bound number as its REAL text form (D1 binds every number as REAL; node:sqlite binds a
    // JS number as REAL too): 7 is stored "7.0". So the reference 7 matched a document "7.0" before (the foreign key
    // compares stored values) and never matched "7" (the old batch failed on the foreign key, after writing files).
    const s = setup({ encryption, project: false });
    const bytes = pngOf(5000);
    const bk = makeBackup({ files: [bytes] });
    bk.artifacts[0].id = "7.0";
    Object.assign(bk.revisions[0], { artifact_id: 7, blob_key: "blobs/src-proj/seven/rev_f1" });
    bk.blobs = { "blobs/src-proj/seven/rev_f1": bk.blobs["blobs/src-proj/art_file/rev_f1"] };
    bk.meta_versions.push({ id: "mv7", artifact_id: 7, version: 1, title: "t", folder: "", tags: "[]", trashed: 0, author_id: OWNER, created_at: at() });
    bk.comments[0].artifact_id = 8;
    bk.artifacts[1].id = 8; // the text document's id is a number (stored "8.0"); its version names it as "8.0"
    bk.revisions[1].artifact_id = "8.0";
    await lib.restoreBackup(s.ctx, bk);
    assert.deepEqual(s.w.sql.prepare("SELECT id, typeof(id) AS t FROM artifacts WHERE project_id = 'src-proj' ORDER BY id").all().map((r) => ({ ...r })), [{ id: "7.0", t: "text" }, { id: "8.0", t: "text" }]);
    assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM revisions WHERE artifact_id = '7.0'").get().n, 1);
    assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM meta_versions WHERE artifact_id = '7.0'").get().n, 1);
    assert.equal(s.w.sql.prepare("SELECT COUNT(*) AS n FROM comments WHERE artifact_id = '8.0'").get().n, 1);
    assert.ok((await download(s, "src-proj", "7.0")).equals(bytes), "the file reads under its document's stored id");
    assert.equal((await lib.getArtifact(s.ctx, "src-proj", "8.0")).body, "# synthetic text\n");
    // 7 against "7" (and "8" against 8) never matched: refused before any write, where the old batch failed.
    for (const mutate of [(b) => { b.artifacts[0].id = "7"; for (const r of b.revisions.filter((r) => r.blob_key)) r.artifact_id = 7; }, (b) => { b.artifacts[1].id = 8; b.revisions.find((r) => !r.blob_key).artifact_id = "8"; b.comments[0].artifact_id = 8; }]) {
      const t = setup({ encryption, project: false });
      const bad = makeBackup();
      mutate(bad);
      const puts = [];
      const put = t.w.env.BLOBS.put;
      t.w.env.BLOBS.put = (k, b, o) => { puts.push(k); return put(k, b, o); };
      await assert.rejects(lib.restoreBackup(t.ctx, bad), (e) => e.status === 400 && e.message === "Revision for an unknown document");
      assert.deepEqual(puts, []);
    }
    // Import keeps comparing ids exactly.
    const u = setup({ encryption });
    await assert.rejects(lib.importBackup(u.ctx, WS, { backup: structuredClone(bk) }, "numid"), status(400, "bad_backup"));
  });

  test(`review Lows (part 4): a list of byte values binds as a BLOB, as D1 bound it before; restore keeps it, import refuses it (encryption ${encryption ? "on" : "off"})`, async () => {
    const s = setup({ encryption, project: false });
    const bk = makeBackup();
    bk.revisions[0].via_label = [104, 105];
    await lib.restoreBackup(s.ctx, bk);
    const row = s.w.sql.prepare("SELECT typeof(via_label) AS t, hex(via_label) AS h FROM revisions WHERE id = 'rev_f1'").get();
    assert.deepEqual({ ...row }, { t: "blob", h: "6869" });
    const t = setup({ encryption });
    await assert.rejects(lib.importBackup(t.ctx, WS, { backup: structuredClone(bk) }, "bytes"), status(400, "bad_backup"));
  });

  test(`review Lows (part 4): document ids holding "/" or "%" restore with their files under URI-encoded prefixes that read back, and no document's prefix holds another's keys (encryption ${encryption ? "on" : "off"})`, async () => {
    const s = setup({ encryption, project: false });
    const ids = ["a", "a/b", "a%2Fb", "50%"];
    const files = new Map(ids.map((id) => [id, pngOf(3000 + id.length)]));
    const bk = makeBackup({ files: [] });
    bk.artifacts = bk.artifacts.filter((a) => a.id !== "art_file");
    bk.blobs = {};
    ids.forEach((id, i) => {
      const bytes = files.get(id), key = `blobs/src-proj/seg${i}/rev_${i}`;
      bk.artifacts.push({ ...bk.artifacts[0], id, kind: "binary", title: `F${i}.png`, head_rev: 1, head_revision_id: `rev_${i}` });
      bk.revisions.push({ id: `rev_${i}`, artifact_id: id, rev_no: 1, author_id: OWNER, body: null, blob_key: key, size: bytes.length, sha256: sha(bytes), mime: "image/png", restored_from: null, created_at: at(), via_kind: "browser", via_id: null, via_label: null, client_info: null, change_note: null });
      bk.blobs[key] = { sha256: sha(bytes), data: bytes.toString("base64") };
    });
    await lib.restoreBackup(s.ctx, bk);
    const rows = fileRows(s, "src-proj");
    assert.equal(rows.length, ids.length);
    const prefix = (id) => `blobs/src-proj/${encodeURIComponent(id)}/`;
    for (const r of rows) {
      assert.ok(r.blob_key.startsWith(prefix(r.artifact_id)), `${r.artifact_id}: ${r.blob_key}`);
      for (const other of ids) if (other !== r.artifact_id) assert.ok(!r.blob_key.startsWith(prefix(other)), `${r.blob_key} not under ${other}`);
      const full = s.w.sql.prepare("SELECT blob_key, size, blob_key_id, blob_header FROM revisions WHERE id = ?").get(r.id);
      assert.ok(Buffer.from(await lib.readBlobBytes(s.env, await lib.blobRef(s.env, full, { projectId: "src-proj", artifactId: r.artifact_id }))).equals(files.get(r.artifact_id)), r.artifact_id);
      assert.ok((await download(s, "src-proj", r.artifact_id)).equals(files.get(r.artifact_id)), `download ${r.artifact_id}`);
      // Another document's id never passes this object's prefix check.
      if (encryption) for (const other of ids) if (other !== r.artifact_id)
        await assert.rejects(silent(async () => { const x = await lib.blobRef(s.env, full, { projectId: "src-proj", artifactId: other }); return lib.readBlobBytes(s.env, x); }).then((o) => { if (o.error) throw o.error; }), status(500, "blob_corrupt"));
    }
    // Export reads every file back.
    const exported = await lib.exportBackup(s.ctx, "src-proj");
    for (const r of exported.revisions.filter((r) => r.blob_key)) assert.ok(Buffer.from(exported.blobs[r.blob_key].data, "base64").equals(files.get(r.artifact_id)));
  });
}
