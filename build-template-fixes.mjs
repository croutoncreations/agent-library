// Last, additive template integration. Exact once-matching patches, scoped to named modules;
// undo every patch and compare the complete input to prove preservation outside these spans.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = f => readFileSync(f, 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');
const input = read('src/index.js');
const base = JSON.parse(read('changes-preservation.json')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-changes.mjs first');
let out = input;
const patches = [];
function add(module, name, find, replacement) {
  const i = out.indexOf(find);
  if (i < 0 || out.indexOf(find, i + 1) >= 0) throw Error('Expected one anchor: ' + name);
  const m = out.lastIndexOf('\n// src/', i);
  if (out.slice(m + 1, out.indexOf('\n', m + 1)) !== module) throw Error('Wrong module: ' + name);
  patches.push({ module, name, find, replacement });
  out = out.slice(0, i) + replacement + out.slice(i + find.length);
}
const service = '// src/service.ts', auth = '// src/auth.ts';
// History source is inserted inside the service module by build-history-fixes.
add(service, 'shared template service and schemas', 'function requireAppConnect(ctx) {\n', read('src/templates/service.js') + '\n' + read('src/templates/tools.js') + '\nfunction requireAppConnect(ctx) {\n');
add(service, 'template identity in ordinary artifact views', '      title: a.title,\n      folder: a.folder,', '      title: a.title,\n      ...a.is_template ? { is_template: true, template_description: a.template_description } : {},\n      folder: a.folder,');
add(service, 'safe source provenance on reads', '    artifact: artifactView(a, appConnectEnabled(ctx.env)),\n    revision:', '    artifact: { ...artifactView(a, appConnectEnabled(ctx.env)), ...await tplProvenance(ctx, projectId, a) },\n    revision:');
add(service, 'owner-only generic maintenance', 'function assertWritable(ctx, a, what) {\n', 'function assertWritable(ctx, a, what) {\n  tplAssertMaintenance(ctx, a);\n');
add(auth, 'agent metadata and trash write fence', 'sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND publisher_id IS NOT NULL)", params: [artifactId] };\n}\nfunction contentWriteSql', 'sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND (publisher_id IS NOT NULL OR is_template = 1))", params: [artifactId] };\n}\nfunction contentWriteSql');
add(auth, 'agent content and restore write fence', 'function contentWriteSql(ctx, artifactId) {\n', 'function contentWriteSql(ctx, artifactId) {\n  if (ctx.principal.kind === "agent" && artifactId !== void 0) return { sql: "NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND (is_template = 1 OR (publisher_id IS NOT NULL AND ? = 0)))", params: [artifactId, ctx.publisher ? 1 : 0] };\n');
// Description belongs in the existing details timeline; identity and provenance never change through metadata writes.
add(service, 'description validation', '  let tags = a.tags;\n', '  if (input.template_description !== undefined && !a.is_template) throw new HttpError(400, "invalid_input", "Not a template");\n  const description = input.template_description !== undefined ? str(input.template_description, "template_description", 280) : a.template_description;\n  let tags = a.tags;\n');
add(service, 'description in metadata result', 'tags: JSON.parse(tags), trashed: !!trashed };', 'tags: JSON.parse(tags), trashed: !!trashed, ...a.is_template ? { template_description: description } : {} };');
add(service, 'description metadata update', 'UPDATE artifacts SET title = ?, folder = ?, tags = ?, trashed_at = ?, meta_version = ?, meta_request_id = ?, updated_at = ?', 'UPDATE artifacts SET title = ?, folder = ?, tags = ?, trashed_at = ?, template_description = ?, meta_version = ?, meta_request_id = ?, updated_at = ?');
add(service, 'description metadata binding', '.bind(title, folder, tags, trashed, next, ctx.requestId, nowIso(), artifactId, projectId, expected, ...az.params)', '.bind(title, folder, tags, trashed, description, next, ctx.requestId, nowIso(), artifactId, projectId, expected, ...az.params)');
add(service, 'description version value', '{ title, folder, tags, trashed: !!trashed, restoredFrom }, input, gate, gp)', '{ title, folder, tags, trashed: !!trashed, description, restoredFrom }, input, gate, gp)');
// These functions are maintained in src/history/service.js and bundled into the service region.
add(service, 'description baseline column', 'version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)\n     SELECT ?, ?, ?, ?, ?, ?, ?, ?, COALESCE', 'version, title, folder, tags, trashed, template_description, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)\n     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE');
add(service, 'description baseline value', 'a.title, a.folder, a.tags, a.trashed_at ? 1 : 0, a.id, a.project_id,', 'a.title, a.folder, a.tags, a.trashed_at ? 1 : 0, a.template_description, a.id, a.project_id,');
add(service, 'description version column', 'version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)\n     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}', 'version, title, folder, tags, trashed, template_description, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)\n     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}');
add(service, 'description version binding', 'v.tags, v.trashed ? 1 : 0, ctx.principal.id,', 'v.tags, v.trashed ? 1 : 0, v.description, ctx.principal.id,');
add(service, 'description history select', 'm.version, m.title, m.folder, m.tags, m.trashed, m.author_id,', 'm.version, m.title, m.folder, m.tags, m.trashed, m.template_description, m.author_id,');
add(service, 'description history result', 'version: m.version, title: m.title, folder: m.folder, tags:', 'version: m.version, title: m.title, template_description: m.template_description, folder: m.folder, tags:');
add(service, 'description restore read', 'SELECT title, folder, tags, trashed FROM meta_versions', 'SELECT title, folder, tags, trashed, template_description FROM meta_versions');
add(service, 'description restore value', '...keepTrash ? {} : { trashed: !!row.trashed },', '...keepTrash ? {} : { trashed: !!row.trashed },\n    ...(await loadArtifact(ctx, projectId, artifactId, { allowTrashed: true })).is_template ? { template_description: row.template_description } : {},');
// Tool registration shares one schema factory, adapting only transport calling conventions.
add('// src/oauth/mcp.ts', 'OAuth template tools', '    TOOLS = [\n', '    TOOLS = [\n      ...tplTools(true),\n');
add('// src/mcp.ts', 'legacy read-only template discovery', 'tools: TOOLS2.filter(t => t.name !== "search_artifacts" || searchReady).map(', 'tools: TOOLS2.filter(t => (t.name !== "search_artifacts" || searchReady) && (!t.write || !!ctx.grant?.can_write)).map(');
add('// src/mcp.ts', 'legacy template tools', 'var TOOLS2 = [\n', 'var TOOLS2 = [\n  ...tplTools(false),\n');
// Legacy /mcp picks the rate bucket from a fixed name set; a copy is a write (artifact + revision + audit).
add('// src/mcp.ts', 'legacy write rate bucket', '"restore_revision", "restore_metadata"]);', '"restore_revision", "restore_metadata", "create_from_template"]);');
// /v1 participates in existing authentication, per-project contexts, rate limits and idempotency validation.
add('// src/api/v1.ts', 'v1 route pattern', '  files: new RegExp(`^/v1/projects/${SEG}/files$`),', '  templates: new RegExp(`^/v1/projects/${SEG}/templates$`),\n  templateCreate: new RegExp(`^/v1/projects/${SEG}/files/from-template$`),\n  files: new RegExp(`^/v1/projects/${SEG}/files$`),');
add('// src/api/v1.ts', 'v1 templates before generic file route', '  if (g = R2.files.exec(path)) {', `  if (g = R2.templates.exec(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const pid = g[1];
    return json(await listTemplates(projectCtx(env, k, requestId, pid), pid, { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }));
  }
  if (g = R2.templateCreate.exec(path)) {
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const pid = g[1]; writeAllowed(k, pid);
    const result = await createFromTemplate(projectCtx(env, k, requestId, pid), pid, await readJson(req), idemKey(req.headers.get("idempotency-key")));
    return json(result.body, result.status);
  }
  if (g = R2.files.exec(path)) {`);
add('// src/api/v1.ts', 'template identity in flag-off v1 views', 'return { ...base, ...origin ? { web_url:', 'return { ...base, ...a.is_template ? { is_template: true, template_description: a.template_description } : {}, ...a.source ? { source: a.source } : {}, ...origin ? { web_url:');
add('// src/index.ts', 'owner template routes', '  if (rest[0] === "backup" && m === "GET")', `  if (rest[0] === "templates" && rest.length === 1) {
    if (m === "GET") return json(await listTemplates(ctx, pid, { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }));
    if (m === "POST") return out(await saveAsTemplate(ctx, pid, await body(req), key()));
  }
  if (rest[0] === "templates" && rest[1] === "preview" && rest.length === 2 && m === "POST") return json(await previewTemplate(ctx, pid, await body(req)));
  if (rest[0] === "artifacts" && rest[1] === "from-template" && rest.length === 2 && m === "POST") return out(await createFromTemplate(ctx, pid, await body(req), key()));
  if (rest[0] === "backup" && m === "GET")`);
// Legacy /1 backups remain readable. Template/provenance exports use /2, so older Workers reject them
// instead of silently losing identity. Restore preserves and validates bounded identity/provenance.
add('// src/backup.ts', 'template backup fields', 'SELECT id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at FROM artifacts', 'SELECT id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date FROM artifacts');
add('// src/backup.ts', 'description backup history', 'SELECT id, artifact_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at FROM meta_versions', 'SELECT id, artifact_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description FROM meta_versions');
add('// src/backup.ts', 'backup capabilities', '    schema: SCHEMA,\n', '    schema: arts.results.some(a => a.is_template || a.source_artifact_id) ? "agent-library-backup/2" : SCHEMA,\n    features: ["document_templates/1"],\n');
add('// src/backup.ts', 'accept legacy and template-aware backups', 'if (backup?.schema !== SCHEMA)', 'if (backup?.schema !== SCHEMA && backup?.schema !== "agent-library-backup/2")');
add('// src/backup.ts', 'validate template backup metadata', '  const blobs = backup.blobs ?? {};', `  for (const a of backup.artifacts ?? []) {
    if (a.is_template != null && a.is_template !== 0 && a.is_template !== 1) throw new HttpError(400, "bad_backup", "Invalid template identity");
    if (a.is_template && (a.kind !== "markdown" || a.publisher_id)) throw new HttpError(400, "bad_backup", "Invalid template kind");
    str(a.template_description ?? "", "template_description", 280);
    if (a.source_artifact_id != null) {
      str(a.source_artifact_id, "source_artifact_id", 64, { min: 1 });
      int(a.source_revision, "source_revision", 1);
      if (!["document", "template"].includes(a.source_role)) throw new HttpError(400, "bad_backup", "Invalid source role");
    }
    if (a.template_date != null) tplDate(a.template_date, true);
  }
  for (const v of Array.isArray(backup.meta_versions) ? backup.meta_versions : []) str(v.template_description ?? "", "template_description", 280);
  const blobs = backup.blobs ?? {};`);
add('// src/backup.ts', 'restore template fields', `INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, `INSERT INTO artifacts (id, project_id, kind, title, folder, tags, head_rev, head_revision_id, meta_version, trashed_at, created_at, updated_at, is_template, template_description, source_artifact_id, source_revision, source_role, template_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
add('// src/backup.ts', 'restore template bindings', 'a.meta_version, a.trashed_at, a.created_at, a.updated_at));', 'a.meta_version, a.trashed_at, a.created_at, a.updated_at, a.is_template ?? 0, a.template_description ?? "", a.source_artifact_id ?? null, a.source_revision ?? null, a.source_role ?? null, a.template_date ?? null));');
add('// src/backup.ts', 'restore description history column', 'version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at, template_description)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
add('// src/backup.ts', 'restore description history binding', 'v.change_note ?? null, v.restored_from ?? null, v.created_at));', 'v.change_note ?? null, v.restored_from ?? null, v.created_at, v.template_description ?? ""));');
let undo = out;
for (const p of [...patches].reverse()) {
  const i = undo.indexOf(p.replacement);
  if (i < 0 || undo.indexOf(p.replacement, i + 1) >= 0) throw Error('Cannot undo ' + p.name);
  undo = undo.slice(0, i) + p.find + undo.slice(i + p.replacement.length);
}
if (undo !== input) throw Error('Preservation failed');
writeFileSync('src/index.js', out);
writeFileSync('template-fixes-preservation.json', JSON.stringify({ base_changes_sha256: base, integrated_sha256: sha(out),
  sources: Object.fromEntries(['src/templates/service.js', 'src/templates/tools.js'].map(f => [f, sha(read(f))])),
  patches: patches.map(p => ({ module: p.module, name: p.name, find_sha256: sha(p.find), replace_sha256: sha(p.replacement) })),
  requires_migration: '0016_document_templates.sql' }, null, 2) + '\n');
console.log('Template bundle: ' + sha(out));
