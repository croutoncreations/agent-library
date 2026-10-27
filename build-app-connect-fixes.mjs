// App Connect suggested destination (runs last, after build-auth-fixes.mjs; needs migration 0012).
// Owners can store a default project/folder on a registered app: app_clients.suggested_project/suggested_folder.
// The consent page (src/web/connect-pages.js) pre-fills it; an app's own agentlib_* hint wins. Exact, once-matching
// patches inside the app-clients module (// src/api/app-clients.ts) and its /api routing only (the registration
// form is in src/web/app.js);
// every other byte stays unchanged.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('auth-fixes-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-auth-fixes.mjs before build-app-connect-fixes.mjs');
let out = input;
const once = (find, rep, name) => {
  if (out.split(find).length !== 2) throw Error('Expected exactly once: ' + name);
  out = out.replace(find, () => rep);
};
// Server: validate, store and return the two optional fields; owner can update them later (PUT /api/app-clients/:id).
once('  origins: JSON.parse(r.origins),\n  created_at: r.created_at,\n  disabled: r.disabled_at !== null\n}), "view");',
  '  origins: JSON.parse(r.origins),\n  suggested_project: r.suggested_project ?? null,\n  suggested_folder: r.suggested_folder ?? null,\n  created_at: r.created_at,\n  disabled: r.disabled_at !== null\n}), "view");\n' +
  '// Optional owner-set default destination. Plain text, 1-80 chars, no "/" or control characters; empty clears it.\n' +
  'function suggestion(v, name) {\n' +
  '  if (v === void 0 || v === null) return null;\n' +
  '  const t = str(v, name, 200).trim();\n' +
  '  if (!t) return null;\n' +
  '  if (t.length > 80 || /[\\/\\u0000-\\u001f\\u007f]/.test(t)) throw new HttpError(400, "invalid_input", `${name} must be 1-80 characters without / or control characters`);\n' +
  '  return t;\n' +
  '}\n' +
  '__name(suggestion, "suggestion");\n' +
  'async function updateAppClient(ctx, id, input) {\n' +
  '  requireHuman(ctx);\n' +
  '  requireAppConnect(ctx);\n' +
  '  const sp = suggestion(input?.suggested_project, "suggested_project"), sf = suggestion(input?.suggested_folder, "suggested_folder");\n' +
  '  const r = await ctx.env.DB.prepare("UPDATE app_clients SET suggested_project = ?, suggested_folder = ? WHERE id = ? AND owner_principal_id = ?").bind(sp, sf, id, ctx.principal.id).run();\n' +
  '  if (!r.meta.changes) throw new HttpError(404, "not_found", "App not found");\n' +
  '  await ctx.env.DB.prepare("INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, NULL, \'app_client.update\', ?, \'ok\', ?)").bind(nowIso(), ctx.principal.id, id, ctx.requestId).run();\n' +
  '  return view(await ctx.env.DB.prepare("SELECT * FROM app_clients WHERE id = ?").bind(id).first());\n' +
  '}\n' +
  '__name(updateAppClient, "updateAppClient");',
  'app-clients view');
once('  const origins = list(input?.origins ?? [], "origins", 0, 3, ORIGIN);\n  const { as } = _servers(',
  '  const origins = list(input?.origins ?? [], "origins", 0, 3, ORIGIN);\n  const suggestedProject = suggestion(input?.suggested_project, "suggested_project"), suggestedFolder = suggestion(input?.suggested_folder, "suggested_folder");\n  const { as } = _servers(',
  'register validation');
once('env.DB.prepare("INSERT INTO app_clients (id, owner_principal_id, client_id, display_name, redirect_uris, origins, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, ctx.principal.id, client.clientId, display, JSON.stringify(redirects), JSON.stringify(origins), nowIso()),',
  'env.DB.prepare("INSERT INTO app_clients (id, owner_principal_id, client_id, display_name, redirect_uris, origins, created_at, suggested_project, suggested_folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ctx.principal.id, client.clientId, display, JSON.stringify(redirects), JSON.stringify(origins), nowIso(), suggestedProject, suggestedFolder),',
  'register insert');
once('    if (seg.length === 3 && seg[2] === "disable" && m === "POST") return json(await disableAppClient(ctx, str(seg[1], "app", 64)));\n',
  '    if (seg.length === 3 && seg[2] === "disable" && m === "POST") return json(await disableAppClient(ctx, str(seg[1], "app", 64)));\n    if (seg.length === 2 && m === "PUT") return json(await updateAppClient(ctx, str(seg[1], "app", 64), await body(req)));\n',
  'route');
writeFileSync('src/index.js', out);
writeFileSync('app-connect-fixes-preservation.json', JSON.stringify({ base_auth_fixes_sha256: base, integrated_sha256: sha(out) }, null, 2) + '\n');
console.log('App Connect suggestions bundle: ' + sha(out));
