#!/usr/bin/env node
// Bounded post-deploy checks against production. At most 27 requests, 10 s each,
// no uploads, no project listing beyond the synthetic smoke credential's scope.
//
// Levels (each reported separately in the receipt; a lower level never counts as a higher one):
//   boundary  - unauthenticated requests are stopped at the right place:
//               app host -> Cloudflare Access login redirect (NOT an application check),
//               MCP endpoint -> 401 with OAuth challenge, OAuth metadata served by the Worker.
//   app       - authenticated application check through the machine API with a
//               synthetic-project credential (AL_SMOKE_API_TOKEN). Skipped if not configured.
//   workflow  - synthetic artifact round trip: expected-revision save of one fixed synthetic
//               file, then read back. Only when AL_SMOKE_FILE_ID is configured.
//
// Writes JSON results to argv[2]. Exit code 1 if any executed check failed.
import { writeFileSync } from 'node:fs';
import { loadTarget } from './lib.mjs';

const out = process.argv[2] ?? 'smoke.json';
const t = loadTarget();
const APP = `https://${t.vars.APP_HOST}`;
const MCP = `https://${t.vars.MCP_HOST}`;
const accessLogin = `https://${t.vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/login/`;
const token = process.env.AL_SMOKE_API_TOKEN || '';
const smokeProject = process.env.AL_SMOKE_PROJECT_ID || '';
const smokeFile = process.env.AL_SMOKE_FILE_ID || '';
const sha = process.env.APP_SHA || process.env.GITHUB_SHA || 'local';
const results = [];

async function req(url, init = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...init, headers: { 'user-agent': 'agent-library-ci-smoke/1', ...(init.headers ?? {}) } });
}

async function check(level, name, fn, { attempts = 3 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { const detail = await fn(); results.push({ level, name, ok: true, detail }); return; }
    catch (e) { last = e; if (i < attempts) await new Promise((r) => setTimeout(r, 5000 * i)); }
  }
  results.push({ level, name, ok: false, detail: String(last?.message ?? last) });
}
const must = (c, msg) => { if (!c) throw new Error(msg); };
const auth = { authorization: `Bearer ${token}` };

await check('boundary', 'app host requires Cloudflare Access (login redirect only, not an app check)', async () => {
  const r = await req(`${APP}/`);
  const loc = r.headers.get('location') ?? '';
  must(r.status === 302 && loc.startsWith(accessLogin), `expected 302 to Access login, got ${r.status} ${loc.slice(0, 80)}`);
  return `302 -> ${accessLogin}`;
});
await check('boundary', 'app API requires Cloudflare Access', async () => {
  const r = await req(`${APP}/api/projects`);
  must(r.status === 302 && (r.headers.get('location') ?? '').startsWith(accessLogin), `expected Access redirect, got ${r.status}`);
  return '302 -> Access login';
});
await check('boundary', 'MCP host serves OAuth authorization-server metadata from the Worker', async () => {
  const r = await req(`${MCP}/.well-known/oauth-authorization-server`);
  must(r.status === 200, `status ${r.status}`);
  const j = await r.json();
  must(String(j.issuer ?? '').includes(t.vars.MCP_HOST), `issuer ${j.issuer}`);
  must(j.authorization_endpoint && j.token_endpoint, 'missing endpoints');
  return `issuer ${j.issuer}`;
});
await check('boundary', 'MCP endpoint rejects unauthenticated calls', async () => {
  const r = await req(`${MCP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci-smoke","version":"1"}}}' });
  must(r.status === 401, `expected 401, got ${r.status}`);
  return `401${r.headers.get('www-authenticate') ? ' with WWW-Authenticate' : ''}`;
});
await check('boundary', 'machine API rejects a missing credential', async () => {
  const r = await req(`${MCP}/v1/projects`);
  must(r.status === 401, `expected 401, got ${r.status}`);
  return '401';
});

if (!token || !smokeProject) {
  results.push({ level: 'app', name: 'authenticated application check', ok: null, detail: 'SKIPPED: AL_SMOKE_API_TOKEN / AL_SMOKE_PROJECT_ID not configured' });
} else {
  await check('app', 'synthetic credential lists exactly its synthetic project', async () => {
    const r = await req(`${MCP}/v1/projects`, { headers: auth });
    must(r.status === 200, `status ${r.status}`);
    const { projects } = await r.json();
    must(projects.some((p) => p.id === smokeProject), 'smoke project not visible');
    must(projects.length === 1, `smoke credential must be scoped to one synthetic project, sees ${projects.length}`);
    return `200, project ${smokeProject}`;
  });
  await check('app', 'connection diagnostic reports only this authenticated synthetic scope', async () => {
    const r = await req(`${MCP}/v1/connection-info`, { headers: auth });
    must(r.status === 200, `diagnostic status ${r.status}`);
    must((r.headers.get('cache-control') ?? '').includes('no-store'), 'diagnostic must not be cached');
    const d = await r.json();
    must(d.connection?.type === 'api_key' && typeof d.connection.id === 'string' && d.connection.id.length > 0, 'missing safe connection identity');
    must(d.projects?.length === 1 && d.projects[0].id === smokeProject, 'diagnostic scope differs from the synthetic credential');
    must(d.projects[0].can_read === true && typeof d.projects[0].can_write === 'boolean', 'missing effective capabilities');
    if (smokeFile) must(d.projects[0].can_write === true, 'synthetic workflow credential lacks write capability');
    must(Number.isFinite(Date.parse(d.checked_at)), 'missing diagnostic check time');
    must(d.successful_operations === 'not measured', 'activity must not imply a successful document operation');
    return `200, safe connection ${d.connection.id}, exactly the synthetic project; metadata only`;
  });
  await check('app', 'connection diagnostic rejects arbitrary identity parameters', async () => {
    const r = await req(`${MCP}/v1/connection-info?connection_id=not-a-connection`, { headers: auth });
    must(r.status === 400, `expected 400, got ${r.status}`);
    return '400; callers cannot request another connection';
  });
  if (!smokeFile) {
    results.push({ level: 'workflow', name: 'synthetic artifact round trip', ok: null, detail: 'SKIPPED: AL_SMOKE_FILE_ID not configured' });
  } else {
    await check('workflow', 'synthetic artifact expected-revision save and read back', async () => {
      const base = `${MCP}/v1/projects/${encodeURIComponent(smokeProject)}/files/${encodeURIComponent(smokeFile)}`;
      const g = await req(base, { headers: auth });
      must(g.status === 200, `read status ${g.status}`);
      const cur = await g.json();
      const rev = cur.revision?.rev;
      must(Number.isInteger(rev), 'no revision');
      const body = `# CI smoke (synthetic)\n\ncommit ${sha}\nrun ${process.env.GITHUB_RUN_ID ?? 'local'}\n`;
      const p = await req(base, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': `ci-smoke-${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}` }, body: JSON.stringify({ expected_revision: rev, body }) });
      must(p.status === 200 || p.status === 201, `save status ${p.status}`);
      const c = await req(`${base}/content`, { headers: auth });
      must(c.status === 200, `content status ${c.status}`);
      must((await c.text()) === body, 'read-back mismatch');
      return `rev ${rev} -> ${rev + 1}, read back OK`;
    }, { attempts: 1 }); // no blind retry of a write; the idempotency key covers transport retries
  }
}

writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
for (const r of results) console.log(`${r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} [${r.level}] ${r.name}: ${r.detail}`);
process.exit(results.some((r) => r.ok === false) ? 1 : 0);
