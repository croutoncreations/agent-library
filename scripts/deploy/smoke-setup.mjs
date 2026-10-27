#!/usr/bin/env node
// Prepares (or re-checks) the synthetic smoke target that the deploy workflow's post-deploy checks use
// (scripts/deploy/smoke.mjs, levels "app" and "workflow"). Idempotent: safe to run again after a cutover, a key
// rotation or a fresh deploy repo.
//
//   node scripts/deploy/smoke-setup.mjs [--target path/to/production.json] [smoke.json]
//   (the API key is read from AL_SMOKE_API_TOKEN, a pipe, or a hidden prompt; --target defaults to
//   deploy/production.json in the current directory, e.g. --target ../../deploy/production.json from a worktree)
//
// Before running, the owner creates in the app (owner-only actions, behind Cloudflare Access):
//   1. a project used only for smoke checks, e.g. "Deploy smoke (synthetic)"; nothing real goes in it;
//   2. an API key (Connections -> API keys) with read_write access to that project ONLY, 90 days.
//
// What this script does, with that key only (machine API at https://<MCP_HOST>/v1, host from deploy/production.json):
//   - checks the key sees exactly one project (smoke.mjs refuses a broader key);
//   - finds the synthetic Markdown file by its fixed title, or creates it (with an idempotency key);
//   - writes the non-secret values to smoke.json (default deploy/smoke.json, gitignored here; commit it to the
//     deploy repo) and prints the commands that store them in the deploy repo's `production` environment.
// It never prints the key, never passes it on a command line, and never touches any other project.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE_TITLE = 'CI smoke (synthetic)';
const argv = process.argv.slice(2);
const ti = argv.indexOf('--target');
const targetPath = ti >= 0 ? argv[ti + 1] : 'deploy/production.json';
const out = argv.filter((a, i) => ti < 0 || (i !== ti && i !== ti + 1)).find((a) => !a.startsWith('--')) ?? 'deploy/smoke.json';
if (!targetPath || !existsSync(targetPath)) {
  console.error(`${targetPath ?? '(missing)'} not found. Run from a checkout that has your installation's deploy/production.json, or pass it:\n  node scripts/deploy/smoke-setup.mjs --target /path/to/deploy/production.json`);
  process.exit(2);
}
const t = JSON.parse(readFileSync(targetPath, 'utf8'));
if (!t?.vars?.MCP_HOST) { console.error(`${targetPath} has no vars.MCP_HOST`); process.exit(2); }
// AL_SMOKE_API_BASE: tests only, and only loopback (a stand-in API); the real target always comes from production.json.
const base = process.env.AL_SMOKE_API_BASE;
if (base && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) { console.error('AL_SMOKE_API_BASE must be a loopback URL (tests only)'); process.exit(2); }
const API = (base ?? `https://${t.vars.MCP_HOST}`) + '/v1';

// The key comes from AL_SMOKE_API_TOKEN, a pipe, or (on a terminal) a prompt with echo off, so it is never shown.
async function readToken() {
  if (process.env.AL_SMOKE_API_TOKEN) return process.env.AL_SMOKE_API_TOKEN.trim();
  if (!process.stdin.isTTY) { let s = ''; for await (const c of process.stdin) s += c; return s.trim(); }
  process.stderr.write('Smoke API key (hidden): ');
  return await new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stderr.write('\n'); return resolve(s.trim()); }
        if (c === '\u0003') { process.stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    });
  });
}
const token = await readToken();
if (!token) { console.error('No API key given (AL_SMOKE_API_TOKEN or stdin).'); process.exit(2); }

async function call(method, path, body, extra = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'agent-library-smoke-setup/1', ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { console.error(`Can't reach ${API} (${e.cause?.code ?? e.name}).`); process.exit(1); }
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? text.slice(0, 120)}`.trim());
  return json;
}

const { projects } = await call('GET', '/projects');
if (projects.length !== 1) {
  console.error(`The smoke key must see exactly one (synthetic) project; it sees ${projects.length}. Create a key scoped to the smoke project only.`);
  process.exit(1);
}
const project = projects[0];
if (project.access !== 'read_write') {
  console.error(`The smoke key needs read_write on "${project.title}" for the save/read-back check.`);
  process.exit(1);
}

let file = null, cursor = null, pages = 0;
do {
  const r = await call('GET', `/projects/${encodeURIComponent(project.id)}/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  file = r.files.find((f) => f.title === FILE_TITLE && f.kind === 'markdown' && !f.trashed) ?? null;
  cursor = r.next_cursor ?? null;
} while (!file && cursor && ++pages < 50);
if (!file && cursor) { console.error('The smoke project has too many files to search; use a project that holds only the smoke file.'); process.exit(1); }

let created = false;
if (!file) {
  // A fresh key per creation: a fixed key would replay an earlier file that has since been trashed or deleted.
  const r = await call('POST', `/projects/${encodeURIComponent(project.id)}/files`,
    { kind: 'markdown', title: FILE_TITLE, body: '# CI smoke (synthetic)\n\nRewritten by every deploy\'s post-deploy check. Synthetic content only.\n', change_note: 'smoke-setup' },
    { 'idempotency-key': `smoke-setup-${crypto.randomUUID()}` });
  file = { id: r.artifact_id ?? r.id, title: FILE_TITLE };
  created = true;
}

// Read back once, exactly like smoke.mjs does, so a wrong key or scope fails here rather than after a deploy.
let cur;
try { cur = await call('GET', `/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(file.id)}`); }
catch (e) { console.error(`The smoke file ${file.id} can't be read back (${e.message}). If it was trashed, restore it or delete it, then re-run.`); process.exit(1); }
if (!Number.isInteger(cur?.revision?.rev)) throw new Error('Smoke file has no readable revision');

const values = {
  $comment: 'Non-secret smoke target for the deploy repo (production environment variables). The API key is a secret: never commit it.',
  installation: t.vars.APP_HOST,
  AL_SMOKE_PROJECT_ID: project.id,
  AL_SMOKE_FILE_ID: file.id,
  project_title: project.title,
  file_title: FILE_TITLE,
};
if (existsSync(out)) {
  const prev = JSON.parse(readFileSync(out, 'utf8'));
  if (prev.AL_SMOKE_PROJECT_ID && prev.AL_SMOKE_PROJECT_ID !== values.AL_SMOKE_PROJECT_ID) console.warn(`Note: ${out} pointed at project ${prev.AL_SMOKE_PROJECT_ID}; updating it.`);
}
writeFileSync(out, JSON.stringify(values, null, 2) + '\n');

console.log(`OK  key sees only "${project.title}" (${project.id})`);
console.log(`OK  smoke file "${FILE_TITLE}" ${created ? 'created' : 'found'} (${file.id}), rev ${cur.revision.rev}`);
console.log(`Wrote ${out} (non-secret). Apply it to the deploy repo:`);
console.log(`  node scripts/deploy/smoke-apply.mjs OWNER/DEPLOY_REPO ${out}`);
