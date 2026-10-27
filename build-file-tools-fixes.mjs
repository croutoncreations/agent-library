// Files for OAuth (MCP) connections (runs last, after build-read-fixes.mjs; needs migration 0013).
// Connections approved on the new consent page (oauth_connections.file_access = 1) can list and read files (images
// inline, any file through a short-lived single-revision download link) and, with Edit, upload new files and versions
// through the existing upload machinery (begin -> PUT to a single-upload link -> finish). docs/agent-setup.md#files.
// The module src/file-tools/oauth-files.js is inserted before // src/api/publisher.ts; every other change is an exact,
// once-matching patch inside the module named next to it. Every byte outside these patches stays unchanged.
// No config, credentials, database or network is used.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('read-fixes-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-read-fixes.mjs before build-file-tools-fixes.mjs');
const mod = readFileSync('src/file-tools/oauth-files.js', 'utf8').replace(/\n*$/, '\n');
if (/^(import|export)\s/m.test(mod) || !mod.includes('async function handleFileTransfer(req, env, url) {\n')) throw Error('src/file-tools/oauth-files.js must define handleFileTransfer and nothing importable');
const once = (needle, what) => { const i = input.indexOf(needle); if (i < 0 || input.indexOf(needle, i + 1) >= 0) throw Error('Expected exactly one ' + what); return i; };
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
const instructions = '"Agent Library: Markdown documents in owner-approved projects. Call list_projects first; pass project_id when more than one project is connected. Read before editing; saves need expected_revision and a fresh idempotency_key. Every change is kept as a version the owner reviews in History: whenever a tool has a change_note field, always set it to one line on why."';
const PATCHES = [
  ['module: files for OAuth connections (inserted before the publisher module)', '// src/api/publisher.ts — isolated readable-generation integration',
    '// src/api/publisher.ts — isolated readable-generation integration\n',
    mod + '\n// src/api/publisher.ts — isolated readable-generation integration\n'],
  ['mcp: file tools only for connections approved with files (call)', '// src/oauth/mcp.ts',
    'const tool = msg.method === "tools/call" ? toolsFor(env).find(',
    'const tool = msg.method === "tools/call" ? ftToolsFor(env, conn).find('],
  ['mcp: file tools only for connections approved with files (list)', '// src/oauth/mcp.ts',
    'return reply(rpc(msg.id, { tools: toolsFor(env).filter(',
    'return reply(rpc(msg.id, { tools: ftToolsFor(env, conn).filter('],
  ['mcp: instructions mention files for connections with files', '// src/oauth/mcp.ts',
    'instructions: ' + instructions,
    'instructions: conn.file_access === 1 ? FT_INSTRUCTIONS : ' + instructions],
  ['mcp: tool context carries the connection (links, per-connection uploader)', '// src/oauth/mcp.ts',
    '        oauthConnection: true,\n        via: { kind: "oauth", id: conn.id, label: conn.client_name },\n',
    '        oauthConnection: true,\n        ftConn: conn,\n        ftOrigin: new URL(req.url).origin,\n        via: { kind: "oauth", id: conn.id, label: conn.client_name },\n'],
  ['mcp: tool results may add image and resource_link content blocks', '// src/oauth/mcp.ts',
    '        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));\n      } catch (e) {\n        if (!(e instanceof HttpError)) throw e;\n        if (e.status === 401) return invalid2();',
    '        return reply(rpc(msg.id, { content: ftContent(result, pv), structuredContent: result, isError: false }));\n      } catch (e) {\n        if (!(e instanceof HttpError)) throw e;\n        if (e.status === 401) return invalid2();'],
  ['mcp: connections with files accept bodies up to 3 MiB (upload_file)', '// src/oauth/mcp.ts',
    '  if (len > 1024 * 1024) return reply(rpcErr(null, -32600, "Payload too large"), 413);\n  const text = await req.text();\n  if (text.length > 1024 * 1024) return reply(rpcErr(null, -32600, "Payload too large"), 413);\n',
    '  const bodyMax = ftMcpBodyMax(conn);\n  if (len > bodyMax) return reply(rpcErr(null, -32600, "Payload too large"), 413);\n  const text = await ftReadCapped(req, bodyMax);\n  if (text === null) return reply(rpcErr(null, -32600, "Payload too large"), 413);\n'],
  ['mcp: rate limits come back as a readable tool error with the limit and wait time', '// src/oauth/mcp.ts',
    '  } catch {\n    return new Response(rtFit(rpcErr(msg.id, -32002, "Too many requests"), rtLim), { status: 429, headers: { ...HDR, "retry-after": "60" } });\n  }\n',
    '  } catch (e) {\n    return ftRateLimited(msg, tool, !!tool?.write, e, rtLim);\n  }\n'],
  ['uploads: uploadPut accepts a context from a verified upload link', '// src/uploads.ts',
    'async function uploadPut(req, env, requestId, uploadId) {\n  const ctx = await authenticate(req, env, requestId);\n  requireCsrf(ctx, req);\n',
    'async function uploadPut(req, env, requestId, uploadId, linkCtx) {\n  // linkCtx: built by handleFileTransfer from a live OAuth connection (no cookie, so no CSRF).\n  const ctx = linkCtx ?? await authenticate(req, env, requestId);\n  if (!linkCtx) requireCsrf(ctx, req);\n'],
  ['connections: Settings shows whether a connection includes files', '// src/oauth/connections.ts',
    '`SELECT id, client_name, client_id, redirect_uri, created_at, expires_at, revoked_at, last_used_at\n     FROM oauth_connections WHERE owner_principal_id = ?',
    '`SELECT id, client_name, client_id, redirect_uri, created_at, expires_at, revoked_at, last_used_at, file_access\n     FROM oauth_connections WHERE owner_principal_id = ?'],
  ['connections: file_access in the Settings list', '// src/oauth/connections.ts',
    '      redirect_host: safeHost(c.redirect_uri),\n      projects: byConn.get(c.id) ?? [],\n',
    '      redirect_host: safeHost(c.redirect_uri),\n      projects: byConn.get(c.id) ?? [],\n      files: c.file_access === 1,\n'],
  ['cleanup: drop expired transfer links', '// src/cleanup.ts',
    '  await DB.prepare("DELETE FROM rate_counters WHERE win < ?").bind(Math.floor(now / 6e4) - 2).run();\n',
    '  await DB.prepare("DELETE FROM rate_counters WHERE win < ?").bind(Math.floor(now / 6e4) - 2).run();\n  await DB.prepare("DELETE FROM transfer_links WHERE expires_at < ?").bind(now).run().catch(() => {\n  });\n'],
  ['routing: transfer links on the MCP host', '// src/index.ts',
    '      if (isV1Path(url.pathname) && !publisherRoute) return withSec(await handleV1(req, env));\n',
    '      if (url.pathname.startsWith("/files/")) return withSec(await handleFileTransfer(req, env, url));\n      if (isV1Path(url.pathname) && !publisherRoute) return withSec(await handleV1(req, env));\n'],
];
const spans = PATCHES.map(([name, module, find, replace]) => {
  const a = once(find, name);
  if (moduleOf(a) !== module) throw Error(`${name}: anchor is in ${moduleOf(a)}, expected ${module}`);
  return { name, module, a, b: a + find.length, find, replace };
}).sort((x, y) => x.a - y.a);
for (let k = 1; k < spans.length; k++) if (spans[k].a < spans[k - 1].b) throw Error('Overlapping patches');
let out = '', pos = 0;
const gaps = [];
for (const s of spans) { gaps.push(input.slice(pos, s.a)); out += input.slice(pos, s.a) + s.replace; pos = s.b; }
gaps.push(input.slice(pos)); out += input.slice(pos);
writeFileSync('src/index.js', out);
const meta = { base_read_fixes_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')),
  module_sha256: sha(mod), patches: spans.map((s) => ({ name: s.name, module: s.module, find_sha256: sha(s.find), replace_sha256: sha(s.replace) })),
  requires_migration: '0013_oauth_file_access.sql' };
writeFileSync('file-tools-fixes-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('OAuth file tools bundle: ' + sha(out));
