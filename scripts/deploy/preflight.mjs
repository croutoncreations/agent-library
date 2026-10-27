#!/usr/bin/env node
// Read-only production preflight. Runs before ANY mutation (migration or deploy).
// Never creates, replaces or modifies Cloudflare resources. On any doubt it refuses.
//
// Usage: node scripts/deploy/preflight.mjs <state.json> [--check-only]
//   --check-only: local/owner dry run. Skips the main-tip check (works on any branch)
//   and the workflow never mutates after it. Everything else is identical.
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GITHUB_SHA; in Actions also GH_TOKEN + GITHUB_REPOSITORY.
// When the deploy runs from a separate (private) deploy repo, APP_SHA / APP_REPOSITORY name the app commit and repo
// being deployed (they override GITHUB_SHA / GITHUB_REPOSITORY, which then describe the deploy repo).
// (tip-of-main lookup via the API, so the checkout keeps no persisted git credentials).
// Writes state.json with { action: deploy|skip, reason, pending[], live, bookmark, ... }.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadTarget, loadWrangler, hostedConfig, checkConfigAgainstTarget, checkLiveVersion, decideRelease, effectiveLive, NON_CODE_TRIGGERS, readMigrations, planMigrations, sha256 } from './lib.mjs';

const out = process.argv[2] ?? 'deploy-state.json';
const checkOnly = process.argv.includes('--check-only');
const sha = process.env.APP_SHA || process.env.GITHUB_SHA || (checkOnly ? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : undefined);
const t = loadTarget();
const env = t.wranglerEnv;

const fail = (msg) => { console.error(`::error::preflight refused: ${msg}`); writeFileSync(out, JSON.stringify({ action: 'refuse', reason: msg }, null, 2)); process.exit(1); };
const wrangler = (...args) => {
  try { return execFileSync('npx', ['--no-install', 'wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }); }
  catch (e) { fail(`wrangler ${args.join(' ')} failed: ${String(e.stderr || e.message).replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => /ERROR|error/.test(l)) ?? 'unknown error'}`); }
};
const wjson = (...args) => JSON.parse(wrangler(...args, '--json'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
// Any unexpected error (bad JSON, config parse, output shape) refuses with a reason, never a bare crash.
process.on('uncaughtException', (e) => fail(`unexpected error: ${e?.message ?? e}`));

if (!/^[0-9a-f]{40}$/.test(sha ?? '')) fail('GITHUB_SHA missing');
if (process.env.CLOUDFLARE_ACCOUNT_ID !== t.accountId) fail(`CLOUDFLARE_ACCOUNT_ID does not match recorded production account ${t.accountId}`);
if (git('rev-parse', 'HEAD') !== sha) fail('checked-out HEAD is not the triggering commit');

// 1. Config in this revision matches the recorded target (no placeholder IDs, no default env).
const cfg = hostedConfig(loadWrangler(), env);
const cfgProblems = checkConfigAgainstTarget(cfg, t);
if (cfgProblems.length) fail(`wrangler.toml [env.${env}] != deploy/production.json:\n  ${cfgProblems.join('\n  ')}`);

// 2. Stale-run guard: only the current tip of main may deploy.
const tip = process.env.GITHUB_ACTIONS === 'true'
  ? execFileSync('gh', ['api', `repos/${process.env.APP_REPOSITORY || process.env.GITHUB_REPOSITORY}/commits/main`, '--jq', '.sha'], { encoding: 'utf8' }).trim()
  : (git('fetch', '--quiet', 'origin', 'main'), git('rev-parse', 'origin/main'));
if (checkOnly) console.log(`check-only: tip-of-main check skipped (HEAD ${sha}, main ${tip})`);
const state = { sha, tag: null, bundleSha256: sha256(readFileSync(t.main)) };
if (tip !== sha && !checkOnly) {
  writeFileSync(out, JSON.stringify({ ...state, action: 'skip', reason: `stale run: main is now ${tip}` }, null, 2));
  console.log(`::notice::skipping stale run; main is now ${tip}, which has its own run`);
  process.exit(0);
}

// 3. Live deployment: must be a single 100% version we can account for.
const dep = wjson('deployments', 'status', '--env', env);
if (dep.versions?.length !== 1 || dep.versions[0].percentage !== 100) fail(`live deployment is split across versions (${JSON.stringify(dep.versions)}); finish or roll back the gradual deploy first`);
const liveVersionId = dep.versions[0].version_id;
const live = wjson('versions', 'view', liveVersionId, '--env', env);
// Secret changes create untagged versions that reuse the previous code; look back (bounded) to the
// newest version the pipeline can account for. Any other trigger (upload, promotion, dashboard, unknown)
// may carry new code and is decided as-is (an untagged one is refused as out-of-band).
const history = [{ versionId: liveVersionId, tag: live.annotations?.['workers/tag'] ?? null, triggeredBy: live.annotations?.['workers/triggered_by'] }];
if (!history[0].tag?.startsWith('gh-') && liveVersionId !== t.baseline.versionId && NON_CODE_TRIGGERS.has(history[0].triggeredBy)) {
  const ids = wjson('deployments', 'list', '--env', env).flatMap((d) => d.versions.map((v) => v.version_id)).reverse().filter((id, i, a) => a.indexOf(id) === i && id !== liveVersionId).slice(0, 10);
  for (const id of ids) { const v = wjson('versions', 'view', id, '--env', env); history.push({ versionId: id, tag: v.annotations?.['workers/tag'] ?? null, triggeredBy: v.annotations?.['workers/triggered_by'] }); }
}
const eff = effectiveLive(history, t.baseline);
if (eff.via) console.log(`::notice::live ${liveVersionId} is a ${history[0].triggeredBy} change on top of ${eff.versionId} (${eff.tag ?? 'untagged'}); deciding from that version`);
const liveTag = eff.tag;
const liveProblems = checkLiveVersion(live, t);
if (liveProblems.length) fail(`live Worker does not match the recorded target:\n  ${liveProblems.join('\n  ')}`);

const resolve = (short) => { try { return git('rev-parse', '--verify', '--quiet', `${short}^{commit}`); } catch { return null; } };
const isAncestor = (a, b) => { try { execFileSync('git', ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
const decision = decideRelease({ liveVersionId: eff.versionId, liveTag, sha, baseline: t.baseline, isAncestor, resolve });
Object.assign(state, { live: { versionId: liveVersionId, tag: history[0].tag, triggeredBy: history[0].triggeredBy, decidedFrom: eff.versionId, deploymentId: dep.id, createdOn: dep.created_on } });
if (decision.action === 'refuse') fail(decision.reason);
if (decision.action === 'skip') {
  writeFileSync(out, JSON.stringify({ ...state, ...decision }, null, 2));
  console.log(`::notice::${decision.reason}`);
  process.exit(0);
}

// 4. Bound resources exist and are the recorded ones. Missing => refuse; never create.
// Always pass --env: without it wrangler resolves the top-level placeholder database id.
const d1 = wjson('d1', 'info', t.bindings.d1[0].name, '--env', env);
if (d1.uuid !== t.bindings.d1[0].id) fail(`D1 ${t.bindings.d1[0].name} uuid ${d1.uuid} != ${t.bindings.d1[0].id}`);
const kvs = wrangler('kv', 'namespace', 'list');
for (const k of t.bindings.kv) if (!kvs.includes(k.id)) fail(`KV namespace ${k.id} not found in account`);
for (const b of t.bindings.r2) {
  const info = wrangler('r2', 'bucket', 'info', b.bucket);
  if (!info.includes(`name:`) || !info.includes(b.bucket)) fail(`R2 bucket ${b.bucket} not found`);
  const dev = wrangler('r2', 'bucket', 'dev-url', 'get', b.bucket);
  if (!/disabled/i.test(dev)) fail(`R2 bucket ${b.bucket} has public r2.dev access enabled; it must stay private`);
}

// 5. Migration plan against actual production history.
const rows = wjson('d1', 'execute', 'DB', '--remote', '--env', env, '--command', 'SELECT name FROM d1_migrations ORDER BY id');
const applied = rows[0].results.map((r) => r.name);
let pending;
try { pending = planMigrations(applied, readMigrations(cfg.d1[0].migrationsDir)); } catch (e) { fail(e.message); }

// 6. Recovery point before mutation: D1 Time Travel bookmark (read-only lookup).
let bookmark = null;
try {
  bookmark = JSON.parse(execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'time-travel', 'info', 'DB', '--env', env, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).bookmark ?? null;
} catch { console.log('::warning::could not read a D1 Time Travel bookmark'); }
if (pending.length && !bookmark) fail('pending migrations but no D1 Time Travel bookmark could be recorded; refusing to migrate without a restore point');

Object.assign(state, { action: 'deploy', reason: decision.reason, appliedBefore: applied, pending: pending.map((m) => m.name), bookmark, bookmarkAt: new Date().toISOString() });
writeFileSync(out, JSON.stringify(state, null, 2));
console.log(`preflight OK: ${decision.reason}; pending migrations: ${pending.length ? pending.map((m) => m.name).join(', ') : 'none'}`);
