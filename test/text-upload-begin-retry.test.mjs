import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { P, lib, world } from "./upload-world.mjs";
const sha = text => createHash("sha256").update(text).digest("hex");
function configured(enabled) {
  const w = world(); w.env.APP_CONNECT_ENABLED = enabled ? "1" : "0"; w.ctx.env = lib.withAdapters(w.env, lib.defaultAdapters()); return w;
}
for (const enabled of [false, true]) for (const saver of ["saveMarkdown", "saveFile"]) test(`begin retry after trash matches ${saver}, App Connect=${enabled}`, async () => {
  const w = configured(enabled);
  const a = await lib.createMarkdown(w.ctx, P, { title: "Retry", body: "first" }, "create");
  const id = a.body.artifact_id, saveInput = { expected_revision: 1, body: "second" };
  await lib[saver](w.ctx, P, id, saveInput, "save");
  const input = { artifact_id: id, expected_revision: 2, mime: "text/markdown", size: 5, sha256: sha("third") };
  const first = await lib.uploadBegin(w.ctx, P, input, "begin", { allowText: true });
  w.sql.prepare("UPDATE artifacts SET trashed_at = 1 WHERE id = ?").run(id);
  assert.equal((await lib[saver](w.ctx, P, id, saveInput, "save")).body.idempotent_replay, true);
  const retry = await lib.uploadBegin(w.ctx, P, input, "begin", { allowText: true });
  assert.equal(retry.body.upload_id, first.body.upload_id); assert.equal(retry.body.idempotent_replay, true);
  await assert.rejects(lib.uploadBegin(w.ctx, P, input, "new-begin", { allowText: true }), e => e.status === 404 && e.message === "Artifact not found");
});

const mimes = { markdown: "text/markdown", html: "text/html", json: "application/json", csv: "text/csv" };
for (const kind of Object.keys(mimes)) test(`fresh ${kind} target: trash and nonexistent are indistinguishable for every MIME`, async () => {
  const w = configured(true);
  const a = await lib.createMarkdown(w.ctx, P, { title: "Trash", body: "x", content: kind === "json" ? "{}" : "h\n" }, "create", kind);
  w.sql.prepare("UPDATE artifacts SET trashed_at = 1 WHERE id = ?").run(a.body.artifact_id);
  const expected = { status: 404, code: "not_found", message: "Artifact not found" };
  for (const mime of Object.values(mimes)) for (const artifact_id of [a.body.artifact_id, "art_nonexistent"]) {
    await assert.rejects(lib.uploadBegin(w.ctx, P, { artifact_id, expected_revision: 1, mime, size: 1, sha256: sha("x") }, "fresh-" + mime + artifact_id, { allowText: true }), e => {
      assert.deepEqual({ status: e.status, code: e.code, message: e.message }, expected); return true;
    });
  }
});

test("replacement begin replays after protection; a fresh wrong-MIME call still reports protection first", async () => {
  const w = configured(true), a = await lib.createMarkdown(w.ctx, P, { title: "Protected", body: "x" }, "create");
  const input = { artifact_id: a.body.artifact_id, expected_revision: 1, mime: mimes.markdown, size: 1, sha256: sha("x") };
  const first = await lib.uploadBegin(w.ctx, P, input, "begin", { allowText: true });
  w.sql.prepare("UPDATE artifacts SET publisher_id = 'pub_synthetic' WHERE id = ?").run(a.body.artifact_id);
  const replay = await lib.uploadBegin(w.ctx, P, input, "begin", { allowText: true });
  assert.equal(replay.body.upload_id, first.body.upload_id); assert.equal(replay.body.idempotent_replay, true);
  await assert.rejects(lib.uploadBegin(w.ctx, P, { ...input, mime: mimes.html }, "fresh", { allowText: true }), e => e.status === 403 && e.code === "protected_source" && e.message === "This file is a source export owned by a connected app and cannot be modified here");
});

for (const explicitFirst of [false, true]) test(`replacement begin schema is request-owned in the digest: explicitFirst=${explicitFirst}`, async () => {
  const w = configured(true), schema = "agentlib.measurements/1", content = JSON.stringify({ schema, records: [] });
  const a = await lib.createMarkdown(w.ctx, P, { title: "Schema", content, schema }, "create", "json");
  const input = { artifact_id: a.body.artifact_id, expected_revision: 1, mime: mimes.json, size: content.length, sha256: sha(content) };
  await lib.uploadBegin(w.ctx, P, { ...input, ...explicitFirst ? { schema } : {} }, "schema-key", { allowText: true });
  await assert.rejects(lib.uploadBegin(w.ctx, P, { ...input, ...explicitFirst ? {} : { schema } }, "schema-key", { allowText: true }), e => e.status === 422 && e.code === "idempotency_key_reused");
});

test("replacement begin treats absent and null schema alike in its digest", async () => {
  const w = configured(true), a = await lib.createMarkdown(w.ctx, P, { title: "No schema", body: "x" }, "create");
  const input = { artifact_id: a.body.artifact_id, expected_revision: 1, mime: mimes.markdown, size: 1, sha256: sha("x") };
  const first = await lib.uploadBegin(w.ctx, P, input, "null-schema", { allowText: true });
  const replay = await lib.uploadBegin(w.ctx, P, { ...input, schema: null }, "null-schema", { allowText: true });
  assert.equal(replay.body.upload_id, first.body.upload_id); assert.equal(replay.body.idempotent_replay, true);
});

test("create begin and JSON create both check a deleted folder before replay", async () => {
  const w = configured(true);
  w.sql.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by) VALUES ('fld_retry', ?, 'Retry', 'retry', '2000-01-01', 'hum_synthetic')").run(P);
  const metadata = { title: "Retry", folder_id: "fld_retry" };
  await lib.createMarkdown(w.ctx, P, { ...metadata, body: "x" }, "create");
  const input = { ...metadata, mime: "text/markdown", size: 1, sha256: sha("x") };
  await lib.uploadBegin(w.ctx, P, input, "begin", { allowText: true });
  w.sql.prepare("DELETE FROM folders WHERE id = 'fld_retry'").run();
  for (const call of [() => lib.createMarkdown(w.ctx, P, { ...metadata, body: "x" }, "create"), () => lib.uploadBegin(w.ctx, P, input, "begin", { allowText: true })]) {
    await assert.rejects(call, e => e.status === 404 && e.code === "not_found" && e.message === "Folder not found");
  }
});
