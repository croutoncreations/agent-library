import { adapters, notify, resolveAdapters, withAdapters } from "./adapters.js";
import { browserSignInEnabled, checkEmailPage, signinCallback, signinChoices, signinStart } from "./identity/browser.js";
import { TURNSTILE_ORIGIN, turnstileSiteKey } from "./identity/turnstile.js";
import { disableAppClient, listAppClients, registerAppClient, revokePublisher, updateAppClient } from "./api/app-clients.js";
import { createApiKey, listApiKeys, replaceApiKey, revokeApiKey, setApiKeyScope } from "./api/credentials.js";
import { handleV1, isV1Path } from "./api/v1.js";
import { authenticate, enforceRate, requireCsrf, requireHuman, sessionCookie } from "./auth.js";
import { exportBackup, importBackup, restoreBackup } from "./backup.js";
import { reconcileUploads } from "./cleanup.js";
import { EDITOR_JS, EDITOR_JS_SHA256 } from "./editor-bundle.js";
import { RENDER_CSP, htmlRefs, renderHtmlDocument } from "./html.js";
import { WEB_ROUTE } from "./links.js";
import { imageRefs, renderMarkdown } from "./markdown.js";
import { handleMcp } from "./mcp.js";
import { listAccess, listConnections, revokeConnection, revokeConnectionById } from "./oauth/connections.js";
import { handleFileTransfer } from "./oauth/mcp.js";
import { handleOAuthHost, originFor } from "./oauth/server.js";
import { servePwa } from "./pwa.js";
import { acceptInvite, createInvite, createWorkspace, deleteWorkspace, listMembers, listWorkspaces, multiUser, previewInvite, removeMember, revokeInvite, setMemberRole, updateWorkspace } from "./workspaces.js";
import { __name } from "./runtime.js";
import { IMAGE_TYPES, VIDEO_TYPES, addComment, appConnectEnabled, chQuery, cleanupChanges, createFile, createFolder, createFromTemplate, createGrant, createMarkdown, createProject, diffRevisions, getArtifact, history, listArtifacts, listAudit, listChanges, listComments, listFolders, listGrants, listProjects, listTemplates, metaHistory, previewTemplate, readRecords, readTextChunk, requireAppConnect, restoreMetadata, restoreRevision, rsQuery, rsReady, rtQuery, saveAsTemplate, saveFile, saveMarkdown, searchArtifacts, updateGrant, updateMetadata } from "./service.js";
import { APP_CSS, APP_HTML, APP_JS } from "./ui.js";
import { serveContent, uploadBegin, uploadFinish, uploadPut } from "./uploads.js";
import { HttpError, errorBody, idemKey, json, nowIso, nowMs, randomId, sha256Hex, str } from "./util.js";

var SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; manifest-src 'self'; worker-src 'self'"
};
async function projectMedia(env, pid, refs) {
  const ok2 = /* @__PURE__ */ new Map();
  if (refs.length) {
    const types = [...IMAGE_TYPES, ...VIDEO_TYPES];
    const q = await env.DB.prepare(
      `SELECT a.id, v.mime FROM artifacts a JOIN revisions v ON v.id = a.head_revision_id
       WHERE a.project_id = ? AND a.trashed_at IS NULL AND v.mime IN (${types.map(() => "?").join(",")}) AND a.id IN (${refs.map(() => "?").join(",")})`
    ).bind(pid, ...types, ...refs).all();
    for (const row of q.results) ok2.set(row.id, row.mime);
  }
  return (ref) => {
    const mime = ok2.get(ref);
    return mime ? { url: `/api/projects/${encodeURIComponent(pid)}/artifacts/${encodeURIComponent(ref)}/content`, mime } : null;
  };
}
/**
 * The app shell's CSP. With the email-link human check on (TURNSTILE_SITE_KEY) and browser sign-in, Cloudflare's
 * Turnstile script and frame are allowed on the shell only; every other response keeps the strict default.
 */
/** The site key the app's sign-in card renders, only when an email-link option exists (else no widget, no CSP change). */
function emailTurnstile(env) {
  return browserSignInEnabled(env) && signinChoices(env).some((c) => c.email) ? turnstileSiteKey(env) : null;
}
function appShellCsp(env) {
  if (!emailTurnstile(env)) return {};
  return { "content-security-policy": SEC_HEADERS["content-security-policy"]
    .replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`).replace("frame-src 'self'", `frame-src 'self' ${TURNSTILE_ORIGIN}`) };
}
function withCookies(res, cookies) {
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}
function withSec(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  return r;
}
async function body(req) {
  const t = await req.text();
  if (t.length > 2 * 1024 * 1024) throw new HttpError(413, "too_large", "Request body too large");
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "Malformed JSON");
  }
}
var out = (r, dflt = 200) => r && typeof r.status === "number" && "body" in r ? json(r.body, r.status) : json(r, dflt);
async function devLogin(req, env, url) {
  if (!env.LOCAL_DEV_LOGIN || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new HttpError(404, "not_found", "Not found");
  const b = await body(req);
  const supplied = await sha256Hex(String(b.passphrase ?? ""));
  if (supplied !== await sha256Hex(env.LOCAL_DEV_LOGIN)) throw new HttpError(401, "unauthenticated", "Bad passphrase");
  // Local development only: `user` picks a synthetic person (default "owner"), so multi-user flows can be tested.
  // Each gets the email <user>@example.test (used to match invitations) and a personal workspace (migration trigger).
  const user = b.user === void 0 ? "owner" : str(b.user, "user", 32);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(user)) throw new HttpError(400, "invalid_input", "user must be lower-case letters, digits or -");
  let p = await env.DB.prepare("SELECT id FROM principals WHERE issuer = 'local-dev' AND subject = ?").bind(user).first("id");
  if (!p) {
    p = randomId("hum");
    const label = user === "owner" ? "Owner" : user.charAt(0).toUpperCase() + user.slice(1);
    await env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at, email) VALUES (?, 'human', 'local-dev', ?, ?, ?, ?)").bind(p, user, label, nowIso(), `${user}@example.test`).run();
  }
  const sid = randomId("ses", 32);
  const csrf = randomId("csrf", 18);
  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(sid), p, csrf, nowMs() + 8 * 36e5).run();
  return withCookies(json({ ok: true, csrf }), sessionCookie(url, sid, 28800));
}
async function accessLogin(req, env, url) {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "bad_origin", "Cross-origin requests are not allowed");
  const id = await adapters(env).identity.login(req, env);
  if (!id) throw new HttpError(401, "access_not_configured", "Hosted identity is not configured");
  let p = await env.DB.prepare("SELECT id, kind FROM principals WHERE issuer = ? AND subject = ?").bind(id.issuer, id.subject).first();
  if (p && p.kind !== "human") throw new HttpError(403, "forbidden", "Not a human principal");
  if (!p) {
    const owners = (await env.DB.prepare("SELECT id FROM principals WHERE kind = 'human' AND issuer = ?").bind(id.issuer).all()).results;
    if (owners.length > 1) throw new HttpError(409, "identity_changed", "This sign-in has a new Access user ID and the owner account is ambiguous. No account was created.");
    if (owners.length === 1) {
      await env.DB.prepare("UPDATE principals SET subject = ? WHERE id = ?").bind(id.subject, owners[0].id).run();
      console.log("owner_subject_relinked", owners[0].id);
      p = { id: owners[0].id };
    }
  }
  if (!p) {
    p = { id: randomId("hum") };
    await env.DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', ?, ?, 'Owner', ?)").bind(p.id, id.issuer, id.subject, nowIso()).run();
  }
  // Keep the verified sign-in email current (matches workspace invitations). Never used for authorization.
  if (id.email) await env.DB.prepare("UPDATE principals SET email = ? WHERE id = ? AND email IS NOT ?").bind(String(id.email).toLowerCase(), p.id, String(id.email).toLowerCase()).run();
  const sid = randomId("ses", 32);
  const csrf = randomId("csrf", 18);
  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(sid), p.id, csrf, nowMs() + 30 * 864e5).run();
  return withCookies(json({ ok: true, csrf }), sessionCookie(url, sid, 2592000));
}
async function route3(req, env, url, requestId) {
  const path = url.pathname;
  const m = req.method;
  if (m === "GET" && (path === "/" || path === "/index.html" || WEB_ROUTE.test(path) || /^\/invite\/inv_[A-Za-z0-9_-]{20,80}$/.test(path))) return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...appShellCsp(env) } });
  if (m === "GET" && path === "/app.js") return new Response(APP_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
  if (m === "GET" && (path === "/manifest.webmanifest" || path === "/sw.js" || path.startsWith("/icons/"))) {
    const r = servePwa(path);
    if (r) return r;
  }
  if (m === "GET" && path === "/app.css") return new Response(APP_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
  if (m === "GET" && path === `/editor.${EDITOR_JS_SHA256.slice(0, 16)}.js`)
    return new Response(EDITOR_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });
  if (path === "/mcp") return handleMcp(req, env, requestId, url.origin);
  if (m === "GET" && path.startsWith("/.well-known/oauth-protected-resource"))
    return json({
      resource: url.origin + "/mcp",
      authorization_servers: [],
      bearer_methods_supported: ["header"],
      resource_documentation: "Prototype: project-scoped bearer grants issued by the owner. OAuth authorization server not yet configured."
    });
  if (m === "POST" && path === "/auth/dev-login") return devLogin(req, env, url);
  if (m === "POST" && path === "/auth/access-login") return accessLogin(req, env, url);
  // How this installation signs people in (public; the browser app picks its sign-in screen from it).
  if (m === "GET" && path === "/auth/methods") return json({ redirect: browserSignInEnabled(env), choices: signinChoices(env), turnstile_site_key: emailTurnstile(env), access: adapters(env).identity.enabled(env), local: !!env.LOCAL_DEV_LOGIN && ["localhost", "127.0.0.1"].includes(url.hostname) }, 200, { "cache-control": "no-store" });
  if ((m === "GET" || m === "POST") && path === "/auth/signin") return signinStart(req, env, url);
  if (m === "GET" && path === "/auth/callback") return signinCallback(req, env, url);
  if (m === "GET" && path === "/auth/check-email" && browserSignInEnabled(env)) return checkEmailPage();
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "bad_origin", "Cross-origin requests are not allowed");
  const tm = /^\/api\/transfers\/([A-Za-z0-9_-]+)$/.exec(path);
  if (tm && m === "PUT") return uploadPut(req, env, requestId, tm[1]);
  if (!path.startsWith("/api/")) return extraRoute(req, env, url, requestId, null);
  const ctx = await authenticate(req, env, requestId);
  if (m !== "GET" && m !== "HEAD") requireCsrf(ctx, req);
  await enforceRate(ctx, m !== "GET" && m !== "HEAD");
  const key = () => idemKey(req.headers.get("idempotency-key"));
  const seg = path.split("/").slice(2);
  if (seg[0] === "search" && seg[1] === "status" && seg.length === 2 && m === "GET") { requireHuman(ctx); return json({ready: await rsReady(env)}); }
  if (seg[0] === "search" && seg.length === 1 && m === "GET") { requireHuman(ctx); return json(await searchArtifacts(ctx, rsQuery(url.searchParams))); }
  if (seg[0] === "me" && m === "GET") return json({ principal: ctx.principal, csrf: ctx.csrf ?? null, api_base: ctx.env.MCP_HOST ? originFor(ctx.env.MCP_HOST) + "/v1" : null, multi_user: multiUser(ctx.env) });
  if (seg[0] === "logout" && m === "POST") {
    requireHuman(ctx);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").bind(nowMs(), ctx.principal.id).run();
    return withCookies(json({ ok: true }), [...sessionCookie(url, "", 0), "al_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"]);
  }
  if (seg[0] === "workspaces") {
    if (seg.length === 1 && m === "GET") return json(await listWorkspaces(ctx));
    if (seg.length === 1 && m === "POST") return json(await createWorkspace(ctx, await body(req)), 201);
    const wid = str(seg[1], "workspace", 80);
    if (seg.length === 2 && m === "PATCH") return json(await updateWorkspace(ctx, wid, await body(req)));
    if (seg.length === 2 && m === "DELETE") return json(await deleteWorkspace(ctx, wid));
    if (seg[2] === "members" && seg.length === 3 && m === "GET") return json(await listMembers(ctx, wid));
    if (seg[2] === "members" && seg.length === 4 && m === "PATCH") return json(await setMemberRole(ctx, wid, str(seg[3], "member", 80), await body(req)));
    if (seg[2] === "members" && seg.length === 4 && m === "DELETE") return json(await removeMember(ctx, wid, str(seg[3], "member", 80)));
    if (seg[2] === "import" && seg.length === 3 && m === "POST") {
      // Backups embed files as base64; the request cap is 2 MiB (about 1.5 MB of files). Larger projects need a
      // streamed import (later); say so clearly instead of a generic 413. The body is read before refusing (measured in
      // bytes) so HTTP/1 clients receive the error rather than a reset; Cloudflare's own request limit bounds the read.
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) throw new HttpError(413, "backup_too_large", "This backup is larger than 2 MB, the import limit for now. Split the project or remove large files first.");
      let parsed; try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "invalid_json", "Malformed JSON"); }
      const k = req.headers.get("idempotency-key");
      return json(await importBackup(ctx, wid, parsed, k ? idemKey(k) : null, k ? await sha256Hex(raw) : ""), 201);
    }
    if (seg[2] === "invites" && seg.length === 3 && m === "POST") return json(await createInvite(ctx, wid, await body(req), url.origin), 201);
    if (seg[2] === "invites" && seg.length === 5 && seg[4] === "revoke" && m === "POST") return json(await revokeInvite(ctx, wid, str(seg[3], "invite", 80)));
    throw new HttpError(404, "not_found", "Not found");
  }
  if (seg[0] === "invites" && seg.length === 2 && seg[1] === "preview" && m === "POST") return json(await previewInvite(ctx, await body(req)));
  if (seg[0] === "invites" && seg.length === 2 && seg[1] === "accept" && m === "POST") return json(await acceptInvite(ctx, await body(req)));
  if (seg[0] === "restore" && m === "POST") return json(await restoreBackup(ctx, await body(req)), 201);
  if (seg[0] === "access" && seg.length === 1 && m === "GET") return json(await listAccess(ctx));
  if (seg[0] === "connections" && seg.length === 3 && seg[2] === "revoke" && m === "POST") return json(await revokeConnectionById(ctx, str(seg[1], "connection", 80)));
  if (seg[0] === "api-keys") {
    if (seg.length === 1 && m === "GET") return json(await listApiKeys(ctx));
    if (seg.length === 1 && m === "POST") return json(await createApiKey(ctx, await body(req)), 201);
    const kid = str(seg[1], "key", 64);
    if (seg.length === 3 && seg[2] === "replace" && m === "POST") return json(await replaceApiKey(ctx, kid, await body(req)), 201);
    if (seg.length === 3 && seg[2] === "scope" && m === "PUT") return json(await setApiKeyScope(ctx, kid, await body(req)));
    if (seg.length === 3 && seg[2] === "revoke" && m === "POST") return json(await revokeApiKey(ctx, kid));
    throw new HttpError(404, "not_found", "Not found");
  }
  if (seg[0] === "app-clients") {
    if (seg.length === 1 && m === "GET") return json(await listAppClients(ctx));
    if (seg.length === 1 && m === "POST") return json(await registerAppClient(ctx, await body(req)), 201);
    if (seg.length === 3 && seg[2] === "disable" && m === "POST") return json(await disableAppClient(ctx, str(seg[1], "app", 64)));
    if (seg.length === 2 && m === "PUT") return json(await updateAppClient(ctx, str(seg[1], "app", 64), await body(req)));
    throw new HttpError(404, "not_found", "Not found");
  }
  if (seg[0] === "publishers" && seg.length === 3 && seg[2] === "revoke" && m === "POST") return json(await revokePublisher(ctx, str(seg[1], "publisher", 64)));
  if (seg[0] !== "projects") return extraRoute(req, env, url, requestId, ctx);
  if (seg.length === 1) {
    if (m === "GET") return json(await listProjects(ctx));
    if (m === "POST") return json(await createProject(ctx, await body(req)), 201);
  }
  const pid = str(seg[1], "project", 64);
  const rest = seg.slice(2);
  if (rest[0] === "grants") {
    if (rest.length === 1 && m === "GET") return json(await listGrants(ctx, pid));
    if (rest.length === 1 && m === "POST") return json(await createGrant(ctx, pid, await body(req)), 201);
    if (rest.length === 2 && m === "PATCH") return json(await updateGrant(ctx, pid, rest[1], await body(req)));
  }
  if (rest[0] === "changes" && rest.length === 1 && m === "GET") return json(await listChanges(ctx,pid,chQuery(url.searchParams)));
  if (rest[0] === "audit" && m === "GET") return json(await listAudit(ctx, pid));
  if (rest[0] === "folders" && rest.length === 1) {
    if (m === "GET") return json(await listFolders(ctx, pid));
    if (m === "POST") return out(await createFolder(ctx, pid, await body(req), key()));
  }
  if (rest[0] === "connections" && rest.length === 1 && m === "GET") return json(await listConnections(ctx, pid));
  if (rest[0] === "connections" && rest.length === 3 && rest[2] === "revoke" && m === "POST") return json(await revokeConnection(ctx, pid, str(rest[1], "connection", 80)));
  if (rest[0] === "maintenance" && rest[1] === "reconcile-uploads" && m === "POST") {
    requireHuman(ctx);
    await listGrants(ctx, pid);
    return json(await reconcileUploads(env, { projectId: pid, limit: 100 }));
  }
  if (rest[0] === "templates" && rest.length === 1) {
    if (m === "GET") return json(await listTemplates(ctx, pid, { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }));
    if (m === "POST") return out(await saveAsTemplate(ctx, pid, await body(req), key()));
  }
  if (rest[0] === "templates" && rest[1] === "preview" && rest.length === 2 && m === "POST") return json(await previewTemplate(ctx, pid, await body(req)));
  if (rest[0] === "artifacts" && rest[1] === "from-template" && rest.length === 2 && m === "POST") return out(await createFromTemplate(ctx, pid, await body(req), key()));
  if (rest[0] === "backup" && m === "GET") return json(await exportBackup(ctx, pid));
  if (rest[0] === "uploads") {
    if (rest.length === 1 && m === "POST") return out(await uploadBegin(ctx, pid, await body(req), key()));
    if (rest.length === 3 && rest[2] === "finish" && m === "POST") return out(await uploadFinish(ctx, pid, rest[1], key()));
  }
  if (rest[0] === "artifacts") {
    if (rest.length === 1 && m === "GET") {
      const kind = url.searchParams.get("kind") ?? void 0, folderId = url.searchParams.get("folder_id") ?? void 0;
      if (kind !== void 0 || folderId !== void 0) requireAppConnect(ctx);
      return json(await listArtifacts(ctx, pid, { query: url.searchParams.get("q") ?? void 0, cursor: url.searchParams.get("cursor") ?? void 0, trashed: url.searchParams.get("trashed") === "1", kind, folderId, withMime: ctx.principal.kind === "human" && url.searchParams.get("include") === "mime" }));
    }
    if (rest.length === 1 && m === "POST") {
      const b = await body(req);
      if (appConnectEnabled(env)) return out(await createFile(ctx, pid, b, key()));
      if (b?.kind !== void 0 && b.kind !== "markdown" && b.kind !== "html") throw new HttpError(422, "unsupported_kind", "kind must be markdown or html");
      return out(await createMarkdown(ctx, pid, b, key(), b?.kind === "html" ? "html" : "markdown"));
    }
    const aid = str(rest[1], "artifact", 64);
    const sub = rest[2];
    const revQ = url.searchParams.get("rev");
    if (!sub && m === "GET") {
      const r = await getArtifact(ctx, pid, aid, revQ ? Number(revQ) : void 0);
      return json(r, 200, { etag: `"${r.revision.sha256}"` });
    }
    if (!sub && m === "PUT") return out(appConnectEnabled(env) ? await saveFile(ctx, pid, aid, await body(req), key()) : await saveMarkdown(ctx, pid, aid, await body(req), key()));
    if (sub === "records" && m === "GET") {
      const sp = url.searchParams;
      return json(await readRecords(ctx, pid, aid, { from: sp.get("from"), to: sp.get("to"), metric: sp.get("metric"), limit: sp.get("limit"), cursor: sp.get("cursor") }));
    }
    if (!sub && m === "PATCH") return out(await updateMetadata(ctx, pid, aid, await body(req), key()));
    if (sub === "preview" && m === "GET") {
      const r = await getArtifact(ctx, pid, aid, revQ ? Number(revQ) : void 0);
      if (r.artifact.kind !== "markdown") throw new HttpError(400, "invalid_input", "Not Markdown");
      const src = r.body;
      const media = await projectMedia(env, pid, imageRefs(src));
      const html = renderMarkdown(src, (ref) => media(ref));
      return json({ revision: r.revision.rev, html });
    }
    if (sub === "render" && m === "GET") {
      const r = await getArtifact(ctx, pid, aid, revQ ? Number(revQ) : void 0);
      if (r.artifact.kind !== "html") throw new HttpError(400, "invalid_input", "Not an HTML document");
      const src = r.body;
      const media = await projectMedia(env, pid, htmlRefs(src));
      const page2 = renderHtmlDocument(src, (ref) => media(ref), r.artifact.title);
      return new Response(page2, { status: 200, headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": RENDER_CSP,
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "same-origin",
        "x-frame-options": "SAMEORIGIN",
        "x-revision": String(r.revision.rev)
      } });
    }
    if (sub === "content" && (m === "GET" || m === "HEAD")) return serveContent(ctx, req, pid, aid, revQ);
    if (sub === "history" && m === "GET") return json(await history(ctx, pid, aid, { cursor: url.searchParams.get("cursor") ?? void 0 }));
    if (sub === "text" && m === "GET") return json(await readTextChunk(ctx, pid, aid, rtQuery(url.searchParams)));
    if (sub === "diff" && m === "GET") return json(await diffRevisions(ctx, pid, aid, url.searchParams.get("from"), url.searchParams.get("to")));
    if (sub === "meta-history" && m === "GET") return json(await metaHistory(ctx, pid, aid, false, url.searchParams.get("cursor") ?? void 0));
    if (sub === "meta-restore" && m === "POST") return out(await restoreMetadata(ctx, pid, aid, await body(req), key()));
    if (sub === "restore" && m === "POST") return out(await restoreRevision(ctx, pid, aid, await body(req), key()));
    if (sub === "comments" && m === "GET") return json(await listComments(ctx, pid, aid));
    if (sub === "comments" && m === "POST") return out(await addComment(ctx, pid, aid, await body(req), key()));
  }
  return extraRoute(req, env, url, requestId, ctx);
}
__name(route3, "route");
/**
 * Routes an installation adds (hosted: billing, sign-up). Only reached when no core route matched, so they can't
 * shadow or bypass core routes. Under /api/ they get the authenticated ctx (CSRF and rate limits already applied).
 */
async function extraRoute(req, env, url, requestId, ctx) {
  for (const r of adapters(env).routes) {
    if (r.method && r.method !== req.method) continue;
    const hit = typeof r.path === "string" ? r.path === url.pathname : r.path.exec(url.pathname);
    if (!hit) continue;
    if (url.pathname.startsWith("/api/") !== !!ctx) continue;
    // /api/ adapter routes are for people unless the route opts in to agent credentials.
    if (ctx && ctx.principal.kind !== "human" && r.agents !== true) throw new HttpError(403, "forbidden", "People only");
    const res = await r.handler(req, env, { url, requestId, ctx, match: hit === true ? null : hit });
    // Adapter responses can't weaken framing or sniffing protection on the app origin.
    const out = new Response(res.body, res);
    for (const k of ["x-content-type-options", "x-frame-options", "referrer-policy"]) out.headers.set(k, SEC_HEADERS[k]);
    if (!/frame-ancestors 'none'/.test(out.headers.get("content-security-policy") ?? "")) out.headers.set("content-security-policy", SEC_HEADERS["content-security-policy"]);
    return out;
  }
  throw new HttpError(404, "not_found", "Not found");
}
/** The Worker for one installation: core plus its adapters (packages/self-host, or the hosted repo). */
function createWorker(adapterConfig = {}) {
  const A = resolveAdapters(adapterConfig);
  // Fail closed: Cloudflare Access is configured but this entry has no sign-in provider, so it would not be enforced.
  const misconfigured = (env) => A.identity.name === "none" && !!(env?.ACCESS_TEAM_DOMAIN || env?.ACCESS_AUD);
  const refuse = () => new Response(JSON.stringify({ error: { code: "misconfigured", message: "This build has no sign-in provider but Access is configured" } }), { status: 500, headers: { "content-type": "application/json" } });
  return {
    scheduled: (ev, env, ctx) => coreWorker.scheduled(ev, withAdapters(env, A), ctx),
    fetch: async (req, env, ctx) => misconfigured(env) ? refuse() : coreWorker.fetch(req, withAdapters(env, A), ctx)
  };
}
var coreWorker = {
  // Cron: expire abandoned uploads and delete their R2 objects (bounded, idempotent).
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(cleanupChanges(env));
    ctx.waitUntil(reconcileUploads(env, { limit: 100 }).then((r) => console.log("reconcile", JSON.stringify(r))));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const requestId = randomId("req", 9);
    const host = url.host.toLowerCase();
    const e2 = env;
    if (e2.MCP_HOST && host === e2.MCP_HOST.toLowerCase()) {
      const publisherRoute = env.APP_CONNECT_ENABLED === "1" && /^\/v1\/publisher(\/|$)/.test(url.pathname);
      if (url.pathname.startsWith("/files/")) return withSec(await handleFileTransfer(req, env, url));
      if (isV1Path(url.pathname) && !publisherRoute) return withSec(await handleV1(req, env));
      return withSec(await handleOAuthHost(req, e2, ctx, host));
    }
    if (e2.APP_HOST && host !== e2.APP_HOST.toLowerCase())
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const res = await route3(req, env, url, requestId);
      res.headers.set?.("x-request-id", requestId);
      return withSec(res);
    } catch (e) {
      if (e instanceof HttpError) {
        const h = { "x-request-id": requestId };
        if (e.status === 429 && e.extra?.retry_after_seconds) h["retry-after"] = String(e.extra.retry_after_seconds);
        return withSec(json(errorBody(e), e.status, h));
      }
      console.error("unhandled", requestId, e?.message);
      return withSec(json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500));
    }
  }
};
export { createWorker, notify };
