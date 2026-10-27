import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { validate, makeConfig, selfHostBundle } from '../scripts/self-host/setup.mjs';
const input = { workerName:'test-library', accountId:'abcd'.repeat(8), databaseName:'test-library-db', databaseId:'abcdef12-1234-4234-8234-123456789abc', bucketName:'test-library-blobs', kvNamespaceId:'bcde'.repeat(8), appHost:'library.example.test', mcpHost:'mcp.example.test', accessTeamDomain:'test-team.cloudflareaccess.com', accessAudience:'audience-for-synthetic-fixture', ownerEmail:'owner@example.test', oidcClientId:'syntheticClient', oidcIssuer:'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/syntheticClient' };
const script = resolve('scripts/self-host/setup.mjs');
test('requires explicit non-secret fields and a consistent, separated auth configuration', () => {
  assert.deepEqual(validate(input),input);
  for (const patch of [{APP_SECRET:'DO_NOT_ECHO'}, {ownerEmail:''}, {appHost:input.mcpHost}, {oidcIssuer:'https://attacker.test/'}, {oidcClientId:'differentClient'}, {workerName:'$(touch unsafe)'}, {appHost:'library.example.com'}, {mcpHost:'library-mcp.example.com'}, {databaseId:'11111111-1111-4111-8111-111111111111'}, {databaseId:'00000000-0000-0000-0000-000000000000'}, {accountId:'0'.repeat(32)}, {oidcClientId:'replaceWithYourOidcClientId',oidcIssuer:'https://test-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/replaceWithYourOidcClientId'}]) assert.throws(()=>validate({...input,...patch}));
  assert.throws(()=>validate(JSON.parse(readFileSync('scripts/self-host/example.json'))));
  const c=makeConfig(input);
  assert.equal(c.vars.MCP_HOST,input.mcpHost);
  assert.equal(c.vars.APP_HOST,input.appHost);
  assert.equal(c.vars.LOCAL_DEV_LOGIN,undefined);
  assert.equal(c.vars.ACCESS_CERTS_URL,undefined);
  assert.equal(c.workers_dev,false);
  assert.equal(c.preview_urls,false);
  assert.equal(c.no_bundle,true);
  assert.deepEqual(c.compatibility_flags,['global_fetch_strictly_public']);
  assert.deepEqual(c.triggers.crons,['*/15 * * * *']);
  assert.deepEqual(c.d1_databases.map(b=>b.binding),['DB']);
  assert.deepEqual(c.r2_buckets.map(b=>b.binding),['BLOBS']);
  assert.deepEqual(c.kv_namespaces.map(b=>b.binding),['OAUTH_KV']);
  assert.doesNotMatch(JSON.stringify(c),/hosted|SECRET/);
  assert.equal(c.vars.OAUTH_EXTRA_REDIRECT_URIS,undefined,'no extra callbacks unless configured');
  const gw=makeConfig(validate({...input,extraRedirectUris:['https://gateway.example.test/oauth/callback','https://other.example.test/cb']}));
  assert.equal(gw.vars.OAUTH_EXTRA_REDIRECT_URIS,'https://gateway.example.test/oauth/callback https://other.example.test/cb');
  for (const bad of [['http://gateway.example.test/cb'],['https://gateway.example.test/cb?x=1'],['https://*.example.test/cb'],['https://gateway.example.test/cb#f'],'https://gateway.example.test/cb',Array(11).fill('https://a.example.test/cb')])
    assert.throws(()=>validate({...input,extraRedirectUris:bad}),/extraRedirectUris/);
});
test('the committed bundle is installation-neutral and is staged unchanged',()=>{
  const source=readFileSync('src/index.js','utf8');
  assert.equal(selfHostBundle(source),source);
  // No operator hostnames, gateways or owner identities are compiled in; they all come from config.
  assert.doesNotMatch(source,/cc-hosted-mcp-gateway|workers\.dev\/upstream|cloudflareaccess\.com\/cdn-cgi|@gmail\.com/);
  assert.ok(source.includes('https://chatgpt.com/connector_platform_oauth_redirect'));
  assert.match(source,/EXTRA_CALLBACKS\.has\(u\)/);
  assert.match(source,/api_base: ctx.env.MCP_HOST/);
});
test('CLI dry-run writes nothing, stages all migrations and refuses overwrite without leaking unknown values',()=>{
  const dir=mkdtempSync(join(tmpdir(),'al-self-host-'));
  try {
    const file=join(dir,'input.json'), out=join(dir,'install');
    writeFileSync(file,JSON.stringify(input));
    execFileSync(process.execPath,[script,'--input',file,'--out',out,'--dry-run']);
    assert.equal(existsSync(out),false);
    execFileSync(process.execPath,[script,'--input',file,'--out',out]);
    const c=JSON.parse(readFileSync(join(out,'wrangler.json')));
    assert.deepEqual(c,makeConfig(input));
    assert.equal(readFileSync(join(out,'worker/index.js'),'utf8'),selfHostBundle(readFileSync('src/index.js','utf8')));
    assert.ok(existsSync(join(out,'migrations/0011_upload_finalize_lease.sql')));
    assert.ok(existsSync(join(out,'manifest.json')));
    assert.equal(JSON.parse(readFileSync(join(out,'manifest.json'))).version,'0.1.0');
    assert.equal(JSON.parse(readFileSync(join(out,'manifest.json'))).license,'MIT');
    assert.equal(readFileSync(join(out,'LICENSE'),'utf8'),readFileSync('LICENSE','utf8'));
    assert.equal(readFileSync(join(out,'THIRD_PARTY_NOTICES.md'),'utf8'),readFileSync('THIRD_PARTY_NOTICES.md','utf8'));
    assert.equal(spawnSync(process.execPath,[script,'--input',file,'--out',out]).status,1);
    writeFileSync(file,JSON.stringify({...input,secret:'DO_NOT_ECHO'}));
    const bad=spawnSync(process.execPath,[script,'--input',file],{encoding:'utf8'});
    assert.equal(bad.status,1);
    assert.doesNotMatch(bad.stdout+bad.stderr,/DO_NOT_ECHO/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
