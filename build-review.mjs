// Review gating (docs/review-gating.md; src/review/*; migration 0017_review_gating.sql). Runs last, after
// build-file-types.mjs. Exact patches, each anchor matching exactly the stated number of times, each occurrence
// checked to sit in its named module; every byte outside the patched spans is preserved (manifest hash).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('file-types-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-file-types.mjs first');
const SOURCES = ['src/review/service.js', 'src/review/tools.js', 'src/review/browser.js', 'src/review/browser.css'];
const src = Object.fromEntries(SOURCES.map((f) => [f, readFileSync(f, 'utf8')]));
// Browser sources go into APP_JS (String.raw template) and APP_CSS (template): no backtick or interpolation.
for (const f of ['src/review/browser.js', 'src/review/browser.css']) if (/[`]|\$\{/.test(src[f]) || (f.endsWith('.css') && src[f].includes('\\'))) throw Error(f + ' would break its template literal');
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
const SERVICE = '// src/service.ts', UPLOADS = '// src/uploads.ts', CLEANUP = '// src/cleanup.ts', BACKUP = '// src/backup.ts',
  OMCP = '// src/oauth/mcp.ts', LMCP = '// src/mcp.ts', V1 = '// src/api/v1.ts', CRED = '// src/api/credentials.ts', INDEX = '// src/index.ts', UI = '// src/ui.ts';
// [name, module (or list, one per occurrence), find, replace, count = 1]
const PATCHES = [
  // ------------------------------------------------------------------ service: sources, reads, gates
  ['review service and tools', SERVICE, 'function requireAppConnect(ctx) {\n', src['src/review/service.js'] + '\n' + src['src/review/tools.js'] + '\nfunction requireAppConnect(ctx) {\n'],
  ['hidden new documents exist only for their proposer (writes) and nobody (reads)', SERVICE,
    '  if (!a || a.head_rev === 0 && a.kind === "binary" && !opts.allowTrashed) throw new HttpError(404, "not_found", "Artifact not found");',
    '  if (!a || a.head_rev === 0 && a.kind === "binary" && !opts.allowTrashed && !(opts.pendingOk && a.pending_review === 1)) throw new HttpError(404, "not_found", "Artifact not found");\n  if (a.pending_review === 1 && !(opts.pendingOk && await rvOwnPending(ctx, a))) throw new HttpError(404, "not_found", "Artifact not found");'],
  ['artifact rows carry pending count and reviewed version', SERVICE,
    'ART_COLS = "a.*, (SELECT display_name FROM publishers WHERE id = a.publisher_id) AS pub_name";',
    'ART_COLS = "a.*, (SELECT display_name FROM publishers WHERE id = a.publisher_id) AS pub_name" + RV_ART_COLS;'],
  ['artifact view: review state (only when review is on or edits are pending)', SERVICE,
    '      } : {}\n    }), "artifactView");', '      } : {},\n      ...rvArtifactReview(a)\n    }), "artifactView");'],
  ['reads resolve the reviewed version', SERVICE, 'bind(artifactId, projectId, revNo ?? a.head_rev).first();', 'bind(artifactId, projectId, await rvResolveRev(ctx, a, revNo)).first();'],
  ['history: who reviewed each version', SERVICE, '  return historyPage(ctx, projectId, artifactId, opts);', '  return rvDecorateHistory(ctx, projectId, artifactId, await historyPage(ctx, projectId, artifactId, opts));'],
  ['hidden documents do not count toward the document limit', SERVICE,
    'SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NULL"', 'SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND publisher_id IS NULL AND pending_review = 0"', 2],
  ['template copies: hidden documents do not count', SERVICE,
    '(SELECT COUNT(*) FROM artifacts WHERE project_id = ? AND publisher_id IS NULL) < ?', '(SELECT COUNT(*) FROM artifacts WHERE project_id = ? AND publisher_id IS NULL AND pending_review = 0) < ?'],
  ['create: gated new documents become proposals', SERVICE, '  const artId = randomId("art");\n',
    '  if (await rvNewGated(ctx, projectId, kind)) return rvCreateNew(ctx, projectId, kind, { title, folder, folderId, schema, body: body2, mime, sha256: await sha256Hex(body2), size: new TextEncoder().encode(body2).length }, i, input);\n  const artId = randomId("art");\n'],
  ['template copy: gated new documents become proposals', SERVICE, '  const id = randomId("art"), rid = randomId("rev"), now = nowIso(), hash = await sha256Hex(body);\n',
    '  if (!definition && await rvNewGated(ctx, projectId, "markdown")) return rvCreateNew(ctx, projectId, "markdown", { title, folder, folderId, body, mime: "text/markdown", sha256: await sha256Hex(body), size: new TextEncoder().encode(body).length }, i, { change_note: note },\n    { cols: ["source_artifact_id", "source_revision", "source_role", "template_date"], vals: [sourceId, revision, "template", date] }, { source_template_id: sourceId, source_template_revision: revision, date });\n  const id = randomId("art"), rid = randomId("rev"), now = nowIso(), hash = await sha256Hex(body);\n'],
  ['content writes: gate (uploads are gated at finish)', SERVICE,
    'async function publishRevision(ctx, projectId, artifactId, expected, i, rev, extra = [], action = "artifact.save") {\n',
    'async function publishRevision(ctx, projectId, artifactId, expected, i, rev, extra = [], action = "artifact.save") {\n  if (rvGatedActor(ctx) && !rev.fence) {\n    const ga = await db(ctx).prepare("SELECT * FROM artifacts WHERE id = ? AND project_id = ?").bind(artifactId, projectId).first();\n    const g = ga && await rvGateContent(ctx, projectId, ga, i, expected, rev);\n    if (g) return g;\n  }\n'],
  ['save: a pending new document is saved at revision 0', SERVICE,
    'const expected = int(input.expected_revision, "expected_revision", 1);\n  const body2 = mdBody(input.body);', 'const expected = int(input.expected_revision, "expected_revision", 0);\n  const body2 = mdBody(input.body);'],
  ['save: the proposer can revise a pending new document', SERVICE,
    'const a = await loadArtifact(ctx, projectId, artifactId);\n  if (a.kind !== "markdown" && a.kind !== "html")', 'const a = await loadArtifact(ctx, projectId, artifactId, { pendingOk: rvGatedActor(ctx) });\n  if (a.kind !== "markdown" && a.kind !== "html")'],
  ['data-file save: revision 0', SERVICE,
    'const expected = int(input.expected_revision, "expected_revision", 1);\n  const text = input.body ?? input.content;', 'const expected = int(input.expected_revision, "expected_revision", 0);\n  const text = input.body ?? input.content;'],
  ['data-file save: the proposer can revise a pending new document', SERVICE,
    'const a = await loadArtifact(ctx, projectId, artifactId);\n  assertWritable(ctx, a, "content");\n  if (a.kind === "markdown"', 'const a = await loadArtifact(ctx, projectId, artifactId, { pendingOk: rvGatedActor(ctx) });\n  assertWritable(ctx, a, "content");\n  if (a.kind === "markdown"'],
  ['details: the proposer can revise a pending new document', SERVICE,
    'const a = await loadArtifact(ctx, projectId, artifactId, { allowTrashed: true });\n  // Agents', 'const a = await loadArtifact(ctx, projectId, artifactId, { allowTrashed: true, pendingOk: rvGatedActor(ctx) });\n  // Agents'],
  ['details: gate (trash refused)', SERVICE, '  if (input.trashed === false) trashed = null;\n',
    '  if (input.trashed === false) trashed = null;\n  {\n    const g = await rvGateMeta(ctx, projectId, a, i, expected, input, { title, folder, tags }, restoredFrom);\n    if (g) return g;\n  }\n'],
  ['a trigger refusal is a conflict, not a crash', SERVICE,
    '    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e))) {',
    '    if (/review_required/.test(String(e?.message ?? e))) throw new HttpError(409, "review_mode_changed", "Review settings of this document changed; read it again and retry");\n    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e?.message ?? e))) {'],
  // ------------------------------------------------------------------ uploads
  ['upload: placeholder for gated new files', UPLOADS, '  let artifactId;\n  let baseRev;\n', '  let artifactId;\n  let baseRev;\n  let rvMeta = null;\n'],
  ['upload: new version of a pending new file at revision 0', UPLOADS,
    '    const a = await loadArtifact(ctx, projectId, artifactId);\n    assertWritable(ctx, a, "content");\n    if (a.kind !== "binary") throw new HttpError(400, "invalid_input", "Not a binary artifact");\n    baseRev = int(input.expected_revision, "expected_revision", 1);',
    '    const a = await loadArtifact(ctx, projectId, artifactId, { pendingOk: rvGatedActor(ctx) });\n    assertWritable(ctx, a, "content");\n    if (a.kind !== "binary") throw new HttpError(400, "invalid_input", "Not a binary artifact");\n    baseRev = int(input.expected_revision, "expected_revision", a.pending_review === 1 ? 0 : 1);'],
  ['upload: gated new file shell', UPLOADS,
    "    stmts.push(db2(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, head_rev, created_at, updated_at)\n      SELECT ?, ?, 'binary', ?, ?, 0, ?, ? WHERE ${az.sql}`).bind(artifactId, projectId, title, str(input.folder, \"folder\", 200, { optional: true }), nowIso(), nowIso(), ...az.params));",
    "    const folder = str(input.folder, \"folder\", 200, { optional: true });\n    rvMeta = await rvNewGated(ctx, projectId, \"binary\") ? JSON.stringify({ title, folder }) : null;\n    if (rvMeta) await rvNewCap(ctx, projectId);\n    stmts.push(db2(ctx).prepare(`INSERT INTO artifacts (id, project_id, kind, title, folder, head_rev, created_at, updated_at, review_mode, pending_review)\n      SELECT ?, ?, 'binary', ?, ?, 0, ?, ?, ?, ? WHERE ${az.sql}`).bind(artifactId, projectId, rvMeta ? RV_PLACEHOLDER : title, rvMeta ? \"\" : folder, nowIso(), nowIso(), rvMeta ? \"required\" : \"off\", rvMeta ? 1 : 0, ...az.params));"],
  ['upload: remember the proposed title of a gated new file', UPLOADS,
    '    audit(ctx, projectId, "upload.begin", artifactId, baseRev, "ok", gate, [uploadId])\n  );\n',
    '    audit(ctx, projectId, "upload.begin", artifactId, baseRev, "ok", gate, [uploadId])\n  );\n  if (rvMeta) stmts.push(db2(ctx).prepare("UPDATE uploads SET review_meta = ? WHERE id = ?").bind(rvMeta, uploadId));\n'],
  ['upload finish: gated files become proposals (gate evaluated now)', UPLOADS, '      const res = await publishRevision(\n',
    '      const gated = await rvGateUpload(ctx, projectId, u, i, { blobKey: finalKey, size: bytes.length, sha256: sha2, mime: u.mime }, { sql: fenced, params: [uploadId, token] }, token);\n      if (gated) {\n        if (!gated.body?.idempotent_replay) await purgeStaging(ctx.env, u);\n        return gated;\n      }\n      const res = await publishRevision(\n'],
  ['quota: proposal files count until purged (once)', UPLOADS, "       AND state IN ('failed','conflict'))`, \"quotaUsedSql\");",
    "       AND state IN ('failed','conflict'))\n  + (SELECT COALESCE(SUM(size),0) FROM (SELECT DISTINCT blob_key, size FROM proposals pq WHERE project_id = ?1 AND blob_key IS NOT NULL AND blob_purged_at IS NULL\n       AND NOT EXISTS (SELECT 1 FROM revisions rq WHERE rq.blob_key = pq.blob_key)))`, \"quotaUsedSql\");"],
  ['uploads/cleanup never purge a file a proposal references', [CLEANUP, UPLOADS], 'AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key)',
    'AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.blob_key = u.final_key) AND NOT EXISTS (SELECT 1 FROM proposals pr WHERE pr.blob_key = u.final_key)', 2],
  ['cleanup: purge closed proposal files after 30 days', CLEANUP, '  await DB.prepare("DELETE FROM rate_counters WHERE win < ?")',
    '  await rvPurge(env, now, limit, opts.projectId ?? null);\n  await DB.prepare("DELETE FROM rate_counters WHERE win < ?")'],
  // ------------------------------------------------------------------ backup
  ['backup: include hidden pending documents', BACKUP, 'FROM artifacts WHERE project_id = ? AND head_rev > 0").bind(projectId),', 'FROM artifacts WHERE project_id = ? AND (head_rev > 0 OR pending_review = 1)").bind(projectId),'],
  ['backup: review section', BACKUP, "  await DB.prepare(\"INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.export'",
    "  const rvSection = await rvBackupExport(ctx, projectId, blobs);\n  await DB.prepare(\"INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id) VALUES (?, ?, ?, 'backup.export'"],
  ['backup: /3 when review data is present (older Workers refuse it)', BACKUP, 'schema: arts.results.some(a => a.is_template || a.source_artifact_id) ? "agent-library-backup/2" : SCHEMA,',
    'schema: rvSection ? "agent-library-backup/3" : arts.results.some(a => a.is_template || a.source_artifact_id) ? "agent-library-backup/2" : SCHEMA,'],
  ['backup: export review data', BACKUP, '    meta_versions: metaVersionsExport,\n    blobs\n  };', '    meta_versions: metaVersionsExport,\n    ...rvSection ?? {},\n    blobs\n  };'],
  ['restore: accept /3', BACKUP, 'if (backup?.schema !== SCHEMA && backup?.schema !== "agent-library-backup/2")', 'if (backup?.schema !== SCHEMA && backup?.schema !== "agent-library-backup/2" && backup?.schema !== "agent-library-backup/3")'],
  ['restore: validate review data and its files first', BACKUP, '  for (const [k, bytes] of decoded) await ctx.env.BLOBS.put(k, bytes);', '  await rvRestorePrepare(backup, blobs, decoded, pid);\n  for (const [k, bytes] of decoded) await ctx.env.BLOBS.put(k, bytes);'],
  ['restore: review authors', BACKUP, '...backup.meta_versions ?? []].map((x) => x.author_id));', '...backup.meta_versions ?? []].map((x) => x.author_id).concat(rvRestoreAuthors(backup)));'],
  ['restore: history imports as it was (gates skip)', BACKUP, '  stmts.push(DB.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)")',
    '  stmts.push(DB.prepare("INSERT OR IGNORE INTO review_restore_context (id) VALUES (1)"));\n  stmts.push(DB.prepare("INSERT INTO projects (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)")'],
  ['restore: review data, then gates on again', BACKUP, '  await DB.batch(stmts);\n  return { restored_project: pid',
    '  stmts.push(...rvRestoreStatements(DB, backup, pid), DB.prepare("DELETE FROM review_restore_context"));\n  await DB.batch(stmts);\n  return { restored_project: pid'],
  // ------------------------------------------------------------------ OAuth MCP
  ['OAuth: review tools', OMCP, '      ...tplTools(true),\n', '      ...tplTools(true),\n      ...rvTools(true),\n'],
  // Revoked connections keep no review grants (a connection's projects are fixed at consent; revocation is final).
  ['OAuth revoke drops review permission', '// src/oauth/connections.ts', '  if (!r.meta.changes) throw new HttpError(404, "not_found", "Active connection not found");\n',
    '  if (!r.meta.changes) throw new HttpError(404, "not_found", "Active connection not found");\n  await ctx.env.DB.prepare("DELETE FROM review_grants WHERE path_kind = \'oauth\' AND path_id = ?").bind(connectionId).run();\n'],
  ['agent token revoke drops review permission', SERVICE, '    res = await db(ctx).prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL").bind(nowMs(), grantId, projectId).run();\n',
    '    res = await db(ctx).prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL").bind(nowMs(), grantId, projectId).run();\n    await db(ctx).prepare("DELETE FROM review_grants WHERE path_kind = \'grant\' AND path_id = ?").bind(grantId).run();\n'],
  ['OAuth read_artifact: reviewed resolves before the document/file split', OMCP, '          const { include_image: _x, ...rest } = a;\n',
    '          a = await rvReviewedArgs(c, p, a);\n          const { include_image: _x, ...rest } = a;\n'],
  ['OAuth transfer: proposal file links serve the proposal (reviewer or proposer, live)', OMCP,
    '      return await serveContent(ctx, req, row.project_id, row.artifact_id, String(row.rev_no));',
    '      if (row.proposal_id) return await serveProposalContent({ ...ctx, ftConn: conn }, req, row.project_id, row.proposal_id);\n      return await serveContent(ctx, req, row.project_id, row.artifact_id, String(row.rev_no));'],
  ['OAuth read: reviewed version', OMCP, 'inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 }, cursor: RT_CURSOR, max_bytes: RT_MAXB }, ["artifact_id"]),',
    'inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 }, reviewed: RV_REVIEWED_ARG, cursor: RT_CURSOR, max_bytes: RT_MAXB }, ["artifact_id"]),'],
  ['OAuth read: resolve reviewed', OMCP, 'run: /* @__PURE__ */ __name(async (c, p, a) => {\n          if (a.cursor != null || a.max_bytes != null) return readTextChunk(c, p, a.artifact_id',
    'run: /* @__PURE__ */ __name(async (c, p, a) => {\n          a = await rvReviewedArgs(c, p, a);\n          if (a.cursor != null || a.max_bytes != null) return readTextChunk(c, p, a.artifact_id'],
  ['OAuth save: revision 0 for a pending new document', OMCP, 'expected_revision: { type: "integer", minimum: 1 }, body: { type: "string" }, change_note: NOTE, idempotency_key: K }',
    'expected_revision: { type: "integer", minimum: 0, description: "The revision you read (0 to revise your own new document while it waits for review)" }, body: { type: "string" }, change_note: NOTE, idempotency_key: K }'],
  ['OAuth save: the proposer can revise a pending new document', OMCP, '          const cur = await getArtifact(c, p, a.artifact_id);', '          const cur = { artifact: await loadArtifact(c, p, a.artifact_id, { pendingOk: rvGatedActor(c) }) };'],
  ['OAuth uploads: revision 0 for a pending new file', OMCP, 'expected_revision: { type: "integer", minimum: 1, description: "Current revision of artifact_id" }',
    'expected_revision: { type: "integer", minimum: 0, description: "Current revision of artifact_id (0 for your own new file while it waits for review)" }', 2],
  ['OAuth uploads: the proposer can upload a pending new file again', OMCP, 'const cur = await loadArtifact(c, p, str(a.artifact_id, "artifact_id", 64));', 'const cur = await loadArtifact(c, p, str(a.artifact_id, "artifact_id", 64), { pendingOk: rvGatedActor(c) });'],
  ['OAuth: review tools listed only where review was granted', OMCP, '  const searchReady = await rsToolReady(env,msg);\n  const tool = msg.method',
    '  const rvListReview = msg.method === "tools/list" && await rvAnyReview(env, "oauth", conn.id);\n  const searchReady = await rsToolReady(env,msg);\n  const tool = msg.method'],
  ['OAuth: tools/list filter', OMCP, '(t.name !== "search_artifacts" || searchReady) && (anyWrite || !t.write))', '(t.name !== "search_artifacts" || searchReady) && (anyWrite || !t.write) && (!t.review || rvListReview))'],
  ['OAuth: reviews use the write rate bucket', OMCP, 'await rateLimit(env, `${tool?.write ? "w" : "r"}:oauth:${conn.id}`, tool?.write ? 20 : 60);',
    'await rateLimit(env, `${tool?.write || tool?.review ? "w" : "r"}:oauth:${conn.id}`, tool?.write || tool?.review ? 20 : 60);'],
  // ------------------------------------------------------------------ legacy /mcp
  ['legacy: review tools', LMCP, '  ...tplTools(false),\n', '  ...tplTools(false),\n  ...rvTools(false),\n'],
  ['legacy read: reviewed version', LMCP, 'revision: { type: "integer" }, cursor: { type: "string", maxLength: 512 }, max_bytes: { type: "integer", minimum: 4096, maximum: 524288 } }, ["project_id", "artifact_id"]),',
    'revision: { type: "integer" }, reviewed: RV_REVIEWED_ARG, cursor: { type: "string", maxLength: 512 }, max_bytes: { type: "integer", minimum: 4096, maximum: 524288 } }, ["project_id", "artifact_id"]),'],
  ['legacy read: resolve reviewed', LMCP,
    'run: /* @__PURE__ */ __name((c, a) => a.cursor != null || a.max_bytes != null ? readTextChunk(c, a.project_id, a.artifact_id, { revision: a.revision, cursor: a.cursor, maxBytes: a.max_bytes, encoding: "mcp" }) : getArtifact(c, a.project_id, a.artifact_id, a.revision), "run")',
    'run: /* @__PURE__ */ __name(async (c, a0) => { const a = await rvReviewedArgs(c, a0.project_id, a0); return a.cursor != null || a.max_bytes != null ? readTextChunk(c, a.project_id, a.artifact_id, { revision: a.revision, cursor: a.cursor, maxBytes: a.max_bytes, encoding: "mcp" }) : getArtifact(c, a.project_id, a.artifact_id, a.revision); }, "run")'],
  ['legacy: review writes use the write bucket', LMCP, '"create_from_template"]);', '"create_from_template", "withdraw_proposal", "review_proposal", "review_revision"]);'],
  ['legacy: review tools listed only where review was granted', LMCP, 'const reply = /* @__PURE__ */ __name((body2) => new Response(rtFit(body2, rtLim), { status: 200, headers: hdr }), "reply");',
    'const reply = /* @__PURE__ */ __name((body2) => new Response(rtFit(body2, rtLim), { status: 200, headers: hdr }), "reply");\n  const rvListReview = msg.method === "tools/list" && !!ctx.grant?.id && await rvAnyReview(env, "grant", ctx.grant.id);'],
  ['legacy: tools/list filter', LMCP, '(t.name !== "search_artifacts" || searchReady) && (!t.write || !!ctx.grant?.can_write))', '(t.name !== "search_artifacts" || searchReady) && (!t.write || !!ctx.grant?.can_write) && (!t.review || rvListReview))'],
  // ------------------------------------------------------------------ /v1
  ['v1: review routes', V1, '  templates: new RegExp(`^/v1/projects/${SEG}/templates$`),\n',
    '  proposals: new RegExp(`^/v1/projects/${SEG}/proposals$`),\n  proposal: new RegExp(`^/v1/projects/${SEG}/proposals/${SEG}$`),\n  proposalContent: new RegExp(`^/v1/projects/${SEG}/proposals/${SEG}/content$`),\n  proposalAction: new RegExp(`^/v1/projects/${SEG}/proposals/${SEG}/(withdraw|review)$`),\n  revisionReview: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/revisions/([0-9]{1,9})/review$`),\n  templates: new RegExp(`^/v1/projects/${SEG}/templates$`),\n'],
  ['v1: review handlers', V1, '  if (g = R2.templates.exec(path)) {', `  if (g = R2.proposals.exec(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const pid = g[1];
    return json(await listProposals(projectCtx(env, k, requestId, pid), pid, { artifact_id: url.searchParams.get("artifact_id"), status: url.searchParams.get("status"), cursor: url.searchParams.get("cursor") }));
  }
  if (g = R2.proposal.exec(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const [, pid, prp] = g;
    return json(await readProposal(projectCtx(env, k, requestId, pid), pid, prp, { contentPath: \`/v1/projects/\${pid}/proposals/\${prp}/content\` }));
  }
  if (g = R2.proposalContent.exec(path)) {
    if (m !== "GET" && m !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const [, pid, prp] = g;
    return serveProposalContent(projectCtx(env, k, requestId, pid), new Request(\`\${url.origin}\${url.pathname}\`, { method: m, headers: req.headers }), pid, prp);
  }
  if (g = R2.proposalAction.exec(path)) {
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const [, pid, prp, action] = g;
    const key = idemKey(req.headers.get("idempotency-key"));
    if (action === "withdraw") writeAllowed(k, pid);
    const r = action === "withdraw" ? await withdrawProposal(projectCtx(env, k, requestId, pid), pid, prp, key) : await reviewProposal(projectCtx(env, k, requestId, pid), pid, prp, await readJson(req), key);
    return json(r.body, r.status);
  }
  if (g = R2.revisionReview.exec(path)) {
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const [, pid, fid, n] = g;
    const r = await reviewRevision(projectCtx(env, k, requestId, pid), pid, fid, Number(n), await readJson(req), idemKey(req.headers.get("idempotency-key")));
    return json(r.body, r.status);
  }
  if (g = R2.templates.exec(path)) {`],
  ['chunked text reads: ?revision=reviewed', SERVICE, '  return { revision: n("revision"), cursor: sp.get("cursor") ?? void 0, maxBytes: n("max_bytes") };',
    '  return { revision: sp.get("revision") === "reviewed" ? "reviewed" : n("revision"), cursor: sp.get("cursor") ?? void 0, maxBytes: n("max_bytes") };'],
  ['chunked text reads: resolve reviewed', SERVICE, '  let rev = opts.revision === void 0 || opts.revision === null ? null : int(opts.revision, "revision", 1);',
    '  if (opts.revision === "reviewed") opts = { ...opts, revision: await rvReviewedRev(ctx, projectId, artifactId) };\n  let rev = opts.revision === void 0 || opts.revision === null ? null : int(opts.revision, "revision", 1);'],
  ['content bytes: ?rev=reviewed / ?revision=reviewed', UPLOADS, '  const revNo = revParam ? int(Number(revParam), "rev", 1) : a.head_rev;',
    '  const revNo = revParam === "reviewed" ? await rvResolveRev(ctx, a, "reviewed") : revParam ? int(Number(revParam), "rev", 1) : a.head_rev;'],
  ['v1 read: ?revision=reviewed', V1, 'pid, fid, revQ !== null ? int(Number(revQ), "revision", 1) : void 0);', 'pid, fid, revQ === "reviewed" ? "reviewed" : revQ !== null ? int(Number(revQ), "revision", 1) : void 0);'],
  ['v1 views keep review state with App Connect off', V1, 'return { ...base, ...a.is_template ?', 'return { ...base, ...a.review ? { review: a.review } : {}, ...a.is_template ?'],
  // ------------------------------------------------------------------ API keys
  ['API key replace keeps review permission', CRED, 'return insertKey(ctx, old.label, lifetime(input?.lifetime_days), scope.results.map((r) => ({ project_id: r.project_id, can_write: !!r.can_write })), id);',
    'const made = await insertKey(ctx, old.label, lifetime(input?.lifetime_days), scope.results.map((r) => ({ project_id: r.project_id, can_write: !!r.can_write })), id);\n  await rvCarryReview(ctx.env, id, made.id);\n  return made;'],
  ['API key scope: review leaves with the project', CRED, '    env.DB.prepare("DELETE FROM api_credential_projects WHERE credential_id = ?").bind(id),\n',
    '    env.DB.prepare("DELETE FROM api_credential_projects WHERE credential_id = ?").bind(id),\n    env.DB.prepare("DELETE FROM review_grants WHERE path_kind = \'api_key\' AND path_id = ? AND project_id NOT IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(scope.map((s) => s.project_id))),\n'],
  // ------------------------------------------------------------------ browser API
  ['owner API: queue and review permission', INDEX, '  if (seg[0] === "publishers" && seg.length === 3', `  if (seg[0] === "review-queue" && seg.length === 1 && m === "GET") return json(await reviewQueue(ctx));
  if (seg[0] === "review-grants" && seg.length === 1 && m === "GET") return json(await listReviewGrants(ctx));
  if (seg[0] === "review-grants" && seg.length === 1 && m === "PUT") return json(await setReviewGrant(ctx, await body(req)));
  if (seg[0] === "publishers" && seg.length === 3`],
  ['owner API: proposals and project review settings', INDEX, '  if (rest[0] === "templates" && rest.length === 1) {', `  if (rest[0] === "proposals" && rest.length === 1 && m === "GET") return json(await listProposals(ctx, pid, { artifact_id: url.searchParams.get("artifact_id"), status: url.searchParams.get("status"), cursor: url.searchParams.get("cursor") }));
  if (rest[0] === "proposals" && rest.length === 2 && m === "GET") return json(await readProposal(ctx, pid, rest[1], { contentPath: \`/api/projects/\${pid}/proposals/\${rest[1]}/content\` }));
  if (rest[0] === "proposals" && rest.length === 3 && rest[2] === "content" && (m === "GET" || m === "HEAD")) return serveProposalContent(ctx, req, pid, rest[1]);
  if (rest[0] === "proposals" && rest.length === 3 && rest[2] === "withdraw" && m === "POST") return out(await withdrawProposal(ctx, pid, rest[1], key()));
  if (rest[0] === "proposals" && rest.length === 3 && rest[2] === "review" && m === "POST") return out(await reviewProposal(ctx, pid, rest[1], await body(req), key()));
  if (rest[0] === "review-settings" && rest.length === 1 && m === "GET") return json(await getReviewSettings(ctx, pid));
  if (rest[0] === "review-settings" && rest.length === 1 && m === "PUT") return json(await setReviewSettings(ctx, pid, await body(req)));
  if (rest[0] === "review-settings" && rest[1] === "apply" && rest.length === 2 && m === "POST") return json(await applyReviewSettings(ctx, pid, await body(req)));
  if (rest[0] === "templates" && rest.length === 1) {`],
  ['owner API: document review mode and version review', INDEX, '    if (sub === "comments" && m === "GET")', `    if (sub === "review-mode" && rest.length === 3 && m === "PUT") return json(await setReviewMode(ctx, pid, aid, await body(req)));
    if (sub === "revisions" && rest.length === 5 && rest[4] === "review" && m === "POST") return out(await reviewRevision(ctx, pid, aid, Number(rest[3]), await body(req), key()));
    if (sub === "comments" && m === "GET")`],
  ['owner API: ?rev=reviewed', INDEX, 'revQ ? Number(revQ) : void 0);\n      return json(r, 200', 'revQ === "reviewed" ? "reviewed" : revQ ? Number(revQ) : void 0);\n      return json(r, 200'],
  // ------------------------------------------------------------------ browser UI
  ['ui: styles', UI, 'var APP_CSS = `', 'var APP_CSS = `' + src['src/review/browser.css']],
  ['ui: review views and helpers', UI, '// ---------- home: authorized', src['src/review/browser.js'] + '// ---------- home: authorized'],
  ['ui: review routes', UI, '    if (p[2] === "trash") return viewList(p[1], true);', '    if (p[2] === "trash") return viewList(p[1], true);\n    if (p[2] === "review" && p[3]) return viewProposal(p[1], p[3]);\n    if (p[2] === "review") return viewProjectReview(p[1]);'],
  ['ui: project Review tab', UI, '  var tabs = [["list", "Documents", "#/p/" + enc(pid)], ["trash", "Trash", "#/p/" + enc(pid) + "/trash"]];',
    '  var tabs = [["list", "Documents", "#/p/" + enc(pid)], ["review", "Review", "#/p/" + enc(pid) + "/review"], ["trash", "Trash", "#/p/" + enc(pid) + "/trash"]];'],
  ['ui: Home "Needs review" reloads with Home (Refresh, returning to the tab)', UI, '    var my = ++seq; refresh.disabled = true; showMsg(msg, ""); markFilter();\n',
    '    var my = ++seq; refresh.disabled = true; showMsg(msg, ""); markFilter();\n    if (seq > 1) rvHome.refresh();\n'],
  ['ui: Home "Needs review" section', UI, '  var list = h("ul", { class: "list home-list", "aria-label": "Home documents" }), empty = h("div", { hidden: true });\n',
    '  var list = h("ul", { class: "list home-list", "aria-label": "Home documents" }), empty = h("div", { hidden: true });\n  var rvHome = rvHomeSection();\n'],
  // Above the Recently edited / Favorites toolbar: the queue is not part of the filtered document list.
  ['ui: Home "Needs review" (only when non-empty)', UI, '    h("div", { class: "toolbar" }, homeTabs, h("span", { class: "spacer" }),', '    rvHome,\n    h("div", { class: "toolbar" }, homeTabs, h("span", { class: "spacer" }),'],
  ['ui: document review setting and pending banner', UI, '  fillMeta();\n\n  // shared panels',
    '  fillMeta();\n  var rvUi = rvDocumentUi(A, pid, aid, details, reloadMeta);\n\n  // shared panels'],
  ['ui: review chip follows saves (owner autosave changes the current version)', UI, '  function setSaved() { setStatus("saved", "Saved - rev " + A.rev); }',
    '  function setSaved() { setStatus("saved", "Saved - rev " + A.rev); if (A.rvRedraw) A.rvRedraw(); }'],
  ['ui: review chip follows details reloads', UI, '  async function reloadMeta() { try { var r = await api("GET", base); A.meta = r.artifact; fillMeta(); } catch (e) {} }',
    '  async function reloadMeta() { try { var r = await api("GET", base); A.meta = r.artifact; fillMeta(); if (A.rvRedraw) A.rvRedraw(); } catch (e) {} }'],
  ['ui: pending banner above the document', UI, '  for (var k in panels) app.append(panels[k]);', '  if (rvUi.banner) app.insertBefore(rvUi.banner, tabNav);\n  if (rvUi.chip) { var rvAt = app.querySelector(".titlebar + .doc-meta") || app.querySelector(".titlebar"); if (rvAt) rvAt.after(rvUi.chip); }\n  for (var k in panels) app.append(panels[k]);'],
  // Badges and the row's button sit in one group (.vh-side) so they center on each other and wrap together.
  ['ui: history row review mark', UI, '          note(v)),\n        current ? h("span", { class: "badge accent", text: "current" }) : null,\n        h("button", { type: "button", class: "secondary vh-open", onclick: function () { open(v.rev); } }, current ? "View" : "Compare", h("span", { class: "sr", text: " version " + v.rev })));',
    '          note(v), rvHistoryWho(v)),\n        h("span", { class: "vh-side" }, rvHistoryBits(A, v),\n        current ? h("span", { class: "badge accent", text: "current" }) : null,\n        h("button", { type: "button", class: "secondary vh-open", onclick: function () { open(v.rev); } }, current ? "View" : "Compare", h("span", { class: "sr", text: " version " + v.rev }))));'],
  ['ui: history burst row: badge and toggle grouped', UI, '          first.rev === A.rev ? h("span", { class: "badge accent", text: "current" }) : null,\n          toggle, inner));',
    '          h("span", { class: "vh-side" }, first.rev === A.rev ? h("span", { class: "badge accent", text: "current" }) : null,\n          toggle), inner));'],
  // Details (title, folder, tags) rows: the same badge/button group, so every History row has one phone layout.
  ['ui: history details rows: badge or Restore grouped', UI, '            cur ? h("span", { class: "badge accent", text: "current" }) : h("button", { type: "button", class: "secondary", onclick: function (e) { restoreMeta(m, e.currentTarget); } }, "Restore", h("span", { class: "sr", text: " title and tags from details version " + m.version }))));',
    '            h("span", { class: "vh-side" }, cur ? h("span", { class: "badge accent", text: "current" }) : h("button", { type: "button", class: "secondary", onclick: function (e) { restoreMeta(m, e.currentTarget); } }, "Restore", h("span", { class: "sr", text: " title and tags from details version " + m.version })))));'],
  // Opening the History tab records it in the URL (?tab=history), so Back from a review screen returns to History.
  ['ui: History tab is restorable from the URL', UI, '  showTab(wantV ? "history" : isTextDoc(A.meta.kind) && initialTab === "edit" ? "edit" : "preview");',
    '  showTab(wantV || /[?&]tab=history(?:&|$)/.test(location.hash) ? "history" : isTextDoc(A.meta.kind) && initialTab === "edit" ? "edit" : "preview");'],
  ['ui: History tab writes ?tab=history', UI, '    if (tabBtns[name].onShow) tabBtns[name].onShow();\n  }\n',
    '    if (name === "history" && !/[?&](v|tab)=/.test(location.hash)) history.replaceState(null, "", "#/p/" + enc(pid) + "/a/" + enc(aid) + "?tab=history");\n    if (tabBtns[name].onShow) tabBtns[name].onShow();\n  }\n'],
  // Pending edits of this document (reviewers/owner see them all) above its versions, each with a Review link.
  ['ui: history lists edits waiting for review', UI, '      if (!revs.length) { list.append(h("li", { class: "empty", text: "No versions yet." })); return; }\n',
    '      rvPendingRows(A, pid, function () { rvLoadPending(A, pid, aid).then(draw); }).forEach(function (li) { list.append(li); });\n      if ((A.rvPendingFailed || A.rvPending && A.rvPending.length) && revs.length) list.append(h("li", { class: "group", text: "Versions" }));\n      if (!revs.length) { list.append(h("li", { class: "empty", text: "No versions yet." })); return; }\n'],
  ['ui: history loads waiting edits with the first page', UI, '        await fetchPage(again);\n',
    '        await Promise.all([again ? null : rvLoadPending(A, pid, aid), fetchPage(again)]);\n'],
  ['ui: history: mark a version reviewed (advisory)', UI, '      if (n !== A.rev) actions.append(h("button", { type: "button", onclick: function (e) { restoreRev(n, e.currentTarget); } }, "Restore this version"));',
    '      var rvMark = rvMarkButton(A, v, function () { load(); });\n      if (rvMark) actions.append(rvMark);\n      if (n !== A.rev) actions.append(h("button", { type: "button", onclick: function (e) { restoreRev(n, e.currentTarget); } }, "Restore this version"));'],
  // New document: choose review up front (starts at the project default for the chosen type; applied after creating).
  ['ui: new document: review choice', UI, '    var createBtn = h("button", { type: "submit" }, "Create");\n',
    '    var createBtn = h("button", { type: "submit" }, "Create");\n    var rvNew = rvNewDocReview(pid, function () { return selectedTemplate ? "markdown" : dkind.value === "html" ? "html" : "markdown"; });\n    dkind.addEventListener("change", rvNew.sync);\n'],
  ['ui: new document: review field', UI, '      } }, h("div", { class: "row" }, h("label", null, "Title", dtitle), h("label", null, "Document type", dkind)),',
    '      } }, h("div", { class: "row" }, h("label", null, "Title", dtitle), h("label", null, "Document type", dkind), rvNew.label), rvNew.help,'],
  ['ui: new document: review follows the template choice', UI, '    start.addEventListener("change", function () { selectedTemplate = templates[start.value] || null; scheduleTemplatePreview(); });',
    '    start.addEventListener("change", function () { selectedTemplate = templates[start.value] || null; scheduleTemplatePreview(); rvNew.sync(); });'],
  ['ui: new document: apply the review choice', UI, 'try { var r = await api("POST", path, req, { key: pending.key }); pending = null; location.hash',
    'try { var r = await api("POST", path, req, { key: pending.key }); pending = null; await rvNew.apply(r.artifact_id, r.revision); location.hash'],
  ['ui: apps: can review', UI, 'diagnostic: connectionSummary("oauth", c.id, c.client_name, c.projects, c.expires_at, c.last_used_at, c.status, data.checked_at),',
    'diagnostic: h("div", null, rvReviewToggles("oauth", c.id, c.projects, c.status === "active"), connectionSummary("oauth", c.id, c.client_name, c.projects, c.expires_at, c.last_used_at, c.status, data.checked_at)),'],
  ['ui: agent tokens: can review', UI, '      li.append(connectionSummary("legacy_grant", g.id, g.label, [{ project_id: g.project_id, title: g.project_title, access: g.access }], g.expires_at, null, g.status, data.checked_at));',
    '      li.append(rvReviewToggles("grant", g.id, [{ id: g.project_id, title: g.project_title }], g.status === "active"));\n      li.append(connectionSummary("legacy_grant", g.id, g.label, [{ project_id: g.project_id, title: g.project_title, access: g.access }], g.expires_at, null, g.status, data.checked_at));'],
  ['ui: API keys: can review', UI, '        statusBadge(k.status));\n      if (k.status === "active") {',
    '        statusBadge(k.status));\n      li.append(rvReviewToggles("api_key", k.id, k.projects.map(function (p) { return { id: p.project_id, title: p.title }; }), k.status === "active"));\n      if (k.status === "active") {'],
];
// The UI module holds APP_HTML, APP_CSS and APP_JS: browser code patches must land inside APP_JS.
const jsStart = input.indexOf('var APP_JS = String.raw`'), jsEnd = input.indexOf('`;\n', jsStart);
const spans = [];
for (const [name, mod, find, replace, count = 1] of PATCHES) {
  const at = [];
  for (let i = input.indexOf(find); i >= 0; i = input.indexOf(find, i + 1)) at.push(i);
  if (at.length !== count) throw Error(`${name}: expected ${count} match(es), found ${at.length}`);
  at.forEach((a, k) => {
    const want = Array.isArray(mod) ? mod[k] : mod;
    if (moduleOf(a) !== want) throw Error(`${name}: occurrence ${k} is in ${moduleOf(a)}, expected ${want}`);
    if (want === UI && name !== 'ui: styles' && !(a > jsStart && a < jsEnd)) throw Error(`${name}: anchor is outside APP_JS`);
    spans.push({ name, a, b: a + find.length, replace });
  });
}
spans.sort((x, y) => x.a - y.a);
for (let k = 1; k < spans.length; k++) if (spans[k].a < spans[k - 1].b) throw Error('Overlapping patches: ' + spans[k - 1].name + ' / ' + spans[k].name);
let out = '', pos = 0;
const gaps = [];
for (const s of spans) { gaps.push(input.slice(pos, s.a)); out += input.slice(pos, s.a) + s.replace; pos = s.b; }
gaps.push(input.slice(pos)); out += input.slice(pos);
writeFileSync('src/index.js', out);
const meta = { base_file_types_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')),
  sources_sha256: Object.fromEntries(SOURCES.map((f) => [f, sha(src[f])])),
  patches: PATCHES.map(([name, mod, find, replace, count = 1]) => ({ name, module: mod, count, find_sha256: sha(find), replace_sha256: sha(replace) })),
  requires_migration: '0017_review_gating.sql' };
writeFileSync('review-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('Review bundle: ' + sha(out));
