
function randomId(prefix, bytes = 12) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + "_" + b64url(b);
}
function b64url(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
/** SHA-256 (hex) of a byte stream, consumed chunk by chunk without buffering it (workerd DigestStream). */
async function sha256HexStream(stream) {
  const d = new crypto.DigestStream("SHA-256");
  await stream.pipeTo(d);
  return hex(await d.digest);
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...headers }
  });
}
function errorBody(e) {
  return { error: { code: e.code, message: e.message, ...e.extra ?? {} } };
}
function str(v, name, max, opts = {}) {
  if (v === void 0 || v === null) {
    if (opts.optional) return "";
    throw new HttpError(400, "invalid_input", `${name} is required`);
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_input", `${name} must be a string`);
  if (v.length < (opts.min ?? 0)) throw new HttpError(400, "invalid_input", `${name} too short`);
  if (v.length > max) throw new HttpError(413, "too_large", `${name} exceeds ${max} characters`);
  return v;
}
function int(v, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new HttpError(400, "invalid_input", `${name} must be an integer in [${min}, ${max}]`);
  return v;
}
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
function idemKey(v) {
  if (typeof v !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(v))
    throw new HttpError(400, "idempotency_key_required", "Idempotency key (8-128 chars [A-Za-z0-9._:-]) is required");
  return v;
}
var HttpError, nowIso, nowMs;
HttpError = class extends Error {
  constructor(status, code, message, extra) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
};
nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
nowMs = () => Date.now();

/**
 * A request body as UTF-8 text, refused once it passes maxBytes (UTF-8 bytes, not characters): a Content-Length over the
 * cap is refused before reading, and the stream is counted as it arrives (a missing or understated length can't pass).
 * Returns null when the body is too large (the caller answers in its own error format).
 */
async function readTextCapped(req, maxBytes) {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= maxBytes)) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * The `truncated` field of a capped list response: the names of the lists that hit their cap (each query fetches cap+1
 * rows and returns cap). An empty array means every list is complete. { members: true, invites: false } -> ["members"].
 */
const cutLists = (flags) => Object.keys(flags).filter((k) => flags[k]);

/** expires_at for credentials that never expire (OAuth connections, "never" API keys): 9999-01-01. */
const NEVER_EXPIRES_AT = Date.UTC(9999, 0, 1);
export { NEVER_EXPIRES_AT, CHANGE_NOTE_MAX, CHANGE_NOTE_SCHEMA, HttpError, b64url, cutLists, errorBody, hex, idemKey, int, json, mcpClientInfo, nowIso, nowMs, randomId, readTextCapped, rememberClientInfo, sha256Hex, sha256HexStream, str };
