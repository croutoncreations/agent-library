// saveMarkdown/saveFile refuse an oversized body after loading the document, so the message names its kind, and (App
// Connect off) a document that cannot take the save answers that refusal instead of 413. Real bundle over node:sqlite
// with every migration (upload-world.mjs). Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { P, lib, world } from "./upload-world.mjs";

const OVER = "x".repeat(10 * 1048576 + 1);
function configured(enabled) {
  const w = world(); w.env.APP_CONNECT_ENABLED = enabled ? "1" : "0"; w.ctx.env = lib.withAdapters(w.env, lib.defaultAdapters()); return w;
}
const refused = (status, code, message) => (e) => { assert.deepEqual([e.status, e.code, e.message], [status, code, message]); return true; };

for (const enabled of [false, true]) test(`an oversized save names the document's kind, App Connect=${enabled}`, async () => {
  const w = configured(enabled);
  for (const kind of ["markdown", "html"]) {
    const id = (await lib.createMarkdown(w.ctx, P, { title: `Synthetic ${kind}`, body: "x" }, "create-" + kind, kind)).body.artifact_id;
    for (const saver of ["saveMarkdown", "saveFile"])
      await assert.rejects(lib[saver](w.ctx, P, id, { expected_revision: 1, body: OVER }, `${saver}-${kind}`),
        refused(413, "too_large", kind === "html" ? "HTML exceeds 10 MiB" : "Markdown exceeds 10 MiB"));
  }
});

test("App Connect off: an oversized save to a missing, trashed or non-text document answers that refusal, not 413", async () => {
  const w = configured(false);
  const json = (await lib.createMarkdown(w.ctx, P, { title: "Synthetic data", content: "{}" }, "create-json", "json")).body.artifact_id;
  const trashed = (await lib.createMarkdown(w.ctx, P, { title: "Synthetic trashed", body: "x" }, "create-trashed")).body.artifact_id;
  w.sql.prepare("UPDATE artifacts SET trashed_at = 1 WHERE id = ?").run(trashed);
  for (const saver of ["saveMarkdown", "saveFile"]) {
    await assert.rejects(lib[saver](w.ctx, P, json, { expected_revision: 1, body: OVER }, saver + "-json"), refused(400, "invalid_input", "Not a Markdown or HTML document"));
    for (const id of [trashed, "art_nonexistent"])
      await assert.rejects(lib[saver](w.ctx, P, id, { expected_revision: 1, body: OVER }, saver + "-" + id), refused(404, "not_found", "Artifact not found"));
  }
});

// Control: with App Connect on, saveFile already loads the document first, so a missing id was 404 before this fix and stays 404.
test("App Connect on: an oversized save to a missing document is 404 (unchanged)", async () => {
  const w = configured(true);
  await assert.rejects(lib.saveFile(w.ctx, P, "art_nonexistent", { expected_revision: 1, body: OVER }, "on-missing"), refused(404, "not_found", "Artifact not found"));
});
