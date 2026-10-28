// Ranked lexical search. See docs/ranked-search.md for semantics, rollout and live pagination.
const RS_SCHEMA = { type: "object", additionalProperties: false, required: ["query"], properties: {
  query: { type: "string", minLength: 1, maxLength: 200 },
  project_ids: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } },
  kind: { type: "string", enum: ["markdown", "html", "json", "csv", "binary"] },
  updated_after: { type: "string" }, updated_before: { type: "string" },
  limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string", maxLength: 512 }
} };
function rsQuery(params) {
  const out = {};
  for (const [k, v] of params) {
    if (!(k in RS_SCHEMA.properties) || k in out) throw new HttpError(400, "invalid_input", "Unknown or repeated search parameter");
    out[k] = k === "project_ids" ? v.split(",") : k === "limit" ? Number(v) : v;
  }
  return out;
}
// Reuse the shared read-authorization predicates, correlated to each candidate's project.
function rsScope(ctx) {
  const marker = {}, gate = rtReadAuthzSql(ctx, marker), params = [];
  let n = 0;
  const sql = gate.sql.replace(/\?/g, () => { const v = gate.params[n++]; if (v === marker) return "p.id"; params.push(v); return "?"; });
  return { sql, params };
}
function rsInvalid(message) { throw new HttpError(400, "invalid_input", message); }
function rsNormalize(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) rsInvalid("Search arguments must be an object");
  for (const k of Object.keys(a)) if (!(k in RS_SCHEMA.properties)) rsInvalid("Unknown search parameter");
  if (typeof a.query !== "string" || a.query.length > 200 || !a.query.trim()) rsInvalid("query must contain 1-200 characters");
  const query = a.query.normalize("NFC").trim().replace(/\s+/g, " ");
  // Operators and punctuation are separators; quoted text has no special phrase syntax.
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || []))];
  if (!terms.length || terms.length > 16) rsInvalid("query must contain 1-16 words");
  const ids = a.project_ids === undefined ? null : a.project_ids;
  if (ids !== null && (!Array.isArray(ids) || ids.length > 20 || ids.some(x => typeof x !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(x)))) rsInvalid("project_ids must contain at most 20 project IDs");
  if (a.kind !== undefined && !RS_SCHEMA.properties.kind.enum.includes(a.kind)) rsInvalid("Invalid kind");
  const limit = a.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) rsInvalid("limit must be 1-50");
  const dates = {};
  for (const k of ["updated_after", "updated_before"]) if (a[k] !== undefined) {
    if (typeof a[k] !== "string" || a[k].length > 40 || !/^\d{4}-\d\d-\d\dT/.test(a[k]) || !Number.isFinite(Date.parse(a[k]))) rsInvalid(k + " must be an ISO timestamp");
    dates[k] = new Date(a[k]).toISOString();
  }
  if (dates.updated_after && dates.updated_before && dates.updated_after >= dates.updated_before) rsInvalid("Invalid time range");
  return { query, terms, project_ids: ids === null ? null : [...new Set(ids)].sort(), kind: a.kind ?? null, limit, ...dates };
}
// The installation-local signing key lives only in D1; pagination consumes no OAuth KV operations.
async function rsSearchState(env) {
  return await env.DB.prepare("SELECT ready=1 AND NOT EXISTS(SELECT 1 FROM artifact_search_missing) AS ready, cursor_key FROM artifact_search_state WHERE id=1").first();
}
async function rsReady(env) { return !!await env.DB.prepare("SELECT ready FROM artifact_search_state WHERE id=1").first("ready"); }
// Catalog gating is constant-size; unrelated MCP calls never depend on search state.
async function rsToolReady(env,msg) {
  if(msg.method!=="tools/list" && !(msg.method==="tools/call" && msg.params?.name==="search_artifacts")) return true;
  try { return !!await env.DB.prepare("SELECT ready FROM artifact_search_state WHERE id=1").first("ready"); }
  catch { return false; } // A search outage must not take the existing tool catalog down.
}
function rsBase64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function rsUnbase64(s) { return Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0)); }
async function rsSigningKey(secret) { return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]); }
async function rsCursorEncode(secret,binding,after) {
  const payload=rsBase64(new TextEncoder().encode(JSON.stringify({b:binding,a:after,e:nowMs()+900000})));
  const signature=await crypto.subtle.sign("HMAC",await rsSigningKey(secret),new TextEncoder().encode(payload));
  return "sc2."+payload+"."+rsBase64(new Uint8Array(signature));
}
async function rsCursorDecode(secret,binding,cursor) {
  const bad=()=>new HttpError(400,"invalid_cursor","Expired, invalid or mismatched search cursor; start again");
  if(typeof cursor!=="string" || cursor.length>512 || !/^sc2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw bad();
  try {
    const [,payload,sig]=cursor.split(".");
    if(!await crypto.subtle.verify("HMAC",await rsSigningKey(secret),rsUnbase64(sig),new TextEncoder().encode(payload))) throw bad();
    const v=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(rsUnbase64(payload)));
    if(v.b!==binding || !Number.isSafeInteger(v.e) || v.e<=nowMs() || !Array.isArray(v.a) || v.a.length!==3 || !Number.isInteger(v.a[0]) || typeof v.a[1]!=="string" || v.a[1].length>40 || typeof v.a[2]!=="string" || v.a[2].length>64) throw bad();
    return v.a;
  }catch { throw bad(); }
}
async function searchArtifacts(ctx, args, transport = "api") {
  if (ctx.publisher) throw new HttpError(403, "forbidden", "Search is unavailable to publishers");
  const a = rsNormalize(args), scope = rsScope(ctx);
  const searchState = await rsSearchState(ctx.env);
  if (!searchState?.ready) throw new HttpError(503, "search_initializing", "Search is being prepared; finish the bounded search backfill and retry");
  const kinds = ["markdown", "html", ...(appConnectEnabled(ctx.env) ? ["json", "csv"] : []), ...(!ctx.oauthConnection || ctx.ftConn?.file_access === 1 ? ["binary"] : [])];
  if (a.kind && !kinds.includes(a.kind)) rsInvalid("kind is unavailable on this connection");
  if (a.project_ids?.length) {
    const allowed = await db(ctx).prepare(`SELECT p.id FROM projects p WHERE ${scope.sql} AND p.id IN (SELECT value FROM json_each(?))`).bind(...scope.params, JSON.stringify(a.project_ids)).all();
    if (allowed.results.length !== a.project_ids.length) throw new HttpError(404, "not_found", "Project not found");
  }
  const binding = await sha256Hex(JSON.stringify([ctx.principal.id, ctx.grant?.id ?? null, !!ctx.oauthConnection, !!ctx.apiCredential, kinds, a]));
  const after = args.cursor === undefined ? null : await rsCursorDecode(searchState.cursor_key,binding,args.cursor);
  if (a.project_ids?.length === 0) return { results: [], has_more: false, next_cursor: null };
  const match = a.terms.map(t => '"' + t + '"').join(" AND ");
  const titleScore = a.terms.map(() => "CASE WHEN instr(lower(a.title),?)>0 THEN 1 ELSE 0 END").join(" + ");
  const where = [scope.sql, "a.trashed_at IS NULL", "a.head_rev>0", "s.revision_id=r.id", "s.sha256=r.sha256", "s.title=a.title",
    "a.kind IN (SELECT value FROM json_each(?))",
    "(a.generation_id IS NULL OR EXISTS (SELECT 1 FROM publisher_generations pg WHERE pg.id=a.generation_id AND pg.publisher_id=a.publisher_id AND pg.state='committed'))"];
  const values = [...scope.params, JSON.stringify(a.kind ? [a.kind] : kinds)];
  if (a.project_ids !== null) { where.push("p.id IN (SELECT value FROM json_each(?))"); values.push(JSON.stringify(a.project_ids)); }
  for (const [k, op] of [["updated_after", ">"], ["updated_before", "<"]]) if (a[k]) { where.push(`a.updated_at ${op} ?`); values.push(a[k]); }
  // No corpus-wide rank statistic: hidden documents cannot affect the order of authorized hits.
  const sql = `WITH hits AS (
    SELECT a.id, a.project_id, p.title AS project_title, a.title, a.kind, a.updated_at, r.rev_no, r.sha256,
      (CASE WHEN lower(a.title)=lower(?) THEN 1000 ELSE 0 END + (${titleScore})) AS score,
      CASE WHEN (${titleScore})>0 THEN 'title' ELSE 'body' END AS matched_field,
      CASE WHEN a.kind='binary' THEN a.title ELSE substr(snippet(artifact_search,4,'','',' … ',40),1,500) END AS snippet
    FROM artifact_search s JOIN artifacts a ON a.id=s.artifact_id JOIN projects p ON p.id=a.project_id
      JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
    WHERE artifact_search MATCH ? AND ${where.join(" AND ")}
  ) SELECT * FROM hits ${after ? "WHERE score < ? OR (score = ? AND (updated_at < ? OR (updated_at = ? AND id > ?)))" : ""}
    ORDER BY score DESC, updated_at DESC, id ASC LIMIT ?`;
  const tail = after ? [after[0], after[0], after[1], after[1], after[2]] : [];
  const rows = (await db(ctx).prepare(sql).bind(a.query, ...a.terms, ...a.terms, match, ...values, ...tail, a.limit + 1).all()).results;
  const origin = appOrigin(ctx.env.APP_HOST);
  const results = rows.slice(0, a.limit).map(r => ({
    project_id: r.project_id, project_title: r.project_title, artifact_id: r.id, title: r.title, kind: r.kind,
    matched_field: r.matched_field, snippet: (r.snippet || r.title).slice(0,500), indexed_body: r.kind !== "binary",
    revision: r.rev_no, sha256: r.sha256, updated_at: r.updated_at,
    web_url: origin ? artifactWebUrl(origin,r.project_id,r.id) + "?v=" + r.rev_no : null,
    preview_url: origin ? previewWebUrl(origin,r.project_id,r.id) + "?v=" + r.rev_no : null
  }));
  const token = "x".repeat(512); // Conservative reservation for the signed cursor in both encoded copies.
  const out = { results, has_more: rows.length > a.limit, next_cursor: null };
  // Budget the complete duplicated JSON MCP envelope (including JSON escaping and the echoed ID), not just snippets.
  const wire = () => new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "", result: { content: [{ type: "text", text: JSON.stringify({ ...out, next_cursor: token }) }], structuredContent: { ...out, next_cursor: token }, isError: false } })).length + (ctx.rpcIdBytes ?? 1024);
  while (results.length && wire() > 65536) { results.pop(); out.has_more = true; }
  if (out.has_more && results.length) {
    const last = rows[results.length-1];
    out.next_cursor = await rsCursorEncode(searchState.cursor_key,binding,[last.score,last.updated_at,last.id]);
  }
  return out;
}
