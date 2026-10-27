// Version history integration step (run AFTER build-icon-fixes.mjs). See docs/version-history.md.
// Starts from the icon-fixes bundle and applies exact, once-matching text patches; each patch names the module it
// belongs to and must match exactly once inside it. Everything outside the patched spans stays byte-identical
// (checked below by undoing every patch on the output). The TypeScript sources are NOT rebuilt.
// Requires migration 0010_version_history.sql. No config, credentials, database or network is used.
//
// What it adds:
//   - who/why on every content version: via_kind/via_id/via_label (server-derived from the access path),
//     client_info (MCP clientInfo, self-reported) and change_note (self-reported)
//   - immutable metadata versions (meta_versions) with restore
//   - history paging, version diffs, restore for MCP (both endpoints) and /v1
//   - browser: labelled, grouped timeline with compare and restore for content and details
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const BASE=JSON.parse(readFileSync('icon-fixes-preservation.json','utf8')).integrated_sha256;
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==BASE)throw Error('Input is not the icon-fixes bundle; run build-icon-fixes.mjs first');
const once=(s,needle,what,from=0)=>{const i=s.indexOf(needle,from);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
// Module spans by marker (first occurrence after `after`), ends at the next "// src/" marker line.
const span=(marker,after=0)=>{const a=input.indexOf('\n'+marker+'\n',after)+1;if(a<=0)throw Error('No module '+marker);const n=input.indexOf('\n// src/',a+marker.length);return [a,n<0?input.length:n+1];};
const MOD={
 util:span('// src/util.ts'),
 auth:span('// src/auth.ts'),
 service:span('// src/service.ts'),
 links:span('// src/links.ts'),
 oauthMcp:span('// src/oauth/mcp.ts'),
 backup:span('// src/backup.ts'),
 mcp:span('// src/mcp.ts',input.indexOf('\n// src/uploads.ts\n')),
 ui:span('// src/ui.ts'),
 v1:span('// src/api/v1.ts',input.indexOf('\n// src/api/credentials.ts\n')),
 index:span('// src/index.ts',input.indexOf('\n// src/api/app-clients.ts\n')),
 publisher:span('// src/api/publisher.ts — isolated readable-generation integration'),
};
const read=(f)=>readFileSync(f,'utf8');
const P=[]; // [module, name, find, replace]
const add=(m,name,find,rep)=>P.push([m,name,find,rep]);

// ---------------------------------------------------------------- service: shared who/why + history logic
add('service','provenance helpers, history paging, diff, metadata versions (appended to the service module)',
 'async function listAudit(ctx, projectId) {\n',
 read('src/history/service.js')+'async function listAudit(ctx, projectId) {\n');
add('service','createMarkdown: first version records who/why',
 `    db(ctx).prepare(\`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at)
      SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ?)\`).bind(revId, artId, projectId, ctx.principal.id, body2, new TextEncoder().encode(body2).length, sha2, mime, now, artId),`,
 `    db(ctx).prepare(\`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind, via_id, via_label, client_info, change_note)
      SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ?)\`).bind(revId, artId, projectId, ctx.principal.id, body2, new TextEncoder().encode(body2).length, sha2, mime, now, ...provenance(ctx, input), artId),`);
add('service','publishRevision: every later version records who/why',
 `    db(ctx).prepare(\`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE`,
 `    db(ctx).prepare(\`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE`);
add('service','publishRevision: bind who/why after created_at',
 `      rev.restoredFrom ?? null,
      now,
      artifactId,`,
 `      rev.restoredFrom ?? null,
      now,
      ...provenance(ctx, rev),
      artifactId,`);
add('service','saveMarkdown: carry the change note into the new version',
 `    { body: body2, size: new TextEncoder().encode(body2).length, sha256: await sha256Hex(body2), mime: TEXT_MIME[a.kind] }
  );
}`,
 `    { body: body2, size: new TextEncoder().encode(body2).length, sha256: await sha256Hex(body2), mime: TEXT_MIME[a.kind], change_note: input.change_note }
  );
}`);
add('service','saveFile: pass the change note through to Markdown/HTML saves',
 `return saveMarkdown(ctx, projectId, artifactId, { expected_revision: input.expected_revision, body: text }, key);`,
 `return saveMarkdown(ctx, projectId, artifactId, { expected_revision: input.expected_revision, body: text, change_note: input.change_note }, key);`);
add('service','saveFile: carry the change note into JSON/CSV versions',
 `    { body: body2, size: new TextEncoder().encode(body2).length, sha256: await sha256Hex(body2), mime: MIME[a.kind] }
  );
  return r.body?.idempotent_replay`,
 `    { body: body2, size: new TextEncoder().encode(body2).length, sha256: await sha256Hex(body2), mime: MIME[a.kind], change_note: input.change_note }
  );
  return r.body?.idempotent_replay`);
add('service','restoreRevision: note defaults to "Restored version N"; read before the idempotency digest stays as is',
 `    { body: old.body ?? void 0, blobKey: old.blob_key ?? void 0, size: old.size, sha256: old.sha256, mime: old.mime, restoredFrom: from },`,
 `    { body: old.body ?? void 0, blobKey: old.blob_key ?? void 0, size: old.size, sha256: old.sha256, mime: old.mime, restoredFrom: from, change_note: input.change_note ?? "Restored version " + from },`);
add('service','history: paged, labelled versions (old 200-row list replaced)',
 `  const r = await db(ctx).prepare(
    "SELECT rev_no AS rev, id, size, sha256, mime, author_id, restored_from, created_at FROM revisions WHERE artifact_id = ? AND project_id = ? ORDER BY rev_no DESC LIMIT 200"
  ).bind(artifactId, projectId).all();
  return { revisions: r.results };
}`,
 `  return historyPage(ctx, projectId, artifactId, opts);
}`);
add('service','history: accept paging options; the owner can read the history of a trashed document (agents: 404)',
 'async function history(ctx, projectId, artifactId) {\n  await authorizeProject(ctx, projectId, false);\n  await loadArtifact(ctx, projectId, artifactId);\n',
 'async function history(ctx, projectId, artifactId, opts = {}) {\n  await authorizeProject(ctx, projectId, false);\n  await loadArtifact(ctx, projectId, artifactId, { allowTrashed: ctx.principal.kind === "human" });\n');
add('service','updateMetadata: change notes are not part of the request digest',
 `  const i = { op: "artifact.meta:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify(input)) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const a = await loadArtifact(ctx, projectId, artifactId, { allowTrashed: true });
  assertWritable(ctx, a, "meta");`,
 `  // restoredFrom is internal-only (set by restoreMetadata); request bodies can never claim a change is a restore.
  const restoredFrom = Number.isInteger(internal?.restoredFrom) ? internal.restoredFrom : null;
  const { change_note: _note, ...digestInput } = input;
  const i = { op: restoredFrom ? "artifact.meta_restore:" + artifactId : "artifact.meta:" + artifactId, key, projectId, digest: await sha256Hex(JSON.stringify(restoredFrom ? [expected, restoredFrom] : digestInput)) };
  const prior = await idemLookup(ctx, i);
  if (prior) return prior;
  const a = await loadArtifact(ctx, projectId, artifactId, { allowTrashed: true });
  // Agents can't restore a trashed document's details (the trash takes it away from them). Checked after the
  // idempotency lookup, so a same-key retry of a restore that already succeeded still replays.
  if (restoredFrom && ctx.principal.kind !== "human" && a.trashed_at) throw new HttpError(404, "not_found", "Artifact not found");
  assertWritable(ctx, a, "meta");`);
add('service','updateMetadata: record the baseline (once) and the new metadata version in the same gated batch',
 `    idemInsert(ctx, i, 200, body2, gate, gp),
    audit(
      ctx,
      projectId,
      input.trashed === true ? "artifact.trash" : input.trashed === false ? "artifact.untrash" : "artifact.meta",`,
 `    metaBaselineInsert(ctx, a, gate, gp),
    metaVersionInsert(ctx, a, next, { title, folder, tags, trashed: !!trashed, restoredFrom }, input, gate, gp),
    idemInsert(ctx, i, 200, body2, gate, gp),
    audit(
      ctx,
      projectId,
      restoredFrom ? "artifact.meta_restore" : input.trashed === true ? "artifact.trash" : input.trashed === false ? "artifact.untrash" : "artifact.meta",`);
add('service','updateMetadata: internal-only restore marker parameter',
 'async function updateMetadata(ctx, projectId, artifactId, input, key) {\n',
 'async function updateMetadata(ctx, projectId, artifactId, input, key, internal) {\n');
add('service','register new service functions',
 '    __name(listAudit, "listAudit");\n',
 '    __name(listAudit, "listAudit");\n    __name(provenance, "provenance");\n    __name(historyPage, "historyPage");\n    __name(diffRevisions, "diffRevisions");\n    __name(lineDiff, "lineDiff");\n    __name(metaBaselineInsert, "metaBaselineInsert");\n    __name(metaVersionInsert, "metaVersionInsert");\n    __name(metaHistory, "metaHistory");\n    __name(restoreMetadata, "restoreMetadata");\n');

// ---------------------------------------------------------------- OAuth MCP (artifacts-mcp host)
add('oauthMcp','OAuth MCP: write context names the connection and carries clientInfo',
 `        principal: { id: conn.owner_principal_id, kind: "agent", label: \`oauth:\${conn.client_name}\` },
        grant: { id: conn.id, project_id: proj.id, can_write: canWrite ? 1 : 0 },
        oauthConnection: true
      };`,
 `        principal: { id: conn.owner_principal_id, kind: "agent", label: \`oauth:\${conn.client_name}\` },
        grant: { id: conn.id, project_id: proj.id, can_write: canWrite ? 1 : 0 },
        oauthConnection: true,
        via: { kind: "oauth", id: conn.id, label: conn.client_name },
        clientInfo: mcpClientInfo(msg.params, conn.client_info)
      };`);
add('oauthMcp','OAuth MCP: remember the initialize clientInfo on the connection',
 `    case "initialize": {
      const want = msg.params?.protocolVersion;
      return reply(rpc(msg.id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],`,
 `    case "initialize": {
      const want = msg.params?.protocolVersion;
      await rememberClientInfo(env, "oauth_connections", conn.id, msg.params);
      return reply(rpc(msg.id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],`);
add('oauthMcp','OAuth MCP: history paging, diff, restore tools (inserted after artifact_history)',
 `        run: /* @__PURE__ */ __name((c, p, a) => history(c, p, a.artifact_id), "run")
      },`,
 `        run: /* @__PURE__ */ __name((c, p, a) => history(c, p, a.artifact_id, { cursor: a.cursor }), "run")
      },
`+read('src/history/oauth-tools.js'));
add('oauthMcp','OAuth MCP: artifact_history takes a cursor and documents labels',
 `        description: "List a document's immutable revisions.",
        inputSchema: S({ project_id: P, artifact_id: A }, ["artifact_id"]),`,
 `        description: "List a document's immutable versions, newest first (50 per page; pass next_cursor for older ones). Each version says who made it (via: the connection, API key or app; client_info and change_note are self-reported) and why. Title/folder/tag changes are listed under meta_versions.",
        inputSchema: S({ project_id: P, artifact_id: A, cursor: { type: "string", maxLength: 12 } }, ["artifact_id"]),`);
add('oauthMcp','OAuth MCP: create_markdown accepts change_note',
 `        inputSchema: S({ project_id: P, title: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string" }, format: { type: "string", enum: ["markdown", "html"], description: "Document format (default markdown)" }, idempotency_key: K }, ["title", "idempotency_key"]),
        annotations: RW,
        write: true,
        run: /* @__PURE__ */ __name(async (c, p, a) => unwrap(await createMarkdown(c, p, { title: a.title, body: a.body ?? "" }, idemKey(a.idempotency_key), a.format === "html" ? "html" : "markdown")), "run")`,
 `        inputSchema: S({ project_id: P, title: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string" }, format: { type: "string", enum: ["markdown", "html"], description: "Document format (default markdown)" }, change_note: NOTE, idempotency_key: K }, ["title", "idempotency_key"]),
        annotations: RW,
        write: true,
        run: /* @__PURE__ */ __name(async (c, p, a) => unwrap(await createMarkdown(c, p, { title: a.title, body: a.body ?? "", change_note: a.change_note }, idemKey(a.idempotency_key), a.format === "html" ? "html" : "markdown")), "run")`);
add('oauthMcp','OAuth MCP: save_markdown accepts change_note',
 `        description: "Save a new revision of a Markdown or HTML document (the format is kept). expected_revision must be the revision you read; on revision_conflict re-read and merge.",
        inputSchema: S({ project_id: P, artifact_id: A, expected_revision: { type: "integer", minimum: 1 }, body: { type: "string" }, idempotency_key: K }, ["artifact_id", "expected_revision", "body", "idempotency_key"]),`,
 `        description: "Save a new revision of a Markdown or HTML document (the format is kept). expected_revision must be the revision you read; on revision_conflict re-read and merge. Every save is kept as an immutable version the owner can compare and restore. Always set change_note to one line on why you made the change; the owner reads it in History.",
        inputSchema: S({ project_id: P, artifact_id: A, expected_revision: { type: "integer", minimum: 1 }, body: { type: "string" }, change_note: NOTE, idempotency_key: K }, ["artifact_id", "expected_revision", "body", "idempotency_key"]),`);
add('oauthMcp','OAuth MCP: save_markdown passes change_note',
 `          return unwrap(await saveMarkdown(c, p, a.artifact_id, { expected_revision: a.expected_revision, body: a.body }, idemKey(a.idempotency_key)));`,
 `          return unwrap(await saveMarkdown(c, p, a.artifact_id, { expected_revision: a.expected_revision, body: a.body, change_note: a.change_note }, idemKey(a.idempotency_key)));`);
add('oauthMcp','OAuth MCP: shared change_note schema',
 '    RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };\n',
 '    RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };\n    NOTE = CHANGE_NOTE_SCHEMA;\n');
add('oauthMcp','OAuth MCP: declare NOTE',
 'var MCP_TEXT_MAX, SUPPORTED, S, A, P, K, unwrap, RO, RW,',
 'var MCP_TEXT_MAX, SUPPORTED, S, A, P, K, NOTE, unwrap, RO, RW,');

// ---------------------------------------------------------------- legacy bearer MCP (/mcp on the app host)
add('mcp','legacy MCP: artifact_history paging + description',
 `    description: "List immutable revisions.",
    inputSchema: S2({ project_id: P2, artifact_id: A2 }, ["project_id", "artifact_id"]),
    run: /* @__PURE__ */ __name((c, a) => history(c, a.project_id, a.artifact_id), "run")
  },`,
 `    description: "List immutable versions, newest first (50 per page; pass next_cursor for older ones), with who made each (via, self-reported client_info) and why (change_note). Title/folder/tag changes are listed under meta_versions.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, cursor: { type: "string" } }, ["project_id", "artifact_id"]),
    run: /* @__PURE__ */ __name((c, a) => history(c, a.project_id, a.artifact_id, { cursor: a.cursor }), "run")
  },
`+read('src/history/legacy-tools.js'));
add('mcp','legacy MCP: create_markdown accepts change_note',
 `    inputSchema: S2({ project_id: P2, title: { type: "string" }, body: { type: "string" }, folder: { type: "string" }, format: { type: "string", enum: ["markdown", "html"] }, idempotency_key: K2 }, ["project_id", "title", "idempotency_key"]),`,
 `    inputSchema: S2({ project_id: P2, title: { type: "string" }, body: { type: "string" }, folder: { type: "string" }, format: { type: "string", enum: ["markdown", "html"] }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "title", "idempotency_key"]),`);
add('mcp','legacy MCP: save_markdown accepts change_note',
 `    description: "Save a new revision of a Markdown or HTML document. Fails with revision_conflict if expected_revision is not the current head; your text is not discarded \\u2014 re-read and merge explicitly.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_revision: { type: "integer" }, body: { type: "string" }, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_revision", "body", "idempotency_key"]),`,
 `    description: "Save a new revision of a Markdown or HTML document. Fails with revision_conflict if expected_revision is not the current head; your text is not discarded \\u2014 re-read and merge explicitly. Every save is kept as an immutable version. Always set change_note to one line on why you made the change; the owner reads it in History.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_revision: { type: "integer" }, body: { type: "string" }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_revision", "body", "idempotency_key"]),`);
add('mcp','legacy MCP: write context names the grant and carries clientInfo',
 `        const result = withWebUrls(tool.name, args, args.project_id, await tool.run(ctx, args), appOrigin(env.APP_HOST) ?? origin);`,
 `        const result = withWebUrls(tool.name, args, args.project_id, await tool.run({ ...ctx, clientInfo: mcpClientInfo(msg.params, ctx.grantClientInfo) }, args), appOrigin(env.APP_HOST) ?? origin);`);
add('mcp','legacy MCP: remember the initialize clientInfo on the grant',
 `    case "initialize": {
      const want = msg.params?.protocolVersion;
      return reply(rpc2(msg.id, {`,
 `    case "initialize": {
      const want = msg.params?.protocolVersion;
      if (ctx.grant?.id) await rememberClientInfo(env, "grants", ctx.grant.id, msg.params);
      return reply(rpc2(msg.id, {`);

// ---------------------------------------------------------------- auth: grant tokens carry their remembered clientInfo
add('auth','grant auth: read the remembered clientInfo with the grant',
 'SELECT g.id, g.project_id, g.can_write, g.expires_at, g.revoked_at, p.id AS pid, p.kind, p.label\n',
 'SELECT g.id, g.project_id, g.can_write, g.expires_at, g.revoked_at, g.client_info, p.id AS pid, p.kind, p.label\n');
add('auth','grant auth: context carries the clientInfo hint',
 `      principal: { id: row.pid, kind: "agent", label: row.label },
      grant: { id: row.id, project_id: row.project_id, can_write: row.can_write }
    };`,
 `      principal: { id: row.pid, kind: "agent", label: row.label },
      grant: { id: row.id, project_id: row.project_id, can_write: row.can_write },
      grantClientInfo: row.client_info ?? null
    };`);
add('mcp','legacy MCP: restore tools rate-limited as mutations',
 `const MUTATING = /* @__PURE__ */ new Set(["create_markdown", "save_markdown", "add_comment", "upload_begin", "upload_finish", "trash_artifact"]);`,
 `const MUTATING = /* @__PURE__ */ new Set(["create_markdown", "save_markdown", "add_comment", "upload_begin", "upload_finish", "trash_artifact", "restore_revision", "restore_metadata"]);`);

// ---------------------------------------------------------------- links: tool outputs carry browser links
add('links','web links for restore results and per-version links',
 `    case "create_markdown":
    case "save_markdown": {`,
 `    case "restore_revision":
    case "restore_metadata":
    case "create_markdown":
    case "save_markdown": {`);
add('links','artifact_history: per-version browser link',
 `      return { ...result, web_url: artifactWebUrl(origin, pid, args.artifact_id), web_url_opens: "current_document" };`,
 `      return { ...result, revisions: (result.revisions ?? []).map((v) => ({ ...v, version_url: \`\${artifactWebUrl(origin, pid, args.artifact_id)}?v=\${v.rev}\` })), web_url: artifactWebUrl(origin, pid, args.artifact_id), web_url_opens: "current_document" };`);
add('links','artifact_history output schema mentions version_url',
 `artifact_history: obj({ revisions: { type: "array" }, web_url: { ...U, description: "Current document page; individual revisions have no browser link. " + WEB_URL_DESCRIPTION }, web_url_opens: OPENS }),`,
 `artifact_history: obj({ revisions: { type: "array", items: obj({ rev: { type: "integer" }, version_url: { ...U, description: "Opens this version read-only in the owner's app (History tab), with compare and restore. " + WEB_URL_DESCRIPTION } }) }, web_url: { ...U, description: "Current document page. " + WEB_URL_DESCRIPTION }, web_url_opens: OPENS }),`);

// ---------------------------------------------------------------- backup: round-trip the new columns and table
add('backup','export: revision who/why columns and metadata versions',
 `    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at FROM revisions WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, created_at FROM comments WHERE project_id = ?").bind(projectId)
  ]);`,
 `    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note FROM revisions WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, rev_no, author_id, body, created_at FROM comments WHERE project_id = ?").bind(projectId),
    DB.prepare("SELECT id, artifact_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at FROM meta_versions WHERE project_id = ?").bind(projectId)
  ]).then(([a, r, c, mv]) => (metaVersionsExport = mv.results, [a, r, c]));`);
add('backup','export: declare the metadata versions holder',
 `async function exportBackup(ctx, projectId) {
  requireHuman(ctx);`,
 `async function exportBackup(ctx, projectId) {
  requireHuman(ctx);
  let metaVersionsExport = [];`);
add('backup','export: include metadata versions',
 `    comments: comments.results,
    blobs
  };`,
 `    comments: comments.results,
    meta_versions: metaVersionsExport,
    blobs
  };`);
add('backup','restore: revision who/why columns',
 `    stmts.push(DB.prepare(\`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).bind(r.id, r.artifact_id, pid, r.rev_no, r.author_id, r.body, r.blob_key, r.size, r.sha256, r.mime, r.restored_from, r.created_at));`,
 `    stmts.push(DB.prepare(\`INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, blob_key, size, sha256, mime, restored_from, created_at, via_kind, via_id, via_label, client_info, change_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).bind(r.id, r.artifact_id, pid, r.rev_no, r.author_id, r.body, r.blob_key, r.size, r.sha256, r.mime, r.restored_from, r.created_at, r.via_kind ?? null, r.via_id ?? null, r.via_label ?? null, r.client_info ?? null, r.change_note ?? null));
  for (const v of backup.meta_versions ?? [])
    stmts.push(DB.prepare(\`INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).bind(v.id, v.artifact_id, pid, v.version, v.title, v.folder, v.tags, v.trashed ? 1 : 0, v.author_id, v.via_kind ?? null, v.via_id ?? null, v.via_label ?? null, v.client_info ?? null, v.change_note ?? null, v.restored_from ?? null, v.created_at));`);
add('backup','restore: authors of metadata versions exist as principals (backups from before 0010 have none)',
 `  const authors = new Set([...backup.revisions, ...backup.comments].map((x) => x.author_id));`,
 `  if (backup.meta_versions !== void 0 && !Array.isArray(backup.meta_versions)) throw new HttpError(400, "bad_backup", "meta_versions must be a list");
  const authors = new Set([...backup.revisions, ...backup.comments, ...backup.meta_versions ?? []].map((x) => x.author_id));`);

// ---------------------------------------------------------------- /v1 machine API
add('v1','routes: version diff, restore, metadata history/restore',
 `  revisions: new RegExp(\`^/v1/projects/\${SEG}/files/\${SEG}/revisions$\`),`,
 `  revisions: new RegExp(\`^/v1/projects/\${SEG}/files/\${SEG}/revisions$\`),
  revisionRestore: new RegExp(\`^/v1/projects/\${SEG}/files/\${SEG}/revisions/([0-9]{1,9})/restore$\`),
  diff: new RegExp(\`^/v1/projects/\${SEG}/files/\${SEG}/diff$\`),
  metaVersions: new RegExp(\`^/v1/projects/\${SEG}/files/\${SEG}/meta-versions$\`),
  metaRestore: new RegExp(\`^/v1/projects/\${SEG}/files/\${SEG}/meta-versions/([0-9]{1,9})/restore$\`),`);
add('v1','API key context names the key',
 `    principal: { id: k.principalId, kind: "agent", label: \`api:\${k.label}\` },
    grant: { id: k.credentialId, project_id: p.id, can_write: p.can_write ? 1 : 0 }
  };`,
 `    principal: { id: k.principalId, kind: "agent", label: \`api:\${k.label}\` },
    grant: { id: k.credentialId, project_id: p.id, can_write: p.can_write ? 1 : 0 },
    via: { kind: "api_key", id: k.credentialId, label: k.label }
  };`);
add('v1','create: change_note',
 `        { kind: b.kind, title: b.title, body: b.body, content: b.content, folder: b.folder, folder_id: b.folder_id, schema: b.schema },`,
 `        { kind: b.kind, title: b.title, body: b.body, content: b.content, folder: b.folder, folder_id: b.folder_id, schema: b.schema, change_note: b.change_note },`);
add('v1','create (flag off): change_note',
 `createMarkdown(projectCtx(env, k, requestId, pid), pid, { title: b.title, body: b.body ?? "", folder: b.folder }, key,`,
 `createMarkdown(projectCtx(env, k, requestId, pid), pid, { title: b.title, body: b.body ?? "", folder: b.folder, change_note: b.change_note }, key,`);
add('v1','save: change_note',
 `{ expected_revision: b.expected_revision, body: b.body, content: b.content }, key) : await saveMarkdown(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, body: b.body }, key);`,
 `{ expected_revision: b.expected_revision, body: b.body, content: b.content, change_note: b.change_note }, key) : await saveMarkdown(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, body: b.body, change_note: b.change_note }, key);`);
add('v1','history paging + new endpoints',
 `    return json(await history(projectCtx(env, k, requestId, pid), pid, fid));
  }
  throw new HttpError(404, "not_found", "Not found");`,
 `    return json(await history(projectCtx(env, k, requestId, pid), pid, fid, { cursor: url.searchParams.get("cursor") ?? void 0 }));
  }
`+read('src/history/v1-routes.js')+`  throw new HttpError(404, "not_found", "Not found");`);

// ---------------------------------------------------------------- browser API (app host)
add('index','browser API: history paging, diff, metadata history and restore',
 `    if (sub === "history" && m === "GET") return json(await history(ctx, pid, aid));`,
 `    if (sub === "history" && m === "GET") return json(await history(ctx, pid, aid, { cursor: url.searchParams.get("cursor") ?? void 0 }));
    if (sub === "diff" && m === "GET") return json(await diffRevisions(ctx, pid, aid, url.searchParams.get("from"), url.searchParams.get("to")));
    if (sub === "meta-history" && m === "GET") return json(await metaHistory(ctx, pid, aid, false, url.searchParams.get("cursor") ?? void 0));
    if (sub === "meta-restore" && m === "POST") return out(await restoreMetadata(ctx, pid, aid, await body(req), key()));`);

// ---------------------------------------------------------------- browser UI
add('ui','history tab: labelled, grouped timeline with compare and restore (old list replaced)',
 `  // history
  var histMsg = h("p", { class: "msg", role: "status" }), histList = h("ul", { class: "list" }), histView = h("div");`,
 read('src/history/ui-history.js')+`  // history (previous list, kept for its view/restore helpers)
  var histMsg = h("p", { class: "msg", role: "status" }), histList = h("ul", { class: "list" }), histView = h("div");`);
add('ui','history tab uses the new timeline',
 `  addTab("history", "History", loadHistory);
  panels.history.append(histMsg, histList, histView);`,
 `  addTab("history", "History", VH.load);
  panels.history.append(VH.root);`);
add('ui','?v=N deep link opens the History tab on that version',
 `  showTab(isTextDoc(A.meta.kind) && initialTab === "edit" ? "edit" : "preview");`,
 `  var wantV = VH.requestedVersion();
  if (wantV) VH.open(wantV);
  showTab(wantV ? "history" : isTextDoc(A.meta.kind) && initialTab === "edit" ? "edit" : "preview");`);
add('ui','a /p/…/a/…?v=N link keeps the version when it becomes the in-app route',
 `  history.replaceState(null, "", "/#/p/" + m[1] + (m[2] ? "/a/" + m[2] + (m[3] ? "/" + m[3] : "") : ""));`,
 `  var v = m[2] && /[?&]v=([0-9]{1,9})(?:&|$)/.exec(location.search);
  history.replaceState(null, "", "/#/p/" + m[1] + (m[2] ? "/a/" + m[2] + (m[3] ? "/" + m[3] : "") + (v ? "?v=" + v[1] : "") : ""));`);
add('ui','router ignores a ?v=N version query on a document route',
 `  var p = location.hash.replace(/^#\\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (S.offline) return offlineRoute();`,
 `  var p = location.hash.replace(/^#\\/?/, "").replace(/\\?.*$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (S.offline) return offlineRoute();`);
add('ui','history CSS (appended to the app stylesheet)',
 '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}\n',
 '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}\n'+read('src/history/ui-history.css'));

// ---------------------------------------------------------------- publisher (App Connect): versions name the app
// The publisher module inserts revisions directly; each insert records via_kind 'publisher', the publisher id and
// the app's display name (snapshot), so published versions carry the same per-version access path as all others.
const PUB_COLS='INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at)';
const PUB_COLS2='INSERT INTO revisions (id, artifact_id, project_id, rev_no, author_id, body, size, sha256, mime, created_at, via_kind, via_id, via_label)';
add('publisher','generation commit: part versions record the publishing app',
 `    q.push(env.DB.prepare(\`${PUB_COLS}
    SELECT json_extract(j.value, '$.r'), json_extract(j.value, '$.a'), ?, 1, ?, t.body, t.bytes, t.sha256, 'application/json', ?
    FROM json_each(?) j JOIN publisher_generation_parts t ON t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key WHERE \${gate}\`).bind(p.project_id, p.principal_id, now, idsJson, p.id, id, ...gp));`,
 `    q.push(env.DB.prepare(\`${PUB_COLS2}
    SELECT json_extract(j.value, '$.r'), json_extract(j.value, '$.a'), ?, 1, ?, t.body, t.bytes, t.sha256, 'application/json', ?, 'publisher', ?, ?
    FROM json_each(?) j JOIN publisher_generation_parts t ON t.publisher_id = ? AND t.generation_id = ? AND t.name = j.key WHERE \${gate}\`).bind(p.project_id, p.principal_id, now, p.id, String(p.display_name ?? "").slice(0, 120) || null, idsJson, p.id, id, ...gp));`);
add('publisher','generation commit: manifest version records the publishing app',
 `    q.push(env.DB.prepare(\`${PUB_COLS}
    SELECT ?, ?, ?, 1, ?, ?, ?, ?, 'application/json', ? WHERE \${gate}\`).bind(mRev, mArt, p.project_id, p.principal_id, manifestText, mSize, mSha, now, ...gp));`,
 `    q.push(env.DB.prepare(\`${PUB_COLS2}
    SELECT ?, ?, ?, 1, ?, ?, ?, ?, 'application/json', ?, 'publisher', ?, ? WHERE \${gate}\`).bind(mRev, mArt, p.project_id, p.principal_id, manifestText, mSize, mSha, now, p.id, String(p.display_name ?? "").slice(0, 120) || null, ...gp));`);
add('publisher','legacy publish: each file version records the publishing app',
 `      stmts.push(env.DB.prepare(\`${PUB_COLS}
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE \${gate} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND head_revision_id = ?)\`).bind(revId, artId, p.project_id, nextRev, p.principal_id, content, size, sha, live_MIME[kind], now, ...gp, artId, revId));`,
 `      stmts.push(env.DB.prepare(\`${PUB_COLS2}
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publisher', ?, ? WHERE \${gate} AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND head_revision_id = ?)\`).bind(revId, artId, p.project_id, nextRev, p.principal_id, content, size, sha, live_MIME[kind], now, p.id, String(p.display_name ?? "").slice(0, 120) || null, ...gp, artId, revId));`);

// ---------------------------------------------------------------- server instructions: ask for change notes
add('oauthMcp','OAuth MCP instructions: every change says why (change_note)',
 'Read before editing; saves need expected_revision and a fresh idempotency_key."',
 'Read before editing; saves need expected_revision and a fresh idempotency_key. Every change is kept as a version the owner reviews in History: whenever a tool has a change_note field, always set it to one line on why."');
add('mcp','legacy MCP instructions: every change says why (change_note)',
 'Agent Library: project-scoped Markdown and binary artifacts. Saves require expected_revision; mutations require idempotency_key."',
 'Agent Library: project-scoped Markdown and binary artifacts. Saves require expected_revision; mutations require idempotency_key. When saving, creating or restoring a document (tools with a change_note field), always set change_note to one line on why; the owner reads it in History."');

// ---------------------------------------------------------------- util: shared, dependency-free helpers
add('util','change note schema + MCP clientInfo reader',
 'function idemKey(v) {\n',
 read('src/history/util.js')+'function idemKey(v) {\n');

// ---------------------------------------------------------------- apply
const order=Object.entries(MOD).sort((a,b)=>a[1][0]-b[1][0]);
for(let i=1;i<order.length;i++)if(order[i][1][0]<order[i-1][1][1])throw Error('Overlapping modules '+order[i-1][0]+'/'+order[i][0]);
const mods=Object.fromEntries(Object.entries(MOD).map(([k,[a,b]])=>[k,input.slice(a,b)]));
const applied=[];
for(const [m,name,find,rep] of P){
 const s=mods[m];const i=once(s,find,`${m}: ${name}`);
 mods[m]=s.slice(0,i)+rep+s.slice(i+find.length);
 applied.push({module:m,name,find_sha256:sha(find)});
}
let out='',pos=0;
for(const [k,[a,b]] of order){out+=input.slice(pos,a)+mods[k];pos=b;}
out+=input.slice(pos);
// Preservation: undo every patch (reverse order, exact) and require the original bundle back.
const undo={...mods};
for(const [m,name,find,rep] of [...P].reverse()){const s=undo[m];const i=s.lastIndexOf(rep);if(i<0)throw Error('Cannot undo '+name);undo[m]=s.slice(0,i)+find+s.slice(i+rep.length);}
let back='';pos=0;for(const [k,[a,b]] of order){back+=input.slice(pos,a)+undo[k];pos=b;}back+=input.slice(pos);
if(back!==input)throw Error('Bytes outside the listed patches changed');
if(/`/.test(read('src/history/ui-history.js').replace(/\\`/g,'')))throw Error('ui-history.js must not contain unescaped backticks');
if(/`|\$\{/.test(read('src/history/ui-history.css')))throw Error('ui-history.css must not contain backticks or ${');
writeFileSync('src/index.js',out);
const meta={base_icon_fixes_sha256:BASE,integrated_sha256:sha(out),
 sources_sha256:Object.fromEntries(['service.js','oauth-tools.js','legacy-tools.js','v1-routes.js','ui-history.js','ui-history.css','util.js'].map(f=>[f,sha(read('src/history/'+f))])),
 migration:'0010_version_history.sql',patches:applied};
writeFileSync('history-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(`Applied ${applied.length} patches; ${sha(out)}`);
