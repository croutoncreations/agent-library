// Real Worker, D1, OAuth + official MCP SDK, machine API, owner UI and isolated backup round trips.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startAppConnectServer } from './fixtures/app-connect-harness.mjs';
import { SERVER_PORTS } from './ports.mjs';
import { key, grant, mcpClient, startServer, agentHttp, ROOT, LOCAL_CONFIG, barrier } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const P = 'templates', Q = 'foreign';
const base = `/api/projects/${P}`;
const sourceBody = '# {{title}}\nProject: {{project}}\nDate: {{date}}\n\n## Findings\n{{unknown}}\n<script>alert(1)</script>\n';
let h, owner, rw, ro, sdk, legacy, legacyGrant, apiKey, readKey, source, template, copy;
const path = id => `${base}/artifacts/${id}`;
async function sql(command) {
  const out = execFileSync('wrangler', ['d1', '--config', LOCAL_CONFIG, 'execute', 'DB', '--local', '--persist-to', h.dir, '--json', '--command', command], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  return JSON.parse(out)[0].results;
}
async function api(method, path, body, token = apiKey, idem = key('api')) {
  const r = await fetch(h.api + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': idem }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const use = extra => ({ template_id: template, template_revision: 1, title: 'Report', date: '2026-10-27', ...extra });
before(async () => {
  h = await startAppConnectServer({ port: SERVER_PORTS.templates }); owner = await h.owner();
  for (const [id, title] of [[P, 'Research 日本 {{date}}'], [Q, 'Foreign project']]) assert.equal((await owner.req('POST', '/api/projects', { id, title })).status, 201);
  source = (await owner.req('POST', base + '/artifacts', { title: 'Research report', body: sourceBody })).body.artifact_id;
  rw = await h.connectMcpAgent({ [P]: 'write' }); ro = await h.connectMcpAgent({ [P]: 'read' });
  sdk = new Client({ name: 'template-test', version: '1.0' });
  await sdk.connect(new StreamableHTTPClientTransport(new URL(h.issuer + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${rw.access_token}` } } }));
  legacyGrant = await grant(owner, P, 'Legacy writer', true); legacy = await mcpClient(h.appUi, legacyGrant.token);
  for (const write of [true, false]) {
    const r = await owner.req('POST', '/api/api-keys', { label: write ? 'Writer' : 'Reader', lifetime_days: 1, projects: [{ project_id: P, access: write ? 'read_write' : 'read' }] });
    assert.equal(r.status, 201); if (write) apiKey = r.body.secret; else readKey = r.body.secret;
  }
});
after(async () => { await sdk?.close(); await legacy?.close(); await h?.stop(); });

test('owner saves exact source revision as independent template; source and tag semantics unchanged', async () => {
  await owner.req('PUT', path(source), { expected_revision: 1, body: 'new source' });
  const input = { source_artifact_id: source, source_revision: 1, title: 'Research report', description: 'Question, findings and sources' };
  const idem = key(); const r = await owner.req('POST', base + '/templates', input, { idem });
  assert.equal(r.status, 201, JSON.stringify(r.body)); template = r.body.artifact_id;
  assert.notEqual(template, source);
  assert.equal((await owner.req('POST', base + '/templates', input, { idem })).body.artifact_id, template);
  const read = (await owner.req('GET', path(template))).body;
  assert.equal(read.body, sourceBody); assert.equal(read.artifact.is_template, true);
  assert.deepEqual([read.artifact.source.artifact_id, read.artifact.source.revision, read.revision.rev], [source, 1, 1]);
  const original = (await owner.req('GET', path(source))).body;
  assert.equal(original.body, 'new source'); assert.equal(original.artifact.is_template, undefined);
  await owner.req('PATCH', path(source), { expected_meta_version: 1, tags: ['template'], is_template: true });
  assert.equal((await owner.req('GET', path(source))).body.artifact.is_template, undefined);
  assert.equal((await owner.req('GET', base + '/templates')).body.templates.length, 1);
  const forged = await owner.req('POST', base + '/artifacts', { title: 'Forged', body: '', is_template: true, source_artifact_id: template });
  assert.equal((await owner.req('GET', path(forged.body.artifact_id))).body.artifact.is_template, undefined);
});

test('OAuth and legacy MCP list -> pinned read -> create -> fill via real SDK; read-only discovery', async () => {
  const tools = (await sdk.listTools()).tools;
  assert.ok(tools.some(t => t.name === 'create_from_template'));
  const roTools = (await ro.list()).map(t => t.name);
  assert.ok(roTools.includes('list_templates')); assert.ok(!roTools.includes('create_from_template'));
  const listed = (await sdk.callTool({ name: 'list_templates', arguments: { project_id: P } })).structuredContent;
  assert.equal(listed.templates[0].id, template); assert.equal(listed.templates[0].body, undefined);
  assert.match(listed.templates[0].preview_url, /\/preview$/);
  const read = (await sdk.callTool({ name: 'read_artifact', arguments: { project_id: P, artifact_id: template, revision: 1, max_bytes: 4096 } })).structuredContent;
  assert.equal(read.text, sourceBody);
  const input = { project_id: P, ...use({ title: '研究 {{date}} <img onerror=x>' }), change_note: 'Start research report', idempotency_key: key('copy') };
  const made = (await sdk.callTool({ name: 'create_from_template', arguments: input })).structuredContent;
  assert.ok(made.artifact_id, JSON.stringify(made)); copy = made.artifact_id;
  const got = (await owner.req('GET', path(copy))).body;
  assert.equal(got.body, '# 研究 {{date}} <img onerror=x>\nProject: Research 日本 {{date}}\nDate: 2026-10-27\n\n## Findings\n{{unknown}}\n<script>alert(1)</script>\n');
  assert.equal(got.artifact.is_template, undefined); assert.equal(got.artifact.source.artifact_id, template);
  const filled = await sdk.callTool({ name: 'save_markdown', arguments: { project_id: P, artifact_id: copy, expected_revision: 1, body: 'Finished findings', change_note: 'Fill report', idempotency_key: key('fill') } });
  assert.equal(filled.isError, false);
  assert.equal((await owner.req('GET', path(copy) + '/history')).body.revisions[1].change_note, 'Start research report');
  assert.equal((await legacy.call('list_templates', { project_id: P })).data.templates[0].id, template);
  const made2 = await legacy.call('create_from_template', { project_id: P, ...use(), idempotency_key: key() });
  assert.equal(made2.isError, false, JSON.stringify(made2.data));
  const denied = await ro.call('create_from_template', input); assert.equal(denied.isError, true);
});

test('machine API list/read/create/fill, read-only denial and explicit date validation', async () => {
  assert.equal((await api('GET', `/projects/${P}/templates`)).body.templates[0].id, template);
  assert.equal((await api('GET', `/projects/${P}/templates`, undefined, readKey)).status, 200);
  assert.equal((await api('GET', `/projects/${P}/files/${template}?revision=1`)).body.body, sourceBody);
  for (const date of [undefined, '', '2026-02-29', '2026-04-31', '0000-01-01', '2026-1-01', '<script>', 12]) {
    const r = await api('POST', `/projects/${P}/files/from-template`, use({ date }));
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  const made = await api('POST', `/projects/${P}/files/from-template`, use({ date: '2024-02-29' }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api('PUT', `/projects/${P}/files/${made.body.artifact_id}`, { expected_revision: 1, body: 'filled' })).status, 200);
  assert.equal((await api('POST', `/projects/${P}/files/from-template`, use(), readKey)).status, 403);
  const noDate = (await owner.req('POST', base + '/templates', { source_artifact_id: source, source_revision: 2, title: 'No variables' })).body.artifact_id;
  assert.equal((await api('POST', `/projects/${P}/files/from-template`, use({ template_id: noDate, date: undefined }))).status, 201);
});

test('pinned old version, deterministic one-pass replacement, safe preview and independent copies', async () => {
  assert.equal((await owner.req('PUT', path(template), { expected_revision: 1, body: 'New template {{title}}' })).status, 200);
  const made = await owner.req('POST', base + '/artifacts/from-template', use());
  assert.equal(made.status, 201); assert.match((await owner.req('GET', path(made.body.artifact_id))).body.body, /Date: 2026-10-27/);
  assert.equal((await owner.req('GET', path(copy))).body.body, 'Finished findings');
  const preview = await owner.req('POST', base + '/templates/preview', use({ title: '<img src=x onerror=alert(1)> {{date}}' }));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.doesNotMatch(preview.body.html, /<script>|<img src=x/); assert.match(preview.body.html, /&lt;img/); assert.match(preview.body.html, /{{date}}/);
  assert.ok(preview.body.placeholders.includes('{{date}}')); assert.match(preview.body.html, /{{unknown}}/);
  assert.equal((await owner.req('POST', base + '/artifacts/from-template', use({ template_revision: 99 }))).status, 404);
});

test('all generic definition mutations denied for OAuth, legacy grants and API; ordinary copies writable', async () => {
  for (const client of [rw, legacy]) {
    for (const [tool, args] of [
      ['save_markdown', { expected_revision: 2, body: 'attack' }],
      ['restore_revision', { expected_revision: 2, from_revision: 1 }],
      ['restore_metadata', { expected_meta_version: 1, from_version: 1 }]
    ]) {
      const r = await client.call(tool, { project_id: P, artifact_id: template, ...args, idempotency_key: key() });
      assert.equal(r.isError, true, JSON.stringify(r));
    }
  }
  const agent = agentHttp(h.appUi, legacyGrant.token);
  for (const input of [{ title: 'attacked' }, { template_description: 'attacked' }, { trashed: true }]) {
    const r = await agent('PATCH', path(template), { expected_meta_version: 1, ...input });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  }
  assert.equal((await api('PUT', `/projects/${P}/files/${template}`, { expected_revision: 2, body: 'attacked' })).status, 403);
  assert.equal((await api('POST', `/projects/${P}/files/${template}/revisions/1/restore`, { expected_revision: 2 })).status, 403);
  assert.equal((await agent('POST', base + '/templates', { source_artifact_id: source, source_revision: 1, title: 'Attack' })).status, 403);
  assert.equal((await owner.req('GET', path(template))).body.body, 'New template {{title}}');
});

test('owner description versions, restoration, trash availability, source redaction and retry after trash', async () => {
  const changed = await owner.req('PATCH', path(template), { expected_meta_version: 1, template_description: 'Edited description', title: 'Renamed report' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const hist = (await owner.req('GET', path(template) + '/meta-history')).body.meta_versions;
  assert.equal(hist[0].template_description, 'Edited description'); assert.equal(hist[1].template_description, 'Question, findings and sources');
  const agentRestore = await rw.call('restore_metadata', { project_id: P, artifact_id: template, expected_meta_version: 2, from_version: 1, idempotency_key: key() });
  assert.equal(agentRestore.data.error.code, 'template_owner_only');
  assert.equal((await owner.req('POST', path(template) + '/meta-restore', { expected_meta_version: 2, from_version: 1 })).status, 200);
  assert.equal((await owner.req('GET', path(template))).body.artifact.template_description, 'Question, findings and sources');
  const idem = key(); const before = await owner.req('POST', base + '/artifacts/from-template', use(), { idem });
  assert.equal((await owner.req('PATCH', path(template), { expected_meta_version: 3, trashed: true })).status, 200);
  assert.ok(!(await owner.req('GET', base + '/templates')).body.templates.some(t => t.id === template));
  assert.equal((await owner.req('POST', base + '/artifacts/from-template', use())).status, 404);
  assert.equal((await owner.req('GET', path(before.body.artifact_id))).body.artifact.source, undefined);
  const replay = await owner.req('POST', base + '/artifacts/from-template', use(), { idem });
  assert.equal(replay.body.artifact_id, before.body.artifact_id); assert.equal(replay.body.idempotent_replay, true);
  assert.equal((await owner.req('PATCH', path(template), { expected_meta_version: 4, trashed: false })).status, 200);
  assert.ok((await owner.req('GET', base + '/templates')).body.templates.some(t => t.id === template));
});

test('project, source, folder, pagination and publisher scope cannot be forged', async () => {
  const foreign = (await owner.req('POST', `/api/projects/${Q}/artifacts`, { title: 'Foreign secret', body: 'secret' })).body.artifact_id;
  const folder = (await owner.req('POST', `/api/projects/${Q}/folders`, { name: 'Private' })).body.id;
  for (const args of [{ template_id: foreign }, { template_id: source }, { folder_id: folder }]) {
    const r = await api('POST', `/projects/${P}/files/from-template`, use(args)); assert.equal(r.status, 404, JSON.stringify(r.body));
  }
  assert.equal((await api('GET', `/projects/${Q}/templates`)).status, 404);
  const first = await api('GET', `/projects/${P}/templates?limit=1`); assert.equal(first.body.templates.length, 1); assert.ok(first.body.next_cursor);
  const next = await api('GET', `/projects/${P}/templates?limit=1&cursor=${first.body.next_cursor}`); assert.notEqual(next.body.templates[0].id, first.body.templates[0].id);
  assert.equal((await api('GET', `/projects/${P}/templates?limit=999`)).status, 400);
  const app = await h.registerApp({ display_name: 'Publisher', redirect_uris: ['https://publisher.example.invalid/callback'] });
  const pub = await h.connectPublisher(app, { project_id: P, destination: 'root' });
  const denied = await h.pub(pub.access_token, 'GET', `/projects/${P}/templates`); assert.ok([401, 403, 404].includes(denied.status)); assert.doesNotMatch(denied.text, /Research report/);
});

test('concurrent identical requests yield one revision, provenance, audit and idempotency result; changed inputs conflict', async () => {
  const idem = key(); const args = use({ title: 'Concurrent' });
  const rs = await barrier(Array.from({ length: 8 }, () => () => api('POST', `/projects/${P}/files/from-template`, args, apiKey, idem)));
  assert.ok(rs.every(r => r.status === 201), JSON.stringify(rs));
  assert.equal(new Set(rs.map(r => r.body.artifact_id)).size, 1);
  const id = rs[0].body.artifact_id;
  const [state] = await sql(`SELECT (SELECT COUNT(*) FROM revisions WHERE artifact_id='${id}') AS revisions, (SELECT COUNT(*) FROM audits WHERE object_id='${id}' AND action='template.use') AS audits, source_artifact_id, source_revision FROM artifacts WHERE id='${id}'`);
  assert.deepEqual([state.revisions, state.audits, state.source_artifact_id, state.source_revision], [1, 1, template, 1]);
  for (const changed of [{ date: '2026-10-28' }, { title: 'Changed' }, { template_revision: 2 }]) assert.equal((await api('POST', `/projects/${P}/files/from-template`, { ...args, ...changed }, apiKey, idem)).status, 422);
});

test('transaction failure rolls back artifacts/revision/audit/idempotency; quota leaves no orphan and allows retry', async () => {
  const idem = key(); const args = use({ title: 'Failure fixture' });
  await sql("CREATE TRIGGER fail_template_test BEFORE INSERT ON revisions WHEN NEW.body LIKE '# Failure fixture%' BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END");
  assert.equal((await api('POST', `/projects/${P}/files/from-template`, args, apiKey, idem)).status, 409);
  assert.equal((await sql("SELECT COUNT(*) AS n FROM artifacts WHERE title='Failure fixture'"))[0].n, 0);
  assert.equal((await sql(`SELECT COUNT(*) AS n FROM idempotency WHERE key='${idem}'`))[0].n, 0);
  await sql('DROP TRIGGER fail_template_test');
  assert.equal((await api('POST', `/projects/${P}/files/from-template`, args, apiKey, idem)).status, 201);
  const [{ n }] = await sql(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id='${P}'`);
  await sql(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${100 - n}) INSERT INTO artifacts (id, project_id, kind, title, created_at, updated_at) SELECT 'quota_'||n, '${P}', 'markdown', 'Quota fixture', '2026-01-01', '2026-01-01' FROM seq`);
  const quotaKey = key(); assert.equal((await api('POST', `/projects/${P}/files/from-template`, use(), apiKey, quotaKey)).status, 413);
  assert.equal((await sql(`SELECT COUNT(*) AS n FROM idempotency WHERE key='${quotaKey}'`))[0].n, 0);
  await sql("DELETE FROM artifacts WHERE id LIKE 'quota_%'");
  assert.equal((await api('POST', `/projects/${P}/files/from-template`, use(), apiKey, quotaKey)).status, 201);
});

test('backup round trip preserves templates, descriptions/history and copy provenance; old backups still restore', async () => {
  const backup = (await owner.req('GET', base + '/backup')).body;
  assert.equal(backup.schema, 'agent-library-backup/2');
  assert.ok(backup.features.includes('document_templates/1'));
  for (const old of [false, true]) {
    const b = structuredClone(backup);
    if (old) {
      delete b.features; b.schema = 'agent-library-backup/1';
      for (const a of b.artifacts) for (const k of ['is_template', 'template_description', 'source_artifact_id', 'source_revision', 'source_role', 'template_date']) delete a[k];
      for (const v of b.meta_versions) delete v.template_description;
    }
    const s = await startServer(old ? 'templates-legacy-restore' : 'templates-restore', old ? SERVER_PORTS['templates-legacy-restore'] : SERVER_PORTS['templates-restore']);
    try {
      const dest = await s.login(); const r = await dest.req('POST', '/api/restore', b); assert.equal(r.status, 201, JSON.stringify(r.body));
      const restored = (await dest.req('GET', path(template))).body;
      assert.equal(restored.artifact.is_template, old ? undefined : true);
      if (!old) {
        assert.equal(restored.artifact.template_description, 'Question, findings and sources');
        assert.equal((await dest.req('GET', path(copy))).body.artifact.source.artifact_id, template);
        assert.equal((await dest.req('GET', path(template) + '/meta-history')).body.meta_versions[0].template_description, 'Question, findings and sources');
      }
    } finally { await s.stop(); }
  }
});

test('grant revocation removes discovery and creation immediately', async () => {
  const temp = await grant(owner, P, 'Revoked agent', true); const client = await mcpClient(h.appUi, temp.token);
  try {
    assert.equal((await client.call('list_templates', { project_id: P })).isError, false);
    await owner.req('PATCH', base + '/grants/' + temp.grant_id, { revoke: true });
    await assert.rejects(client.call('list_templates', { project_id: P }));
    await assert.rejects(client.call('create_from_template', { project_id: P, ...use(), idempotency_key: key() }));
  } finally { await client.close(); }
});

const require = createRequire(import.meta.url);
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const puppeteer = `${process.env.HOME}/.npm-packages/lib/node_modules/puppeteer`;
test('Chrome: save/cancel template, pinned picker, preview safety, mobile/keyboard and uncertain-submit replay', { skip: !existsSync(chrome) || !existsSync(puppeteer) }, async () => {
  const browser = await require(puppeteer).launch({ executablePath: chrome, headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.emulateTimezone('America/Los_Angeles');
    await page.evaluateOnNewDocument(() => {
      const NativeDate = Date;
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-28T00:30:00Z'])); } static now() { return new NativeDate('2026-10-28T00:30:00Z').getTime(); } };
    });
    await page.setViewport({ width: 1280, height: 900 });
    const [name, value] = owner.cookie.split('=');
    await page.setCookie({ name, value, url: h.appUi, httpOnly: true });
    const uiDoc = (await owner.req('POST', base + '/artifacts', { title: 'UI source', body: sourceBody })).body.artifact_id;
    await page.goto(h.appUi + `/p/${P}/a/${uiDoc}`);
    await page.waitForFunction(() => [...document.querySelectorAll('summary')].some(e => e.textContent === 'Details'));
    const clickText = text => page.evaluate(t => [...document.querySelectorAll('button,summary')].find(e => e.textContent.trim() === t).click(), text);
    await clickText('Details');
    assert.equal(await page.$('[aria-label="Template name"]'), null, 'template fields appear only after Save as template');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save as template').parentElement === [...document.querySelectorAll('button')].find(b => b.textContent === 'Save details').parentElement), true, 'document actions share one row');
    await page.screenshot({ path: 'tmp/test-evidence/templates-details-desktop.png', fullPage: true });
    await clickText('Save as template');
    await page.waitForSelector('[aria-label="Template name"]', { visible: true });
    const before = (await owner.req('GET', base + '/artifacts')).body.artifacts.length;
    await page.evaluate(() => document.querySelector('[aria-label="Template name"]').closest('form').querySelector('button[type=button]').click());
    assert.equal((await owner.req('GET', base + '/artifacts')).body.artifacts.length, before);
    await clickText('Save as template');
    await page.waitForSelector('[aria-label="Template name"]', { visible: true });
    await page.$eval('[aria-label="Template name"]', e => { e.value = 'UI Research ' + 'long name '.repeat(15); });
    await page.type('[aria-label="New template description"]', 'Reusable research structure');
    await page.screenshot({ path: 'tmp/test-evidence/templates-save-desktop.png', fullPage: true });
    await clickText('Save template');
    await page.waitForFunction(id => location.hash.includes('/edit') && !location.hash.includes(id), {}, uiDoc);
    await page.waitForSelector('.template-note');
    const uiTemplate = await page.evaluate(() => location.hash.split('/a/')[1].split('/')[0]);
    assert.equal((await owner.req('GET', path(uiTemplate))).body.artifact.is_template, true);
    await page.goto(h.appUi + `/p/${P}`);
    await page.waitForSelector('[aria-label="Start from"]');
    await clickText('New document');
    await page.waitForFunction(id => [...document.querySelector('[aria-label="Start from"]').options].some(o => o.value === id), {}, uiTemplate);
    assert.equal(await page.$eval('[aria-label="Start from"]', e => e.closest('label').hidden), false, 'picker is shown when templates exist');
    await page.type('[aria-label="New document title"]', 'UI report {{date}} <script>safe</script>');
    await page.select('[aria-label="Start from"]', uiTemplate);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Use template' && !b.disabled));
    assert.equal(await page.$eval('[aria-label="Template date"]', e => e.value), '2026-10-27', 'local calendar day, not UTC host day');
    assert.equal(await page.$eval('.template-preview', e => !!e.querySelector('script,img[onerror]')), false);
    assert.match(await page.$eval('.template-preview', e => e.textContent), /{{unknown}}/);
    await owner.req('PUT', path(uiTemplate), { expected_revision: 1, body: 'Later template version' });
    await page.screenshot({ path: 'tmp/test-evidence/templates-picker-desktop.png', fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'mobile picker fits');
    await page.screenshot({ path: 'tmp/test-evidence/templates-picker-mobile.png', fullPage: true });
    await page.focus('[aria-label="Start from"]'); await page.keyboard.press('Tab');
    assert.equal(await page.$eval('[aria-label="Template date"]', e => e === document.activeElement), true);
    let uncertain = true, lostId, keys = [], failList = false, holdList = false, heldList;
    await page.setRequestInterception(true);
    page.on('request', async req => {
      if (req.url().endsWith('/templates') && req.method() === 'GET') {
        if (holdList) { heldList = req; return; }
        if (failList) return req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic network outage' } }) });
      }
      if (!req.url().endsWith('/artifacts/from-template') || req.method() !== 'POST') return req.continue();
      keys.push(req.headers()['idempotency-key']);
      if (!uncertain) return req.continue();
      uncertain = false;
      const r = await fetch(req.url(), { method: 'POST', headers: req.headers(), body: req.postData() });
      assert.equal(r.status, 201); lostId = (await r.json()).artifact_id;
      await req.abort('failed');
    });
    await clickText('Use template');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=alert]')].some(e => e.textContent.includes('Network error')));
    assert.equal(await page.$eval('[aria-label="New document title"]', e => e.value), 'UI report {{date}} <script>safe</script>');
    assert.equal(await page.$eval('[aria-label="Template date"]', e => e.value), '2026-10-27');
    await page.screenshot({ path: 'tmp/test-evidence/templates-retry-mobile.png', fullPage: true });
    await clickText('Use template');
    await page.waitForFunction(id => location.hash.includes(id), {}, lostId);
    await page.waitForFunction(() => [...document.querySelectorAll('p')].some(e => e.textContent.includes('Created from UI Research')));
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    const created = (await owner.req('GET', path(lostId))).body;
    assert.equal(created.artifact.source.revision, 1); assert.match(created.body, /Date: 2026-10-27/); assert.doesNotMatch(created.body, /Later template/);
    await page.screenshot({ path: 'tmp/test-evidence/templates-copy-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    // Empty and loading failures keep Blank usable and explain template saving.
    const empty = 'empty-templates'; await owner.req('POST', '/api/projects', { id: empty, title: 'Empty project' });
    await page.goto(h.appUi + `/p/${empty}`);
    await page.waitForFunction(() => document.body.textContent.includes('No templates yet.'));
    await clickText('New document');
    assert.equal(await page.$eval('[aria-label="Start from"]', e => e.closest('label').hidden), true, 'empty projects hide Start from');
    await page.screenshot({ path: 'tmp/test-evidence/templates-empty-mobile.png', fullPage: true });
    failList = true;
    await page.reload();
    await page.waitForFunction(() => document.body.textContent.includes("Couldn't load templates:"));
    await clickText('New document');
    assert.equal(await page.$eval('[aria-label="Start from"]', e => e.closest('label').hidden), true, 'unknown template availability keeps the picker hidden');
    await page.type('[aria-label="New document title"]', 'Blank after outage');
    await page.screenshot({ path: 'tmp/test-evidence/templates-list-error-mobile.png', fullPage: true });
    failList = false; holdList = true;
    await clickText('Reload templates');
    await page.waitForFunction(() => document.body.textContent.includes('Loading templates…'));
    await page.screenshot({ path: 'tmp/test-evidence/templates-loading-mobile.png', fullPage: true });
    assert.ok(heldList); holdList = false; await heldList.continue();
    await page.waitForFunction(() => document.body.textContent.includes('No templates yet.'));
    assert.equal(await page.$eval('[aria-label="New document title"]', e => e.value), 'Blank after outage');
    await clickText('Create');
    await page.waitForFunction(() => location.hash.includes('/a/'));
    await page.waitForSelector('h1');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
