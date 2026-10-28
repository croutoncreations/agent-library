// Project-scoped Markdown starting content. Template identity and copy provenance are immutable;
// description uses the existing metadata timeline. No separate content/version store.
function tplDenyPublisher(ctx) {
  if (ctx.publisher) throw new HttpError(404, "not_found", "Not found");
}
function tplAssertMaintenance(ctx, a) {
  if (a.is_template && ctx.principal.kind !== "human") throw new HttpError(403, "template_owner_only", "Only the owner can maintain template definitions");
}
function tplLinks(ctx, pid, id) {
  const origin = appOrigin(ctx.env.APP_HOST);
  return origin ? { web_url: artifactWebUrl(origin, pid, id), preview_url: previewWebUrl(origin, pid, id) } : {};
}
function tplDate(v, required) {
  if (v == null && !required) return null;
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) || v.slice(0, 4) === "0000" || new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v)
    throw new HttpError(400, "invalid_date", "Supply a valid calendar date as YYYY-MM-DD");
  return v;
}
function tplReplace(body, title, project, date) {
  const values = { title, project, date };
  return body.replace(/\{\{(title|project|date)\}\}/g, (_, k) => values[k]);
}
async function listTemplates(ctx, projectId, q = {}) {
  tplDenyPublisher(ctx);
  await authorizeProject(ctx, projectId, false);
  const limit = q.limit == null ? 50 : int(Number(q.limit), "limit", 1, 50);
  const cursor = q.cursor == null ? "" : str(q.cursor, "cursor", 64);
  const az = rtReadAuthzSql(ctx, projectId);
  const r = await db(ctx).prepare(`SELECT a.id, a.title, a.template_description, a.head_rev, r.sha256
    FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id
    WHERE a.project_id = ? AND a.is_template = 1 AND a.kind = 'markdown' AND a.trashed_at IS NULL
      AND a.publisher_id IS NULL AND a.id > ? AND ${az.sql} ORDER BY a.id LIMIT ?`)
    .bind(projectId, cursor, ...az.params, limit + 1).all();
  const rows = r.results.slice(0, limit);
  return { templates: rows.map(a => ({ id: a.id, template_id: a.id, name: a.title, description: a.template_description,
    kind: "markdown", revision: a.head_rev, sha256: a.sha256, ...tplLinks(ctx, projectId, a.id) })),
    next_cursor: r.results.length > limit ? rows[rows.length - 1].id : null };
}
async function tplSource(ctx, pid, id, revision, definition) {
  const az = rtReadAuthzSql(ctx, pid);
  // Read access, availability, project and pinned content are checked in the same statement.
  const r = await db(ctx).prepare(`SELECT r.body FROM revisions r JOIN artifacts a ON a.id = r.artifact_id AND a.project_id = r.project_id
    WHERE a.id = ? AND a.project_id = ? AND r.rev_no = ? AND a.kind = 'markdown' AND a.publisher_id IS NULL
    AND a.trashed_at IS NULL ${definition ? "AND a.is_template = 1" : ""} AND ${az.sql}`)
    .bind(id, pid, revision, ...az.params).first();
  if (!r) throw new HttpError(404, "not_found", "Source is not available");
  return { body: r.body };
}
async function tplCopy(ctx, projectId, input, key, definition = false) {
  tplDenyPublisher(ctx);
  if (definition) requireHuman(ctx);
  await authorizeProject(ctx, projectId, true);
  const sourceId = str(definition ? input.source_artifact_id : input.template_id, "source_id", 64, { min: 1 });
  const revision = int(definition ? input.source_revision : input.template_revision, "source_revision", 1);
  const title = str(input.title, "title", 200, { min: 1 });
  const description = definition ? str(input.description ?? "", "description", 280) : "";
  const date = definition ? null : tplDate(input.date, false);
  const folder = str(input.folder, "folder", 200, { optional: true });
  const folderId = input.folder_id ?? null;
  const note = provenance(ctx, input)[4];
  const i = { projectId, op: definition ? "template.create" : "template.use", key,
    digest: await sha256Hex(JSON.stringify([sourceId, revision, title, description, date, folder, folderId, note])) };
  // Replay before reading mutable project title or template availability; authorization still precedes replay.
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const src = await tplSource(ctx, projectId, sourceId, revision, !definition);
  await folderCheck(ctx, projectId, folderId);
  const project = await db(ctx).prepare("SELECT title FROM projects WHERE id = ?").bind(projectId).first();
  if (!definition) tplDate(date, src.body.includes("{{date}}"));
  const body = mdBody(definition ? src.body : tplReplace(src.body, title, project.title, date));
  const id = randomId("art"), rid = randomId("rev"), now = nowIso(), hash = await sha256Hex(body);
  const az = authzSql(ctx, projectId);
  // All writes share this fence inside a single serialized D1 transaction. The idempotency insert is first,
  // so competing identical requests roll back rather than leaving a second copy/revision/audit behind.
  const gate = `${az.sql} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND project_id = ? AND kind = 'markdown'
    AND trashed_at IS NULL AND publisher_id IS NULL ${definition ? "" : "AND is_template = 1"})
    AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND project_id = ?))
    AND (SELECT COUNT(*) FROM artifacts WHERE project_id = ? AND publisher_id IS NULL) < ?`;
  const gp = [...az.params, sourceId, projectId, folderId, folderId, projectId, projectId, LIMITS.artifactsPerProject];
  const result = { status: 201, body: { artifact_id: id, kind: "markdown", revision: 1, revision_id: rid, sha256: hash,
    ...tplLinks(ctx, projectId, id), source_artifact_id: sourceId, source_revision: revision,
    ...definition ? { is_template: true } : { source_template_id: sourceId, source_template_revision: revision, date } } };
  const ownGate = "EXISTS (SELECT 1 FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = ? AND key = ? AND response = ?)";
  const ownParams = [ctx.principal.id, projectId, i.op, key, JSON.stringify(result.body)];
  const created = "EXISTS (SELECT 1 FROM artifacts WHERE id = ?)";
  const out = await runBatch(ctx, [
    idemInsert(ctx, i, 201, result.body, gate, gp),
    db(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, folder_id, head_rev, head_revision_id, created_at, updated_at,
      is_template, template_description, source_artifact_id, source_revision, source_role, template_date)
      SELECT ?, ?, 'markdown', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ownGate}`)
      .bind(id, projectId, title, folder, folderId, rid, now, now, definition ? 1 : 0, description, sourceId, revision, definition ? "document" : "template", date, ...ownParams),
    db(ctx).prepare(`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind, via_id, via_label, client_info, change_note)
      SELECT ?, ?, ?, 1, ?, ?, ?, ?, 'text/markdown', ?, ?, ?, ?, ?, ? WHERE ${created}`)
      .bind(rid, id, projectId, ctx.principal.id, body, new TextEncoder().encode(body).length, hash, now, ...provenance(ctx, { change_note: note }), id),
    audit(ctx, projectId, definition ? "template.create" : "template.use", id, 1, "ok", created, [id])
  ], i);
  if (!Array.isArray(out)) return out;
  if (!out[1].meta.changes) {
    const replay = await idemLookup(ctx, i); if (replay) return replay;
    await tplSource(ctx, projectId, sourceId, revision, !definition);
    await folderCheck(ctx, projectId, folderId);
    const n = await db(ctx).prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NULL").bind(projectId).first("n");
    if (n >= LIMITS.artifactsPerProject) throw new HttpError(413, "quota_exceeded", "Artifact limit reached");
    throw new HttpError(403, "forbidden", "Grant no longer valid");
  }
  return result;
}
async function createFromTemplate(ctx, pid, input, key) { return tplCopy(ctx, pid, input, key, false); }
async function saveAsTemplate(ctx, pid, input, key) { return tplCopy(ctx, pid, input, key, true); }
async function previewTemplate(ctx, pid, input) {
  tplDenyPublisher(ctx);
  await authorizeProject(ctx, pid, false);
  const revision = int(input.template_revision, "template_revision", 1);
  const src = await tplSource(ctx, pid, str(input.template_id, "template_id", 64), revision, true);
  const date = tplDate(input.date, src.body.includes("{{date}}"));
  const project = await db(ctx).prepare("SELECT title FROM projects WHERE id = ?").bind(pid).first();
  const title = str(input.title ?? "", "title", 200);
  const text = mdBody(tplReplace(src.body, title, project.title, date));
  // Bound the rendered preview and let the ordinary revision reader handle full content.
  const bounded = text.slice(0, 24000);
  return { revision, placeholders: [...new Set(src.body.match(/\{\{(?:title|project|date)\}\}/g) ?? [])],
    html: renderMarkdown(bounded, () => null), truncated: text.length > bounded.length };
}
async function tplProvenance(ctx, pid, a) {
  if (!a.source_artifact_id || ctx.publisher) return {};
  const az = rtReadAuthzSql(ctx, pid);
  const source = await db(ctx).prepare(`SELECT title FROM artifacts WHERE id = ? AND project_id = ? AND trashed_at IS NULL AND publisher_id IS NULL AND ${az.sql}`)
    .bind(a.source_artifact_id, pid, ...az.params).first();
  return source ? { source: { artifact_id: a.source_artifact_id, revision: a.source_revision, role: a.source_role,
    title: source.title, ...tplLinks(ctx, pid, a.source_artifact_id) } } : {};
}
