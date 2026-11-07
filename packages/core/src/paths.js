// Addresses: a workspace handle (unique on the installation) and a project slug (unique in its workspace) give every
// project a readable path, <handle>/<slug>, used in links (https://app/<handle>/<slug>/a/<doc>) and accepted wherever
// a project id is (browser API, /v1 as handle%2Fslug, MCP project_id, search project_ids). The id stays the storage
// key; resolving a path only maps it to an id, and the usual authorization then applies, so an address someone can't
// open answers exactly like an unknown one.
import { HttpError } from "./util.js";

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;   // 1-39
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;     // 1-64
const PATH_RE = /^([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9-]{0,63})$/;
/** Never a project id (ids are prj_… or [a-z0-9-] slugs), so it resolves nothing and gets the normal "not found". */
export const NO_PROJECT = "x_no_such_project";

// First path segments the app, API, sign-in and likely installation routes (billing, legal pages) use, plus names
// that would mislead. A handle can't be one of these.
export const RESERVED_HANDLES = new Set(`a about account accounts admin agent agentlibrary agents api api-keys app apps
  assets auth authorize billing blog callback checkout cloudflare connections dashboard device docs edit editor files
  health help home icons invite invites legal library login logout manifest mcp me new null oauth offline org orgs p
  portal pricing privacy project projects publishing r register root s search security settings signin signout signup
  static status stripe supabase support sw system team teams terms token tokens u undefined upstream user users v1 v2
  w webhook webhooks well-known workspace workspaces www`.split(/\s+/).filter(Boolean));

/** Lower-case [a-z0-9-] text from a title or name ("Q3 Notes!" -> "q3-notes"); "" when nothing usable is left. */
export function slugify(text, max = 64) {
  return String(text ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, max).replace(/-+$/, "");
}
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

export function checkHandle(v) {
  if (typeof v !== "string" || !HANDLE_RE.test(v)) throw new HttpError(400, "invalid_input", "Use 1-39 lower-case letters, digits or hyphens (not at the start or end)");
  if (RESERVED_HANDLES.has(v)) throw new HttpError(400, "handle_reserved", `"${v}" is reserved; choose another`);
  return v;
}
export function checkSlug(v) {
  if (typeof v !== "string" || !SLUG_RE.test(v)) throw new HttpError(400, "invalid_input", "Use 1-64 lower-case letters, digits or hyphens (not at the start or end)");
  return v;
}
const isUnique = (e) => /UNIQUE|constraint/i.test(String(e?.message ?? e));

/** Candidates for a derived name: base, base-2 … base-5, then base-<random>. */
function* candidates(base, max, randomOnly) {
  if (!randomOnly) { yield base; for (let i = 2; i <= 5; i++) yield `${base.slice(0, max - 2)}-${i}`; }
  for (let i = 0; i < 6; i++) yield `${base.slice(0, max - 5)}-${rand(4)}`;
}

/**
 * Gives a workspace a handle if it has none (first use of a workspace created before handles, or by the sign-up
 * trigger).
 */
export async function ensureHandle(env, ws) {
  if (ws.handle) return ws.handle;
  // Personal handles are random ("u-k3x9m2p7"): never derived from a person's name or email, and never confirming an
  // account exists. The owner can choose another.
  let base = ws.personal ? "u" : slugify(ws.name, 30);
  if (!ws.personal && (!base || base.length < 2 || RESERVED_HANDLES.has(base))) base = `${base || "team"}-ws`;
  for (const h of ws.personal ? Array.from({ length: 6 }, () => `u-${rand(8)}`) : candidates(base, 39, false)) {
    if (!HANDLE_RE.test(h) || RESERVED_HANDLES.has(h)) continue;
    try {
      const r = await env.DB.prepare("UPDATE workspaces SET handle = ? WHERE id = ? AND handle IS NULL").bind(h, ws.id).run();
      if (r.meta.changes) return h;
      return await env.DB.prepare("SELECT handle FROM workspaces WHERE id = ?").bind(ws.id).first("handle"); // set concurrently
    } catch (e) { if (!isUnique(e)) throw e; }
  }
  throw new HttpError(503, "handle_unavailable", "Couldn't assign a workspace address; try again");
}

/** Gives a project a slug from its title if it has none; also records its workspace id on rows that predate it. */
export async function ensureSlug(env, p) {
  if (p.slug) return p.slug;
  const base = slugify(p.title, 58) || "project";
  for (const s of candidates(base, 64, false)) {
    if (!SLUG_RE.test(s)) continue;
    try {
      const r = await env.DB.prepare("UPDATE projects SET slug = ?, workspace_id = COALESCE(workspace_id, 'wsp_' || owner_id) WHERE id = ? AND slug IS NULL").bind(s, p.id).run();
      if (r.meta.changes) return s;
      return await env.DB.prepare("SELECT slug FROM projects WHERE id = ?").bind(p.id).first("slug");
    } catch (e) { if (!isUnique(e)) throw e; }
  }
  throw new HttpError(503, "slug_unavailable", "Couldn't assign a project address; try again");
}

export const ASSIGN_PER_CALL = 20;
/** Map project id -> "<handle>/<slug>" for the given ids (assigning missing handles and slugs). Unknown ids are absent. */
export async function projectPaths(env, ids) {
  const want = [...new Set((ids ?? []).filter((x) => typeof x === "string" && x))];
  const out = new Map();
  if (!want.length || !env?.DB) return out;
  const rows = (await env.DB.prepare(
    `SELECT p.id, p.title, p.slug, w.id AS wid, w.handle, w.personal, w.name, w.status
     FROM projects p JOIN workspaces w ON w.id = COALESCE(p.workspace_id, 'wsp_' || p.owner_id)
     WHERE p.id IN (SELECT value FROM json_each(?)) AND p.deleted_at IS NULL`
  ).bind(JSON.stringify(want.slice(0, 1000))).all()).results;
  // Missing handles/slugs are assigned here (first use after migration 0020), at most ASSIGN_PER_CALL per request so
  // one request stays far below D1's per-invocation query limit; the rest get theirs on later requests.
  const handles = new Map();
  let budget = ASSIGN_PER_CALL;
  for (const r of rows) {
    if (r.status === "deleting") continue;
    if (!handles.has(r.wid)) {
      if (!r.handle && budget-- <= 0) { handles.set(r.wid, null); continue; }
      handles.set(r.wid, await ensureHandle(env, { id: r.wid, handle: r.handle, personal: r.personal, name: r.name }));
    }
    if (!handles.get(r.wid)) continue;
    if (!r.slug && budget-- <= 0) continue;
    out.set(r.id, `${handles.get(r.wid)}/${await ensureSlug(env, { id: r.id, slug: r.slug, title: r.title })}`);
  }
  return out;
}

/**
 * A project reference as clients send it: an id (returned unchanged) or an address "<handle>/<slug>" (also
 * URL-encoded, "handle%2Fslug"), returned as the id it names, or NO_PROJECT. Never authorizes anything.
 */
export async function resolveProjectRef(env, ref) {
  if (typeof ref !== "string" || !/\/|%2f/i.test(ref)) return ref;
  const m = PATH_RE.exec(ref.replace(/%2f/gi, "/"));
  if (!m) return NO_PROJECT;
  const id = await env.DB.prepare(
    "SELECT p.id FROM workspaces w JOIN projects p ON p.workspace_id = w.id AND p.slug = ? AND p.deleted_at IS NULL WHERE w.handle = ? AND w.status <> 'deleting'"
  ).bind(m[2], m[1]).first("id");
  return id ?? NO_PROJECT;
}

// Only the link fields this code generates are rewritten, at fixed places in its own result shapes (never inside
// records, document bodies or files), and only for projects the caller may open (`allowed`): a link can never reveal
// another workspace's address.
const LINK_KEYS = ["web_url", "preview_url", "version_url"];
const LIST_KEYS = ["artifacts", "projects", "revisions", "results", "changes", "templates", "files"];
const ONE_KEYS = ["artifact", "file", "template"];
const appOrigin = (env) => {
  const h = env?.APP_HOST?.toLowerCase();
  if (!h || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(h)) return null;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) ? `http://${h}` : `https://${h}`;
};
function linkFields(value, f) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const own = (o) => { if (o && typeof o === "object" && !Array.isArray(o)) for (const k of LINK_KEYS) if (typeof o[k] === "string") f(o, k); };
  own(value);
  for (const k of ONE_KEYS) own(value[k]);
  for (const k of LIST_KEYS) if (Array.isArray(value[k])) for (const x of value[k].slice(0, 1000)) own(x);
}
/**
 * Rewrites generated links (…/p/<id>…) in a result object, in place, to …/<handle>/<slug>…. `allowed` is the set of
 * project ids the caller can open (others keep their /p/<id> link).
 */
export async function addressLinks(env, value, allowed) {
  const o = appOrigin(env);
  if (!o || !allowed) return value;
  const ok = allowed instanceof Set ? allowed : new Set(allowed);
  const pre = `${o}/p/`, idOf = (s) => /^([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(s.slice(pre.length))?.[1];
  const ids = new Set();
  linkFields(value, (obj, k) => { if (obj[k].startsWith(pre)) { const id = idOf(obj[k]); if (id && ok.has(id)) ids.add(id); } });
  if (!ids.size) return value;
  const paths = await projectPaths(env, [...ids]);
  linkFields(value, (obj, k) => {
    if (!obj[k].startsWith(pre)) return;
    const id = idOf(obj[k]);
    if (id && paths.has(id)) obj[k] = `${o}/${paths.get(id)}${obj[k].slice(pre.length + id.length)}`;
  });
  return value;
}
// Responses that carry stored content (files, records, text chunks, exports, renders) are never rewritten.
const CONTENT_ROUTE = /\/(content|records|text|backup|render|preview|diff|export)(\/|$)/;
/** Same for a JSON API response the code built (v1, publisher, browser API), for the caller's `allowed` projects. */
export async function addressLinksResponse(env, res, pathname, allowed) {
  if (!res || res.status >= 300 || CONTENT_ROUTE.test(pathname) || !/^application\/json/.test(res.headers.get("content-type") ?? "") || !appOrigin(env)) return res;
  const text = await res.text();
  if (!text.includes(`${appOrigin(env)}/p/`)) return new Response(text, res);
  let v; try { v = JSON.parse(text); } catch { return new Response(text, res); }
  const ok = typeof allowed === "function" ? await allowed() : allowed;
  return new Response(JSON.stringify(await addressLinks(env, v, ok)), res);
}
