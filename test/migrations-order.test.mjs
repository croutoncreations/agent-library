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
  assert.deepEqual(planMigrations(target.appliedMigrationsAtBaseline, repo).map((m) => m.name), names.slice(target.appliedMigrationsAtBaseline.length));
});

test('both 0009 migrations exist, in production order (html_documents before publisher_generations)', () => {
  const i = names.indexOf('0009_html_documents.sql'), j = names.indexOf('0009_publisher_generations.sql');
  assert.ok(i >= 0 && j > i);
  // Byte-identical to the file production applied on 2026-10-04 (canonical html-editor branch).
  assert.equal(repo[i].sha256, HTML_DOCUMENTS_SHA256);
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

const HTML_DOCUMENTS_SHA256 = '696e040163ba0b7b46fbfa37ff600273fc3c97a54815f31e8176392472ac3309';
