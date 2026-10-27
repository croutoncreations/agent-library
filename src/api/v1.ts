// Machine REST API (/v1) on the MCP host, for API-credential (alk_) clients such as Muse's REST skill.
// Contract: docs/api/v1.openapi.yaml. JSON only (file content endpoints return the stored bytes with a
// non-HTML type); never redirects; never sets cookies; never serves HTML. Business logic and authorization
// are shared with the owner app and MCP via service.ts (authzSql re-checks the credential inside every
// write batch, so a key revoked between check and commit publishes nothing).
import { rateLimit, limitsFor, type Ctx, type Env } from "../auth";
import { appOrigin, artifactWebUrl, previewWebUrl, projectWebUrl } from "../links";
import * as svc from "../service";
import { serveContent } from "../uploads";
import { errorBody, HttpError, idemKey, int, json, randomId, str } from "../util";
import { verifyApiKey, type ApiKeyCtx } from "./credentials";

// Wire limit allows \uXXXX-escaped JSON (Python json.dumps default: up to 6 bytes per char);
// the real limit (1 MiB of decoded Markdown) is enforced by the service layer.
const MAX_BODY = 6_500_000;
const SEG = "([A-Za-z0-9_-]{1,64})";
const R = {
  projects: /^\/v1\/projects$/,
  files: new RegExp(`^/v1/projects/${SEG}/files$`),
  file: new RegExp(`^/v1/projects/${SEG}/files/${SEG}$`),
  content: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/content$`),
  revisions: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/revisions$`),
  records: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/records$`),
  folders: new RegExp(`^/v1/projects/${SEG}/folders$`),
};

export const isV1Path = (p: string) => p === "/v1" || p.startsWith("/v1/");

async function readJson(req: Request): Promise<any> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY)) throw new HttpError(413, "too_large", "Request body too large");
  const reader = req.body?.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) { await reader.cancel().catch(() => {}); throw new HttpError(413, "too_large", "Request body too large"); }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  try {
    const v = n ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf)) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch { throw new HttpError(400, "invalid_json", "Body must be a JSON object"); }
}

/** Per-request service context for one project of the credential. Out-of-scope projects are 404. */
function projectCtx(env: Env, k: ApiKeyCtx, requestId: string, pid: string): Ctx {
  const p = k.projects.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  return {
    env, requestId, apiCredential: true,
    principal: { id: k.principalId, kind: "agent", label: `api:${k.label}` },
    grant: { id: k.credentialId, project_id: p.id, can_write: p.can_write ? 1 : 0 },
  };
}

const writeAllowed = (k: ApiKeyCtx, pid: string) => {
  const p = k.projects.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  if (!p.can_write) throw new HttpError(403, "forbidden", "This credential cannot write to this project");
};

// Phase 1 (flag off) keeps the exact Phase 1 shapes; Phase 2 fields appear only with App Connect enabled.
const P1_FIELDS = ["id", "project_id", "kind", "title", "folder", "tags", "revision", "meta_version", "trashed", "updated_at"];
function fileView(origin: string | null, a: any, env?: Env) {
  const base = svc.appConnectEnabled(env) ? a : Object.fromEntries(P1_FIELDS.map((k) => [k, a[k]]));
  const linkable = svc.appConnectEnabled(env) ? ["markdown", "json", "csv"].includes(a.kind) : a.kind === "markdown";
  return { ...base, ...(origin ? { web_url: artifactWebUrl(origin, a.project_id, a.id), ...(linkable ? { preview_url: previewWebUrl(origin, a.project_id, a.id) } : {}) } : {}) };
}

function withLinks(origin: string | null, pid: string, r: { status: number; body: any }) {
  if (!origin || !r.body?.artifact_id) return r;
  return { ...r, body: { ...r.body, web_url: artifactWebUrl(origin, pid, r.body.artifact_id), preview_url: previewWebUrl(origin, pid, r.body.artifact_id) } };
}

async function route(req: Request, env: Env, url: URL, requestId: string): Promise<Response> {
  const m = req.method;
  const path = url.pathname.replace(/\/$/, "");
  // Test-only redirect probe (observes a client's redirect behaviour). Off unless V1_TEST_ENDPOINTS=1.
  // Belt and braces: never on a non-loopback host, even if the flag were set in a deployed environment.
  if (path === "/v1/_test/redirect" && (env as any).V1_TEST_ENDPOINTS === "1" && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.host)) {
    const code = Number(url.searchParams.get("code"));
    if (![301, 302, 307, 308].includes(code)) throw new HttpError(400, "invalid_input", "code must be 301, 302, 307 or 308");
    return new Response(null, { status: code, headers: { location: "https://redirect-probe.invalid/v1/projects", "cache-control": "no-store" } });
  }
  const ac = svc.appConnectEnabled(env);
  const known = Object.entries(R).some(([name, re]) => (ac || (name !== "records" && name !== "folders")) && re.test(path));
  if (!known) throw new HttpError(404, "not_found", "Not found");
  if (req.headers.get("cookie")) throw new HttpError(400, "invalid_request", "Cookies are not accepted on the API");

  let k: ApiKeyCtx;
  try { k = await verifyApiKey(env, req.headers.get("authorization")); }
  catch (e) {
    if (e instanceof HttpError && e.status === 401) await rateLimit(env, "authfail:" + (req.headers.get("cf-connecting-ip") ?? "local"), limitsFor(env).authFailPerMin);
    throw e;
  }
  const write = m !== "GET" && m !== "HEAD";
  const lim = limitsFor(env);
  await rateLimit(env, `${write ? "w" : "r"}:${k.principalId}`, write ? lim.writesPerMin : lim.readsPerMin);
  const origin = appOrigin(env.APP_HOST);
  let g: RegExpExecArray | null;

  if (R.projects.test(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json({ projects: k.projects.map((p) => ({ id: p.id, title: p.title, access: p.can_write ? "read_write" : "read", ...(origin ? { web_url: projectWebUrl(origin, p.id) } : {}) })) });
  }
  if ((g = R.files.exec(path))) {
    const pid = g[1];
    if (m === "GET") {
      const ctx = projectCtx(env, k, requestId, pid);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const kind = url.searchParams.get("kind") ?? undefined, folderId = url.searchParams.get("folder_id") ?? undefined;
      if ((kind !== undefined || folderId !== undefined) && !svc.appConnectEnabled(env)) throw new HttpError(400, "invalid_input", "Unknown query parameter");
      const r = await svc.listArtifacts(ctx, pid, { query: url.searchParams.get("query") ?? undefined, cursor, kind, folderId });
      return json({ files: r.artifacts.map((a: any) => fileView(origin, a, env)), next_cursor: r.next_cursor });
    }
    if (m === "POST") {
      writeAllowed(k, pid);
      const key = idemKey(req.headers.get("idempotency-key"));
      const b = await readJson(req);
      if (!svc.appConnectEnabled(env)) {
        if (b.kind !== undefined && b.kind !== "markdown") throw new HttpError(422, "unsupported_kind", "Only kind \"markdown\" is supported in this version");
        const r = await svc.createMarkdown(projectCtx(env, k, requestId, pid), pid, { title: b.title, body: b.body ?? "", folder: b.folder }, key);
        return json(withLinks(origin, pid, r).body, r.status);
      }
      const r = await svc.createFile(projectCtx(env, k, requestId, pid), pid,
        { kind: b.kind, title: b.title, body: b.body, content: b.content, folder: b.folder, folder_id: b.folder_id, schema: b.schema }, key);
      return json(withLinks(origin, pid, r).body, r.status);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
  if ((g = R.file.exec(path))) {
    const [, pid, fid] = g;
    if (m === "GET") {
      const revQ = url.searchParams.get("revision");
      const r: any = await svc.getArtifact(projectCtx(env, k, requestId, pid), pid, fid, revQ !== null ? int(Number(revQ), "revision", 1) : undefined);
      const { content_url: _drop, artifact, ...rest } = r;
      return json({ ...rest, file: fileView(origin, artifact, env),
        content_path: `/v1/projects/${pid}/files/${fid}/content?revision=${r.revision.rev}` }, 200, { etag: `"${r.revision.sha256}"` });
    }
    if (m === "PUT") {
      writeAllowed(k, pid);
      const key = idemKey(req.headers.get("idempotency-key"));
      const b = await readJson(req);
      const r = svc.appConnectEnabled(env)
        ? await svc.saveFile(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, body: b.body, content: b.content }, key)
        : await svc.saveMarkdown(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, body: b.body }, key);
      return json(withLinks(origin, pid, r).body, r.status);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
  if ((g = R.content.exec(path))) {
    const [, pid, fid] = g;
    if (m !== "GET" && m !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    // serveContent never returns HTML (Markdown is text/plain; PNG/PDF/MP4 carry a sandbox CSP + nosniff).
    // Strip owner-UI query switches so the API surface is exactly ?revision=.
    // App Connect: only format=spreadsheet (CSV, formula-neutralized download) passes through.
    const fmt = svc.appConnectEnabled(env) && url.searchParams.get("format") === "spreadsheet" ? "?format=spreadsheet" : "";
    const clean = new Request(`${url.origin}${url.pathname}${fmt}`, { method: m, headers: req.headers });
    return serveContent(projectCtx(env, k, requestId, pid), clean, pid, fid, url.searchParams.get("revision"));
  }
  if ((g = R.records.exec(path))) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const sp = url.searchParams;
    return json(await svc.readRecords(projectCtx(env, k, requestId, pid), pid, fid,
      { from: sp.get("from"), to: sp.get("to"), metric: sp.get("metric"), limit: sp.get("limit"), cursor: sp.get("cursor") }));
  }
  if ((g = R.folders.exec(path))) {
    const pid = g[1];
    if (m === "GET") return json(await svc.listFolders(projectCtx(env, k, requestId, pid), pid));
    if (m === "POST") {
      svc.requireAppConnect(projectCtx(env, k, requestId, pid));
      writeAllowed(k, pid);
      const key = idemKey(req.headers.get("idempotency-key"));
      const r = await svc.createFolder(projectCtx(env, k, requestId, pid), pid, await readJson(req), key);
      return json(r.body, r.status);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
  if ((g = R.revisions.exec(path))) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await svc.history(projectCtx(env, k, requestId, pid), pid, fid));
  }
  throw new HttpError(404, "not_found", "Not found");
}

const BEARER_ERR: Record<string, string> = {
  unauthenticated: 'Bearer realm="agent-library", error="invalid_token"',
  credential_expired: 'Bearer realm="agent-library", error="invalid_token", error_description="expired"',
  credential_revoked: 'Bearer realm="agent-library", error="invalid_token", error_description="revoked"',
};

/** Entry point for /v1 on the MCP host. Always JSON errors, never a redirect (except the flag-gated probe). */
export async function handleV1(req: Request, env: Env): Promise<Response> {
  const requestId = randomId("req", 9);
  const url = new URL(req.url);
  try {
    const res = await route(req, env, url, requestId);
    const r = new Response(res.body, res);
    r.headers.set("x-request-id", requestId);
    return r;
  } catch (caught) {
    if (!(caught instanceof HttpError)) {
      console.error("v1_unhandled", requestId, (caught as Error)?.name ?? "error");
      return json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500, { "x-request-id": requestId });
    }
    let e: HttpError = caught;
    // A write rejected inside the commit batch can mean the key was revoked/expired mid-request:
    // re-verify and report that state (401) rather than a misleading 403.
    if (e.status === 403 && e.code === "forbidden") {
      try { await verifyApiKey(env, req.headers.get("authorization")); }
      catch (e2) { if (e2 instanceof HttpError && e2.status === 401) e = e2; }
    }
    // Service-layer wording is about "grants"; the API speaks of credentials.
    if (e.status === 403 && e.code === "forbidden") e.message = "This credential is not allowed to do this";
    const h: Record<string, string> = { "x-request-id": requestId };
    if (e.status === 401) {
      // Safe diagnostics only: request id, method, path, reason category, key id (if identified), UA (truncated).
      // Never the Authorization value or any part of it.
      console.log("v1_auth_fail " + JSON.stringify({ request_id: requestId, method: req.method, path: url.pathname.slice(0, 120),
        code: e.code, reason: e.extra?.reason ?? "unknown", key_id: e.extra?.key_id ?? null, ua: (req.headers.get("user-agent") ?? "").slice(0, 60) }));
    }
    if (e.status === 401) h["www-authenticate"] = BEARER_ERR[e.code] ?? BEARER_ERR.unauthenticated;
    if (e.status === 403) h["www-authenticate"] = 'Bearer realm="agent-library", error="insufficient_scope"';
    if (e.status === 429 && e.extra?.retry_after_seconds) h["retry-after"] = String(e.extra.retry_after_seconds);
    const b = errorBody(e) as any;
    delete b.error.reason; delete b.error.key_id; // diagnostics stay server-side
    b.error.request_id = requestId;
    return json(b, e.status, h);
  }
}
