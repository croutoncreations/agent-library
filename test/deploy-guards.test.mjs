// Deploy pipeline guards: pure logic only, no network, no Cloudflare, no production data.
// Runs against the committed examples with synthetic IDs filled in; if an installation's own
// wrangler.toml and deploy/production.json exist (gitignored), it also checks that they match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { decideRelease, effectiveLive, checkLiveVersion, checkConfigAgainstTarget, hostedConfig, loadTarget, loadWrangler, loadExampleTarget, loadExampleWrangler, planMigrations, nonAdditiveStatements, tagFor } from '../scripts/deploy/lib.mjs';

// Synthetic installation: the examples with their placeholders replaced by fake but well-formed IDs.
const SYN = { d1: 'abcdef12-1234-4234-8234-123456789abc', kv: 'bcde'.repeat(8) };
function synthetic() {
  const t = loadExampleTarget(), w = loadExampleWrangler();
  t.bindings.d1[0].id = SYN.d1; t.bindings.kv[0].id = SYN.kv; t.accountId = 'cdef'.repeat(8);
  t.customDomains = ['library.test.invalid', 'library-mcp.test.invalid'];
  w.env.hosted.routes = t.customDomains.map((pattern) => ({ pattern, custom_domain: true }));
  t.baseline = { versionId: 'baseline-version', tag: 'baseline' };
  w.env.hosted.d1_databases[0].database_id = SYN.d1; w.env.hosted.kv_namespaces[0].id = SYN.kv;
  return { t, w };
}
const { t: target, w: wrangler } = synthetic();
const loadWranglerSynthetic = () => structuredClone(wrangler);
const baseline = target.baseline;
// Linear history a <- b <- c, plus a diverged commit x.
const parents = { b: 'a', c: 'b', x: 'a' };
const isAncestor = (anc, d) => { for (let n = d; n; n = parents[n]) if (n === anc) return true; return false; };
const resolve = (s) => (['a', 'b', 'c', 'x'].includes(s) ? s : null);
const decide = (liveVersionId, liveTag, sha) => decideRelease({ liveVersionId, liveTag, sha, baseline, isAncestor, resolve });

test('first activation deploys only over the recorded baseline version', () => {
  assert.equal(decide(baseline.versionId, baseline.tag, 'c').action, 'deploy');
  assert.equal(decide('some-other-version', baseline.tag, 'c').action, 'refuse', 'tag alone is not enough');
});

test('forward releases deploy; stale runs skip; divergence and out-of-band deploys refuse', () => {
  assert.equal(decide('v2', 'gh-b', 'c').action, 'deploy');
  assert.equal(decide('v2', 'gh-c', 'c').action, 'deploy', 'redeploy of the same commit is allowed');
  assert.equal(decide('v3', 'gh-c', 'b').action, 'skip', 'older commit never overwrites newer release');
  assert.equal(decide('v3', 'gh-x', 'c').action, 'refuse');
  assert.equal(decide('v3', 'gh-zzz', 'c').action, 'refuse', 'unknown commit');
  assert.equal(decide('v3', 'manual-hotfix', 'c').action, 'refuse');
  assert.equal(decide('v3', null, 'c').action, 'refuse');
});

test('tags fit Cloudflare limits and are deterministic', () => {
  const t = tagFor('0123456789abcdef0123456789abcdef01234567');
  assert.equal(t, 'gh-0123456789ab');
  assert.ok(t.length <= 25);
});

function liveFixture(mut = (b) => b) {
  const bindings = [
    ...Object.entries(target.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    { type: 'secret_text', name: 'ACCESS_OIDC_CLIENT_SECRET' },
    { type: 'd1', name: 'DB', id: target.bindings.d1[0].id },
    { type: 'kv_namespace', name: 'OAUTH_KV', namespace_id: target.bindings.kv[0].id },
    { type: 'r2_bucket', name: 'BLOBS', bucket_name: target.bindings.r2[0].bucket },
  ];
  return { resources: { bindings: mut(bindings), script_runtime: { compatibility_date: target.compatibilityDate } } };
}

test('live version matching the target passes', () => {
  assert.deepEqual(checkLiveVersion(liveFixture(), target), []);
});

test('a var added or changed by this deploy passes only via pendingVars pinned to the value it replaces', () => {
  const ok = (t) => assert.deepEqual(checkLiveVersion(liveFixture(), t), []);
  const refuse = (t, why) => assert.notDeepEqual(checkLiveVersion(liveFixture(), t), [], why);
  const added = { ...target, vars: { ...target.vars, OAUTH_EXTRA_REDIRECT_URIS: 'https://gateway.example.test/cb' } };
  refuse(added, 'undeclared target-only var refuses (it may have been removed live)');
  ok({ ...added, pendingVars: { OAUTH_EXTRA_REDIRECT_URIS: null } });
  const liveHost = target.vars.APP_HOST;
  const changed = { ...target, vars: { ...target.vars, APP_HOST: 'new.example.test' } };
  refuse(changed, 'undeclared value change refuses');
  ok({ ...changed, pendingVars: { APP_HOST: liveHost } });
  // A forgotten entry must not override a later live change (e.g. a kill switch flipped in the dashboard).
  refuse({ ...changed, pendingVars: { APP_HOST: 'something-else.example.test' } }, 'live no longer holds the expected value');
  refuse({ ...added, pendingVars: { OAUTH_EXTRA_REDIRECT_URIS: 'https://old.example.test/cb' } }, 'expected a value but the var is absent live');
  refuse({ ...target, pendingVars: { APP_CONNECT_ENABLED: null } }, 'expected absent but the var is live (and already equal)');
  refuse({ ...target, pendingVars: { APP_CONNECT_ENABLED: target.vars.APP_CONNECT_ENABLED } }, 'an entry already live with the target value must be cleared');
  refuse({ ...target, pendingVars: { NOT_IN_VARS: null } }, 'pendingVars must name a target var');
  refuse({ ...target, pendingVars: ['APP_HOST'] }, 'pendingVars must be an object, not a list');
  refuse({ ...changed, pendingVars: { APP_HOST: 1 } }, 'expected value must be a string or null');
  refuse({ ...target, newVars: [] }, 'the old field is rejected, not silently ignored');
  const dropped = { ...target, vars: Object.fromEntries(Object.entries(target.vars).filter(([k]) => k !== 'APP_CONNECT_ENABLED')) };
  refuse(dropped, 'removing a live var is a reviewed, manual change');
  refuse({ ...dropped, pendingVars: { APP_CONNECT_ENABLED: '1' } }, 'pendingVars cannot remove a live var');
});

test('live drift blocks deploy instead of being overwritten', () => {
  const cases = {
    'missing secret': (b) => b.filter((x) => x.name !== 'ACCESS_OIDC_CLIENT_SECRET'),
    'other D1': (b) => b.map((x) => (x.type === 'd1' ? { ...x, id: 'ffffffff-0000-0000-0000-000000000000' } : x)),
    'other KV': (b) => b.map((x) => (x.type === 'kv_namespace' ? { ...x, namespace_id: 'f'.repeat(32) } : x)),
    'other bucket': (b) => b.map((x) => (x.type === 'r2_bucket' ? { ...x, bucket_name: 'new-bucket' } : x)),
    'dashboard var': (b) => [...b, { type: 'plain_text', name: 'NEW_FLAG', text: '1' }],
    'var changed': (b) => b.map((x) => (x.name === 'APP_HOST' ? { ...x, text: 'other.example.test' } : x)),
    'var removed': (b) => b.filter((x) => x.name !== 'APP_CONNECT_ENABLED'),
    'unexpected binding type': (b) => [...b, { type: 'durable_object_namespace', name: 'DO' }],
  };
  const flags = liveFixture(); flags.resources.script_runtime.compatibility_flags = ['nodejs_compat'];
  assert.notDeepEqual(checkLiveVersion(flags, target), [], 'compatibility flags drift');
  for (const [name, mut] of Object.entries(cases)) assert.notDeepEqual(checkLiveVersion(liveFixture(mut), target), [], name);
});

test('wrangler.example.toml [env.hosted] and deploy/production.example.json describe the same installation', () => {
  assert.deepEqual(checkConfigAgainstTarget(hostedConfig(loadWranglerSynthetic()), target), []);
});

test('the shipped examples are rejected as-is (placeholder IDs never deploy)', () => {
  assert.notDeepEqual(checkConfigAgainstTarget(hostedConfig(loadExampleWrangler()), loadExampleTarget()), []);
});

// Not skipped when absent: CI forbids skips. Public checkouts have neither file (the deploy repo copies them in),
// and having only one of the two is a setup mistake.
test('an installation\'s own wrangler.toml [env.hosted] matches its deploy/production.json (when present)', () => {
  const have = [existsSync('wrangler.toml'), existsSync('deploy/production.json')];
  assert.equal(have[0], have[1], 'wrangler.toml and deploy/production.json must be present together');
  if (have[0]) assert.deepEqual(checkConfigAgainstTarget(hostedConfig(loadWrangler()), loadTarget()), []);
});

test('deploy scripts never fall back to the examples', () => {
  assert.throws(() => loadTarget('test'), /never fall back to the example/);
  assert.throws(() => loadWrangler('test'), /never fall back to the example/);
});

test('config checks catch placeholder IDs, missing vars, routes and cron changes', () => {
  const good = hostedConfig(loadWranglerSynthetic());
  const variants = {
    placeholderD1: { ...good, d1: good.d1.map((d) => ({ ...d, id: '00000000-0000-0000-0000-000000000000' })) },
    placeholderKv: { ...good, kv: good.kv.map((k) => ({ ...k, id: '0'.repeat(32) })) },
    missingVar: { ...good, vars: Object.fromEntries(Object.entries(good.vars).filter(([k]) => k !== 'APP_CONNECT_ENABLED')) },
    droppedDomain: { ...good, routes: good.routes.slice(1) },
    noCron: { ...good, crons: [] },
    workersDev: { ...good, workersDev: true },
    bundled: { ...good, noBundle: false },
  };
  for (const [name, cfg] of Object.entries(variants)) assert.notDeepEqual(checkConfigAgainstTarget(cfg, target), [], name);
});

test('the default (non-hosted) config is never accepted as a deploy target', () => {
  const w = loadWranglerSynthetic();
  assert.throws(() => hostedConfig({ ...w, env: {} }), /refusing to use the default/);
  const top = { name: w.name, main: w.main, vars: w.vars ?? {}, d1: [{ id: w.d1_databases[0].database_id }], kv: [{ id: w.kv_namespaces[0].id }], r2: [], routes: [], crons: [], compatibilityFlags: [] };
  assert.notDeepEqual(checkConfigAgainstTarget(top, target), []);
});

const m = (name, sql = 'CREATE TABLE IF NOT EXISTS t (id TEXT);') => ({ name, sql, destructive: nonAdditiveStatements(sql).length > 0, approved: false });

test('migration plan: nothing pending, pending in order, retry after partial apply', () => {
  const repo = [m('0001_a.sql'), m('0002_b.sql'), m('0003_c.sql')];
  assert.deepEqual(planMigrations(['0001_a.sql', '0002_b.sql', '0003_c.sql'], repo), []);
  assert.deepEqual(planMigrations(['0001_a.sql'], repo).map((x) => x.name), ['0002_b.sql', '0003_c.sql']);
  // A failed run that applied 0002 only: retry applies exactly the remainder.
  assert.deepEqual(planMigrations(['0001_a.sql', '0002_b.sql'], repo).map((x) => x.name), ['0003_c.sql']);
});

test('migration plan refuses source behind production, out-of-order and destructive pending', () => {
  const repo = [m('0001_a.sql'), m('0003_c.sql')];
  assert.throws(() => planMigrations(['0001_a.sql', '0002_b.sql'], repo), /missing from this revision/);
  assert.throws(() => planMigrations(['0001_a.sql', '0003_c.sql'], [...repo, m('0002_b.sql')].sort((a, b) => a.name.localeCompare(b.name))), /sort before the last applied/);
  assert.throws(() => planMigrations(['0001_a.sql'], [m('0001_a.sql'), m('0002_drop.sql', 'DROP TABLE x;')]), /destructive/);
  assert.throws(() => planMigrations([], [m('2_bad.sql')]), /bad migration filename/);
});

test('secret rotation / settings versions decide from the code version underneath', () => {
  const tagged = { versionId: 'v5', tag: 'gh-b', triggeredBy: 'deployment' };
  const secret = { versionId: 'v6', tag: null, triggeredBy: 'secret' };
  const e = effectiveLive([secret, tagged], baseline);
  assert.equal(e.versionId, 'v5'); assert.equal(e.via, 'v6');
  assert.equal(decide(e.versionId, e.tag, 'c').action, 'deploy');
  // Over the baseline too.
  assert.equal(effectiveLive([secret, { versionId: baseline.versionId, tag: baseline.tag, triggeredBy: 'deployment' }], baseline).versionId, baseline.versionId);
  // A manual code deploy underneath still refuses.
  const manual = effectiveLive([secret, { versionId: 'v7', tag: 'hotfix', triggeredBy: 'deployment' }, tagged], baseline);
  assert.equal(manual.versionId, 'v7');
  assert.equal(decide(manual.versionId, manual.tag, 'c').action, 'refuse');
});

test('only secret changes are walked back; upload, promotion, dashboard and unknown triggers count as code', () => {
  const tagged = { versionId: 'v5', tag: 'gh-b', triggeredBy: 'deployment' };
  for (const trig of ['upload', 'promotion', 'version_upload', 'deployment', 'rollback', 'update_settings', 'dashboard', 'something_new', undefined, null]) {
    const top = { versionId: 'v9', tag: null, triggeredBy: trig };
    const e = effectiveLive([top, tagged], baseline);
    assert.equal(e.versionId, 'v9', `trigger ${trig} must not be walked past`);
    assert.equal(e.via, null);
    assert.equal(decide(e.versionId, e.tag, 'c').action, 'refuse', `out-of-band ${trig} version must refuse`);
    // Also when it hides under a secret change.
    const under = effectiveLive([{ versionId: 'v10', tag: null, triggeredBy: 'secret' }, top, tagged], baseline);
    assert.equal(under.versionId, 'v9');
    assert.equal(decide(under.versionId, under.tag, 'c').action, 'refuse');
  }
  // Only secret changes in the bounded window: decide from the oldest seen (untagged -> refuse).
  const onlySecrets = effectiveLive([{ versionId: 's2', tag: null, triggeredBy: 'secret' }, { versionId: 's1', tag: null, triggeredBy: 'secret' }], baseline);
  assert.equal(decide(onlySecrets.versionId, onlySecrets.tag, 'c').action, 'refuse');
  assert.equal(effectiveLive([], baseline), null);
});

test('only additive SQL may be auto-applied; comment/quote/identifier tricks are caught', () => {
  const additive = [
    'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY);',
    'CREATE UNIQUE INDEX IF NOT EXISTS t_x ON t(x);',
    "ALTER TABLE t ADD COLUMN note TEXT NOT NULL DEFAULT '';",
    "INSERT OR IGNORE INTO t (id) VALUES ('a; DROP TABLE x; --');",
    '-- DROP TABLE x;\nCREATE TABLE y (id TEXT);',
    'CREATE TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (1); END;',
  ];
  for (const sql of additive) assert.deepEqual(nonAdditiveStatements(sql), [], sql);
  const destructive = [
    'DROP TABLE x;', 'drop table if exists x;', 'DELETE FROM t;', 'UPDATE t SET a = 1;',
    'ALTER TABLE "foo" RENAME TO bar;', 'ALTER TABLE "foo" DROP bar;', 'ALTER TABLE t DROP COLUMN c;',
    'UPDATE "foo" SET a = 1;', 'UPDATE OR IGNORE foo SET a = 1;', 'UPDATE main.foo SET a = 1;',
    '/* -- */ DROP TABLE x;', "INSERT INTO t VALUES('--'); DROP TABLE x;",
    'PRAGMA writable_schema=1;', 'INSERT OR REPLACE INTO t VALUES (1);', 'REPLACE INTO t VALUES (1);',
    'CREATE TABLE t2 (id TEXT); DROP TABLE t;',
  ];
  for (const sql of destructive) assert.notDeepEqual(nonAdditiveStatements(sql), [], sql);
});
