import { authenticate, enforceRate } from "./auth.js";
import { WEB_URL_OUTPUT_SCHEMAS, WEB_URL_TOOL_NOTE, appOrigin, withWebUrls } from "./links.js";
import { addressLinks, resolveProjectRef } from "./paths.js";
import { __name } from "./runtime.js";
import { RS_SCHEMA, RT_ID_TOO_LONG, addComment, auditDenied, createMarkdown, diffRevisions, getArtifact, history, legacyConnectionInfo, listArtifacts, listChanges, listComments, listProjects, readTextChunk, restoreMetadata, restoreRevision, rsToolReady, rtChunkLimit, rtFit, rtIdBytes, saveMarkdown, searchArtifacts, tplTools, updateMetadata } from "./service.js";
import { uploadBegin, uploadFinish } from "./uploads.js";
import { CHANGE_NOTE_SCHEMA, HttpError, idemKey, mcpClientInfo, rememberClientInfo } from "./util.js";

var SUPPORTED2 = ["2025-11-25", "2025-06-18", "2025-03-26"];
var S2 = /* @__PURE__ */ __name((props, required) => ({ type: "object", properties: props, required, additionalProperties: false }), "S");
var P2 = { type: "string", description: "Project ID or path (workspace/project)" };
var A2 = { type: "string", description: "Artifact ID" };
var K2 = { type: "string", description: "Idempotency key (8-128 chars); reuse it when retrying the same request" };
var unwrap2 = /* @__PURE__ */ __name((r) => r && typeof r.status === "number" && "body" in r ? r.body : r, "unwrap");
var TOOLS2 = [
  { name: "connection_info", description: "Identify this authenticated grant and current project access. Read-only; compare the safe ID in Connections.", inputSchema: S2({}, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, run: (c) => legacyConnectionInfo(c) },
  ...tplTools(false),
  { name: "list_changes", description: "Poll published changes in one explicit project. WITHOUT cursor establishes a current checkpoint and returns NO history (initialized=true). Store next_cursor; follow has_more, then poll again. At-least-once: deduplicate by event_id. Cursors expire after 30 days; checkpoint BEFORE reconciling current content. Publishers excluded. No bodies or push notifications.", inputSchema: S2({ project_id: { type: "string", maxLength: 110, description: "Project ID or path (workspace/project)" }, cursor: { type: "string", maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["project_id"]), run: (c,a) => listChanges(c,a.project_id,a) },
  { name: "search_artifacts", description: "Ranked lexical search of currently readable projects, with excerpts and revision-pinned links. All words must match. Live pagination.", inputSchema: RS_SCHEMA, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, run: (c,a) => searchArtifacts(c,a,"mcp") },
  { name: "list_projects", description: "List projects this identity may access.", inputSchema: S2({}, []), run: (c) => listProjects(c) },
  {
    name: "list_artifacts",
    description: "List/search artifacts (title and Markdown body). Paginated (50).",
    inputSchema: S2({ project_id: P2, query: { type: "string" }, cursor: { type: "string" } }, ["project_id"]),
    run: (c, a) => listArtifacts(c, a.project_id, { query: a.query, cursor: a.cursor })
  },
  {
    name: "read_artifact",
    description: "Read an artifact's current (or given) revision. Markdown returns body; binaries return metadata and an authenticated content_url. For long documents pass max_bytes (4096-524288) to get one bounded chunk, then pass next_cursor until eof: every chunk comes from the same version (revision + sha256), so concurrent edits never mix in; a revision_changed error means start again.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, revision: { type: "integer" }, cursor: { type: "string", maxLength: 512 }, max_bytes: { type: "integer", minimum: 4096, maximum: 524288 } }, ["project_id", "artifact_id"]),
    run: (c, a) => a.cursor != null || a.max_bytes != null ? readTextChunk(c, a.project_id, a.artifact_id, { revision: a.revision, cursor: a.cursor, maxBytes: a.max_bytes, encoding: "mcp" }) : getArtifact(c, a.project_id, a.artifact_id, a.revision)
  },
  {
    name: "artifact_history",
    description: "List immutable versions, newest first (50 per page; pass next_cursor for older ones), with who made each (via, self-reported client_info) and why (change_note). Title/folder/tag changes are listed under meta_versions.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, cursor: { type: "string" } }, ["project_id", "artifact_id"]),
    run: (c, a) => history(c, a.project_id, a.artifact_id, { cursor: a.cursor })
  },
  {
    name: "diff_revisions",
    description: "Compare two versions line by line (default: current against the previous one). Unified hunks; lines start with ' ', '-' or '+'.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, from: { type: "integer" }, to: { type: "integer" } }, ["project_id", "artifact_id"]),
    run: (c, a) => diffRevisions(c, a.project_id, a.artifact_id, a.from, a.to)
  },
  {
    name: "restore_revision",
    description: "Restore an earlier version's content as a new version (nothing is deleted). expected_revision must be the current revision. Set change_note to why.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_revision: { type: "integer" }, from_revision: { type: "integer" }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_revision", "from_revision", "idempotency_key"]),
    run: async (c, a) => unwrap2(await restoreRevision(c, a.project_id, a.artifact_id, { expected_revision: a.expected_revision, from_revision: a.from_revision, change_note: a.change_note }, idemKey(a.idempotency_key)))
  },
  {
    name: "restore_metadata",
    description: "Restore an earlier title, folder and tags (see meta_versions in artifact_history) as a new metadata version. expected_meta_version must be current. Set change_note to why.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_meta_version: { type: "integer" }, from_version: { type: "integer" }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_meta_version", "from_version", "idempotency_key"]),
    run: async (c, a) => unwrap2(await restoreMetadata(c, a.project_id, a.artifact_id, { expected_meta_version: a.expected_meta_version, from_version: a.from_version, change_note: a.change_note }, idemKey(a.idempotency_key)))
  },

  {
    name: "create_markdown",
    description: 'Create a document: Markdown by default, or format "html" for a static HTML page (scripts/external resources removed when shown; embed same-project media with src="art_\u2026").',
    inputSchema: S2({ project_id: P2, title: { type: "string" }, body: { type: "string" }, folder: { type: "string" }, format: { type: "string", enum: ["markdown", "html"] }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "title", "idempotency_key"]),
    run: async (c, a) => unwrap2(await createMarkdown(c, a.project_id, a, idemKey(a.idempotency_key), a.format === "html" ? "html" : "markdown"))
  },
  {
    name: "save_markdown",
    description: "Save a new revision of a Markdown or HTML document. Fails with revision_conflict if expected_revision is not the current head; your text is not discarded \u2014 re-read and merge explicitly. Every save is kept as an immutable version. Always set change_note to one line on why you made the change; the owner reads it in History.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_revision: { type: "integer" }, body: { type: "string" }, change_note: CHANGE_NOTE_SCHEMA, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_revision", "body", "idempotency_key"]),
    run: async (c, a) => unwrap2(await saveMarkdown(c, a.project_id, a.artifact_id, a, idemKey(a.idempotency_key)))
  },
  {
    name: "add_comment",
    description: "Comment on a specific revision.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, revision: { type: "integer" }, body: { type: "string" }, idempotency_key: K2 }, ["project_id", "artifact_id", "revision", "body", "idempotency_key"]),
    run: async (c, a) => unwrap2(await addComment(c, a.project_id, a.artifact_id, a, idemKey(a.idempotency_key)))
  },
  {
    name: "list_comments",
    description: "List comments.",
    inputSchema: S2({ project_id: P2, artifact_id: A2 }, ["project_id", "artifact_id"]),
    run: (c, a) => listComments(c, a.project_id, a.artifact_id)
  },
  {
    name: "upload_begin",
    description: "Begin a binary upload (PNG/PDF/MP4/other, <=5 MiB). The server cannot read your local files: you must then HTTP PUT the raw bytes to put_url with your bearer token, then call upload_finish.",
    inputSchema: S2(
      { project_id: P2, title: { type: "string" }, artifact_id: A2, expected_revision: { type: "integer" }, mime: { type: "string" }, size: { type: "integer" }, sha256: { type: "string" }, idempotency_key: K2 },
      ["project_id", "mime", "size", "sha256", "idempotency_key"]
    ),
    run: async (c, a) => unwrap2(await uploadBegin(c, a.project_id, a, idemKey(a.idempotency_key)))
  },
  {
    name: "upload_finish",
    description: "Verify uploaded bytes (length + SHA-256 + signature) and publish exactly one immutable version.",
    inputSchema: S2({ project_id: P2, upload_id: { type: "string" }, idempotency_key: K2 }, ["project_id", "upload_id", "idempotency_key"]),
    run: async (c, a) => unwrap2(await uploadFinish(c, a.project_id, a.upload_id, idemKey(a.idempotency_key)))
  },
  {
    name: "trash_artifact",
    description: "Move to trash (recoverable by the owner). There is no permanent delete.",
    inputSchema: S2({ project_id: P2, artifact_id: A2, expected_meta_version: { type: "integer" }, idempotency_key: K2 }, ["project_id", "artifact_id", "expected_meta_version", "idempotency_key"]),
    run: async (c, a) => unwrap2(await updateMetadata(c, a.project_id, a.artifact_id, { expected_meta_version: a.expected_meta_version, trashed: true }, idemKey(a.idempotency_key)))
  }
];
var rpc2 = /* @__PURE__ */ __name((id, result) => ({ jsonrpc: "2.0", id, result }), "rpc");
var rpcErr2 = /* @__PURE__ */ __name((id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), "rpcErr");
async function handleMcp(req, env, requestId, origin) {
  const hdr = { "content-type": "application/json", "cache-control": "no-store" };
  const o = req.headers.get("origin");
  if (o && o !== origin) return new Response(JSON.stringify(rpcErr2(null, -32600, "Origin not allowed")), { status: 403, headers: hdr });
  const unauth = (code = "unauthenticated", msg2 = "Bearer token required") => new Response(JSON.stringify(rpcErr2(null, -32001, msg2)), {
    status: 401,
    headers: { ...hdr, "www-authenticate": `Bearer realm="agent-library", error="invalid_token", error_description="${code}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }
  });
  const limited = (e) => new Response(JSON.stringify(rpcErr2(null, -32002, e.message)), { status: 429, headers: { ...hdr, "retry-after": String(e.extra?.retry_after_seconds ?? 60) } });
  if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (!req.headers.get("authorization")) return unauth();
  let ctx;
  try {
    ctx = await authenticate(req, env, requestId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return limited(e);
    if (e instanceof HttpError) return unauth(e.code, e.message);
    throw e;
  }
  if (ctx.principal.kind !== "agent") return unauth();
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !SUPPORTED2.includes(pv)) return new Response(JSON.stringify(rpcErr2(null, -32600, "Unsupported protocol version")), { status: 400, headers: hdr });
  const text = await req.text();
  if (text.length > 2 * 1024 * 1024) return new Response(JSON.stringify(rpcErr2(null, -32600, "Payload too large")), { status: 413, headers: hdr });
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify(rpcErr2(null, -32700, "Parse error")), { status: 400, headers: hdr });
  }
  if (Array.isArray(msg) || msg?.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return new Response(JSON.stringify(rpcErr2(msg?.id, -32600, "Invalid request")), { status: 400, headers: hdr });
  if (msg.id === void 0) return new Response(null, { status: 202 });
  const rtLim = rtChunkLimit(msg);
  if (rtLim?.idTooLong) return new Response(JSON.stringify(RT_ID_TOO_LONG), { status: 400, headers: hdr });
  const MUTATING = /* @__PURE__ */ new Set(["create_markdown", "save_markdown", "add_comment", "upload_begin", "upload_finish", "trash_artifact", "restore_revision", "restore_metadata", "create_from_template"]);
  try {
    await enforceRate(ctx, msg.method === "tools/call" && MUTATING.has(msg.params?.name));
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return limited(e);
    throw e;
  }
  const reply = (body2) => new Response(rtFit(body2, rtLim), { status: 200, headers: hdr });
  const searchReady = await rsToolReady(env,msg);
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      if (ctx.grant?.id) await rememberClientInfo(env, "grants", ctx.grant.id, msg.params);
      return reply(rpc2(msg.id, {
        protocolVersion: SUPPORTED2.includes(want) ? want : SUPPORTED2[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-library", version: "0.1.0" },
        instructions: "Agent Library: project-scoped Markdown and binary artifacts. Saves require expected_revision; mutations require idempotency_key. When saving, creating or restoring a document (tools with a change_note field), always set change_note to one line on why; the owner reads it in History."
      }));
    }
    case "ping":
      return reply(rpc2(msg.id, {}));
    case "tools/list":
      return reply(rpc2(msg.id, { tools: TOOLS2.filter(t => (t.name !== "search_artifacts" || searchReady) && (!t.write || !!ctx.grant?.can_write)).map(({ name, description, inputSchema, annotations }) => ({
        annotations,
        name,
        description: WEB_URL_OUTPUT_SCHEMAS[name] ? description + WEB_URL_TOOL_NOTE : description,
        inputSchema,
        ...WEB_URL_OUTPUT_SCHEMAS[name] ? { outputSchema: WEB_URL_OUTPUT_SCHEMAS[name] } : {}
      })) }));
    case "tools/call": {
      const tool = TOOLS2.filter(t => t.name !== "search_artifacts" || searchReady).find((t) => t.name === msg.params?.name);
      if (!tool) return reply(rpcErr2(msg.id, -32602, "Unknown tool"));
      const args = msg.params?.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return reply(rpcErr2(msg.id, -32602, "arguments must be an object"));
      const allowed = new Set(Object.keys(tool.inputSchema.properties));
      for (const k of Object.keys(args)) if (!allowed.has(k)) return reply(rpcErr2(msg.id, -32602, `Unknown argument ${k}`));
      // A missing required argument is the caller's mistake (it used to reach the database as undefined: a 500).
      const missing = (tool.inputSchema.required ?? []).find((k) => args[k] === undefined || args[k] === null);
      if (missing) return reply(rpcErr2(msg.id, -32602, `Missing argument ${missing}`));
      if (typeof args.project_id === "string" && args.project_id.includes("/")) args.project_id = await resolveProjectRef(env, args.project_id);
      if (Array.isArray(args.project_ids) && args.project_ids.length <= 20) args.project_ids = await Promise.all(args.project_ids.map((x) => resolveProjectRef(env, x)));
      try {
        const result = await addressLinks(env, withWebUrls(tool.name, args, args.project_id, await tool.run({ ...ctx, clientInfo: mcpClientInfo(msg.params, ctx.grantClientInfo), rpcIdBytes: rtIdBytes(msg.id) }, args), appOrigin(env.APP_HOST) ?? origin), [ctx.grant?.project_id]);
        return reply(rpc2(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (e.status === 401 || e.status === 403) await auditDenied(ctx, args.project_id ?? null, "mcp." + tool.name, e.code);
        if (e.status === 401) return unauth(e.code, e.message);
        const err2 = { status: e.status, code: e.code, message: e.message, ...e.extra ?? {} };
        return reply(rpc2(msg.id, { content: [{ type: "text", text: JSON.stringify({ error: err2 }) }], structuredContent: { error: err2 }, isError: true }));
      }
    }
    default:
      return reply(rpcErr2(msg.id, -32601, "Method not found"));
  }
}

export { handleMcp };
