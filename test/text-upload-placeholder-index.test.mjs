import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { P, lib, world } from "./upload-world.mjs";

for (const projectId of [undefined, P]) test(`real orphan-placeholder SQL uses 0028: ${projectId ? "project" : "global"}`, async () => {
  const w = world(), queries = [], prepare = w.env.DB.prepare;
  w.env.DB.prepare = q => {
    const stmt = prepare(q);
    return { ...stmt, bind(...p) { if (q.startsWith("SELECT a.id FROM artifacts a")) queries.push({ q, p }); return stmt.bind(...p); } };
  };
  await lib.reconcileUploads(w.env, { projectId });
  assert.equal(queries.length, 1);
  const { q, p } = queries[0], explain = () => w.sql.prepare("EXPLAIN QUERY PLAN " + q).all(...p).map(r => r.detail);
  w.sql.exec("DROP INDEX artifacts_unpublished");
  const before = explain();
  assert.ok(before.includes(projectId ? "SEARCH a USING INDEX artifacts_folder (project_id=?)" : "SCAN a"));
  const migration = readFileSync(new URL("../migrations/0028_text_upload_placeholders.sql", import.meta.url), "utf8");
  w.sql.exec(migration); w.sql.exec(migration); // retry-safe; 0026 is deliberately retained
  const after = explain();
  assert.ok(after.some(d => /(?:SCAN|SEARCH) a USING INDEX artifacts_unpublished/.test(d)));
  assert.ok(after.every(d => !/^SCAN (?:a|artifacts|r|revisions)$/.test(d)));
  assert.ok(w.sql.prepare("SELECT 1 FROM sqlite_master WHERE name = 'artifacts_placeholders'").get());
  console.log(JSON.stringify({ scope: projectId ? "project" : "global", query: q, before, after }));
});
