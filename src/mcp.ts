// Minimal stateless Streamable HTTP MCP server (JSON responses). Every tool call goes through
// the same service layer as the HTTP API. Authorization is the bearer grant on each POST;
// Mcp-Session-Id is never used for authorization.
import { auditDenied } from "./service";
import * as svc from "./service";
import { uploadBegin, uploadFinish } from "./uploads";
import { authenticate, enforceRate, type Env } from "./auth";
import { HttpError, idemKey } from "./util";
import { appOrigin, WEB_URL_OUTPUT_SCHEMAS, WEB_URL_TOOL_NOTE, withWebUrls } from "./links";

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26"];

type Tool = { name: string; description: string; inputSchema: any; run: (ctx: any, a: any) => Promise<any> };
const S = (props: Record<string, any>, required: string[]) => ({ type: "object", properties: props, required, additionalProperties: false });
const P = { type: "string", description: "Project ID" };
const A = { type: "string", description: "Artifact ID" };
const K = { type: "string", description: "Idempotency key (8-128 chars); reuse it when retrying the same request" };
const unwrap = (r: any) => (r && typeof r.status === "number" && "body" in r ? r.body : r);

const TOOLS: Tool[] = [
  { name: "list_projects", description: "List projects this identity may access.", inputSchema: S({}, []), run: (c) => svc.listProjects(c) },
  { name: "list_artifacts", description: "List/search artifacts (title and Markdown body). Paginated (50).",
    inputSchema: S({ project_id: P, query: { type: "string" }, cursor: { type: "string" } }, ["project_id"]),
    run: (c, a) => svc.listArtifacts(c, a.project_id, { query: a.query, cursor: a.cursor }) },
  { name: "read_artifact", description: "Read an artifact's current (or given) revision. Markdown returns body; binaries return metadata and an authenticated content_url.",
    inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer" } }, ["project_id", "artifact_id"]),
    run: (c, a) => svc.getArtifact(c, a.project_id, a.artifact_id, a.revision) },
  { name: "artifact_history", description: "List immutable revisions.", inputSchema: S({ project_id: P, artifact_id: A }, ["project_id", "artifact_id"]),
    run: (c, a) => svc.history(c, a.project_id, a.artifact_id) },
  { name: "create_markdown", description: "Create a Markdown artifact.",
    inputSchema: S({ project_id: P, title: { type: "string" }, body: { type: "string" }, folder: { type: "string" }, idempotency_key: K }, ["project_id", "title", "idempotency_key"]),
    run: async (c, a) => unwrap(await svc.createMarkdown(c, a.project_id, a, idemKey(a.idempotency_key))) },
  { name: "save_markdown", description: "Save a new revision. Fails with revision_conflict if expected_revision is not the current head; your text is not discarded — re-read and merge explicitly.",
    inputSchema: S({ project_id: P, artifact_id: A, expected_revision: { type: "integer" }, body: { type: "string" }, idempotency_key: K }, ["project_id", "artifact_id", "expected_revision", "body", "idempotency_key"]),
    run: async (c, a) => unwrap(await svc.saveMarkdown(c, a.project_id, a.artifact_id, a, idemKey(a.idempotency_key))) },
  { name: "add_comment", description: "Comment on a specific revision.",
    inputSchema: S({ project_id: P, artifact_id: A, revision: { type: "integer" }, body: { type: "string" }, idempotency_key: K }, ["project_id", "artifact_id", "revision", "body", "idempotency_key"]),
    run: async (c, a) => unwrap(await svc.addComment(c, a.project_id, a.artifact_id, a, idemKey(a.idempotency_key))) },
  { name: "list_comments", description: "List comments.", inputSchema: S({ project_id: P, artifact_id: A }, ["project_id", "artifact_id"]),
    run: (c, a) => svc.listComments(c, a.project_id, a.artifact_id) },
  { name: "upload_begin", description: "Begin a binary upload (PNG/PDF/MP4/other, <=5 MiB). The server cannot read your local files: you must then HTTP PUT the raw bytes to put_url with your bearer token, then call upload_finish.",
    inputSchema: S({ project_id: P, title: { type: "string" }, artifact_id: A, expected_revision: { type: "integer" }, mime: { type: "string" }, size: { type: "integer" }, sha256: { type: "string" }, idempotency_key: K },
      ["project_id", "mime", "size", "sha256", "idempotency_key"]),
    run: async (c, a) => unwrap(await uploadBegin(c, a.project_id, a, idemKey(a.idempotency_key))) },
  { name: "upload_finish", description: "Verify uploaded bytes (length + SHA-256 + signature) and publish exactly one immutable version.",
    inputSchema: S({ project_id: P, upload_id: { type: "string" }, idempotency_key: K }, ["project_id", "upload_id", "idempotency_key"]),
    run: async (c, a) => unwrap(await uploadFinish(c, a.project_id, a.upload_id, idemKey(a.idempotency_key))) },
  { name: "trash_artifact", description: "Move to trash (recoverable by the owner). There is no permanent delete.",
    inputSchema: S({ project_id: P, artifact_id: A, expected_meta_version: { type: "integer" }, idempotency_key: K }, ["project_id", "artifact_id", "expected_meta_version", "idempotency_key"]),
    run: async (c, a) => unwrap(await svc.updateMetadata(c, a.project_id, a.artifact_id, { expected_meta_version: a.expected_meta_version, trashed: true }, idemKey(a.idempotency_key))) },
];

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleMcp(req: Request, env: Env, requestId: string, origin: string): Promise<Response> {
  const hdr = { "content-type": "application/json", "cache-control": "no-store" };
  // DNS-rebinding / cross-site protection: browsers send Origin; only our own origin is allowed.
  const o = req.headers.get("origin");
  if (o && o !== origin) return new Response(JSON.stringify(rpcErr(null, -32600, "Origin not allowed")), { status: 403, headers: hdr });
  const unauth = (code = "unauthenticated", msg = "Bearer token required") =>
    new Response(JSON.stringify(rpcErr(null, -32001, msg)), {
      status: 401,
      headers: { ...hdr, "www-authenticate": `Bearer realm="agent-library", error="invalid_token", error_description="${code}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
    });
  const limited = (e: HttpError) =>
    new Response(JSON.stringify(rpcErr(null, -32002, e.message)), { status: 429, headers: { ...hdr, "retry-after": String(e.extra?.retry_after_seconds ?? 60) } });
  if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST" } }); // no server-initiated stream
  if (req.method === "DELETE") return new Response(null, { status: 405, headers: { allow: "POST" } }); // stateless
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
  if (pv && !SUPPORTED.includes(pv)) return new Response(JSON.stringify(rpcErr(null, -32600, "Unsupported protocol version")), { status: 400, headers: hdr });
  const text = await req.text();
  if (text.length > 2 * 1024 * 1024) return new Response(JSON.stringify(rpcErr(null, -32600, "Payload too large")), { status: 413, headers: hdr });
  let msg: any;
  try { msg = JSON.parse(text); } catch { return new Response(JSON.stringify(rpcErr(null, -32700, "Parse error")), { status: 400, headers: hdr }); }
  if (Array.isArray(msg) || msg?.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return new Response(JSON.stringify(rpcErr(msg?.id, -32600, "Invalid request")), { status: 400, headers: hdr });
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notification
  // Every request counts against the identity's budget; state-changing tools use the mutation budget.
  const MUTATING = new Set(["create_markdown", "save_markdown", "add_comment", "upload_begin", "upload_finish", "trash_artifact"]);
  try {
    await enforceRate(ctx, msg.method === "tools/call" && MUTATING.has(msg.params?.name));
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return limited(e);
    throw e;
  }

  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: hdr });
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return reply(rpc(msg.id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-library", version: "0.1.0" },
        instructions: "Agent Library: project-scoped Markdown and binary artifacts. Saves require expected_revision; mutations require idempotency_key.",
      }));
    }
    case "ping": return reply(rpc(msg.id, {}));
    case "tools/list":
      return reply(rpc(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name, description: WEB_URL_OUTPUT_SCHEMAS[name] ? description + WEB_URL_TOOL_NOTE : description, inputSchema,
        ...(WEB_URL_OUTPUT_SCHEMAS[name] ? { outputSchema: WEB_URL_OUTPUT_SCHEMAS[name] } : {}),
      })) }));
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return reply(rpcErr(msg.id, -32602, "Unknown tool"));
      const args = msg.params?.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return reply(rpcErr(msg.id, -32602, "arguments must be an object"));
      const allowed = new Set(Object.keys(tool.inputSchema.properties));
      for (const k of Object.keys(args)) if (!allowed.has(k)) return reply(rpcErr(msg.id, -32602, `Unknown argument ${k}`));
      try {
        // web_url always points at the owner app host (APP_HOST), or this origin when unset (local dev).
        const result = withWebUrls(tool.name, args, args.project_id, await tool.run(ctx, args), appOrigin(env.APP_HOST) ?? origin);
        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (e.status === 401 || e.status === 403) await auditDenied(ctx, args.project_id ?? null, "mcp." + tool.name, e.code);
        if (e.status === 401) return unauth(e.code, e.message);
        const err = { status: e.status, code: e.code, message: e.message, ...(e.extra ?? {}) };
        return reply(rpc(msg.id, { content: [{ type: "text", text: JSON.stringify({ error: err }) }], structuredContent: { error: err }, isError: true }));
      }
    }
    default:
      return reply(rpcErr(msg.id, -32601, "Method not found"));
  }
}
