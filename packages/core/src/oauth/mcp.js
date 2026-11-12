import { getBlob } from "../content-store.js";
import { insufficientScope } from "@cloudflare/workers-oauth-provider";
import { agentRate, limitsFor, rateLimit } from "../auth.js";
import { byteLength } from "../formats.js";
import { WEB_URL_OUTPUT_SCHEMAS, WEB_URL_TOOL_NOTE, appOrigin, artifactWebUrl, withWebUrls } from "../links.js";
import { addressLinks, projectPaths, resolveProjectRef } from "../paths.js";
import { SCOPES, liveConnection } from "./server.js";
import { __name } from "../runtime.js";
import { FILE_BYTES_CEILING } from "../limits.js";
import { BINARY_TYPES, IMAGE_TYPES, RS_SCHEMA, RT_ID_TOO_LONG, RT_KINDS_ALL, RT_KINDS_DOCS, appConnectEnabled, connectionInfo, createMarkdown, db, diffRevisions, getArtifact, history, listArtifacts, listChanges, loadArtifact, provenance, readRecords, readTextChunk, restoreMetadata, restoreRevision, rsToolReady, rtChunkLimit, rtFit, rtIdBytes, saveMarkdown, searchArtifacts, tplTools } from "../service.js";
import { TEXT_UPLOAD_KINDS, UPLOAD_BEGIN_DESCRIPTION, UPLOAD_FINISH_DESCRIPTION, serveContent, uploadBegin, uploadBeginFields, uploadFinish, uploadPut } from "../uploads.js";
import { CHANGE_NOTE_SCHEMA, HttpError, errorBody, idemKey, json, mcpClientInfo, nowIso, nowMs, randomId, rememberClientInfo, sha256Hex, str } from "../util.js";

function truncateUtf8(s, max) {
  if (byteLength(s) <= max) return { text: s, truncated: false };
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (byteLength(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(s[lo - 1])) lo--;
  return { text: s.slice(0, lo), truncated: true };
}
function toolsFor(env) {
  if (!appConnectEnabled(env)) return TOOLS;
  return [...TOOLS.map((t) => t.name === "list_artifacts" ? {
    ...t,
    description: "List documents and data files (Markdown, JSON, CSV) in a connected project; optional query filters by title. Paginated. To search document text, use search_artifacts if it is listed.",
    inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...AC_LIST_PROPS } }
  } : t), READ_RECORDS];
}
async function handleOAuthMcp(req, env, ctx) {
  let rtLim = null, rateBudget = 0;
  const reply = (body2, status = 200) => new Response(rtFit(body2, rtLim), { status, headers: HDR });
  const o = req.headers.get("origin");
  if (o && o !== new URL(req.url).origin && o !== "https://chatgpt.com") return reply(rpcErr(null, -32600, "Origin not allowed"), 403);
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (new URL(req.url).pathname !== "/mcp") return reply({ error: "not_found" }, 404);
  let conn;
  try {
    conn = await liveConnection(env, ctx.props?.connection_id);
  } catch {
    conn = null;
  }
  const invalid2 = /* @__PURE__ */ __name(() => new Response(JSON.stringify(rpcErr(null, -32001, "Connection revoked or expired")), {
    status: 401,
    headers: { ...HDR, "www-authenticate": `Bearer error="invalid_token", error_description="connection revoked or expired", resource_metadata="${new URL(req.url).origin}/.well-known/oauth-protected-resource/mcp"` }
  }), "invalid");
  if (!conn || conn.client_id !== ctx.auth.clientId || conn.resource !== ctx.auth.audience) return invalid2();
  const tokenScopes = new Set(ctx.auth.scope);
  const canRead = tokenScopes.has(SCOPES.read) && conn.can_read === 1;
  const tokenWrite = canRead && tokenScopes.has(SCOPES.write) && conn.can_write === 1;
  const projectWrite = (p) => tokenWrite && p.can_write === 1;
  const anyWrite = conn.projects.some(projectWrite);
  if (!canRead) return insufficientScope(ctx.auth, [SCOPES.read]);
  const len = Number(req.headers.get("content-length") ?? "0");
  const bodyMax = ftMcpBodyMax(conn);
  if (len > bodyMax) return reply(rpcErr(null, -32600, ftTooLarge(conn)), 413);
  const text = await ftReadCapped(req, bodyMax);
  if (text === null) return reply(rpcErr(null, -32600, ftTooLarge(conn)), 413);
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return reply(rpcErr(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(msg) || msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return reply(rpcErr(msg?.id, -32600, "Invalid request"), 400);
  if (msg.id === void 0) return new Response(null, { status: 202 });
  rtLim = rtChunkLimit(msg);
  if (rtLim?.idTooLong) return reply(RT_ID_TOO_LONG, 400);
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !SUPPORTED.includes(pv)) return reply(rpcErr(null, -32600, "Unsupported protocol version"), 400);
  const searchReady = await rsToolReady(env,msg);
  const tool = msg.method === "tools/call" ? ftToolsFor(env, conn).filter(t => t.name !== "search_artifacts" || searchReady).find((t) => t.name === msg.params?.name) : void 0;
  if (tool?.write && !tokenScopes.has(SCOPES.write)) return insufficientScope(ctx.auth, [SCOPES.read, SCOPES.write]);
  try {
    rateBudget = await agentRate(env, conn.workspace_id ?? `wsp_${conn.owner_principal_id}`, !!tool?.write);
    await rateLimit(env, `${tool?.write ? "w" : "r"}:oauth:${conn.id}`, rateBudget);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 429) throw e;
    return ftRateLimited(msg, tool, !!tool?.write, e, rtLim, rateBudget);
  }
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      await rememberClientInfo(env, "oauth_connections", conn.id, msg.params);
      return reply(rpc(msg.id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-library", title: "Agent Library", version: "0.3.0" },
        instructions: conn.file_access === 1 ? FT_INSTRUCTIONS : "Agent Library: Markdown documents in owner-approved projects. Call list_projects first; pass project_id when more than one project is connected. Read before editing; saves need expected_revision and a fresh idempotency_key. Every change is kept as a version the owner reviews in History: whenever a tool has a change_note field, always set it to one line on why."
      }));
    }
    case "ping":
      return reply(rpc(msg.id, {}));
    case "tools/list":
      return reply(rpc(msg.id, { tools: ftToolsFor(env, conn).filter((t) => (t.name !== "search_artifacts" || searchReady) && (anyWrite || !t.write)).map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description: WEB_URL_OUTPUT_SCHEMAS[name] ? description + WEB_URL_TOOL_NOTE : description,
        inputSchema,
        annotations,
        ...WEB_URL_OUTPUT_SCHEMAS[name] ? { outputSchema: WEB_URL_OUTPUT_SCHEMAS[name] } : {}
      })) }));
    case "tools/call": {
      if (!tool) return reply(rpcErr(msg.id, -32602, "Unknown tool"));
      const args = msg.params?.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return reply(rpcErr(msg.id, -32602, "arguments must be an object"));
      const allowed = new Set(Object.keys(tool.inputSchema.properties));
      for (const k of Object.keys(args)) if (!allowed.has(k)) return reply(rpcErr(msg.id, -32602, `Unknown argument ${k}`));
      if (tool.name === "connection_info") {
        const result = connectionInfo("oauth", conn.id, conn.client_name, conn.projects.map((p) => ({ ...p, can_write: projectWrite(p) })), conn.expires_at, conn.last_used_at, { files: conn.file_access === 1 });
        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      }
      // A project may be named by its address (<handle>/<slug>) as well as its id.
      if (typeof args.project_id === "string" && args.project_id.includes("/")) args.project_id = await resolveProjectRef(env, args.project_id);
      if (Array.isArray(args.project_ids) && args.project_ids.length <= 20) args.project_ids = await Promise.all(args.project_ids.map((x) => resolveProjectRef(env, x)));
      const connIds = conn.projects.map((p) => p.id);
      if (tool.name === "list_projects") {
        const paths = await projectPaths(env, conn.projects.map((p) => p.id));
        const result = await addressLinks(env, withWebUrls("list_projects", args, void 0, { projects: conn.projects.map((p) => ({ id: p.id, title: p.title, ...paths.has(p.id) ? { path: paths.get(p.id) } : {}, can_write: projectWrite(p) })) }, appOrigin(env.APP_HOST)), connIds);
        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      }
      if (tool.name === "search_artifacts") {
        try {
          const result = await searchArtifacts({ env, requestId: randomId("req",9), principal: { id: conn.owner_principal_id, kind: "agent" }, grant: { id: conn.id }, oauthConnection: true, ftConn: conn, rpcIdBytes: rtIdBytes(msg.id) }, args, "mcp");
          return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
        } catch(e) {
          if (!(e instanceof HttpError)) throw e;
          return reply(rpc(msg.id, toolError({ status: e.status, code: e.code, message: e.message })));
        }
      }
      if (tool.name === "list_changes" && !args.project_id) return reply(rpc(msg.id, toolError({ status: 400, code: "project_required", message: "Pass one explicit project_id" })));
      let proj = conn.projects.length === 1 && args.project_id === void 0 ? conn.projects[0] : void 0;
      if (args.project_id !== void 0) proj = conn.projects.find((p) => p.id === args.project_id);
      if (!proj) {
        const choices = conn.projects.map((p) => ({ id: p.id, title: p.title }));
        const err2 = args.project_id === void 0 ? { status: 400, code: "project_required", message: `This connection has ${choices.length} projects; pass project_id (one of: ${choices.map((c) => c.id).join(", ")}). If your tool schema has no project_id argument, refresh this app's tools in the client.`, projects: choices } : { status: 404, code: "not_found", message: "Project not found in this connection", projects: choices };
        return reply(rpc(msg.id, toolError(err2)));
      }
      const canWrite = projectWrite(proj);
      if (tool.write && !canWrite && proj.read_only) return reply(rpc(msg.id, toolError({ status: 403, code: "workspace_read_only", message: "This workspace is suspended and read-only. Reading still works." })));
      if (tool.write && !canWrite) return reply(rpc(msg.id, toolError({ status: 403, code: "forbidden", message: "This connection is read-only for this project" })));
      const { project_id: _omit, ...toolArgs } = args;
      const sctx = {
        env,
        requestId: randomId("req", 9),
        principal: { id: conn.owner_principal_id, kind: "agent", label: `oauth:${conn.client_name}` },
        grant: { id: conn.id, project_id: proj.id, can_write: canWrite ? 1 : 0 },
        oauthConnection: true,
        ftConn: conn,
        ftOrigin: new URL(req.url).origin,
        via: { kind: "oauth", id: conn.id, label: conn.client_name },
        clientInfo: mcpClientInfo(msg.params, conn.client_info),
        rpcIdBytes: rtIdBytes(msg.id)
      };
      try {
        const result = await addressLinks(env, withWebUrls(tool.name, toolArgs, proj.id, await tool.run(sctx, proj.id, toolArgs), appOrigin(env.APP_HOST)), connIds);
        await env.DB.prepare("UPDATE oauth_connections SET last_used_at = ? WHERE id = ?").bind(nowMs(), conn.id).run().catch(() => {
        });
        return reply(rpc(msg.id, { content: ftContent(result, pv), structuredContent: result, isError: false }));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (e.status === 401) return invalid2();
        return reply(rpc(msg.id, toolError({ status: e.status, code: e.code, message: e.message, ...e.extra ?? {} })));
      }
    }
    default:
      return reply(rpcErr(msg.id, -32601, "Method not found"));
  }
}
var MCP_TEXT_MAX, SUPPORTED, S, A, P, K, NOTE, RT_CURSOR, RT_MAXB, unwrap, RO, RW, TOOLS, AC_LIST_PROPS, READ_RECORDS, rpc, rpcErr, HDR, toolError;
MCP_TEXT_MAX = 64 * 1024;
SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26"];
S = (props, required) => ({ type: "object", properties: props, required, additionalProperties: false });
A = { type: "string", description: "Artifact ID" };
P = { type: "string", maxLength: 110, description: "Project ID or path (workspace/project, as shown in list_projects). Optional when the connection has exactly one project." };
K = { type: "string", description: "Unique key for this change (8-128 chars, e.g. a UUID). Reuse it only when retrying the same change." };
unwrap = (r) => r && typeof r.status === "number" && "body" in r ? r.body : r;
RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
NOTE = CHANGE_NOTE_SCHEMA;
RT_CURSOR = { type: "string", maxLength: 512, description: "next_cursor from the previous chunk" };
RT_MAXB = { type: "integer", minimum: 4096, maximum: 524288, description: "Upper bound in bytes for this whole tool result as encoded (default 65536)" };
RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
TOOLS = [
  { name: "connection_info", title: "Check connection access", description: "Identify this authenticated connection and its current effective project access. No document reads or writes. Compare the safe ID in Connections.", inputSchema: S({}, []), annotations: RO, write: false },
  ...tplTools(true),
  { name: "list_changes", title: "List project changes", description: "Poll published changes in one explicit project. WITHOUT cursor establishes a current checkpoint and returns NO history (initialized=true). Store next_cursor; follow has_more, then poll again. At-least-once: deduplicate by event_id. Cursors expire after 30 days; checkpoint BEFORE reconciling current content. Publishers excluded. No bodies or push notifications.", inputSchema: S({ project_id: { type: "string", maxLength: 110, description: "Project ID or path (workspace/project)" }, cursor: { type: "string", maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["project_id"]), annotations: RO, write: false, run: (c,p,a) => listChanges(c,p,a) },
  { name: "search_artifacts", title: "Search library", description: "Ranked lexical search across currently readable projects. All words must match stored title/text; punctuation separates words. Returns bounded plain-text excerpts and revision-pinned links. Live pagination expires after 15 minutes.", inputSchema: RS_SCHEMA, annotations: RO, write: false, run: (c, p, a) => searchArtifacts(c,a,"mcp") },
  {
    name: "list_projects",
    title: "List projects",
    description: "List the projects this connection can access, with whether each allows editing.",
    inputSchema: S({}, []),
    annotations: RO,
    write: false,
    run: async () => {
      throw new Error("handled inline");
    }
  },
  {
    name: "list_artifacts",
    title: "List documents",
    description: "List documents (Markdown and HTML) in a connected project; optional query filters by title. Paginated. To search document text, use search_artifacts if it is listed.",
    inputSchema: S({ project_id: P, query: { type: "string", maxLength: 200 }, cursor: { type: "string", maxLength: 12 } }, []),
    annotations: RO,
    write: false,
    run: async (c, p, a) => {
      if (appConnectEnabled(c.env)) {
        const r2 = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: a.folder_id });
        return { ...r2, artifacts: r2.artifacts.filter((x) => x.kind !== "binary") };
      }
      if (a.kind !== void 0 || a.folder_id !== void 0) throw new HttpError(400, "invalid_input", "kind/folder_id filters are not available");
      const r = await listArtifacts(c, p, { query: a.query, cursor: a.cursor });
      return { ...r, artifacts: r.artifacts.filter((x) => x.kind === "markdown" || x.kind === "html") };
    }
  },
  {
    name: "read_artifact",
    title: "Read document",
    description: "Read a Markdown or HTML document (current or a given revision). Returns body (source text), kind, revision and sha256. For long documents pass max_bytes (4096-524288) to get one bounded chunk, then pass next_cursor until eof: every chunk comes from the same version (revision + sha256), so concurrent edits never mix in; a revision_changed error means start again. Chunks return text, offset, content_bytes, eof and next_cursor.",
    inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 }, cursor: RT_CURSOR, max_bytes: RT_MAXB }, ["artifact_id"]),
    annotations: RO,
    write: false,
    run: async (c, p, a) => {
      if (a.cursor != null || a.max_bytes != null) return readTextChunk(c, p, a.artifact_id, { revision: a.revision, cursor: a.cursor, maxBytes: a.max_bytes, encoding: "mcp", kinds: appConnectEnabled(c.env) ? RT_KINDS_ALL : RT_KINDS_DOCS });
      const r = await getArtifact(c, p, a.artifact_id, a.revision);
      if ((r.artifact.kind === "json" || r.artifact.kind === "csv") && appConnectEnabled(c.env)) {
        const { content_url: _u, content, ...rest } = r;
        const t = truncateUtf8(content ?? "", MCP_TEXT_MAX);
        return {
          ...rest,
          content: t.text,
          truncated: t.truncated,
          ...r.artifact.schema && r.artifact.kind === "json" ? { records_hint: "Use read_records for filtered, paginated records." } : {}
        };
      }
      if (r.artifact.kind !== "markdown" && r.artifact.kind !== "html") throw new HttpError(415, "unsupported_kind", "Only Markdown and HTML documents are available to this connection");
      return r;
    }
  },
  {
    name: "artifact_history",
    title: "Document history",
    description: "List a document's immutable versions, newest first (50 per page; pass next_cursor for older ones). Each version says who made it (via: the connection, API key or app; client_info and change_note are self-reported) and why. Title/folder/tag changes are listed under meta_versions.",
    inputSchema: S({ project_id: P, artifact_id: A, cursor: { type: "string", maxLength: 12 } }, ["artifact_id"]),
    annotations: RO,
    write: false,
    run: (c, p, a) => history(c, p, a.artifact_id, { cursor: a.cursor })
  },
  {
    name: "diff_revisions",
    title: "Compare versions",
    description: "Compare two versions (default: current against previous). Text diffs return unified hunks and added/removed counts when bounded; non-identical inputs over 1 MiB or 20,000 lines return no hunks and null counts. Identical hashes still report identical.",
    inputSchema: S({ project_id: P, artifact_id: A, from: { type: "integer", minimum: 1 }, to: { type: "integer", minimum: 1 } }, ["artifact_id"]),
    annotations: RO,
    write: false,
    run: (c, p, a) => diffRevisions(c, p, a.artifact_id, a.from, a.to)
  },
  {
    name: "restore_revision",
    title: "Restore a version",
    description: "Restore an earlier version of a document's content. Creates a new version with that content; nothing is deleted, so a restore can itself be undone. expected_revision must be the current revision; on revision_conflict re-read first. Use artifact_history and diff_revisions to pick the version. Set change_note to why.",
    inputSchema: S({ project_id: P, artifact_id: A, expected_revision: { type: "integer", minimum: 1 }, from_revision: { type: "integer", minimum: 1 }, change_note: NOTE, idempotency_key: K }, ["artifact_id", "expected_revision", "from_revision", "idempotency_key"]),
    annotations: RW,
    write: true,
    run: async (c, p, a) => unwrap(await restoreRevision(c, p, a.artifact_id, { expected_revision: a.expected_revision, from_revision: a.from_revision, change_note: a.change_note }, idemKey(a.idempotency_key)))
  },
  {
    name: "restore_metadata",
    title: "Restore title and tags",
    description: "Restore an earlier title, folder and tags of a document (listed under meta_versions in artifact_history). Creates a new metadata version; nothing is deleted. expected_meta_version must be the document's current meta_version. Set change_note to why.",
    inputSchema: S({ project_id: P, artifact_id: A, expected_meta_version: { type: "integer", minimum: 1 }, from_version: { type: "integer", minimum: 1 }, change_note: NOTE, idempotency_key: K }, ["artifact_id", "expected_meta_version", "from_version", "idempotency_key"]),
    annotations: RW,
    write: true,
    run: async (c, p, a) => unwrap(await restoreMetadata(c, p, a.artifact_id, { expected_meta_version: a.expected_meta_version, from_version: a.from_version, change_note: a.change_note }, idemKey(a.idempotency_key)))
  },

  {
    name: "create_markdown",
    title: "Create document",
    description: 'Create a new document in a connected project that allows editing. Markdown by default; set format "html" for an HTML page (static HTML/CSS: scripts and external resources are removed when shown; embed same-project images/videos with src="art_\u2026"). For large text, use upload_begin \u2192 HTTP PUT \u2192 upload_finish when available.',
    inputSchema: S({ project_id: P, title: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string" }, format: { type: "string", enum: ["markdown", "html"], description: "Document format (default markdown)" }, change_note: NOTE, idempotency_key: K }, ["title", "idempotency_key"]),
    annotations: RW,
    write: true,
    run: async (c, p, a) => unwrap(await createMarkdown(c, p, { title: a.title, body: a.body ?? "", change_note: a.change_note }, idemKey(a.idempotency_key), a.format === "html" ? "html" : "markdown"))
  },
  {
    name: "save_markdown",
    title: "Edit document",
    description: "Save a new revision of a Markdown or HTML document (the format is kept). expected_revision must be the revision you read; on revision_conflict re-read and merge. Every save is kept as an immutable version the owner can compare and restore. Always set change_note to one line on why you made the change; the owner reads it in History. For large Markdown or HTML that will not fit a tool request, use upload_begin \u2192 HTTP PUT raw UTF-8 \u2192 upload_finish, if those tools are available and you can make HTTP requests.",
    inputSchema: S({ project_id: P, artifact_id: A, expected_revision: { type: "integer", minimum: 1 }, body: { type: "string" }, change_note: NOTE, idempotency_key: K }, ["artifact_id", "expected_revision", "body", "idempotency_key"]),
    annotations: RW,
    write: true,
    run: async (c, p, a) => {
      const cur = await getArtifact(c, p, a.artifact_id);
      if (cur.artifact.kind !== "markdown" && cur.artifact.kind !== "html") throw new HttpError(415, "unsupported_kind", "Only Markdown and HTML documents can be edited");
      return unwrap(await saveMarkdown(c, p, a.artifact_id, { expected_revision: a.expected_revision, body: a.body, change_note: a.change_note }, idemKey(a.idempotency_key)));
    }
  }
];
AC_LIST_PROPS = {
  kind: { type: "string", enum: ["markdown", "json", "csv"], description: "Only files of this kind" },
  folder_id: { type: "string", maxLength: 64, description: 'Only files in this folder (fld_\u2026), or "root"' }
};
READ_RECORDS = {
  name: "read_records",
  title: "Read measurement records",
  description: "Read records from a JSON file with schema agentlib.measurements/1 (current revision, source order). recorded_at is the source's original timestamp, returned verbatim; date is present only when the source provided it. from/to (YYYY-MM-DD, inclusive) match only that source date; records without one are excluded from ranged queries and counted in undated_excluded.",
  inputSchema: S({
    project_id: P,
    artifact_id: A,
    from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    metric: { type: "string", maxLength: 40 },
    limit: { type: "integer", minimum: 1, maximum: 500 },
    cursor: { type: "string", maxLength: 12 }
  }, ["artifact_id"]),
  annotations: RO,
  write: false,
  run: (c, p, a) => readRecords(c, p, a.artifact_id, { from: a.from, to: a.to, metric: a.metric, limit: a.limit, cursor: a.cursor })
};
rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
HDR = { "content-type": "application/json", "cache-control": "no-store" };
toolError = (err2) => ({ content: [{ type: "text", text: JSON.stringify({ error: err2 }) }], structuredContent: { error: err2 }, isError: true });

// Files for OAuth (MCP) connections: list, read (inline image + short-lived download link) and upload new files or
// versions (begin -> HTTP PUT to a single-upload link -> finish). See docs/agent-setup.md#files-and-large-text-uploads. Needs migration
// 0013_oauth_file_access.sql.
//  - Only connections approved on a consent page that offered files (oauth_connections.file_access = 1) get these
//    tools. Older connections keep exactly what they were shown (documents and history) until the owner reconnects.
//  - Uploads reuse uploadBegin/uploadPut/uploadFinish (quota, BINARY_TYPES, file_bytes limit, finalize lease).
//    They run as a per-connection agent principal, so "one active upload per identity" applies per connection and
//    an agent's upload never blocks the owner's own uploads. Authorship in History is the connection (via oauth).
//  - Transfer links are capabilities for one revision (download) or one upload (PUT). Only their SHA-256 is stored.
//    Every request re-checks the live connection, the project and (for PUT) edit permission, so revoking a
//    connection stops links minted before the revoke. Never log or print link URLs.
var FT_DOWNLOAD_TTL_MS = 10 * 60 * 1e3;
var FT_INLINE_IMAGE_BYTES = 1024 * 1024;
// upload_file: bytes inline as base64 in the tool call, for agents that cannot make HTTP requests (owner-approved
// 2026-10-27). Same upload machinery as begin/PUT/finish. MCP request bodies of connections with files may be up to
// FT_MCP_BODY_MAX so a full-size inline upload fits (base64 is 4/3 the size, plus JSON).
var FT_INLINE_UPLOAD_BYTES = 2 * 1024 * 1024;
var FT_INLINE_B64_MAX = Math.ceil(FT_INLINE_UPLOAD_BYTES / 3) * 4;
var FT_MCP_BODY_MAX = 3 * 1024 * 1024;
// Over-cap advice names upload tools only to connections that have them (file access).
function ftTooLarge(conn) {
  return conn?.file_access === 1
    ? "Payload too large. For document content, use upload_begin, HTTP PUT raw UTF-8 bytes to put_url, then upload_finish (text up to 10 MiB). This requires an HTTP-capable client; otherwise send a smaller document."
    : "Payload too large. This connection has no upload tools. Send a smaller document, or ask the owner to reconnect with file access and use upload_begin \u2192 HTTP PUT \u2192 upload_finish from an HTTP-capable client.";
}
function ftMcpBodyMax(conn) {
  return conn?.file_access === 1 ? FT_MCP_BODY_MAX : 1024 * 1024;
}
// Reads at most max bytes of a request body (counted while streaming, so a body without Content-Length cannot make
// the Worker buffer more); null when it is larger.
async function ftReadCapped(req, max) {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let n = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {
      });
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
// Rate limits answered as a tool result the model can read (limit, budget, seconds to wait), not a bare HTTP 429.
function ftRateLimited(msg, tool, write, e, lim, limit) {
  const wait = Math.max(1, Math.min(60, Number(e?.extra?.retry_after_seconds) || 60));
  const what = write ? "changes (create, save, upload, restore)" : "reads";
  const err2 = { status: 429, code: "rate_limited", message: `Rate limit: this connection allows ${limit} ${what} per minute. Wait ${wait} seconds, then retry the same call (reuse its idempotency_key).`, retry_after_seconds: wait, limit_per_minute: limit, budget: write ? "write" : "read" };
  if (msg.method === "tools/call" && tool) return new Response(rtFit(rpc(msg.id, toolError(err2)), lim), { status: 200, headers: { ...HDR, "retry-after": String(wait) } });
  return new Response(rtFit(rpcErr(msg.id, -32002, err2.message), lim), { status: 429, headers: { ...HDR, "retry-after": String(wait) } });
}
var FT_LINK = /^\/files\/([du])\/(ft_[A-Za-z0-9_-]{40,60})$/;
function ftUploadPrincipal(conn) {
  return { id: "oap_" + conn.id.slice(4), kind: "agent", label: `oauth:${conn.client_name}`.slice(0, 200) };
}
async function ftUploadCtx(c, create) {
  const principal = ftUploadPrincipal(c.ftConn);
  if (create) await c.env.DB.prepare("INSERT OR IGNORE INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'agent', 'agent-library-oauth', ?, ?, ?)").bind(principal.id, c.ftConn.id, principal.label, nowIso()).run();
  return { ...c, principal };
}
async function ftMint(c, kind, projectId, artifactId, revNo, uploadId, expiresAt) {
  const token = randomId("ft", 32);
  await c.env.DB.prepare("INSERT INTO transfer_links (token_hash, kind, connection_id, project_id, artifact_id, rev_no, upload_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(await sha256Hex(token), kind, c.ftConn.id, projectId, artifactId, revNo, uploadId, expiresAt, nowIso()).run();
  return `${c.ftOrigin}/files/${kind === "download" ? "d" : "u"}/${token}`;
}
function ftBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
function ftWebUrl(c, projectId, artifactId) {
  const o = appOrigin(c.env.APP_HOST);
  return o ? { web_url: artifactWebUrl(o, projectId, artifactId) } : {};
}
// Extra MCP content blocks (image, resource_link) ride on a symbol key: never part of structuredContent or its text.
var FT_BLOCKS = Symbol("ftBlocks");
function ftContent(result, protocolVersion) {
  // resource_link exists from MCP 2025-06-18. A missing MCP-Protocol-Version header means 2025-03-26 (spec), so those
  // clients get the image only; download_url is always in the text.
  const v = protocolVersion || "2025-03-26";
  const blocks = (result?.[FT_BLOCKS] ?? []).filter((b) => b.type !== "resource_link" || v !== "2025-03-26");
  return [{ type: "text", text: JSON.stringify(result) }, ...blocks];
}
async function ftReadFile(c, p, a) {
  const r = await getArtifact(c, p, a.artifact_id, a.revision);
  if (r.artifact.kind !== "binary") throw new HttpError(415, "unsupported_kind", "Not a file; use read_artifact for documents");
  const rev = r.revision;
  const expires = nowMs() + FT_DOWNLOAD_TTL_MS;
  const url = await ftMint(c, "download", p, a.artifact_id, rev.rev, null, expires);
  const canInline = IMAGE_TYPES.includes(rev.mime) && rev.size <= FT_INLINE_IMAGE_BYTES;
  const wantInline = canInline && a.include_image !== false;
  const blocks = [];
  if (wantInline) {
    const row = await db(c).prepare("SELECT blob_key FROM revisions WHERE id = ? AND project_id = ?").bind(rev.id, p).first();
    const obj2 = row?.blob_key ? await getBlob(c.env, row.blob_key) : null;
    if (!obj2) throw new HttpError(500, "blob_missing", "Stored bytes missing");
    blocks.push({ type: "image", data: ftBase64(new Uint8Array(await obj2.arrayBuffer())), mimeType: rev.mime });
  }
  blocks.push({ type: "resource_link", uri: url, name: r.artifact.title, mimeType: rev.mime, size: rev.size, description: "Short-lived download link for this version (expires in minutes; not a share link)" });
  const result = {
    artifact: { ...r.artifact, ...ftWebUrl(c, p, a.artifact_id) },
    revision: rev,
    image_inline: wantInline,
    ...!wantInline && IMAGE_TYPES.includes(rev.mime) ? { image_note: canInline ? "include_image was false" : `Image is over ${FT_INLINE_IMAGE_BYTES} bytes; fetch download_url` } : {},
    download_url: url,
    download_expires_at: new Date(expires).toISOString(),
    web_url_opens: "current_document"
  };
  Object.defineProperty(result, FT_BLOCKS, { value: blocks, enumerable: true });
  return result;
}
async function ftUploadBegin(c, p, a, opts = {}) {
  const note = provenance(c, a)[4];
  if (!note) throw new HttpError(400, "change_note_required", "change_note is required: one line on why you are adding or changing this file");
  const isNew = a.artifact_id === void 0;
  // upload_file (binaryOnly) never reads mime here: its getter checks it later, preserving its error precedence.
  const textKind = !opts.binaryOnly && typeof a.mime === "string" && Object.hasOwn(TEXT_UPLOAD_KINDS, a.mime) ? TEXT_UPLOAD_KINDS[a.mime] : null;
  if (isNew ? a.title === void 0 || a.expected_revision !== void 0 : a.title !== void 0 || a.expected_revision === void 0)
    throw new HttpError(400, "invalid_input", textKind ? "Pass title and optional create metadata for a new document, or artifact_id and expected_revision for a new version" : "Pass title for a new file, or artifact_id and expected_revision for a new version");
  const uc = await ftUploadCtx(c, true);
  const key = idemKey(a.idempotency_key);
  if (!isNew) {
    const cur = await loadArtifact(c, p, str(a.artifact_id, "artifact_id", 64));
    // Text versions go to documents of the same kind (checked by uploadBegin); everything else to files only.
    if (!textKind && cur.kind !== "binary") throw new HttpError(415, "unsupported_kind", "Not a file; use save_markdown for documents");
    // Fail early on a stale revision, except when retrying a begin that already succeeded (it replays below).
    const retry = await db(c).prepare("SELECT 1 AS x FROM idempotency WHERE principal_id = ? AND project_id = ? AND op = 'upload.begin' AND key = ?").bind(uc.principal.id, p, key).first("x");
    if (!retry && cur.head_rev !== a.expected_revision) throw new HttpError(409, "revision_conflict", "Expected revision is stale", { current_revision: cur.head_rev, expected_revision: a.expected_revision });
  }
  const r = unwrap(await uploadBegin(uc, p, textKind
    ? { title: a.title, folder: a.folder, folder_id: a.folder_id, schema: a.schema, artifact_id: a.artifact_id, expected_revision: a.expected_revision, mime: a.mime, size: a.size, sha256: a.sha256, change_note: a.change_note }
    : { title: a.title, folder: a.folder, artifact_id: a.artifact_id, expected_revision: a.expected_revision, mime: a.mime, size: a.size, sha256: a.sha256 }, key, { allowText: !opts.binaryOnly }));
  const u = await db(c).prepare("SELECT state, expires_at FROM uploads WHERE id = ? AND principal_id = ?").bind(r.upload_id, uc.principal.id).first();
  if (!u) throw new HttpError(404, "not_found", "Upload not found");
  const open = u.state === "pending" && u.expires_at > nowMs();
  if (open) await db(c).prepare("UPDATE uploads SET change_note = ? WHERE id = ? AND state = 'pending' AND change_note IS NULL").bind(note, r.upload_id).run();
  const { put_url: _apiPath, instructions: _i, ...rest } = r;
  return {
    ...rest,
    state: u.state,
    ...open && opts.link === false ? {} : open ? {
      put_url: await ftMint(c, "upload", p, r.artifact_id, null, r.upload_id, u.expires_at),
      method: "PUT",
      // Binary answers keep their earlier wording byte for byte.
      instructions: textKind ? "HTTP PUT exactly size raw bytes to put_url; no Authorization header is needed. Text must be UTF-8. Then call upload_finish with upload_id. This link is only for this upload and expires at expires_at." : "HTTP PUT the raw file bytes (exactly size bytes) to put_url; no Authorization header is needed. Then call upload_finish with upload_id. put_url works for this one upload only and expires at expires_at."
    } : { instructions: "This upload is no longer accepting bytes; call upload_finish with upload_id to get its outcome." }
  };
}
async function ftUploadFinish(c, p, a) {
  const uc = await ftUploadCtx(c, false);
  const r = unwrap(await uploadFinish(uc, p, str(a.upload_id, "upload_id", 64), idemKey(a.idempotency_key)));
  await db(c).prepare("DELETE FROM transfer_links WHERE upload_id = ?").bind(a.upload_id).run().catch(() => {
  });
  return { ...r, ...r.artifact_id ? ftWebUrl(c, p, r.artifact_id) : {} };
}
function ftDecodeBase64(v) {
  const s = str(v, "content_base64", FT_INLINE_B64_MAX + 4096).replace(/\s+/g, "");
  const tooBig = () => new HttpError(413, "too_large", `upload_file takes up to ${FT_INLINE_UPLOAD_BYTES} bytes; use upload_begin + HTTP PUT for larger files (up to this plan's file size limit)`);
  if (s.length > FT_INLINE_B64_MAX + 4) throw tooBig();
  if (!s || s.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new HttpError(400, "invalid_input", "content_base64 must be non-empty standard base64");
  let out2;
  try {
    if (typeof Uint8Array.fromBase64 === "function") out2 = Uint8Array.fromBase64(s);
    else {
      const bin = atob(s);
      out2 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out2[i] = bin.charCodeAt(i);
    }
  } catch {
    throw new HttpError(400, "invalid_input", "content_base64 must be standard base64");
  }
  if (out2.length > FT_INLINE_UPLOAD_BYTES) throw tooBig();
  return out2;
}
// One call: begin (idempotent), the same PUT handler with the decoded bytes, then finish (idempotent). A retry with
// the same idempotency_key resumes wherever the first attempt stopped and never publishes twice.
async function ftUploadInline(c, p, a) {
  const bytes = ftDecodeBase64(a.content_base64);
  const { content_base64: _b, ...rest } = a;
  const begun = await ftUploadBegin(c, p, {
    ...rest, size: bytes.length, sha256: await sha256Hex(bytes),
    // Evaluate at ftUploadBegin's shared-begin call, after its note/target/access checks, preserving error precedence.
    get mime() {
      const mime = str(rest.mime, "mime", 100);
      if (!Object.hasOwn(BINARY_TYPES, mime)) throw new HttpError(415, "unsupported_type", "Allowed: " + Object.keys(BINARY_TYPES).join(", "));
      return mime;
    }
  }, { link: false, binaryOnly: true });
  if (begun.state === "pending") {
    const uc = await ftUploadCtx(c, false);
    await uploadPut(new Request("https://upload.invalid/inline", { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length) } }), c.env, c.requestId, begun.upload_id, uc);
  }
  return ftUploadFinish(c, p, { upload_id: begun.upload_id, idempotency_key: a.idempotency_key });
}
async function ftList(c, p, a) {
  const prefix = a.mime_prefix === void 0 ? "" : str(a.mime_prefix, "mime_prefix", 100).toLowerCase();
  const r = await listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: appConnectEnabled(c.env) ? a.folder_id : void 0 });
  const ids = r.artifacts.map((x) => x.id);
  const info = /* @__PURE__ */ new Map();
  if (ids.length) {
    const rows = await db(c).prepare(`SELECT a.id, r.mime, r.size FROM artifacts a JOIN revisions r ON r.artifact_id = a.id AND r.project_id = a.project_id AND r.rev_no = a.head_rev
      WHERE a.project_id = ? AND a.id IN (${ids.map(() => "?").join(",")})`).bind(p, ...ids).all();
    for (const x of rows.results) info.set(x.id, x);
  }
  // JSON/CSV data files are App Connect features; without it they stay hidden from connections, as before.
  const shown = appConnectEnabled(c.env) ? r.artifacts : r.artifacts.filter((x) => x.kind !== "json" && x.kind !== "csv");
  const artifacts = shown.map((x) => ({ ...x, mime: info.get(x.id)?.mime ?? null, size: info.get(x.id)?.size ?? null })).filter((x) => !prefix || (x.mime ?? "").startsWith(prefix));
  return { ...r, artifacts };
}
// upload_begin: text documents (Markdown and HTML; JSON and CSV with App Connect) or binary files.
var ftUploadBeginCache = /* @__PURE__ */ new Map();
function ftUploadBeginTool(appConnect) {
  let t = ftUploadBeginCache.get(appConnect);
  if (t) return t;
  const f = uploadBeginFields(appConnect);
  t = {
    name: "upload_begin",
    title: "Start upload",
    description: UPLOAD_BEGIN_DESCRIPTION + ` The returned upload link needs no Authorization header. Binary-only upload_file is available up to ${FT_INLINE_UPLOAD_BYTES / 1048576} MiB if HTTP PUT is unavailable.`,
    inputSchema: S({
      project_id: P,
      title: { type: "string", minLength: 1, maxLength: 200, description: f.title },
      folder: { type: "string", maxLength: 200, description: f.folder },
      ...f.appConnect,
      artifact_id: { ...A, description: f.artifact_id },
      expected_revision: { type: "integer", minimum: 1, description: "Current revision of artifact_id" },
      mime: { ...f.mime, enum: f.mimeTypes },
      size: f.size,
      sha256: { type: "string", pattern: "^[0-9a-f]{64}$", description: "SHA-256 of the bytes, lowercase hex" },
      change_note: NOTE,
      idempotency_key: K
    }, ["mime", "size", "sha256", "change_note", "idempotency_key"]),
    annotations: RW,
    write: true,
    run: (c, p, a) => ftUploadBegin(c, p, a)
  };
  ftUploadBeginCache.set(appConnect, t);
  return t;
}
// Tool definitions are built lazily: S, P, A, K, NOTE, RO and RW are set when the OAuth MCP module initialises.
var ftDefs = null;
// Documents-only connections (approved before files were offered): every tool that names an artifact refuses files,
// as if they were not there (history, diff, restores included), so they get exactly what their consent page said.
var ftDocsOnlyCache = /* @__PURE__ */ new WeakMap();
function ftDocsOnly(base) {
  let out2 = ftDocsOnlyCache.get(base);
  if (out2) return out2;
  out2 = base.map((t) => !t.inputSchema.properties.artifact_id ? t : { ...t, run: async (c, p, a) => {
    const k = await db(c).prepare("SELECT kind FROM artifacts WHERE id = ? AND project_id = ?").bind(String(a.artifact_id ?? ""), p).first("kind");
    if (k === "binary") throw new HttpError(404, "not_found", "Artifact not found");
    return t.run(c, p, a);
  } });
  ftDocsOnlyCache.set(base, out2);
  return out2;
}
function ftToolsFor(env, conn) {
  const base = toolsFor(env);
  if (!conn || conn.file_access !== 1) return ftDocsOnly(base);
  ftDefs ??= {
    read_file: {
      name: "read_file",
      title: "Read file",
      description: `Read a file (image, PDF, video or other upload), current or a given revision. Returns metadata (mime, size, sha256, revision), a download_url and a resource_link. Images (PNG, JPEG, WebP, GIF) up to ${FT_INLINE_IMAGE_BYTES / 1048576} MiB are also returned inline so you can see them. download_url is a short-lived link to this one version (about 10 minutes; plain GET, supports Range); it is not a share link, so do not give it to people. web_url is for the user's browser.`,
      inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 }, include_image: { type: "boolean", description: "Return images inline (default true)" } }, ["artifact_id"]),
      annotations: RO,
      write: false,
      run: (c, p, a) => ftReadFile(c, p, a)
    },
    // Replaced per request by ftUploadBeginTool (its fields depend on App Connect).
    upload_begin: null,
    upload_file: {
      name: "upload_file",
      title: "Upload a small file",
      description: `Upload a file in one call, bytes as content_base64 (up to ${FT_INLINE_UPLOAD_BYTES / 1048576} MiB decoded). New file: pass title. New version: pass artifact_id and expected_revision (revision_conflict if stale). Allowed: PNG, JPEG, WebP, GIF, PDF, MP4, WebM or application/octet-stream. For larger files (up to the plan's file size limit), use upload_begin + HTTP PUT + upload_finish. Safe to retry with the same idempotency_key. Returns artifact_id, revision and web_url (for the user's browser). Always set change_note to why.`,
      inputSchema: S({
        project_id: P,
        title: { type: "string", minLength: 1, maxLength: 200, description: "Title of a new file" },
        folder: { type: "string", maxLength: 200 },
        artifact_id: { ...A, description: "File to add a new version to" },
        expected_revision: { type: "integer", minimum: 1, description: "Current revision of artifact_id" },
        mime: { type: "string", enum: Object.keys(BINARY_TYPES) },
        content_base64: { type: "string", maxLength: FT_INLINE_B64_MAX + 4, contentEncoding: "base64", description: "The file's bytes, standard base64" },
        change_note: NOTE,
        idempotency_key: K
      }, ["mime", "content_base64", "change_note", "idempotency_key"]),
      annotations: RW,
      write: true,
      run: (c, p, a) => ftUploadInline(c, p, a)
    },
    upload_finish: {
      name: "upload_finish",
      title: "Finish upload",
      description: UPLOAD_FINISH_DESCRIPTION,
      inputSchema: S({ project_id: P, upload_id: { type: "string", maxLength: 64 }, idempotency_key: K }, ["upload_id", "idempotency_key"]),
      annotations: RW,
      write: true,
      run: (c, p, a) => ftUploadFinish(c, p, a)
    }
  };
  const out2 = [];
  for (const t of base) {
    if (t.name === "list_artifacts") {
      out2.push({
        ...t,
        title: "List documents and files",
        description: 'List documents (Markdown, HTML, JSON, CSV) and files (images, PDFs, video: kind "binary") in a connected project; optional query filters by title. Each item has kind, mime, size and revision. Paginated (50 per page; pass next_cursor). To search document text, use search_artifacts if it is listed.',
        inputSchema: S({
          project_id: P,
          query: { type: "string", maxLength: 200 },
          cursor: { type: "string", maxLength: 12 },
          kind: { type: "string", enum: ["markdown", "html", "json", "csv", "binary"], description: 'Only this kind; "binary" means files (images, PDFs, video)' },
          mime_prefix: { type: "string", maxLength: 100, description: 'Only items whose MIME type starts with this, e.g. "image/" or "application/pdf". A page can then hold fewer than 50 items; keep following next_cursor.' },
          ...appConnectEnabled(env) ? { folder_id: AC_LIST_PROPS.folder_id } : {}
        }, []),
        run: (c, p, a) => ftList(c, p, a)
      });
    } else if (t.name === "read_artifact") {
      out2.push({
        ...t,
        title: "Read document or file",
        description: "Read a document (Markdown, HTML, JSON, CSV: returns its text, revision and sha256) or a file (image, PDF, video: same result as read_file), current or a given revision.",
        inputSchema: S({ ...t.inputSchema.properties, include_image: { type: "boolean", description: "For images: return them inline (default true)" } }, t.inputSchema.required),
        run: async (c, p, a) => {
          const { include_image: _x, ...rest } = a;
          try {
            return await t.run(c, p, rest);
          } catch (e) {
            // A chunked read (cursor/max_bytes) of a file returns the link only: an inline image could never fit max_bytes.
            if (e instanceof HttpError && e.code === "unsupported_kind") return ftReadFile(c, p, a.cursor != null || a.max_bytes != null ? { ...a, include_image: false } : a);
            throw e;
          }
        }
      }, ftDefs.read_file);
    } else out2.push(t);
    if (t.name === "save_markdown") out2.push(ftDefs.upload_file, ftUploadBeginTool(appConnectEnabled(env)), ftDefs.upload_finish);
  }
  return out2;
}
var FT_INSTRUCTIONS = "Agent Library: documents (Markdown, HTML, JSON, CSV) and files (images, PDFs, video) in owner-approved projects. Call list_projects first; pass project_id when more than one project is connected. Read before editing; saves need expected_revision and a fresh idempotency_key. read_file returns images inline and a short-lived download_url for any file. For large text (up to 10 MiB), use upload_begin, HTTP PUT raw UTF-8 bytes to put_url, then upload_finish. Binary files use the same flow, or binary-only upload_file for up to 2 MiB inline. Every change is kept as a version the owner reviews in History: whenever a tool has a change_note field, always set it to one line on why.";
// GET/HEAD /files/d/<token> (download one revision) and PUT /files/u/<token> (bytes of one upload), on the MCP host.
async function handleFileTransfer(req, env, url) {
  const requestId = randomId("req", 9);
  try {
    const m = FT_LINK.exec(url.pathname);
    if (!m) throw new HttpError(404, "not_found", "Not found");
    const kind = m[1] === "d" ? "download" : "upload";
    if (kind === "download" ? req.method !== "GET" && req.method !== "HEAD" : req.method !== "PUT")
      return new Response(null, { status: 405, headers: { allow: kind === "download" ? "GET, HEAD" : "PUT" } });
    const row = await env.DB.prepare("SELECT * FROM transfer_links WHERE token_hash = ? AND kind = ?").bind(await sha256Hex(m[2]), kind).first();
    if (!row || row.expires_at <= nowMs()) {
      await rateLimit(env, "authfail:" + (req.headers.get("cf-connecting-ip") ?? "local"), limitsFor(env).authFailPerMin);
      throw new HttpError(401, "link_expired", kind === "download" ? "Link expired or unknown; call read_file again for a fresh one" : "Upload link expired or unknown; start again with upload_begin");
    }
    const conn = await liveConnection(env, row.connection_id);
    if (!conn || conn.can_read !== 1 || conn.file_access !== 1) throw new HttpError(401, "connection_revoked", "Connection revoked or expired");
    const proj = conn.projects.find((x) => x.id === row.project_id);
    if (!proj) throw new HttpError(403, "forbidden", "This connection no longer has access to this project");
    const canWrite = conn.can_write === 1 && proj.can_write === 1;
    const ctx = {
      env,
      requestId,
      principal: { id: conn.owner_principal_id, kind: "agent", label: `oauth:${conn.client_name}` },
      grant: { id: conn.id, project_id: proj.id, can_write: canWrite ? 1 : 0 },
      oauthConnection: true,
      via: { kind: "oauth", id: conn.id, label: conn.client_name }
    };
    if (kind === "download") {
      await rateLimit(env, `dl:oauth:${conn.id}`, 300);
      return await serveContent(ctx, req, row.project_id, row.artifact_id, String(row.rev_no));
    }
    if (!canWrite) throw new HttpError(403, "forbidden", "This connection is read-only for this project");
    return await uploadPut(req, env, requestId, row.upload_id, { ...ctx, principal: ftUploadPrincipal(conn) });
  } catch (e) {
    if (e instanceof HttpError) return json(errorBody(e), e.status, { "x-request-id": requestId });
    console.error("file_transfer_error", requestId, e?.message);
    return json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500);
  }
}

export { handleFileTransfer, handleOAuthMcp };
