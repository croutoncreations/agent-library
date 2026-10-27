// scripts/deploy/smoke-setup.mjs against the real local Worker (wrangler dev harness) with owner-created alk_ keys.
// Synthetic data only. Covers: refuses a key that sees more than one project or only reads; creates the synthetic
// file once (idempotent on re-run); recreates it after the owner trashes it; writes only non-secret values; never
// prints the key; the API base override accepts loopback only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, ROOT } from './helpers.mjs';
import { SERVER_PORTS } from './ports.mjs';

const PORT = SERVER_PORTS['smoke-setup'];
const BASE = `http://127.0.0.1:${PORT}`;   // machine host (MCP_HOST)
const APP = `http://localhost:${PORT}`;    // owner host (APP_HOST)
const SMOKE = 'syn-smoke', OTHER = 'syn-other';
let s, owner;

before(async () => {
  s = await startServer('smoke-setup', PORT, {
    vars: { MCP_HOST: `127.0.0.1:${PORT}`, APP_HOST: `localhost:${PORT}`, V1_TEST_ENDPOINTS: '1',
      RATE_READS_PER_MIN: '100000', RATE_WRITES_PER_MIN: '100000', RATE_AUTHFAIL_PER_MIN: '100000', OAUTH_RATE_MULTIPLIER: '100' },
    readyBase: APP,
  });
  owner = await s.loginAt(APP);
  for (const id of [SMOKE, OTHER]) assert.equal((await owner.req('POST', '/api/projects', { id, title: `Synthetic ${id}` })).status, 201);
});
after(async () => { await s?.stop(); });

const mkKey = async (projects) => {
  const r = await owner.req('POST', '/api/api-keys', { label: 'smoke test', lifetime_days: 1, projects });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.secret;
};

// A throwaway app root with the scripts and a synthetic production.json (the script resolves config from cwd).
function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'al-smoke-setup-'));
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'node_modules', 'smol-toml'), join(d, 'node_modules', 'smol-toml'), { recursive: true });
  mkdirSync(join(d, 'deploy'), { recursive: true });
  writeFileSync(join(d, 'deploy/production.json'), readFileSync(join(ROOT, 'deploy/production.example.json')));
  return d;
}
// Async child so the test process stays responsive; the key goes in on stdin (piped, so no prompt).
const run = (d, secret, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['scripts/deploy/smoke-setup.mjs'], { cwd: d, env: { ...process.env, AL_SMOKE_API_TOKEN: '', AL_SMOKE_API_BASE: BASE, ...env } });
  let stdout = '', stderr = '';
  c.stdout.on('data', (x) => (stdout += x)); c.stderr.on('data', (x) => (stderr += x));
  c.on('close', (status) => resolve({ status, stdout, stderr }));
  c.stdin.end(secret);
});
const smokeFiles = async () => (await owner.req('GET', `/api/projects/${SMOKE}/artifacts`)).body.artifacts.filter((a) => a.title === 'CI smoke (synthetic)');

test('creates the synthetic file once, writes non-secret values only, never prints the key', async () => {
  const secret = await mkKey([{ project_id: SMOKE, access: 'read_write' }]);
  const d = workdir();
  const a = await run(d, secret);
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.match(a.stdout, /created \(art_/);
  const b = await run(d, secret);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /found \(art_/);
  assert.equal((await smokeFiles()).length, 1, 'idempotent: no second file');
  const out = readFileSync(join(d, 'deploy/smoke.json'), 'utf8'), v = JSON.parse(out);
  assert.equal(v.AL_SMOKE_PROJECT_ID, SMOKE);
  assert.equal(v.AL_SMOKE_FILE_ID, (await smokeFiles())[0].id);
  for (const x of [a.stdout, a.stderr, b.stdout, b.stderr, out]) assert.ok(!x.includes(secret), 'key never printed or stored');
});

test('after the owner trashes the smoke file, a re-run creates a fresh one', async () => {
  const secret = await mkKey([{ project_id: SMOKE, access: 'read_write' }]);
  const [f] = await smokeFiles();
  const t = await owner.req('PATCH', `/api/projects/${SMOKE}/artifacts/${f.id}`, { expected_meta_version: f.meta_version, trashed: true });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const d = workdir();
  const r = await run(d, secret);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /created \(art_/);
  assert.notEqual(JSON.parse(readFileSync(join(d, 'deploy/smoke.json'), 'utf8')).AL_SMOKE_FILE_ID, f.id);
});

test('refuses a key that sees more than one project, or cannot write', async () => {
  const before = (await smokeFiles()).length;
  const wide = await run(workdir(), await mkKey([{ project_id: SMOKE, access: 'read_write' }, { project_id: OTHER, access: 'read' }]));
  assert.equal(wide.status, 1, wide.stderr); assert.match(wide.stderr, /exactly one/);
  const ro = await run(workdir(), await mkKey([{ project_id: SMOKE, access: 'read' }]));
  assert.equal(ro.status, 1, ro.stderr); assert.match(ro.stderr, /read_write/);
  assert.equal((await smokeFiles()).length, before, 'nothing created');
});

test('the API base override accepts loopback only', async () => {
  const r = await run(workdir(), 'unused', { AL_SMOKE_API_BASE: 'https://evil.example.com' });
  assert.equal(r.status, 2); assert.match(r.stderr, /loopback/);
});
