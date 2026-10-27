#!/usr/bin/env node
// Applies a prepared smoke target (smoke.json from smoke-setup.mjs) to a deploy repository's `production`
// environment, so the post-deploy checks run their "app" and "workflow" levels. Re-run it after any cutover
// (new deploy repo, renamed repo) or key rotation; it only sets these three values.
//
//   node scripts/deploy/smoke-apply.mjs OWNER/DEPLOY_REPO [smoke.json] [--set-secret]
//
// Variables AL_SMOKE_PROJECT_ID and AL_SMOKE_FILE_ID come from smoke.json. The secret AL_SMOKE_API_TOKEN is set only
// with --set-secret: `gh secret set` then reads the key from AL_SMOKE_API_TOKEN (passed on stdin, never on a command
// line) or prompts for it. Without the flag it checks whether the secret exists and says what to run.
// Needs an authenticated `gh` with admin access to the deploy repo.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const repo = args.find((a) => /^[\w.-]+\/[\w.-]+$/.test(a) && !a.endsWith('.json'));
const file = args.find((a) => a.endsWith('.json')) ?? 'deploy/smoke.json';
if (!repo) { console.error('Usage: node scripts/deploy/smoke-apply.mjs OWNER/DEPLOY_REPO [smoke.json] [--set-secret]'); process.exit(2); }
if (!existsSync(file)) { console.error(`${file} not found: run scripts/deploy/smoke-setup.mjs first`); process.exit(2); }
const v = JSON.parse(readFileSync(file, 'utf8'));
for (const k of ['AL_SMOKE_PROJECT_ID', 'AL_SMOKE_FILE_ID']) if (!/^[A-Za-z0-9_-]{4,64}$/.test(v[k] ?? '')) { console.error(`${file}: missing or invalid ${k}`); process.exit(2); }

const gh = (argv, input) => {
  const r = spawnSync('gh', argv, { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`gh ${argv.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
};
// gh shows its hidden "Paste your secret" prompt only when stdin AND stdout are terminals, so it gets the real
// terminal here (nothing captured). Refuse rather than fall back to reading an echoed paste.
const ghPrompt = (argv) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('No terminal for a hidden prompt: set AL_SMOKE_API_TOKEN in the environment instead');
  const r = spawnSync('gh', argv, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`gh ${argv.slice(0, 3).join(' ')} failed`);
};

gh(['api', `repos/${repo}/environments/production`, '--jq', '.name']); // fails clearly if the environment is missing
for (const k of ['AL_SMOKE_PROJECT_ID', 'AL_SMOKE_FILE_ID']) {
  gh(['variable', 'set', k, '--env', 'production', '-R', repo, '--body', v[k]]);
  console.log(`OK  ${k}=${v[k]} (production, ${repo})`);
}

if (args.includes('--set-secret')) {
  const key = process.env.AL_SMOKE_API_TOKEN;
  if (key) gh(['secret', 'set', 'AL_SMOKE_API_TOKEN', '--env', 'production', '-R', repo], key.trim());
  else ghPrompt(['secret', 'set', 'AL_SMOKE_API_TOKEN', '--env', 'production', '-R', repo]); // gh's own hidden prompt
  console.log(`OK  AL_SMOKE_API_TOKEN set (production, ${repo})`);
} else {
  const have = gh(['secret', 'list', '--env', 'production', '-R', repo]).split('\n').some((l) => l.split('\t')[0] === 'AL_SMOKE_API_TOKEN');
  console.log(have ? `OK  AL_SMOKE_API_TOKEN already set (production, ${repo})`
    : `TODO AL_SMOKE_API_TOKEN not set: run again with --set-secret (gh prompts for the key), or: gh secret set AL_SMOKE_API_TOKEN --env production -R ${repo}`);
}
console.log(`Next deploy's receipt should show the "app" and "workflow" smoke levels as PASS.`);
