#!/usr/bin/env node
// Offline proof that `wrangler deploy --env hosted` would upload exactly the
// committed, byte-pinned src/index.js with the recorded installation config.
// Uses --dry-run (no account, no network writes). Run before deploys (deploy.yml).
// Needs the installation's wrangler.toml and deploy/production.json (both gitignored).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTarget, loadWrangler, hostedConfig, checkConfigAgainstTarget, sha256 } from './lib.mjs';

const t = loadTarget();
const problems = checkConfigAgainstTarget(hostedConfig(loadWrangler(), t.wranglerEnv), t);
const out = mkdtempSync(join(tmpdir(), 'al-dry-'));
try {
  const log = execFileSync('npx', ['--no-install', 'wrangler', 'deploy', '--dry-run', '--env', t.wranglerEnv, '--outdir', out], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
  });
  const files = readdirSync(out).filter((f) => !f.startsWith('.') && f !== 'README.md');
  if (JSON.stringify(files) !== JSON.stringify(['index.js'])) problems.push(`dry-run produced unexpected modules: ${files.join(', ')}`);
  const want = sha256(readFileSync(t.main)), got = sha256(readFileSync(join(out, 'index.js')));
  if (want !== got) problems.push(`upload would not be byte-identical to ${t.main}: ${got} != ${want}`);
  const expected = [
    ...t.bindings.d1.map((d) => `env.${d.binding} (${d.name})`),
    ...t.bindings.kv.map((k) => `env.${k.binding} (${k.id})`),
    ...t.bindings.r2.map((r) => `env.${r.binding} (${r.bucket})`),
    ...Object.keys(t.vars).map((k) => `env.${k} (`), // wrangler truncates long values in its summary
  ];
  for (const b of expected) if (!log.includes(b)) problems.push(`dry-run binding summary missing ${b}`);
  if (/00000000/.test(log)) problems.push('dry-run references a placeholder resource id');
  if (!problems.length) console.log(`deploy config OK: hosted upload == ${t.main} (sha256 ${want})`);
} finally { rmSync(out, { recursive: true, force: true }); }
if (problems.length) { console.error(problems.map((p) => `::error::${p}`).join('\n')); process.exit(1); }
