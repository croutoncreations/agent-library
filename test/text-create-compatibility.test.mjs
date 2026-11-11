// Literal observations from the real c980189 bundle, built under /tmp/al-tu-c980189-source.
// App API off calls createMarkdown; App API on and /v1 call createFile. Direct MCP/template callers retain createMarkdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./load-worker.mjs";
import { P, world } from "./upload-world.mjs";
const lib = await loadWorker({ "service.js": ["createMarkdown", "createFile"], "adapters.js": ["withAdapters", "defaultAdapters"] });
const sha256 = "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5";
const digests = {
  markdown: { schema: "6a5be69a114f807533c65f1bc589e5357d6e9d0e6dfebea1626918b0dd5fe560", folder: "047f8abda7df9dad8a2685b815b4367f41f54ada7a70e2395b56f0b2b77f9af6" },
  html: { schema: "f956ee830bf8cde57f23196f56a81b6040d44050bc5482200e20a3550b8bcaae", folder: "c5ee964cc82d911ab772ad3879334a88fd1d239440bba045dc8b7c9c7a7a38a0" }
};
for (const enabled of [false, true]) for (const wrapper of [false, true]) for (const kind of ["markdown", "html"]) {
  for (const variant of ["schema", "folder", "missing-folder", "schema-and-missing-folder", "bad-title-and-schema"]) {
    test(`c980189 create compatibility: appConnect=${enabled}, wrapper=${wrapper}, ${kind}, ${variant}`, async () => {
      const w = world(); w.env.APP_CONNECT_ENABLED = enabled ? "1" : "0"; w.ctx.env = lib.withAdapters(w.env, lib.defaultAdapters());
      w.sql.prepare("INSERT INTO folders (id, project_id, name, name_key, created_at, created_by) VALUES ('fld_present', ?, 'Present', 'present', '2000-01-01', 'hum_synthetic')").run(P);
      const input = { kind, title: "Pinned", body: "body", ...variant.includes("schema") ? { schema: "ignored" } : {}, ...variant === "folder" ? { folder_id: "fld_present" } : {}, ...variant.includes("missing-folder") ? { folder_id: "fld_absent" } : {}, ...variant === "bad-title-and-schema" ? { title: "" } : {} };
      const call = () => wrapper ? lib.createFile(w.ctx, P, input, "pinned") : lib.createMarkdown(w.ctx, P, input, "pinned", kind);
      const schemaError = wrapper && variant.includes("schema");
      const folderGate = wrapper && !enabled && (variant === "folder" || variant === "missing-folder");
      const message = schemaError ? "schema is only allowed for json or csv files" : folderGate ? "Not found" : variant.includes("missing-folder") ? "Folder not found" : variant === "bad-title-and-schema" ? "title too short" : null;
      if (message) {
        const status = message === "Not found" || message === "Folder not found" ? 404 : 400;
        await assert.rejects(call, e => { assert.deepEqual({ status: e.status, code: e.code, message: e.message }, { status, code: status === 404 ? "not_found" : "invalid_input", message }); return true; });
      } else {
        const r = await call(), { artifact_id, revision_id, ...body } = r.body;
        assert.match(artifact_id, /^art_/); assert.match(revision_id, /^rev_/);
        assert.equal(r.status, 201);
        assert.deepEqual(body, kind === "markdown" && variant === "schema" ? { revision: 1, sha256 } : { kind, folder_id: variant === "folder" ? "fld_present" : null, schema: null, revision: 1, sha256 });
        assert.equal(w.sql.prepare("SELECT digest FROM idempotency").get().digest, digests[kind][variant]);
        assert.equal((await call()).body.idempotent_replay, true);
      }
    });
  }
}
