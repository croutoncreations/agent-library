// Version history: shared input schema and the MCP client name reader (docs/version-history.md).
var CHANGE_NOTE_MAX = 280;
var CHANGE_NOTE_SCHEMA = { type: "string", maxLength: 280, description: "Always include: why you made this change, in one line (e.g. \"Fixed the broken table in Results\"). The owner sees it in the document's history next to who made it. Optional only for old clients." };
// MCP clientInfo is self-reported by the client; never treated as identity. Standard MCP only, nothing custom:
// MCP 2026-07-28 clients send it on every request (params._meta["io.modelcontextprotocol/clientInfo"]); older
// clients send it once, in initialize params.clientInfo, which the endpoints remember on the connection/grant
// (rememberClientInfo) and use when a request carries none. Returns "name version" (<= 120 printable chars) or null.
function mcpClientInfo(params, fallback) {
  const m = params && typeof params === "object" ? params._meta : null;
  const ci = m && typeof m === "object" && m["io.modelcontextprotocol/clientInfo"] || params && params.clientInfo;
  let s = null;
  if (ci && typeof ci === "object" && typeof ci.name === "string") s = ci.name + (typeof ci.version === "string" ? " " + ci.version : "");
  if (typeof s !== "string") s = typeof fallback === "string" ? fallback : null;
  if (s === null) return null;
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  return s || null;
}
// Remember the initialize clientInfo for clients that do not repeat it per request. Best effort, never fails a call.
async function rememberClientInfo(env, table, id, params) {
  const s = mcpClientInfo(params, null);
  if (!s || !id || (table !== "oauth_connections" && table !== "grants")) return;
  await env.DB.prepare(`UPDATE ${table} SET client_info = ? WHERE id = ? AND (client_info IS NULL OR client_info <> ?)`).bind(s, id, s).run().catch(() => {});
}
