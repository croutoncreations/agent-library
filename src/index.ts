import { verifyAccess } from "./access";
import { authenticate, enforceRate, requireCsrf, requireHuman, SESSION_COOKIE, type Ctx, type Env } from "./auth";
import { exportBackup, restoreBackup } from "./backup";
import { reconcileUploads } from "./cleanup";
import { listAccess, listConnections, revokeConnection, revokeConnectionById } from "./oauth/connections";
import { handleOAuthHost, type OAuthEnv } from "./oauth/server";
import { handleMcp } from "./mcp";
import { imageRefs, renderMarkdown } from "./markdown";
import * as svc from "./service";
import { APP_HTML, APP_JS, APP_CSS } from "./ui";
import { serveContent, uploadBegin, uploadFinish, uploadPut } from "./uploads";
import { errorBody, HttpError, idemKey, json, nowIso, nowMs, randomId, sha256Hex, str } from "./util";
import { WEB_ROUTE } from "./links";
import { handleV1, isV1Path } from "./api/v1";
import { createApiKey, listApiKeys, replaceApiKey, revokeApiKey, setApiKeyScope } from "./api/credentials";
import { disableAppClient, listAppClients, registerAppClient, revokePublisher } from "./api/app-clients";

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function withSec(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  return r;
}

async function body(req: Request): Promise<any> {
  const t = await req.text();
  if (t.length > 2 * 1024 * 1024) throw new HttpError(413, "too_large", "Request body too large");
  try { return t ? JSON.parse(t) : {}; } catch { throw new HttpError(400, "invalid_json", "Malformed JSON"); }
}

const out = (r: { status: number; body: unknown } | unknown, dflt = 200) =>
  r && typeof (r as any).status === "number" && "body" in (r as any) ? json((r as any).body, (r as any).status) : json(r, dflt);

/**
 * Local-only human login (Access is the intended hosted identity; it is not configured yet).
 * Enabled only when LOCAL_DEV_LOGIN is set (from ignored .dev.vars) AND the request host is loopback.
 */
async function devLogin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.LOCAL_DEV_LOGIN || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new HttpError(404, "not_found", "Not found");
  const b = await body(req);
  const supplied = await sha256Hex(String(b.passphrase ?? ""));
  if (supplied !== (await sha256Hex(env.LOCAL_DEV_LOGIN))) throw new HttpError(401, "unauthenticated", "Bad passphrase");
  let p = await env.DB.prepare("SELECT id FROM principals WHERE issuer = 'local-dev' AND subject = 'owner'").first<string>("id");
  if (!p) {
    p = randomId("hum");
    await env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', 'local-dev', 'owner', 'Owner', ?)").bind(p, nowIso()).run();
  }
  const sid = randomId("ses", 32);
  const csrf = randomId("csrf", 18);
  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(sid), p, csrf, nowMs() + 8 * 3600_000).run();
  return json({ ok: true, csrf }, 200, {
    "set-cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${url.protocol === "https:" ? "; Secure" : ""}`,
  });
}

/** Hosted human login: exchange a verified Cloudflare Access identity for an app session + CSRF token. */
async function accessLogin(req: Request, env: Env, url: URL): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "bad_origin", "Cross-origin requests are not allowed");
  const id = await verifyAccess(req, env);
  let p = await env.DB.prepare("SELECT id, kind FROM principals WHERE issuer = ? AND subject = ?").bind(id.issuer, id.subject).first<any>();
  if (p && p.kind !== "human") throw new HttpError(403, "forbidden", "Not a human principal");
  if (!p) {
    p = { id: randomId("hum") };
    await env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', ?, ?, 'Owner', ?)")
      .bind(p.id, id.issuer, id.subject, nowIso()).run();
  }
  const sid = randomId("ses", 32);
  const csrf = randomId("csrf", 18);
  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(sid), p.id, csrf, nowMs() + 8 * 3600_000).run();
  return json({ ok: true, csrf }, 200, {
    "set-cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
  });
}

async function route(req: Request, env: Env, url: URL, requestId: string): Promise<Response> {
  const path = url.pathname;
  const m = req.method;
  // Browser deep links (/p/:project, /p/:project/a/:artifact) serve the same app shell; the app reads the
  // path after sign-in. Being real paths (not #fragments), they survive the Cloudflare Access login redirect.
  // The shell contains no data; authorization happens on the /api calls it makes.
  if (m === "GET" && (path === "/" || path === "/index.html" || WEB_ROUTE.test(path))) return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (m === "GET" && path === "/app.js") return new Response(APP_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
  if (m === "GET" && path === "/app.css") return new Response(APP_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
  if (path === "/mcp") return handleMcp(req, env, requestId, url.origin);
  if (m === "GET" && path.startsWith("/.well-known/oauth-protected-resource"))
    return json({ resource: url.origin + "/mcp", authorization_servers: [], bearer_methods_supported: ["header"],
      resource_documentation: "Prototype: project-scoped bearer grants issued by the owner. OAuth authorization server not yet configured." });
  if (m === "POST" && path === "/auth/dev-login") return devLogin(req, env, url);
  if (m === "POST" && path === "/auth/access-login") return accessLogin(req, env, url);

  // CORS: same-origin only. Reject cross-site browser mutations outright.
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "bad_origin", "Cross-origin requests are not allowed");

  const tm = /^\/api\/transfers\/([A-Za-z0-9_-]+)$/.exec(path);
  if (tm && m === "PUT") return uploadPut(req, env, requestId, tm[1]);

  if (!path.startsWith("/api/")) throw new HttpError(404, "not_found", "Not found");
  const ctx: Ctx = await authenticate(req, env, requestId);
  if (m !== "GET" && m !== "HEAD") requireCsrf(ctx, req);
  await enforceRate(ctx, m !== "GET" && m !== "HEAD");
  const key = () => idemKey(req.headers.get("idempotency-key"));
  const seg = path.split("/").slice(2); // after /api

  if (seg[0] === "me" && m === "GET") return json({ principal: ctx.principal, csrf: ctx.csrf ?? null });
  if (seg[0] === "logout" && m === "POST") {
    requireHuman(ctx);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").bind(nowMs(), ctx.principal.id).run();
    return json({ ok: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (seg[0] === "restore" && m === "POST") return json(await restoreBackup(ctx, await body(req)), 201);
  // Owner-wide "Connected apps": OAuth connections across all projects + agent grants.
  if (seg[0] === "access" && seg.length === 1 && m === "GET") return json(await listAccess(ctx));
  if (seg[0] === "connections" && seg.length === 3 && seg[2] === "revoke" && m === "POST") return json(await revokeConnectionById(ctx, str(seg[1], "connection", 80)));
  // Owner-only API key management (Settings -> API keys). requireHuman inside each; CSRF enforced above.
  if (seg[0] === "api-keys") {
    if (seg.length === 1 && m === "GET") return json(await listApiKeys(ctx));
    if (seg.length === 1 && m === "POST") return json(await createApiKey(ctx, await body(req)), 201);
    const kid = str(seg[1], "key", 64);
    if (seg.length === 3 && seg[2] === "replace" && m === "POST") return json(await replaceApiKey(ctx, kid, await body(req)), 201);
    if (seg.length === 3 && seg[2] === "scope" && m === "PUT") return json(await setApiKeyScope(ctx, kid, await body(req)));
    if (seg.length === 3 && seg[2] === "revoke" && m === "POST") return json(await revokeApiKey(ctx, kid));
    throw new HttpError(404, "not_found", "Not found");
  }
  // Owner-only App Connect administration (flag-gated inside).
  if (seg[0] === "app-clients") {
    if (seg.length === 1 && m === "GET") return json(await listAppClients(ctx));
    if (seg.length === 1 && m === "POST") return json(await registerAppClient(ctx, await body(req)), 201);
    if (seg.length === 3 && seg[2] === "disable" && m === "POST") return json(await disableAppClient(ctx, str(seg[1], "app", 64)));
    throw new HttpError(404, "not_found", "Not found");
  }
  if (seg[0] === "publishers" && seg.length === 3 && seg[2] === "revoke" && m === "POST") return json(await revokePublisher(ctx, str(seg[1], "publisher", 64)));
  if (seg[0] !== "projects") throw new HttpError(404, "not_found", "Not found");
  if (seg.length === 1) {
    if (m === "GET") return json(await svc.listProjects(ctx));
    if (m === "POST") return json(await svc.createProject(ctx, await body(req)), 201);
  }
  const pid = str(seg[1], "project", 64);
  const rest = seg.slice(2);
  if (rest[0] === "grants") {
    if (rest.length === 1 && m === "GET") return json(await svc.listGrants(ctx, pid));
    if (rest.length === 1 && m === "POST") return json(await svc.createGrant(ctx, pid, await body(req)), 201);
    if (rest.length === 2 && m === "PATCH") return json(await svc.updateGrant(ctx, pid, rest[1], await body(req)));
  }
  if (rest[0] === "audit" && m === "GET") return json(await svc.listAudit(ctx, pid));
  if (rest[0] === "folders" && rest.length === 1) {
    if (m === "GET") return json(await svc.listFolders(ctx, pid));
    if (m === "POST") return out(await svc.createFolder(ctx, pid, await body(req), key()));
  }
  if (rest[0] === "connections" && rest.length === 1 && m === "GET") return json(await listConnections(ctx, pid));
  if (rest[0] === "connections" && rest.length === 3 && rest[2] === "revoke" && m === "POST") return json(await revokeConnection(ctx, pid, str(rest[1], "connection", 80)));
  if (rest[0] === "maintenance" && rest[1] === "reconcile-uploads" && m === "POST") {
    requireHuman(ctx);
    await svc.listGrants(ctx, pid); // owner-of-project check (404 otherwise)
    return json(await reconcileUploads(env, { projectId: pid, limit: 100 }));
  }
  if (rest[0] === "backup" && m === "GET") return json(await exportBackup(ctx, pid));
  if (rest[0] === "uploads") {
    if (rest.length === 1 && m === "POST") return out(await uploadBegin(ctx, pid, await body(req), key()));
    if (rest.length === 3 && rest[2] === "finish" && m === "POST") return out(await uploadFinish(ctx, pid, rest[1], key()));
  }
  if (rest[0] === "artifacts") {
    if (rest.length === 1 && m === "GET") {
      const kind = url.searchParams.get("kind") ?? undefined, folderId = url.searchParams.get("folder_id") ?? undefined;
      if (kind !== undefined || folderId !== undefined) svc.requireAppConnect(ctx);
      return json(await svc.listArtifacts(ctx, pid, { query: url.searchParams.get("q") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined, trashed: url.searchParams.get("trashed") === "1", kind, folderId }));
    }
    if (rest.length === 1 && m === "POST") return out(svc.appConnectEnabled(env) ? await svc.createFile(ctx, pid, await body(req), key()) : await svc.createMarkdown(ctx, pid, await body(req), key()));
    const aid = str(rest[1], "artifact", 64);
    const sub = rest[2];
    const revQ = url.searchParams.get("rev");
    if (!sub && m === "GET") {
      const r = await svc.getArtifact(ctx, pid, aid, revQ ? Number(revQ) : undefined);
      return json(r, 200, { etag: `"${r.revision.sha256}"` });
    }
    if (!sub && m === "PUT") return out(svc.appConnectEnabled(env) ? await svc.saveFile(ctx, pid, aid, await body(req), key()) : await svc.saveMarkdown(ctx, pid, aid, await body(req), key()));
    if (sub === "records" && m === "GET") {
      const sp = url.searchParams;
      return json(await svc.readRecords(ctx, pid, aid, { from: sp.get("from"), to: sp.get("to"), metric: sp.get("metric"), limit: sp.get("limit"), cursor: sp.get("cursor") }));
    }
    if (!sub && m === "PATCH") return out(await svc.updateMetadata(ctx, pid, aid, await body(req), key()));
    if (sub === "preview" && m === "GET") {
      const r = await svc.getArtifact(ctx, pid, aid, revQ ? Number(revQ) : undefined);
      if (r.artifact.kind !== "markdown") throw new HttpError(400, "invalid_input", "Not Markdown");
      const src = (r as any).body as string;
      // Inline images: only current, non-trashed PNG artifacts in this same project (already authorized above).
      const refs = imageRefs(src);
      const ok = new Set<string>();
      if (refs.length) {
        const q = await env.DB.prepare(
          `SELECT a.id FROM artifacts a JOIN revisions v ON v.id = a.head_revision_id
           WHERE a.project_id = ? AND a.trashed_at IS NULL AND v.mime = 'image/png' AND a.id IN (${refs.map(() => "?").join(",")})`,
        ).bind(pid, ...refs).all<any>();
        for (const row of q.results) ok.add(row.id);
      }
      const html = renderMarkdown(src, (ref) => ok.has(ref) ? `/api/projects/${encodeURIComponent(pid)}/artifacts/${encodeURIComponent(ref)}/content` : null);
      return json({ revision: r.revision.rev, html });
    }
    if (sub === "content" && (m === "GET" || m === "HEAD")) return serveContent(ctx, req, pid, aid, revQ);
    if (sub === "history" && m === "GET") return json(await svc.history(ctx, pid, aid));
    if (sub === "restore" && m === "POST") return out(await svc.restoreRevision(ctx, pid, aid, await body(req), key()));
    if (sub === "comments" && m === "GET") return json(await svc.listComments(ctx, pid, aid));
    if (sub === "comments" && m === "POST") return out(await svc.addComment(ctx, pid, aid, await body(req), key()));
  }
  throw new HttpError(404, "not_found", "Not found");
}

export default {
  // Cron: expire abandoned uploads and delete their R2 objects (bounded, idempotent).
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(reconcileUploads(env, { limit: 100 }).then((r) => console.log("reconcile", JSON.stringify(r))));
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const requestId = randomId("req", 9);
    // Host dispatcher (first): exact hostnames only. The OAuth host never reaches the owner app router.
    const host = url.host.toLowerCase();
    const e2 = env as OAuthEnv;
    if (e2.MCP_HOST && host === e2.MCP_HOST.toLowerCase()) {
      // Machine REST API for API-credential clients (Muse). JSON only, no redirects, no cookies.
      // /v1/publisher/* is the publisher OAuth resource (App Connect, flag on only): served by the OAuth host.
      const publisherRoute = (env as any).APP_CONNECT_ENABLED === "1" && /^\/v1\/publisher(\/|$)/.test(url.pathname);
      if (isV1Path(url.pathname) && !publisherRoute) return withSec(await handleV1(req, env));
      return withSec(await handleOAuthHost(req, e2, ctx, host));
    }
    if (e2.APP_HOST && host !== e2.APP_HOST.toLowerCase())
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const res = await route(req, env, url, requestId);
      res.headers.set?.("x-request-id", requestId);
      return withSec(res);
    } catch (e) {
      if (e instanceof HttpError) {
        const h: Record<string, string> = { "x-request-id": requestId };
        if (e.status === 429 && e.extra?.retry_after_seconds) h["retry-after"] = String(e.extra.retry_after_seconds);
        return withSec(json(errorBody(e), e.status, h));
      }
      console.error("unhandled", requestId, (e as Error)?.message);
      return withSec(json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500));
    }
  },
};
