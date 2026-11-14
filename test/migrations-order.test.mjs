// Migration ordering, history and safety policy. Uses an in-memory SQLite database
// (node:sqlite) only; never touches D1 or production data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readMigrations, planMigrations, MIGRATION_NAME } from '../scripts/deploy/lib.mjs';

// Migrations released before the deploy pipeline existed (some rebuild tables). Every migration after
// these must be additive and retry-safe so existing installations can be upgraded automatically.
const HISTORIC = [
  '0001_init.sql', '0002_rate_limits.sql', '0003_upload_cleanup.sql', '0004_oauth_connections.sql',
  '0005_oauth_code_redemptions.sql', '0006_oauth_connection_projects.sql', '0007_api_credentials.sql',
  '0008_app_connect_files.sql', '0009_html_documents.sql', '0009_publisher_generations.sql',
];
const target = { appliedMigrationsAtBaseline: HISTORIC };
const repo = readMigrations('migrations');
const names = repo.map((m) => m.name);

test('migration filenames are well formed and unique by full name', () => {
  for (const n of names) assert.match(n, MIGRATION_NAME);
  assert.equal(new Set(names).size, names.length);
});

test('released migration history is a prefix of the repository order', () => {
  // wrangler applies files in filename order; every installation's d1_migrations order must match.
  assert.deepEqual(names.slice(0, target.appliedMigrationsAtBaseline.length), target.appliedMigrationsAtBaseline);
  // An owner-approved destructive migration is never auto-applied: the plan refuses until the owner has run it in a manual
  // window (docs/deploy-pipeline.md#destructive-migrations), and continues after it.
  const base = target.appliedMigrationsAtBaseline.length, search = names.indexOf('0031_search_contentless.sql');
  assert.deepEqual(planMigrations(target.appliedMigrationsAtBaseline, repo.slice(0, search)).map((m) => m.name), names.slice(base, search));
  assert.throws(() => planMigrations(target.appliedMigrationsAtBaseline, repo), /manual owner-run window.*0031_search_contentless\.sql/);
  const rebuild = names.indexOf('0034_oauth_connections_nullable_project.sql');
  assert.deepEqual(planMigrations(names.slice(0, search + 1), repo.slice(0, rebuild)).map((m) => m.name), names.slice(search + 1, rebuild));
  assert.throws(() => planMigrations(names.slice(0, search + 1), repo), /manual owner-run window.*0034_oauth_connections_nullable_project\.sql/);
  assert.deepEqual(planMigrations(names.slice(0, rebuild + 1), repo).map((m) => m.name), names.slice(rebuild + 1));
});

test('0031_search_contentless.sql drops only the derived search index and carries the owner approval', () => {
  const m = repo.find((x) => x.name === '0031_search_contentless.sql');
  assert.ok(m.destructive && m.approved);
  assert.deepEqual(repo.filter((x) => x.destructive && !HISTORIC.includes(x.name)).map((x) => x.name), ['0031_search_contentless.sql', '0034_oauth_connections_nullable_project.sql']);
});

test('0034 is the only rebuild of oauth_connections, carries the owner approval and 0035 (label) is additive', () => {
  const rebuild = repo.find((x) => x.name === '0034_oauth_connections_nullable_project.sql');
  assert.ok(rebuild.destructive && rebuild.approved);
  const label = repo.find((x) => x.name === '0035_oauth_connection_label.sql');
  assert.ok(!label.destructive, '0035 must stay additive so the pipeline can auto-apply it');
  assert.match(label.sql, /ALTER TABLE oauth_connections ADD COLUMN label TEXT;/);
  // Pipeline order: a database at 0033 refuses until 0034 has been run by hand, then applies 0035 on its own.
  const at33 = names.indexOf('0033_proposal_text_keys.sql');
  assert.throws(() => planMigrations(names.slice(0, at33 + 1), repo), /manual owner-run window.*0034_oauth_connections_nullable_project\.sql/);
  assert.deepEqual(planMigrations(names.slice(0, at33 + 2), repo).map((m) => m.name), ['0035_oauth_connection_label.sql']);
});

test('0034 rebuilds oauth_connections: rows, columns and all four indexes survive, project_id accepts NULL, and the foreign key from oauth_connection_projects still holds', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of repo.filter((x) => x.name < '0034')) db.exec(m.sql);
  const at = '2026-11-14T00:00:00Z';
  db.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES ('hum_a','human','synthetic','a','A',?)").run(at);
  db.prepare("INSERT INTO projects (id, owner_id, title, created_at, workspace_id) VALUES ('prj_a','hum_a','A',?,'wsp_hum_a')").run(at);
  const conn = (id, ws) => db.prepare(`INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, oauth_grant_id, created_at, expires_at, revoked_at, last_used_at, client_info, file_access, workspace_id, created_by)
    VALUES (?, 'hum_a', 'prj_a', 'cid', 'Claude', 'https://claude.example/cb', 'https://mcp.example.test/mcp', 1, 1, 'g1', ?, 99, NULL, 5, 'Claude 1.0', 1, ?, 'hum_a')`).run(id, at, ws);
  conn('oac_one', 'wsp_hum_a'); conn('oac_legacy', null);
  db.prepare("INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) VALUES ('oac_one','prj_a',1)").run();
  const plain = (rows) => rows.map((r) => ({ ...r }));
  const before = plain(db.prepare('SELECT * FROM oauth_connections ORDER BY id').all());
  const colsBefore = db.prepare('PRAGMA table_info(oauth_connections)').all().map((c) => [c.name, c.type]);
  // D1 applies a migration file as one transaction; defer_foreign_keys only lasts until its commit.
  const rebuild = repo.find((x) => x.name === '0034_oauth_connections_nullable_project.sql').sql;
  db.exec('BEGIN;'); db.exec(rebuild); db.exec('COMMIT;');
  db.exec(repo.find((x) => x.name === '0035_oauth_connection_label.sql').sql);
  assert.deepEqual(plain(db.prepare('SELECT * FROM oauth_connections ORDER BY id').all()).map(({ label, ...r }) => (assert.equal(label, null), r)), before);
  const info = db.prepare('PRAGMA table_info(oauth_connections)').all();
  assert.deepEqual(info.filter((c) => c.name !== 'label').map((c) => [c.name, c.type]), colsBefore, 'every column keeps its name, type and order');
  assert.equal(info.at(-1).name, 'label');
  const notNull = Object.fromEntries(info.map((c) => [c.name, c.notnull]));
  assert.equal(notNull.project_id, 0, 'project_id is nullable now');
  assert.equal(notNull.client_id, 1); assert.equal(notNull.file_access, 1);
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'oauth_connections' AND sql IS NOT NULL ORDER BY name").all();
  assert.deepEqual(idx.map((i) => i.name), ['oauth_connections_owner', 'oauth_connections_owner_legacy', 'oauth_connections_project', 'oauth_connections_workspace']);
  assert.match(idx.find((i) => i.name === 'oauth_connections_owner_legacy').sql, /WHERE workspace_id IS NULL/);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view') AND sql LIKE '%oauth_connections%'").all(), []);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_connection_projects').get().n, 1, 'the child rows were not touched');
  // A connection without any project is storable, and its (empty) scope table is fine.
  db.prepare(`INSERT INTO oauth_connections (id, owner_principal_id, project_id, client_id, client_name, redirect_uri, resource, can_read, can_write, created_at, expires_at, workspace_id, created_by)
    VALUES ('oac_zero','hum_a',NULL,'cid','Claude','https://claude.example/cb','https://mcp.example.test/mcp',1,0,?,99,'wsp_hum_a','hum_a')`).run(at);
  // Foreign keys still bite: the parent must exist for a scope row, project_id must reference a project, and a parent
  // with scope rows can't be deleted.
  assert.throws(() => db.prepare("INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) VALUES ('oac_nope','prj_a',0)").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE oauth_connections SET project_id = 'prj_nope' WHERE id = 'oac_zero'").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("DELETE FROM oauth_connections WHERE id = 'oac_one'").run(), /FOREIGN KEY/);
  db.prepare("INSERT INTO oauth_connection_projects (connection_id, project_id, can_write) VALUES ('oac_zero','prj_a',0)").run();
  assert.ok(db.prepare("SELECT 1 FROM change_scope_epochs WHERE connection_id = 'oac_zero'").get(), 'the change-feed triggers on oauth_connection_projects still fire');
  db.close();
});

test('both 0009 migrations exist, in production order (html_documents before publisher_generations)', () => {
  const i = names.indexOf('0009_html_documents.sql'), j = names.indexOf('0009_publisher_generations.sql');
  assert.ok(i >= 0 && j > i);
  // Byte-identical to the file production applied on 2026-10-04 (canonical html-editor branch).
  assert.equal(repo[i].sha256, HTML_DOCUMENTS_SHA256);
});

test('migration numbers are contiguous (the two 0009 files aside) and 0017_review_gating.sql is main\'s file byte for byte', () => {
  const numbers = names.map((n) => Number(n.slice(0, 4)));
  assert.deepEqual([...new Set(numbers)], Array.from({ length: Math.max(...numbers) }, (_, i) => i + 1));
  assert.equal(names.filter((n) => n.startsWith('0017_')).join(), '0017_review_gating.sql');
  // SHA-256 of origin/main's migrations/0017_review_gating.sql. Its code is not ported yet; the schema is inert.
  assert.equal(repo.find((m) => m.name === '0017_review_gating.sql').sha256, REVIEW_GATING_SHA256);
});

test('migrations after the baseline are additive unless explicitly owner-approved', () => {
  for (const m of repo.filter((x) => !target.appliedMigrationsAtBaseline.includes(x.name))) {
    assert.ok(!m.destructive || m.approved, `${m.name} is destructive; add an owner-approved marker and apply it manually (docs/deploy-pipeline.md#destructive-migrations)`);
  }
});

test('all migrations apply cleanly, in order, to a fresh database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of repo) {
    try { db.exec(m.sql); } catch (e) { assert.fail(`${m.name}: ${e.message}`); }
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const kinds = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifacts'").get().sql;
  assert.match(kinds, /'html'/, 'artifacts.kind must allow html, as in production');
  db.close();
});

const REVIEW_GATING_SHA256 = 'cdbbbd6926d618566d54be7c061d3151990bfea6d45acbcfb7102affba2cec93';
const HTML_DOCUMENTS_SHA256 = '696e040163ba0b7b46fbfa37ff600273fc3c97a54815f31e8176392472ac3309';
