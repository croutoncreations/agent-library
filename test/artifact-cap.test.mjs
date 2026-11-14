// Per-project document cap (PROJECT_ARTIFACT_LIMIT): the 1000 default, operator override, invalid values falling back,
// and the template and review-approval guards. Real Worker/D1 (wrangler dev), the official MCP client for ordinary
// creation; OAuth agents for review. Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, setupProject, grant, mcpClient, key, ROOT, LOCAL_CONFIG } from './helpers.mjs';
import { startAppConnectServer } from './fixtures/app-connect-harness.mjs';
import { SERVER_PORTS } from './ports.mjs';

const FUNCTIONAL = { RATE_READS_PER_MIN: '100000', RATE_WRITES_PER_MIN: '100000', RATE_AUTHFAIL_PER_MIN: '100000' };
const logSize = (name) => { const f = join(ROOT, 'tmp', `test-state-${name}.log`); return existsSync(f) ? readFileSync(f).length : 0; };
const logSince = (name, from) => readFileSync(join(ROOT, 'tmp', `test-state-${name}.log`)).subarray(from).toString('utf8');

for (const [name, configured, limit, warns] of [
  ['default', undefined, 1000, false],
  ['raised', '1500', 1500, false],
  ['lowered', '2', 2, false],
  ['invalid zero', '0', 1000, true],
  ['invalid above the supported ceiling', '10001', 1000, true],
  ['invalid text', '12abc', 1000, true],
]) {
  test(`artifact cap: ${name}: boundary, project isolation, trash, saves and replay`, async () => {
    const vars = { ...FUNCTIONAL };
    if (configured !== undefined) vars.PROJECT_ARTIFACT_LIMIT = configured;
    const logFrom = logSize('artifact-cap');
    const s = await startServer('artifact-cap', SERVER_PORTS['artifact-cap'], { vars });
    let m;
    try {
      const h = await s.login();
      await setupProject(h, 'cap'); await setupProject(h, 'other');
      // Seed only synthetic quota rows; the requests below exercise actual creation and revision writes.
      execFileSync('wrangler', ['d1', '--config', LOCAL_CONFIG, 'execute', 'DB', '--local', '--persist-to', s.dir, '--command',
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${limit - 1}) INSERT INTO artifacts (id, project_id, kind, title, created_at, updated_at) SELECT 'quota_'||n, 'cap', 'markdown', 'Synthetic quota fixture', '2026-01-01', '2026-01-01' FROM seq`],
      { cwd: ROOT, stdio: 'pipe', env: { ...process.env, CI: '1' } });
      m = await mcpClient(s.base, (await grant(h, 'cap', 'cap-writer', true)).token);
      const input = { project_id: 'cap', title: 'Last slot', body: '# Synthetic', change_note: 'Verify project quota', idempotency_key: key('boundary') };
      const made = await m.call('create_markdown', input);
      assert.equal(made.isError, false, JSON.stringify(made));
      const id = made.data.artifact_id;
      assert.ok(id);
      assert.equal((await m.call('create_markdown', input)).data.artifact_id, id, 'a retry replays the stored result');
      const denied = await h.req('POST', '/api/projects/cap/artifacts', { title: 'Over cap', body: 'x' });
      assert.equal(denied.status, 413); assert.equal(denied.body.error.code, 'quota_exceeded');
      assert.equal((await h.req('PUT', `/api/projects/cap/artifacts/${id}`, { expected_revision: 1, body: '# Edited' })).status, 200, 'saving an existing document is not a creation');
      assert.equal((await h.req('PATCH', `/api/projects/cap/artifacts/${id}`, { expected_meta_version: 1, trashed: true })).status, 200);
      assert.equal((await h.req('POST', '/api/projects/cap/artifacts', { title: 'Trash still counts' })).status, 413);
      assert.equal((await h.req('POST', '/api/projects/other/artifacts', { title: 'Independent project' })).status, 201);
      const warnings = (logSince('artifact-cap', logFrom).match(/"event":"config_invalid"/g) ?? []).length;
      assert.equal(warnings, warns ? 1 : 0, 'an invalid value logs one config warning, however many requests read it');
    } finally { await m?.close(); await s.stop(); }
  });
}

test('artifact cap: template copy, template creation and review approval honor the configured cap', async () => {
  const P = 'capguard', LIMIT = 3;
  const h = await startAppConnectServer({ port: SERVER_PORTS['artifact-cap-guards'], vars: { PROJECT_ARTIFACT_LIMIT: String(LIMIT) } });
  let writer, reviewer;
  try {
    const owner = await h.owner();
    assert.equal((await owner.req('POST', '/api/projects', { id: P, title: 'Cap guards' })).status, 201);
    const base = `/api/projects/${P}`;
    const create = (title) => owner.req('POST', base + '/artifacts', { title, body: '# ' + title });

    // Templates: document 1 is the source, 2 the template, 3 a copy; the 4th item is refused on both paths.
    const source = (await create('Source')).body.artifact_id;
    const tpl = await owner.req('POST', base + '/templates', { source_artifact_id: source, source_revision: 1, title: 'Cap template' });
    assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
    const use = { template_id: tpl.body.artifact_id, template_revision: 1, title: 'Copy' };
    assert.equal((await owner.req('POST', base + '/artifacts/from-template', use)).status, 201);
    const copyDenied = await owner.req('POST', base + '/artifacts/from-template', { ...use, title: 'Copy over cap' });
    assert.equal(copyDenied.status, 413, JSON.stringify(copyDenied.body)); assert.equal(copyDenied.body.error.code, 'quota_exceeded');
    const defDenied = await owner.req('POST', base + '/templates', { source_artifact_id: source, source_revision: 1, title: 'Second template' });
    assert.equal(defDenied.status, 413, JSON.stringify(defDenied.body)); assert.equal(defDenied.body.error.code, 'quota_exceeded');
    assert.equal((await create('Plain over cap')).status, 413);

    // Review: a project with room for exactly one more document; two new-document proposals compete for it.
    const Q = 'capreview', qbase = `/api/projects/${Q}`;
    assert.equal((await owner.req('POST', '/api/projects', { id: Q, title: 'Cap review' })).status, 201);
    writer = await h.connectMcpAgent({ [Q]: 'write' }, { clientName: 'Cap writer' });
    reviewer = await h.connectMcpAgent({ [Q]: 'read' }, { clientName: 'Cap reviewer' });
    const connId = (await owner.req('GET', '/api/access')).body.connections.find((c) => c.client_name === 'Cap reviewer').id;
    assert.equal((await owner.req('PUT', '/api/review-grants', { path_kind: 'oauth', path_id: connId, project_id: Q, can_review: true })).status, 200);
    assert.equal((await owner.req('PUT', qbase + '/review-settings', { default: 'required', kinds: ['markdown'] })).status, 200);
    for (const t of ['Owner one', 'Owner two']) assert.equal((await owner.req('POST', qbase + '/artifacts', { title: t, body: 'x' })).status, 201);
    const propose = async (title) => {
      const r = await writer.call('create_markdown', { project_id: Q, title, body: 'x', idempotency_key: key() });
      assert.equal(r.isError, false, JSON.stringify(r.data)); assert.equal(r.data.status, 'pending_review');
      return r.data.proposal_id;
    };
    const first = await propose('Proposal one'), second = await propose('Proposal two');
    const approve = (proposal_id) => reviewer.call('review_proposal', { project_id: Q, proposal_id, decision: 'approve', idempotency_key: key() });
    const taken = await approve(first);
    assert.equal(taken.isError, false, JSON.stringify(taken.data));
    const refused = await approve(second);
    assert.equal(refused.isError, true, JSON.stringify(refused.data));
    assert.equal((refused.data.error ?? refused.data).code, 'quota_exceeded');
    const rejected = await reviewer.call('review_proposal', { project_id: Q, proposal_id: second, decision: 'reject', idempotency_key: key() });
    assert.equal(rejected.isError, false, 'a refused approval leaves the proposal open, and rejecting still works');
  } finally { await h.stop(); }
});
