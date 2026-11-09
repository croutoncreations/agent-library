import { readOnlyError } from "../tenancy.js";
import { verifyApiKey } from "./credentials.js";
import { agentRate, limitsFor, rateLimit } from "../auth.js";
import { appOrigin, artifactWebUrl, previewWebUrl, projectWebUrl } from "../links.js";
import { addressLinksResponse, projectPaths, resolveProjectRef } from "../paths.js";
import { __name } from "../runtime.js";
import { RT_KINDS_ALL, RT_KINDS_DOCS, appConnectEnabled, chQuery, connectionInfo, createFile, createFolder, createFromTemplate, createMarkdown, diffRevisions, getArtifact, history, listArtifacts, listChanges, listFolders, listTemplates, metaHistory, readRecords, readTextChunk, requireAppConnect, restoreMetadata, restoreRevision, rsQuery, rtQuery, saveFile, saveMarkdown, searchArtifacts } from "../service.js";
import { serveContent } from "../uploads.js";
import { HttpError, errorBody, idemKey, int, json, randomId } from "../util.js";

var MAX_BODY2 = 65e5;
var SEG = "([A-Za-z0-9_-]{1,64})";
var R2 = {
  connectionInfo: /^\/v1\/connection-info$/,
  search: /^\/v1\/search$/,
  projects: /^\/v1\/projects$/,
  changes: new RegExp(`^/v1/projects/${SEG}/changes$`),
  templates: new RegExp(`^/v1/projects/${SEG}/templates$`),
  templateCreate: new RegExp(`^/v1/projects/${SEG}/files/from-template$`),
  files: new RegExp(`^/v1/projects/${SEG}/files$`),
  file: new RegExp(`^/v1/projects/${SEG}/files/${SEG}$`),
  content: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/content$`),
  text: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/text$`),
  revisions: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/revisions$`),
  revisionRestore: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/revisions/([0-9]{1,9})/restore$`),
  diff: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/diff$`),
  metaVersions: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/meta-versions$`),
  metaRestore: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/meta-versions/([0-9]{1,9})/restore$`),
  records: new RegExp(`^/v1/projects/${SEG}/files/${SEG}/records$`),
  folders: new RegExp(`^/v1/projects/${SEG}/folders$`)
};
var isV1Path = (p) => p === "/v1" || p.startsWith("/v1/");
async function readJson(req) {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY2)) throw new HttpError(413, "too_large", "Request body too large");
  const reader = req.body?.getReader();
  const parts = [];
  let n = 0;
  if (reader) for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY2) {
      await reader.cancel().catch(() => {
      });
      throw new HttpError(413, "too_large", "Request body too large");
    }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.byteLength;
  }
  try {
    const v = n ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf)) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}
function projectCtx(env, k, requestId, pid) {
  const p = k.projects.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  return {
    env,
    requestId,
    apiCredential: true,
    principal: { id: k.principalId, kind: "agent", label: `api:${k.label}` },
    grant: { id: k.credentialId, project_id: p.id, can_write: p.can_write ? 1 : 0 },
    via: { kind: "api_key", id: k.credentialId, label: k.label }
  };
}
var writeAllowed = (k, pid) => {
  const p = k.projects.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, "not_found", "Project not found");
  if (!p.can_write && p.read_only) throw readOnlyError(); // writable key, suspended workspace
  if (!p.can_write) throw new HttpError(403, "forbidden", "This credential cannot write to this project");
};
var P1_FIELDS = ["id", "project_id", "kind", "title", "folder", "tags", "revision", "meta_version", "trashed", "updated_at"];
function fileView2(origin, a, env) {
  const base = appConnectEnabled(env) ? a : Object.fromEntries(P1_FIELDS.map((k) => [k, a[k]]));
  const linkable = appConnectEnabled(env) ? ["markdown", "html", "json", "csv"].includes(a.kind) : a.kind === "markdown" || a.kind === "html";
  return { ...base, ...a.is_template ? { is_template: true, template_description: a.template_description } : {}, ...a.source ? { source: a.source } : {}, ...origin ? { web_url: artifactWebUrl(origin, a.project_id, a.id), ...linkable ? { preview_url: previewWebUrl(origin, a.project_id, a.id) } : {} } : {} };
}
__name(fileView2, "fileView");
function withLinks(origin, pid, r) {
  if (!origin || !r.body?.artifact_id) return r;
  return { ...r, body: { ...r.body, web_url: artifactWebUrl(origin, pid, r.body.artifact_id), preview_url: previewWebUrl(origin, pid, r.body.artifact_id) } };
}
async function route2(req, env, url, requestId, seen = {}) {
  const m = req.method;
  let path = url.pathname.replace(/\/$/, "");
  // /v1/projects/<handle>%2F<slug>/… names a project by its address; it's mapped to the id before matching (no
  // authorization here: an address the key can't use answers like an unknown project).
  const am = /^\/v1\/projects\/([a-z0-9-]{1,39}%2[Ff][a-z0-9-]{1,64})(\/.*)?$/.exec(path);
  if (am) path = `/v1/projects/${await resolveProjectRef(env, am[1])}${am[2] ?? ""}`;
  if (path === "/v1/_test/redirect" && env.V1_TEST_ENDPOINTS === "1" && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.host)) {
    const code = Number(url.searchParams.get("code"));
    if (![301, 302, 307, 308].includes(code)) throw new HttpError(400, "invalid_input", "code must be 301, 302, 307 or 308");
    return new Response(null, { status: code, headers: { location: "https://redirect-probe.invalid/v1/projects", "cache-control": "no-store" } });
  }
  const ac = appConnectEnabled(env);
  const known = Object.entries(R2).some(([name, re]) => (ac || name !== "records" && name !== "folders") && re.test(path));
  if (!known) throw new HttpError(404, "not_found", "Not found");
  if (req.headers.get("cookie")) throw new HttpError(400, "invalid_request", "Cookies are not accepted on the API");
  let k;
  try {
    k = await verifyApiKey(env, req.headers.get("authorization"));
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) await rateLimit(env, "authfail:" + (req.headers.get("cf-connecting-ip") ?? "local"), limitsFor(env).authFailPerMin);
    throw e;
  }
  seen.k = k;
  const write = m !== "GET" && m !== "HEAD";
  await rateLimit(env, `${write ? "w" : "r"}:${k.principalId}`, await agentRate(env, k.workspaceId, write));
  const origin = appOrigin(env.APP_HOST);
  let g;
  if (R2.search.test(path)) {
    if (m !== "GET") throw new HttpError(405,"method_not_allowed","Method not allowed");
    return json(await searchArtifacts({ env, requestId, apiCredential: true, principal: { id: k.principalId, kind: "agent" }, grant: { id: k.credentialId } }, rsQuery(url.searchParams)));
  }
  if (R2.connectionInfo.test(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    if (url.search) throw new HttpError(400, "invalid_input", "This diagnostic accepts no parameters");
    return json(connectionInfo("api_key", k.credentialId, k.label, k.projects, k.expiresAt, k.lastActivityAt), 200, { "cache-control": "no-store" });
  }
  if (R2.projects.test(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const paths = await projectPaths(env, k.projects.map((p) => p.id));
    return json({ projects: k.projects.map((p) => ({ id: p.id, title: p.title, ...paths.has(p.id) ? { path: paths.get(p.id) } : {}, access: p.can_write ? "read_write" : "read", ...origin ? { web_url: projectWebUrl(origin, p.id) } : {} })) });
  }
  if (g = R2.changes.exec(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await listChanges(projectCtx(env,k,requestId,g[1]),g[1],chQuery(url.searchParams)));
  }
  if (g = R2.templates.exec(path)) {
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const pid = g[1];
    return json(await listTemplates(projectCtx(env, k, requestId, pid), pid, { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }));
  }
  if (g = R2.templateCreate.exec(path)) {
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const pid = g[1]; writeAllowed(k, pid);
    const result = await createFromTemplate(projectCtx(env, k, requestId, pid), pid, await readJson(req), idemKey(req.headers.get("idempotency-key")));
    return json(result.body, result.status);
  }
  if (g = R2.files.exec(path)) {
    const pid = g[1];
    if (m === "GET") {
      const ctx = projectCtx(env, k, requestId, pid);
      const cursor = url.searchParams.get("cursor") ?? void 0;
      const kind = url.searchParams.get("kind") ?? void 0, folderId = url.searchParams.get("folder_id") ?? void 0;
      if ((kind !== void 0 || folderId !== void 0) && !appConnectEnabled(env)) throw new HttpError(400, "invalid_input", "Unknown query parameter");
      const r = await listArtifacts(ctx, pid, { query: url.searchParams.get("query") ?? void 0, cursor, kind, folderId });
      return json({ files: r.artifacts.map((a) => fileView2(origin, a, env)), next_cursor: r.next_cursor });
    }
    if (m === "POST") {
      writeAllowed(k, pid);
      const key = idemKey(req.headers.get("idempotency-key"));
      const b = await readJson(req);
      if (!appConnectEnabled(env)) {
        if (b.kind !== void 0 && b.kind !== "markdown" && b.kind !== "html") throw new HttpError(422, "unsupported_kind", 'Only kind "markdown" or "html" is supported in this version');
        const r2 = await createMarkdown(projectCtx(env, k, requestId, pid), pid, { title: b.title, body: b.body ?? "", folder: b.folder, change_note: b.change_note }, key, b.kind === "html" ? "html" : "markdown");
        return json(withLinks(origin, pid, r2).body, r2.status);
      }
      const r = await createFile(
        projectCtx(env, k, requestId, pid),
        pid,
        { kind: b.kind, title: b.title, body: b.body, content: b.content, folder: b.folder, folder_id: b.folder_id, schema: b.schema, change_note: b.change_note },
        key
      );
      return json(withLinks(origin, pid, r).body, r.status);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
  if (g = R2.file.exec(path)) {
    const [, pid, fid] = g;
    if (m === "GET") {
      const revQ = url.searchParams.get("revision");
      const r = await getArtifact(projectCtx(env, k, requestId, pid), pid, fid, revQ !== null ? int(Number(revQ), "revision", 1) : void 0);
      const { content_url: _drop, artifact, ...rest } = r;
      return json({
        ...rest,
        file: fileView2(origin, artifact, env),
        content_path: `/v1/projects/${pid}/files/${fid}/content?revision=${r.revision.rev}`
      }, 200, { etag: `"${r.revision.sha256}"` });
    }
    if (m === "PUT") {
      writeAllowed(k, pid);
      const key = idemKey(req.headers.get("idempotency-key"));
      const b = await readJson(req);
      const r = appConnectEnabled(env) ? await saveFile(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, body: b.body, content: b.content, change_note: b.change_note }, key) : await saveMarkdown(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, body: b.body, change_note: b.change_note }, key);
      return json(withLinks(origin, pid, r).body, r.status);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
  if (g = R2.content.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET" && m !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const fmt = appConnectEnabled(env) && url.searchParams.get("format") === "spreadsheet" ? "?format=spreadsheet" : "";
    const clean = new Request(`${url.origin}${url.pathname}${fmt}`, { method: m, headers: req.headers });
    return serveContent(projectCtx(env, k, requestId, pid), clean, pid, fid, url.searchParams.get("revision"));
  }
  if (g = R2.text.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await readTextChunk(projectCtx(env, k, requestId, pid), pid, fid, { ...rtQuery(url.searchParams), kinds: appConnectEnabled(env) ? RT_KINDS_ALL : RT_KINDS_DOCS }));
  }
  if (g = R2.records.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const sp = url.searchParams;
    return json(await readRecords(
      projectCtx(env, k, requestId, pid),
      pid,
      fid,
      { from: sp.get("from"), to: sp.get("to"), metric: sp.get("metric"), limit: sp.get("limit"), cursor: sp.get("cursor") }
    ));
  }
  if (g = R2.folders.exec(path)) {
    const pid = g[1];
    if (m === "GET") return json(await listFolders(projectCtx(env, k, requestId, pid), pid));
    if (m === "POST") {
      requireAppConnect(projectCtx(env, k, requestId, pid));
      writeAllowed(k, pid);
      const key = idemKey(req.headers.get("idempotency-key"));
      const r = await createFolder(projectCtx(env, k, requestId, pid), pid, await readJson(req), key);
      return json(r.body, r.status);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
  if (g = R2.revisions.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await history(projectCtx(env, k, requestId, pid), pid, fid, { cursor: url.searchParams.get("cursor") ?? void 0 }));
  }
  if (g = R2.diff.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await diffRevisions(projectCtx(env, k, requestId, pid), pid, fid, url.searchParams.get("from"), url.searchParams.get("to")));
  }
  if (g = R2.revisionRestore.exec(path)) {
    const [, pid, fid, n] = g;
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    writeAllowed(k, pid);
    const key = idemKey(req.headers.get("idempotency-key"));
    const b = await readJson(req);
    const r = await restoreRevision(projectCtx(env, k, requestId, pid), pid, fid, { expected_revision: b.expected_revision, from_revision: Number(n), change_note: b.change_note }, key);
    return json(withLinks(origin, pid, r).body, r.status);
  }
  if (g = R2.metaVersions.exec(path)) {
    const [, pid, fid] = g;
    if (m !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    return json(await metaHistory(projectCtx(env, k, requestId, pid), pid, fid, false, url.searchParams.get("cursor") ?? void 0));
  }
  if (g = R2.metaRestore.exec(path)) {
    const [, pid, fid, n] = g;
    if (m !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    writeAllowed(k, pid);
    const key = idemKey(req.headers.get("idempotency-key"));
    const b = await readJson(req);
    const r = await restoreMetadata(projectCtx(env, k, requestId, pid), pid, fid, { expected_meta_version: b.expected_meta_version, from_version: Number(n), change_note: b.change_note }, key);
    return json(r.body, r.status);
  }
  throw new HttpError(404, "not_found", "Not found");
}
__name(route2, "route");
var BEARER_ERR = {
  unauthenticated: 'Bearer realm="agent-library", error="invalid_token"',
  credential_expired: 'Bearer realm="agent-library", error="invalid_token", error_description="expired"',
  credential_revoked: 'Bearer realm="agent-library", error="invalid_token", error_description="revoked"'
};
async function handleV1(req, env) {
  const requestId = randomId("req", 9);
  const url = new URL(req.url);
  try {
    const seen = {};
    const res = await addressLinksResponse(env, await route2(req, env, url, requestId, seen), url.pathname, seen.k ? seen.k.projects.map((p) => p.id) : []);
    const r = new Response(res.body, res);
    r.headers.set("x-request-id", requestId);
    return r;
  } catch (caught) {
    if (!(caught instanceof HttpError)) {
      console.error("v1_unhandled", requestId, caught?.name ?? "error");
      return json({ error: { code: "internal", message: "Internal error", request_id: requestId } }, 500, { "x-request-id": requestId });
    }
    let e = caught;
    if (e.status === 403 && e.code === "forbidden") {
      try {
        await verifyApiKey(env, req.headers.get("authorization"));
      } catch (e2) {
        if (e2 instanceof HttpError && e2.status === 401) e = e2;
      }
    }
    if (e.status === 403 && e.code === "forbidden") e.message = "This credential is not allowed to do this";
    const h = { "x-request-id": requestId };
    if (e.status === 401) {
      console.log("v1_auth_fail " + JSON.stringify({
        request_id: requestId,
        method: req.method,
        path: url.pathname.slice(0, 120),
        code: e.code,
        reason: e.extra?.reason ?? "unknown",
        key_id: e.extra?.key_id ?? null,
        ua: (req.headers.get("user-agent") ?? "").slice(0, 60)
      }));
    }
    if (e.status === 401) h["www-authenticate"] = BEARER_ERR[e.code] ?? BEARER_ERR.unauthenticated;
    if (e.status === 403) h["www-authenticate"] = 'Bearer realm="agent-library", error="insufficient_scope"';
    if (e.status === 429 && e.extra?.retry_after_seconds) h["retry-after"] = String(e.extra.retry_after_seconds);
    const b = errorBody(e);
    delete b.error.reason;
    delete b.error.key_id;
    b.error.request_id = requestId;
    return json(b, e.status, h);
  }
}

export { handleV1, isV1Path };
