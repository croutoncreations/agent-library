#!/usr/bin/env node
// Offline only. No credentials, subprocesses, network, resource creation or deployment.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function validate(input) {
  const patterns = {
    workerName: /^[a-z][a-z0-9-]{1,50}$/, accountId: /^[a-f0-9]{32}$/,
    databaseName: /^[a-z][a-z0-9-]{1,50}$/, databaseId: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    bucketName: /^[a-z][a-z0-9-]{2,62}$/, kvNamespaceId: /^[a-f0-9]{32}$/,
    appHost: /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/,
    mcpHost: /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/,
    accessTeamDomain: /^[a-z0-9-]+\.cloudflareaccess\.com$/,
    accessAudience: /^[A-Za-z0-9_-]{16,256}$/, ownerEmail: /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/,
    oidcClientId: /^[A-Za-z0-9]{8,128}$/, oidcIssuer: /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/cdn-cgi\/access\/sso\/oidc\/[A-Za-z0-9]+$/,
  };
  // Optional: exact https callbacks to trust besides the built-in ChatGPT/Claude/Cursor ones (e.g. your own MCP gateway).
  const optional = { extraRedirectUris: /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9/_.~-]*$/ };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Expected a JSON object');
  for (const key of Object.keys(input)) if (!Object.hasOwn(patterns, key) && !Object.hasOwn(optional, key)) throw Error('Unknown field; input must contain non-secret configuration only');
  for (const [key, re] of Object.entries(patterns)) if (typeof input[key] !== 'string' || !re.test(input[key])) throw Error(`Invalid or missing ${key}`);
  if (input.extraRedirectUris !== undefined && (!Array.isArray(input.extraRedirectUris) || input.extraRedirectUris.length > 10 || !input.extraRedirectUris.every((u) => typeof u === 'string' && optional.extraRedirectUris.test(u))))
    throw Error('extraRedirectUris must be a list of up to 10 exact https callback URLs (no query, fragment or wildcard)');
  if (input.appHost === input.mcpHost) throw Error('App and MCP hosts must differ');
  if (input.oidcIssuer !== `https://${input.accessTeamDomain}/cdn-cgi/access/sso/oidc/${input.oidcClientId}`) throw Error('OIDC issuer must match team and client ID');
  if (Object.values(input).some(value => /replaceWith|^replace-/.test(value)) || /^(0+|1+)$/.test(input.accountId) || /^(0+|2+)$/.test(input.kvNamespaceId) || [input.appHost, input.mcpHost].some(host => /(?:^|\.)example\.(com|net|org|invalid)$/.test(host)) || /^(00000000-0000-0000-0000-000000000000|11111111-1111-4111-8111-111111111111)$/.test(input.databaseId)) throw Error('Replace example placeholders with your existing resource identifiers');
  return input;
}
export function makeConfig(v) {
  return {
    name: v.workerName, account_id: v.accountId, main: 'worker/index.js',
    compatibility_date: '2025-09-01', compatibility_flags: ['global_fetch_strictly_public'],
    no_bundle: true, find_additional_modules: false, workers_dev: false, preview_urls: false,
    routes: [{ pattern: v.appHost, custom_domain: true }, { pattern: v.mcpHost, custom_domain: true }],
    triggers: { crons: ['*/15 * * * *'] },
    vars: { ACCESS_TEAM_DOMAIN: v.accessTeamDomain, ACCESS_AUD: v.accessAudience, OWNER_EMAIL: v.ownerEmail,
      APP_HOST: v.appHost, MCP_HOST: v.mcpHost, ACCESS_OIDC_ISSUER: v.oidcIssuer, ACCESS_OIDC_CLIENT_ID: v.oidcClientId, APP_CONNECT_ENABLED: '1',
      ...(v.extraRedirectUris?.length ? { OAUTH_EXTRA_REDIRECT_URIS: v.extraRedirectUris.join(' ') } : {}) },
    d1_databases: [{ binding: 'DB', database_name: v.databaseName, database_id: v.databaseId, migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'BLOBS', bucket_name: v.bucketName }],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: v.kvNamespaceId }],
  };
}
// The committed bundle is installation-neutral (hostnames, owner and extra callbacks all come from config),
// so self-hosting stages it byte-for-byte.
export function selfHostBundle(bundle) {
  return bundle;
}
function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) { console.log('Usage: node scripts/self-host/setup.mjs --input operator.json [--out dist/self-host] [--dry-run]\nOffline: validates existing IDs and stages config/bundle/migrations; never provisions or deploys.'); return; }
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') { opts.dryRun = true; continue; }
    if (!['--input', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Invalid arguments');
    opts[args[i].slice(2)] = args[++i];
  }
  if (!opts.input) throw Error('--input is required');
  const v = validate(JSON.parse(readFileSync(resolve(opts.input), 'utf8')));
  const config = makeConfig(v);
  const bundle = selfHostBundle(readFileSync(join(root, 'src/index.js'), 'utf8'));
  const digest = createHash('sha256').update(bundle).digest('hex');
  if (opts.dryRun) { console.log(`Validated offline: DB/R2/KV bindings, two hosts, Access/OIDC; bucket privacy requires operator verification; bundle SHA-256 ${digest}. No files written.`); return; }
  const out = resolve(opts.out || join(root, 'dist/self-host'));
  // Exclusive creation prevents overwriting config or an existing installation.
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(out, { recursive: false, mode: 0o700 });
  mkdirSync(join(out, 'worker'));
  writeFileSync(join(out, 'worker/index.js'), bundle);
  cpSync(join(root, 'migrations'), join(out, 'migrations'), { recursive: true });
  writeFileSync(join(out, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(join(root, file), join(out, file));
  const release = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version: release.version, license: release.license, bundleSha256: digest, sourceSha256: createHash('sha256').update(readFileSync(join(root, 'src/index.js'))).digest('hex') }, null, 2) + '\n');
  console.log(`Staged offline in ${out}. See docs/self-hosting.md for explicit migration, secret and deployment commands. Nothing was provisioned or deployed.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e instanceof SyntaxError ? 'Invalid JSON input' : e.message); process.exitCode = 1; }
}
