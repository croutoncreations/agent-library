// MCP for OAuth connections. Token already validated by the library (signature/hash, audience = canonical
// resource, expiry). Here: live D1 connection check, effective scopes = token ∩ connection ∩ operation,
// a verified principal for the shared service layer, and an in-batch authorization predicate bound to the
// connection so revocation between check and commit publishes nothing.
import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { rateLimit, type Ctx, type Env } from "../auth";
import * as svc from "../service";
import { HttpError, idemKey, nowMs, randomId } from "../util";
import { liveConnection, SCOPES } from "./server";
import { byteLength } from "../formats";

const MCP_TEXT_MAX = 64 * 1024;
/** First MCP_TEXT_MAX bytes of a UTF-8 string, never splitting a code point. */
function truncateUtf8(s: string, max: number): { text: string; truncated: boolean } {
  if (byteLength(s) <= max) return { text: s, truncated: false };
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (byteLength(s.slice(0, mid)) <= max) lo = mid; else hi = mid - 1; }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(s[lo - 1])) lo--;
  return { text: s.slice(0, lo), truncated: true };
}
import { appOrigin, WEB_URL_OUTPUT_SCHEMAS, WEB_URL_TOOL_NOTE, withWebUrls } from "../links";

export type ConnProps = { connection_id: string };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26"];
const S = (props: Record<string, any>, required: string[]) => ({ type: "object", properties: props, required, additionalProperties: false });
const A = { type: "string", description: "Artifact ID" };
const P = { type: "string", maxLength: 64, description: "Project ID from list_projects. Optional when the connection has exactly one project." };
const K = { type: "string", description: "Unique key for this change (8-128 chars, e.g. a UUID). Reuse it only when retrying the same change." };
const unwrap = (r: any) => (r && typeof r.status === "number" && "body" in r ? r.body : r);
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

type Tool = { name: string; title: string; description: string; inputSchema: any; annotations: any; write: boolean; run: (c: Ctx, p: string, a: any) => Promise<any> };
const TOOLS: Tool[] = [
  { name: "list_projects", title: "List projects", description: "List the projects this connection can access, with whether each allows editing.", inputSchema: S({}, []), annotations: RO, write: false,
    run: async () => { throw new Error("handled inline"); } },
  { name: "list_artifacts", title: "List documents", description: "List or search Markdown documents in a connected project (title and text). Paginated.",
    inputSchema: S({ project_id: P, query: { type: "string", maxLength: 200 }, cursor: { type: "string", maxLength: 12 } }, []), annotations: RO, write: false,
    run: async (c, p, a) => {
      if (svc.appConnectEnabled(c.env)) {
        const r = await svc.listArtifacts(c, p, { query: a.query, cursor: a.cursor, kind: a.kind, folderId: a.folder_id });
        return { ...r, artifacts: r.artifacts.filter((x: any) => x.kind !== "binary") };
      }
      if (a.kind !== undefined || a.folder_id !== undefined) throw new HttpError(400, "invalid_input", "kind/folder_id filters are not available");
      const r = await svc.listArtifacts(c, p, { query: a.query, cursor: a.cursor });
      return { ...r, artifacts: r.artifacts.filter((x: any) => x.kind === "markdown") };
    } },
  { name: "read_artifact", title: "Read document", description: "Read a Markdown document (current or a given revision). Returns body, revision and sha256.",
    inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer", minimum: 1 } }, ["artifact_id"]), annotations: RO, write: false,
    run: async (c, p, a) => {
      const r: any = await svc.getArtifact(c, p, a.artifact_id, a.revision);
      if ((r.artifact.kind === "json" || r.artifact.kind === "csv") && svc.appConnectEnabled(c.env)) {
        const { content_url: _u, content, ...rest } = r;
        const t = truncateUtf8(content ?? "", MCP_TEXT_MAX);
        return { ...rest, content: t.text, truncated: t.truncated,
          ...(r.artifact.schema && r.artifact.kind === "json" ? { records_hint: "Use read_records for filtered, paginated records." } : {}) };
      }
      if (r.artifact.kind !== "markdown") throw new HttpError(415, "unsupported_kind", "Only Markdown documents are available to this connection");
      return r;
    } },
  { name: "artifact_history", title: "Document history", description: "List a document's immutable revisions.", inputSchema: S({ project_id: P, artifact_id: A }, ["artifact_id"]), annotations: RO, write: false,
    run: (c, p, a) => svc.history(c, p, a.artifact_id) },
  { name: "create_markdown", title: "Create document", description: "Create a new Markdown document in a connected project that allows editing.",
    inputSchema: S({ project_id: P, title: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string" }, idempotency_key: K }, ["title", "idempotency_key"]), annotations: RW, write: true,
    run: async (c, p, a) => unwrap(await svc.createMarkdown(c, p, { title: a.title, body: a.body ?? "" }, idemKey(a.idempotency_key))) },
  { name: "save_markdown", title: "Edit document", description: "Save a new revision of a Markdown document. expected_revision must be the revision you read; on revision_conflict re-read and merge.",
    inputSchema: S({ project_id: P, artifact_id: A, expected_revision: { type: "integer", minimum: 1 }, body: { type: "string" }, idempotency_key: K }, ["artifact_id", "expected_revision", "body", "idempotency_key"]), annotations: RW, write: true,
    run: async (c, p, a) => {
      const cur: any = await svc.getArtifact(c, p, a.artifact_id);
      if (cur.artifact.kind !== "markdown") throw new HttpError(415, "unsupported_kind", "Only Markdown documents can be edited");
      return unwrap(await svc.saveMarkdown(c, p, a.artifact_id, { expected_revision: a.expected_revision, body: a.body }, idemKey(a.idempotency_key)));
    } },
];

// App Connect additions (only when APP_CONNECT_ENABLED; otherwise tools/list stays byte-identical).
const AC_LIST_PROPS = { kind: { type: "string", enum: ["markdown", "json", "csv"], description: "Only files of this kind" },
  folder_id: { type: "string", maxLength: 64, description: "Only files in this folder (fld_…), or \"root\"" } };
const READ_RECORDS: Tool = { name: "read_records", title: "Read measurement records",
  description: "Read records from a JSON file with schema agentlib.measurements/1 (current revision, source order). recorded_at is the source's original timestamp, returned verbatim; date is present only when the source provided it. from/to (YYYY-MM-DD, inclusive) match only that source date; records without one are excluded from ranged queries and counted in undated_excluded.",
  inputSchema: S({ project_id: P, artifact_id: A, from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    metric: { type: "string", maxLength: 40 }, limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: { type: "string", maxLength: 12 } }, ["artifact_id"]),
  annotations: RO, write: false,
  run: (c, p, a) => svc.readRecords(c, p, a.artifact_id, { from: a.from, to: a.to, metric: a.metric, limit: a.limit, cursor: a.cursor }) };
function toolsFor(env: Env): Tool[] {
  if (!svc.appConnectEnabled(env)) return TOOLS;
  return [...TOOLS.map((t) => t.name === "list_artifacts"
    ? { ...t, description: "List or search documents and data files (Markdown, JSON, CSV) in a connected project. Paginated.",
        inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...AC_LIST_PROPS } } }
    : t), READ_RECORDS];
}

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const HDR = { "content-type": "application/json", "cache-control": "no-store" };

export async function handleOAuthMcp(req: Request, env: Env, ctx: OAuthResourceContext<ConnProps>): Promise<Response> {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HDR });
  const o = req.headers.get("origin");
  if (o && o !== new URL(req.url).origin && o !== "https://chatgpt.com") return reply(rpcErr(null, -32600, "Origin not allowed"), 403);
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (new URL(req.url).pathname !== "/mcp") return reply({ error: "not_found" }, 404);

  // Live connection: fail closed (any lookup error -> 401 invalid_token so the client re-authorizes).
  let conn: Awaited<ReturnType<typeof liveConnection>>;
  try { conn = await liveConnection(env, ctx.props?.connection_id); } catch { conn = null; }
  const invalid = () => new Response(JSON.stringify(rpcErr(null, -32001, "Connection revoked or expired")), {
    status: 401, headers: { ...HDR, "www-authenticate": `Bearer error="invalid_token", error_description="connection revoked or expired", resource_metadata="${new URL(req.url).origin}/.well-known/oauth-protected-resource/mcp"` } });
  if (!conn || conn.client_id !== ctx.auth.clientId || conn.resource !== ctx.auth.audience) return invalid();

  // Effective permission = token scopes ∩ connection ceiling ∩ per-project permission (D1) ∩ operation.
  const tokenScopes = new Set(ctx.auth.scope);
  const canRead = tokenScopes.has(SCOPES.read) && conn.can_read === 1;
  const tokenWrite = canRead && tokenScopes.has(SCOPES.write) && conn.can_write === 1;
  const projectWrite = (p: { can_write: number }) => tokenWrite && p.can_write === 1;
  const anyWrite = conn.projects.some(projectWrite);
  if (!canRead) return insufficientScope(ctx.auth, [SCOPES.read]);

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 1024 * 1024) return reply(rpcErr(null, -32600, "Payload too large"), 413);
  const text = await req.text();
  if (text.length > 1024 * 1024) return reply(rpcErr(null, -32600, "Payload too large"), 413);
  let msg: any;
  try { msg = JSON.parse(text); } catch { return reply(rpcErr(null, -32700, "Parse error"), 400); }
  if (Array.isArray(msg) || msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return reply(rpcErr(msg?.id, -32600, "Invalid request"), 400);
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !SUPPORTED.includes(pv)) return reply(rpcErr(null, -32600, "Unsupported protocol version"), 400);

  const tool = msg.method === "tools/call" ? toolsFor(env).find((t) => t.name === msg.params?.name) : undefined;
  // Step-up at the HTTP layer: a write tool without write scope in the token -> 403 insufficient_scope.
  if (tool?.write && !(tokenScopes.has(SCOPES.write))) return insufficientScope(ctx.auth, [SCOPES.read, SCOPES.write]);
  try {
    await rateLimit(env, `${tool?.write ? "w" : "r"}:oauth:${conn.id}`, tool?.write ? 20 : 60);
  } catch { return new Response(JSON.stringify(rpcErr(msg.id, -32002, "Too many requests")), { status: 429, headers: { ...HDR, "retry-after": "60" } }); }

  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return reply(rpc(msg.id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-library", title: "Agent Library", version: "0.3.0" },
        instructions: "Agent Library: Markdown documents in owner-approved projects. Call list_projects first; pass project_id when more than one project is connected. Read before editing; saves need expected_revision and a fresh idempotency_key.",
      }));
    }
    case "ping": return reply(rpc(msg.id, {}));
    case "tools/list":
      return reply(rpc(msg.id, { tools: toolsFor(env).filter((t) => anyWrite || !t.write).map(({ name, title, description, inputSchema, annotations }) => ({
        name, title, description: WEB_URL_OUTPUT_SCHEMAS[name] ? description + WEB_URL_TOOL_NOTE : description, inputSchema, annotations,
        ...(WEB_URL_OUTPUT_SCHEMAS[name] ? { outputSchema: WEB_URL_OUTPUT_SCHEMAS[name] } : {}),
      })) }));
    case "tools/call": {
      if (!tool) return reply(rpcErr(msg.id, -32602, "Unknown tool"));
      const args = msg.params?.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return reply(rpcErr(msg.id, -32602, "arguments must be an object"));
      const allowed = new Set(Object.keys(tool.inputSchema.properties));
      for (const k of Object.keys(args)) if (!allowed.has(k)) return reply(rpcErr(msg.id, -32602, `Unknown argument ${k}`));
      if (tool.name === "list_projects") {
        // web_url targets the owner app host (APP_HOST), never this MCP host.
        const result = withWebUrls("list_projects", args, undefined, { projects: conn.projects.map((p) => ({ id: p.id, title: p.title, can_write: projectWrite(p) })) }, appOrigin(env.APP_HOST));
        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      }
      // Resolve the target project strictly from the connection's own D1 project list.
      let proj = conn.projects.length === 1 && args.project_id === undefined ? conn.projects[0] : undefined;
      if (args.project_id !== undefined) proj = conn.projects.find((p) => p.id === args.project_id);
      if (!proj) {
        // Name the valid choices so a client can retry immediately (also helps clients with a stale tool cache).
        const choices = conn.projects.map((p) => ({ id: p.id, title: p.title }));
        const err = args.project_id === undefined
          ? { status: 400, code: "project_required", message: `This connection has ${choices.length} projects; pass project_id (one of: ${choices.map((c) => c.id).join(", ")}). If your tool schema has no project_id argument, refresh this app's tools in the client.`, projects: choices }
          : { status: 404, code: "not_found", message: "Project not found in this connection", projects: choices };
        return reply(rpc(msg.id, toolError(err)));
      }
      const canWrite = projectWrite(proj);
      if (tool.write && !canWrite) return reply(rpc(msg.id, toolError({ status: 403, code: "forbidden", message: "This connection is read-only for this project" })));
      const { project_id: _omit, ...toolArgs } = args;
      const sctx: Ctx = {
        env, requestId: randomId("req", 9),
        principal: { id: conn.owner_principal_id, kind: "agent", label: `oauth:${conn.client_name}` },
        grant: { id: conn.id, project_id: proj.id, can_write: canWrite ? 1 : 0 },
        oauthConnection: true,
      };
      try {
        const result = withWebUrls(tool.name, toolArgs, proj.id, await tool.run(sctx, proj.id, toolArgs), appOrigin(env.APP_HOST));
        await env.DB.prepare("UPDATE oauth_connections SET last_used_at = ? WHERE id = ?").bind(nowMs(), conn.id).run().catch(() => {});
        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (e.status === 401) return invalid();
        return reply(rpc(msg.id, toolError({ status: e.status, code: e.code, message: e.message, ...(e.extra ?? {}) })));
      }
    }
    default:
      return reply(rpcErr(msg.id, -32601, "Method not found"));
  }
}
const toolError = (err: any) => ({ content: [{ type: "text", text: JSON.stringify({ error: err }) }], structuredContent: { error: err }, isError: true });
