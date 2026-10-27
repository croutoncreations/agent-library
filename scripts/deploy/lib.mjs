// Pure helpers for the production deploy pipeline. No network, no wrangler calls:
// everything here is unit-tested in test/deploy-*.test.mjs. The workflow scripts
// (preflight.mjs, smoke.mjs, receipt.mjs) feed them data gathered from wrangler.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// An installation's own config (wrangler.toml, deploy/production.json) is gitignored. Deploy scripts
// require it; offline checks and tests may fall back to the committed examples ({ example: true }).
function configPath(root, file, example, { allowExample = false } = {}) {
  const real = join(root, file);
  if (existsSync(real)) return real;
  if (allowExample) return join(root, example);
  throw new Error(`${file} not found: create it from ${example} (see docs/deploy-pipeline.md); deploy scripts never fall back to the example`);
}

export function loadTarget(root = '.', opts) {
  return JSON.parse(readFileSync(configPath(root, 'deploy/production.json', 'deploy/production.example.json', opts), 'utf8'));
}

export function loadWrangler(root = '.', opts) {
  return parseToml(readFileSync(configPath(root, 'wrangler.toml', 'wrangler.example.toml', opts), 'utf8'));
}

export const loadExampleTarget = (root = '.') => JSON.parse(readFileSync(join(root, 'deploy/production.example.json'), 'utf8'));
export const loadExampleWrangler = (root = '.') => parseToml(readFileSync(join(root, 'wrangler.example.toml'), 'utf8'));

const PLACEHOLDER = /^0+(-0+)*$|^replace-with-|example\.(com|net|org)$/;

// The effective hosted config, i.e. what `wrangler deploy --env hosted` would apply.
// Wrangler does not inherit bindings/vars into named envs, so we read env.hosted only.
export function hostedConfig(wrangler, envName = 'hosted') {
  const env = wrangler.env?.[envName];
  if (!env) throw new Error(`wrangler.toml has no [env.${envName}]; refusing to use the default (local placeholder) config`);
  return {
    name: env.name ?? wrangler.name,
    main: env.main ?? wrangler.main,
    noBundle: env.no_bundle ?? wrangler.no_bundle ?? false,
    findAdditionalModules: env.find_additional_modules ?? wrangler.find_additional_modules ?? false,
    compatibilityDate: env.compatibility_date ?? wrangler.compatibility_date,
    compatibilityFlags: env.compatibility_flags ?? wrangler.compatibility_flags ?? [],
    workersDev: env.workers_dev,
    previewUrls: env.preview_urls,
    routes: (env.routes ?? []).map((r) => (typeof r === 'string' ? { pattern: r } : r)),
    crons: env.triggers?.crons ?? [],
    vars: env.vars ?? {},
    d1: (env.d1_databases ?? []).map((d) => ({ binding: d.binding, id: d.database_id, name: d.database_name, migrationsDir: d.migrations_dir })),
    kv: (env.kv_namespaces ?? []).map((k) => ({ binding: k.binding, id: k.id })),
    r2: (env.r2_buckets ?? []).map((b) => ({ binding: b.binding, bucket: b.bucket_name })),
  };
}

// Returns a list of human-readable problems; empty means the config matches the
// recorded production target exactly (bindings, IDs, vars, routes, cron).
export function checkConfigAgainstTarget(cfg, target) {
  const p = [];
  const eq = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) p.push(`${label}: config=${JSON.stringify(a)} target=${JSON.stringify(b)}`); };
  eq('worker name', cfg.name, target.workerName);
  eq('main (upload path)', cfg.main, target.uploadMain);
  eq('no_bundle', cfg.noBundle, target.noBundle);
  eq('find_additional_modules', cfg.findAdditionalModules, false);
  eq('compatibility_date', cfg.compatibilityDate, target.compatibilityDate);
  eq('compatibility_flags', [...cfg.compatibilityFlags].sort(), [...target.compatibilityFlags].sort());
  eq('workers_dev', cfg.workersDev, false);
  eq('preview_urls', cfg.previewUrls, false);
  eq('routes', cfg.routes.map((r) => `${r.pattern}|${r.custom_domain === true}`).sort(), target.customDomains.map((h) => `${h}|true`).sort());
  eq('crons', [...cfg.crons].sort(), [...target.crons].sort());
  eq('vars', sortObj(cfg.vars), sortObj(target.vars));
  eq('d1', cfg.d1.map(({ binding, id, name }) => ({ binding, id, name })), target.bindings.d1);
  eq('kv', cfg.kv, target.bindings.kv);
  eq('r2', cfg.r2, target.bindings.r2);
  for (const id of [...cfg.d1.map((d) => d.id), ...cfg.kv.map((k) => k.id)]) {
    if (!id || PLACEHOLDER.test(id)) p.push(`placeholder resource id in hosted config: ${id}`);
  }
  for (const r of cfg.routes) if (PLACEHOLDER.test(r.pattern)) p.push(`placeholder hostname in hosted config: ${r.pattern}`);
  if (!target.accountId || !/^[0-9a-f]{32}$/.test(target.accountId)) p.push('deploy target accountId must be your 32-hex Cloudflare account ID');
  return p;
}

// Compare the live Worker version (from `wrangler versions view <id> --json`)
// with the target. Missing/different bindings or secrets block the deploy: we
// never "fix" production by creating or replacing resources.
export function checkLiveVersion(live, target) {
  const p = [];
  const b = live?.resources?.bindings ?? [];
  const by = (type) => b.filter((x) => x.type === type);
  const liveVars = Object.fromEntries(by('plain_text').map((x) => [x.name, x.text]));
  // Drift refuses: a live var that the target lacks or sets differently (e.g. a dashboard edit), and a target var that
  // is missing live (it may have been removed on purpose, e.g. a kill switch). The one exception is a reviewed change
  // listed in `pendingVars` as { NAME: <exact value it replaces, or null if the var is new> }. The deploy applies it
  // only while live still holds that expected value, so a forgotten entry can never override a later live change.
  if (target.newVars !== undefined) p.push('deploy target field newVars was replaced by pendingVars');
  const pv = target.pendingVars ?? {};
  if (typeof pv !== 'object' || Array.isArray(pv) || pv === null) p.push('pendingVars must be an object: { NAME: <current live value, or null if new> }');
  const pending = new Set();
  for (const [k, from] of Object.entries(pv && typeof pv === 'object' && !Array.isArray(pv) ? pv : {})) {
    if (!Object.hasOwn(target.vars, k)) { p.push(`pendingVars lists ${k}, which is not in the target vars`); continue; }
    if (from !== null && typeof from !== 'string') { p.push(`pendingVars.${k} must be the current live value (a string) or null`); continue; }
    const now = Object.hasOwn(liveVars, k) ? liveVars[k] : null;
    if (now === target.vars[k]) p.push(`${k} is already live with the target value; remove it from the target's pendingVars`);
    else if (now !== from) p.push(`${k} changed live since this pendingVars entry was written (expected ${from === null ? 'absent' : 'the recorded value'}); reconcile before deploying`);
    else pending.add(k);
  }
  const drift = Object.keys(liveVars).filter((k) => !pending.has(k) && (!Object.hasOwn(target.vars, k) || target.vars[k] !== liveVars[k]));
  if (drift.length) p.push(`live vars differ from target (${drift.sort().join(', ')}): live=${JSON.stringify(sortObj(liveVars))}; if this deploy changes them on purpose, list them in the target's pendingVars`);
  const missing = Object.keys(target.vars).filter((k) => !Object.hasOwn(liveVars, k) && !pending.has(k));
  if (missing.length) p.push(`target vars missing in production (${missing.sort().join(', ')}); if this deploy adds them, list them in the target's pendingVars`);
  const liveSecrets = by('secret_text').map((x) => x.name).sort();
  for (const s of target.requiredSecrets) if (!liveSecrets.includes(s)) p.push(`required Worker secret missing in production: ${s}`);
  const d1 = by('d1').map((x) => ({ binding: x.name, id: x.id }));
  for (const t of target.bindings.d1) if (!d1.some((x) => x.binding === t.binding && x.id === t.id)) p.push(`live D1 binding ${t.binding} is not ${t.id}`);
  const kv = by('kv_namespace').map((x) => ({ binding: x.name, id: x.namespace_id ?? x.id }));
  for (const t of target.bindings.kv) if (!kv.some((x) => x.binding === t.binding && x.id === t.id)) p.push(`live KV binding ${t.binding} is not ${t.id}`);
  const r2 = by('r2_bucket').map((x) => ({ binding: x.name, bucket: x.bucket_name ?? x.id }));
  for (const t of target.bindings.r2) if (!r2.some((x) => x.binding === t.binding && x.bucket === t.bucket)) p.push(`live R2 binding ${t.binding} is not ${t.bucket}`);
  const known = new Set(['plain_text', 'secret_text', 'd1', 'kv_namespace', 'r2_bucket']);
  for (const x of b) if (!known.has(x.type)) p.push(`live has unexpected ${x.type} binding ${x.name}; reconcile config before deploying`);
  const rt = live?.resources?.script_runtime ?? {};
  if (rt.compatibility_date && rt.compatibility_date !== target.compatibilityDate) p.push(`live compatibility_date ${rt.compatibility_date} != ${target.compatibilityDate}`);
  if (rt.compatibility_flags && JSON.stringify([...rt.compatibility_flags].sort()) !== JSON.stringify([...target.compatibilityFlags].sort())) p.push(`live compatibility_flags ${JSON.stringify(rt.compatibility_flags)} != ${JSON.stringify(target.compatibilityFlags)}`);
  return p;
}

export const TAG_PREFIX = 'gh-';
export const tagFor = (sha) => `${TAG_PREFIX}${sha.slice(0, 12)}`;

// A secret change (`wrangler secret put`/`delete`) creates a new version that reuses the previous
// version's code and carries no tag. For release decisions, walk back through such versions to the
// newest one the pipeline can account for. history: newest first, [{ versionId, tag, triggeredBy }].
// Conservative by design: ONLY triggers known to keep the code walk back. Everything else (`upload`,
// `promotion`, `version_upload`, `deployment`, `rollback`, dashboard edits, unknown or missing values)
// may carry new code, so the walk stops there and an untagged version is treated as out-of-band.
export const NON_CODE_TRIGGERS = new Set(['secret']);
export function effectiveLive(history, baseline) {
  if (!history.length) return null;
  const via = (v) => ({ ...v, via: v === history[0] ? null : history[0].versionId });
  for (const v of history) {
    if (v.versionId === baseline.versionId || (v.tag && v.tag.startsWith(TAG_PREFIX))) return via(v);
    if (!NON_CODE_TRIGGERS.has(v.triggeredBy)) return via(v);
  }
  // Every version seen was a secret change: the code is older than this history; decide from the newest.
  return via(history[history.length - 1]);
}

// Decide whether deploying `sha` over the current live version is allowed.
// isAncestor(a, b) answers "is commit a an ancestor of (or equal to) b".
//  - live is the recorded pre-pipeline baseline         -> deploy (first activation)
//  - live tag gh-<x>, x ancestor of sha                  -> deploy (normal forward release)
//  - live tag gh-<x>, sha ancestor of x                  -> skip (stale run; newer already live)
//  - anything else (manual/out-of-band deploy, diverged) -> refuse; owner reconciles
export function decideRelease({ liveVersionId, liveTag, sha, baseline, isAncestor, resolve }) {
  if (liveVersionId === baseline.versionId) return { action: 'deploy', reason: `live is recorded baseline ${baseline.versionId} (${baseline.tag})` };
  if (liveTag && liveTag.startsWith(TAG_PREFIX)) {
    const liveSha = resolve(liveTag.slice(TAG_PREFIX.length));
    if (!liveSha) return { action: 'refuse', reason: `live tag ${liveTag} does not resolve to a commit in this repository` };
    if (liveSha === sha) return { action: 'deploy', reason: `redeploying the same commit ${sha}` };
    if (isAncestor(liveSha, sha)) return { action: 'deploy', reason: `live ${liveSha} is an ancestor of ${sha}` };
    if (isAncestor(sha, liveSha)) return { action: 'skip', reason: `stale run: live ${liveSha} is newer than ${sha}` };
    return { action: 'refuse', reason: `live ${liveSha} and ${sha} have diverged` };
  }
  return { action: 'refuse', reason: `live version ${liveVersionId} (tag ${liveTag ?? 'none'}) was not deployed by this pipeline and is not the recorded baseline; reconcile production with main first (docs/deploy-pipeline.md#recovery)` };
}

// ---- Migrations ----

export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
// Additive statements the pipeline may auto-apply. Anything else (DROP, DELETE, UPDATE,
// REPLACE, RENAME, table rebuilds, PRAGMA, ...) can lose data or break the previous Worker if
// a deploy fails after migrating: it needs explicit owner approval (marker) and is never
// auto-applied by the pipeline.
const ADDITIVE = [
  /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TABLE\s/i,
  /^CREATE\s+(UNIQUE\s+)?INDEX\s/i,
  /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?VIEW\s/i,
  /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\s/i,
  /^ALTER\s+TABLE\s+\S+\s+ADD\s/i,
  /^INSERT\s+(OR\s+IGNORE\s+)?INTO\s/i,
];
export const APPROVAL_MARKER = /^--\s*owner-approved-destructive:\s*\S.+$/m;

// Split SQL into statements, dropping -- and /* */ comments but never inside quoted
// strings or identifiers ('..', "..", `..`, [..]). Trigger bodies (BEGIN ... END) stay whole.
export function sqlStatements(sql) {
  const out = []; let cur = ''; let i = 0;
  const closer = { "'": "'", '"': '"', '`': '`', '[': ']' };
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (two === '--') { while (i < sql.length && sql[i] !== '\n') i++; cur += ' '; continue; }
    if (two === '/*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; cur += ' '; continue; }
    if (closer[c]) { const e = sql.indexOf(closer[c], i + 1); const j = e < 0 ? sql.length : e + 1; cur += sql.slice(i, j); i = j; continue; }
    if (c === ';') {
      const t = cur.trim();
      if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\s/i.test(t) && !/\bEND$/i.test(t)) { cur += ';'; i++; continue; }
      if (t) out.push(t.replace(/\s+/g, ' '));
      cur = ''; i++; continue;
    }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
  return out;
}

export function nonAdditiveStatements(sql) {
  return sqlStatements(sql).filter((st) => !ADDITIVE.some((re) => re.test(st)) || /^INSERT\s+OR\s+(REPLACE|ROLLBACK|ABORT|FAIL)\b/i.test(st));
}

export function readMigrations(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, sha256: sha256(sql), destructive: nonAdditiveStatements(sql).length > 0, approved: APPROVAL_MARKER.test(sql) };
  });
}

// applied: names from d1_migrations in id order. repo: readMigrations() output.
// Throws on drift; returns pending migrations in the order wrangler will apply them.
export function planMigrations(applied, repo) {
  const names = repo.map((m) => m.name);
  for (const n of names) if (!MIGRATION_NAME.test(n)) throw new Error(`bad migration filename ${n}`);
  const unknown = applied.filter((n) => !names.includes(n));
  if (unknown.length) throw new Error(`production has applied migrations missing from this revision: ${unknown.join(', ')}; refusing (source is behind production)`);
  const sortedApplied = [...applied].sort();
  if (JSON.stringify(sortedApplied) !== JSON.stringify(applied)) throw new Error(`production migration history is not in filename order: ${applied.join(', ')}`);
  const last = applied.at(-1);
  const pending = repo.filter((m) => !applied.includes(m.name));
  const early = pending.filter((m) => last && m.name < last);
  if (early.length) throw new Error(`pending migrations sort before the last applied (${last}): ${early.map((m) => m.name).join(', ')}; rename them to sort after it`);
  const blocked = pending.filter((m) => m.destructive);
  if (blocked.length) throw new Error(`pending destructive migrations need a manual owner-run window, not auto-deploy: ${blocked.map((m) => m.name).join(', ')} (docs/deploy-pipeline.md#destructive-migrations)`);
  return pending;
}

function sortObj(o) { return Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b))); }
