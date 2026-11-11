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
