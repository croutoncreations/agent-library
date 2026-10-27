#!/usr/bin/env node
// Builds the deployment receipt (Markdown + JSON) from the preflight state, the
// post-deploy live version and smoke results. No secrets are read or written.
// Usage: node scripts/deploy/receipt.mjs <state.json> <smoke.json|-> <outdir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadTarget } from './lib.mjs';

const [stateFile, smokeFile, outdir = 'receipt'] = process.argv.slice(2);
const read = (f) => (f && f !== '-' && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const state = read(stateFile) ?? { action: 'unknown' };
const smoke = read(smokeFile) ?? [];
const t = loadTarget();
const env = t.wranglerEnv;
const outcome = process.env.DEPLOY_OUTCOME ?? 'unknown';
const migrateOutcome = process.env.MIGRATE_OUTCOME ?? 'skipped';

let after = null, appliedAfter = null;
try {
  const w = (...a) => JSON.parse(execFileSync('npx', ['--no-install', 'wrangler', ...a, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const dep = w('deployments', 'status', '--env', env);
  const v = w('versions', 'view', dep.versions[0].version_id, '--env', env);
  after = { versionId: dep.versions[0].version_id, percentage: dep.versions[0].percentage, tag: v.annotations?.['workers/tag'] ?? null, deploymentId: dep.id, createdOn: dep.created_on };
  appliedAfter = w('d1', 'execute', 'DB', '--remote', '--env', env, '--command', 'SELECT name FROM d1_migrations ORDER BY id')[0].results.map((r) => r.name);
} catch (e) { after = { error: `could not read live state: ${String(e.message).split('\n')[0]}` }; }

const run = `${process.env.GITHUB_SERVER_URL ?? ''}/${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`;
const prev = state.live?.versionId;
const mutated = ['success', 'failure', 'cancelled'].includes(outcome) || ['success', 'failure', 'cancelled'].includes(migrateOutcome);
const mark = (r) => (r.ok === null ? 'SKIPPED' : r.ok ? 'PASS' : 'FAIL');
const lines = [
  `# Agent Library deployment receipt`,
  ``,
  `| | |`, `|---|---|`,
  `| Commit | \`${state.sha ?? process.env.APP_SHA ?? process.env.GITHUB_SHA}\` |`,
  `| Outcome | preflight=${state.action}; migrations=${migrateOutcome}; deploy=${outcome} |`,
  `| Reason | ${state.reason ?? ''} |`,
  `| Bundle sha256 (${t.main}) | \`${state.bundleSha256 ?? ''}\` |`,
  `| Previous live version | \`${prev ?? 'n/a'}\` (tag ${state.live?.tag ?? 'none'}) |`,
  `| Live version now | \`${after?.versionId ?? after?.error ?? 'n/a'}\` (tag ${after?.tag ?? 'none'}, ${after?.percentage ?? '?'}%) |`,
  `| Workflow run | ${run} |`,
  ``,
  `## Migrations`,
  `- Applied before: ${(state.appliedBefore ?? []).length} (last: ${(state.appliedBefore ?? []).at(-1) ?? 'n/a'})`,
  `- Pending at preflight: ${(state.pending ?? []).join(', ') || 'none'}`,
  `- Applied after: ${appliedAfter ? `${appliedAfter.length} (last: ${appliedAfter.at(-1)})` : 'unknown'}`,
  `- D1 Time Travel bookmark before mutation: \`${state.bookmark ?? 'n/a'}\` at ${state.bookmarkAt ?? 'n/a'}`,
  ``,
  `## Verification`,
  ...(smoke.length ? smoke.map((r) => `- **${mark(r)}** [${r.level}] ${r.name}: ${r.detail}`) : ['- not run']),
  ``,
  `Levels: *boundary* = unauthenticated requests stopped correctly (an Access login redirect proves the gate, not that the app works); *app* = authenticated synthetic-credential API call; *workflow* = synthetic artifact save + read-back.`,
  ``,
  ...(mutated ? [
    `## Recovery`,
    `Worker rollback does NOT undo D1 migrations. Migrations are additive by policy, so the previous Worker should run on the new schema.`,
    ``,
    '```sh',
    `# Roll the Worker back to the version that was live before this run (owner, from a checkout with wrangler.toml):`,
    `npx wrangler rollback ${prev ?? '<previous-version-id>'} --env ${env} --message "rollback from ${(state.sha ?? '').slice(0, 12)}"`,
    `# Re-deploy this exact commit later: re-run this workflow run, or push a fix to main.`,
    `# D1 point-in-time restore is DESTRUCTIVE (drops all writes after the bookmark) and needs explicit owner approval:`,
    `#   npx wrangler d1 time-travel restore DB --env ${env} --bookmark ${state.bookmark ?? '<bookmark>'}`,
    '```',
    `See docs/deploy-pipeline.md#recovery for the decision table (migration succeeded + deploy failed, smoke failed, etc.).`,
  ] : [`## Recovery`, `Nothing was changed in the installation by this run (preflight ${state.action}); no recovery needed.`]),
];
mkdirSync(outdir, { recursive: true });
writeFileSync(join(outdir, 'receipt.md'), lines.join('\n') + '\n');
writeFileSync(join(outdir, 'receipt.json'), JSON.stringify({ state, after, appliedAfter, smoke, deployOutcome: outcome, migrateOutcome, run }, null, 2) + '\n');
console.log(lines.join('\n'));
