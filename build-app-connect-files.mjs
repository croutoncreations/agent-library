// App Connect binary files (runs last, after build-artifact-limits.mjs; no migration). Publishers upload images, PDFs,
// video and other files into their own destination through POST /v1/publisher/uploads -> PUT bytes -> POST finish,
// reusing the existing upload machinery, and download them from /v1/publisher/files/{id}/content.
// docs/app-connect.md#binary-files. The module src/app-connect-files/publisher-files.js is inserted before
// // src/api/publisher.ts; every other change is an exact, once-matching patch inside the module named next to it.
// Every byte outside these patches stays unchanged. No config, credentials, database or network is used.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('artifact-limits-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-artifact-limits.mjs before build-app-connect-files.mjs');
const mod = readFileSync('src/app-connect-files/publisher-files.js', 'utf8').replace(/\n*$/, '\n');
if (/^(import|export)\s/m.test(mod) || !mod.includes('async function pfRoute(req, env, p, requestId, ctx, quota) {\n')) throw Error('src/app-connect-files/publisher-files.js must define pfRoute and nothing importable');
const once = (needle, what) => { const i = input.indexOf(needle); if (i < 0 || input.indexOf(needle, i + 1) >= 0) throw Error('Expected exactly one ' + what); return i; };
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
const PUB = '// src/api/publisher.ts — isolated readable-generation integration';
const PATCHES = [
  ['module: App Connect binary files (inserted before the publisher module)', PUB,
    PUB + '\n',
    mod + '\n' + PUB + '\n'],
  ['publisher: me reports the binary upload contract', PUB,
    '      generation_contract: GENERATION_CONTRACT,\n',
    '      generation_contract: GENERATION_CONTRACT,\n      files_contract: pfContract(env),\n'],
  ['publisher: file views carry the MIME type', PUB,
    '      schema: a.schema_id ?? null,\n      revision: a.head_rev,\n',
    '      schema: a.schema_id ?? null,\n      mime: a.mime ?? null,\n      revision: a.head_rev,\n'],
  ['publisher: file queries read the head MIME type', PUB,
    'var FILE_SQL = `SELECT a.*, r.sha256, r.size FROM artifacts a',
    'var FILE_SQL = `SELECT a.*, r.sha256, r.size, r.mime FROM artifacts a'],
  ['publisher: routes /v1/publisher/uploads', PUB,
    '    if (generationResponse) return generationResponse;\n',
    '    if (generationResponse) return generationResponse;\n    const fileResponse = await pfRoute(req, env, p, requestId, pubCtx(env, p, requestId), PUB_QUOTA);\n    if (fileResponse) return fileResponse;\n'],
  ['publisher: content of binary files comes from R2 (attachment, Range)', PUB,
    '      const r = await env.DB.prepare("SELECT body, mime, sha256 FROM revisions WHERE artifact_id = ? AND rev_no = ?").bind(a.id, revNo).first();\n      if (!r) throw new live_HttpError(404, "not_found", "File not found");\n',
    '      const r = await env.DB.prepare("SELECT body, mime, sha256, blob_key, size FROM revisions WHERE artifact_id = ? AND rev_no = ?").bind(a.id, revNo).first();\n      if (!r) throw new live_HttpError(404, "not_found", "File not found");\n      if (r.blob_key) return pfServeBlob(req, env, a, r);\n'],
  ['cors: publisher preflight allows PUT (byte transfer) and Range', '// src/oauth/server.ts',
    '    "access-control-allow-methods": "GET, POST",\n    "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",\n',
    '    "access-control-allow-methods": "GET, POST, PUT",\n    "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, Range",\n'],
  ['cors: browsers can read download headers', '// src/oauth/server.ts',
    'r.headers.set("access-control-expose-headers", "WWW-Authenticate, Retry-After, X-Request-Id");',
    'r.headers.set("access-control-expose-headers", "WWW-Authenticate, Retry-After, X-Request-Id, Content-Range, Content-Disposition, ETag");'],
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
const meta = { base_artifact_limits_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')),
  module_sha256: sha(mod), patches: spans.map((s) => ({ name: s.name, module: s.module, find_sha256: sha(s.find), replace_sha256: sha(s.replace) })) };
writeFileSync('app-connect-files-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('App Connect binary files bundle: ' + sha(out));
