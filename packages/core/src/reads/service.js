import { getTextRange } from "../content-store.js";
import { authorizeProject, credentialGate } from "../auth.js";
import { db } from "../service.js";
import { HttpError, int, nowMs } from "../util.js";

// ---------- revision-pinned chunked text reads (docs/chunked-reads.md) ----------
// One shared implementation for every transport (OAuth MCP, legacy /mcp, /v1, browser API). A read returns at most
// one bounded chunk of one immutable version: the cursor pins the version (rev_no + sha256) and the byte offset, so
// chunks never mix versions even while the document is being edited. Every chunk re-checks, in the same statement
// that pins its version, the caller's current read access and trash state (again after reading R2).
const RT_KINDS_ALL = ["markdown", "html", "json", "csv"];
const RT_KINDS_DOCS = ["markdown", "html"];
const RT_DEFAULT_MAX = 64 * 1024, RT_MIN_MAX = 4096, RT_MAX_MAX = 512 * 1024;
// MCP results carry the result twice (content[0].text = JSON text, plus structuredContent) inside the JSON-RPC
// envelope {"jsonrpc":"2.0","id":<id>,"result":{"content":[{"type":"text","text":…}],"structuredContent":…,"isError":false}},
// which is 107 bytes plus the request id echoed back. The MCP handlers pass the id's encoded size as ctx.rpcIdBytes.
const RT_RPC_FIXED = 107;
const RT_DEFAULT_ID_BYTES = 64;
function rtIdBytes(id) {
  try {
    const s = JSON.stringify(id);
    return s === void 0 ? 4 : new TextEncoder().encode(s).length;
  } catch {
    return RT_MAX_MAX;
  }
}
// Whole-response bound for chunked MCP reads, errors included. Both MCP handlers call rtChunkLimit right after
// parsing the request: a chunked read_artifact call (cursor or max_bytes set) whose request id is longer than
// RT_MAX_ID_BYTES is refused before any reply echoes that id, and rtFit bounds every reply the handler then sends.
const RT_MAX_ID_BYTES = 1024;
function rtChunkLimit(msg) {
  if (msg?.method === "tools/call" && msg.params?.name === "search_artifacts") return { maxBytes: 65536, idTooLong: rtIdBytes(msg.id) > RT_MAX_ID_BYTES };
  if (msg?.method === "tools/call" && msg.params?.name === "list_changes") return { maxBytes: 65536, idTooLong: rtIdBytes(msg.id) > RT_MAX_ID_BYTES };
  const a = msg?.method === "tools/call" && msg.params?.name === "read_artifact" ? msg.params.arguments : void 0;
  if (!a || typeof a !== "object" || Array.isArray(a) || a.cursor == null && a.max_bytes == null) return null;
  const m = a.max_bytes;
  const maxBytes = m == null ? RT_DEFAULT_MAX : Number.isInteger(m) && m >= RT_MIN_MAX && m <= RT_MAX_MAX ? m : RT_MIN_MAX;
  return { maxBytes, idTooLong: rtIdBytes(msg.id) > RT_MAX_ID_BYTES };
}
// The JSON-RPC body for a reply: as is, unless a chunked read's reply would exceed its max_bytes; then a compact
// error of the same kind (tool error or JSON-RPC error) that echoes the (at most RT_MAX_ID_BYTES) id.
function rtFit(body, lim) {
  const s = JSON.stringify(body);
  if (!lim || new TextEncoder().encode(s).length <= lim.maxBytes) return s;
  const message = "The response would exceed max_bytes; pass a larger max_bytes";
  if (body && body.result !== void 0) {
    const err = { status: 413, code: "response_too_large", message };
    return JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: err }) }], structuredContent: { error: err }, isError: true } });
  }
  return JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: body?.error?.code ?? -32603, message } });
}
const RT_ID_TOO_LONG = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request id is too long for a chunked read (at most 1024 bytes as JSON)" } };
function rtReadAuthzSql(ctx, projectId) {
  return credentialGate(ctx, projectId, "read");
}
function rtCursorEncode(p, a, r, h, o) {
  return "rc1." + btoa(JSON.stringify([p, a, r, h, o])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function rtCursorDecode(s, projectId, artifactId) {
  const bad = () => new HttpError(400, "invalid_cursor", "cursor is not a read cursor for this document; start again without cursor");
  if (typeof s !== "string" || s.length > 512 || !/^rc1\.[A-Za-z0-9_-]+$/.test(s)) throw bad();
  let v;
  try {
    const b = s.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    v = JSON.parse(atob(b + "===".slice((b.length + 3) % 4)));
  } catch {
    throw bad();
  }
  if (!Array.isArray(v) || v.length !== 5) throw bad();
  const [p, a, r, h, o] = v;
  if (p !== projectId || a !== artifactId || !Number.isInteger(r) || r < 1 || typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h) || !Number.isInteger(o) || o < 1) throw bad();
  return { r, h, o };
}
// Bytes one character adds to the encoded response: JSON once (API), or JSON plus JSON-in-a-JSON-string (MCP).
function rtAsciiCost(b, mcp) {
  if (b === 34 || b === 92) return mcp ? 6 : 2;
  if (b === 8 || b === 9 || b === 10 || b === 12 || b === 13) return mcp ? 5 : 2;
  if (b < 32) return mcp ? 13 : 6;
  return mcp ? 2 : 1;
}
function rtEncodedSize(result, mcp, idBytes) {
  const enc = new TextEncoder(), j = JSON.stringify(result);
  return mcp ? enc.encode(JSON.stringify(j)).length + enc.encode(j).length + RT_RPC_FIXED + idBytes : enc.encode(j).length;
}
// Query-string options for the HTTP routes (?revision=&cursor=&max_bytes=).
function rtQuery(sp) {
  const n = (k) => sp.get(k) === null ? void 0 : Number(sp.get(k));
  return { revision: n("revision"), cursor: sp.get("cursor") ?? void 0, maxBytes: n("max_bytes") };
}
async function readTextChunk(ctx, projectId, artifactId, opts = {}) {
  await authorizeProject(ctx, projectId, false);
  const mcp = opts.encoding === "mcp";
  const maxBytes = opts.maxBytes === void 0 || opts.maxBytes === null ? RT_DEFAULT_MAX : int(opts.maxBytes, "max_bytes", RT_MIN_MAX, RT_MAX_MAX);
  let rev = opts.revision === void 0 || opts.revision === null ? null : int(opts.revision, "revision", 1);
  let pin = null;
  if (opts.cursor !== void 0 && opts.cursor !== null) {
    pin = rtCursorDecode(opts.cursor, projectId, artifactId);
    if (rev !== null && rev !== pin.r) throw new HttpError(400, "invalid_input", "revision does not match the cursor");
    rev = pin.r;
  }
  const offset = pin ? pin.o : 0;
  const az = rtReadAuthzSql(ctx, projectId);
  // One statement pins current access, trash state and the immutable version before fetching its bytes.
  const select = `SELECT a.kind, a.head_rev, a.trashed_at, r.rev_no, r.sha256, r.mime, r.blob_key,
       r.body, r.body_key, CASE WHEN r.body_key IS NOT NULL THEN r.size ELSE length(CAST(r.body AS BLOB)) END AS nbytes,
       (${az.sql}) AS allowed
     FROM artifacts a LEFT JOIN revisions r ON r.artifact_id = a.id AND r.project_id = a.project_id AND r.rev_no = COALESCE(?, a.head_rev)
     WHERE a.id = ? AND a.project_id = ?`;
  const row = await db(ctx).prepare(select).bind(...az.params, rev, artifactId, projectId).first();
  // Access ended between authentication and this chunk (revoked, expired or project removed): same answer as a
  // project the caller cannot see, whether or not the document exists. The next request fails authentication.
  if (!row || !row.allowed) throw new HttpError(404, "not_found", "Artifact not found");
  if (row.trashed_at || row.head_rev === 0) throw new HttpError(404, "not_found", "Artifact not found");
  const kinds = opts.kinds ?? RT_KINDS_ALL;
  if (!kinds.includes(row.kind)) throw new HttpError(415, "unsupported_kind", kinds === RT_KINDS_DOCS ? "Only Markdown and HTML documents are available to this connection" : "Only text documents (Markdown, HTML, JSON, CSV) can be read as text");
  if (row.rev_no === null || row.rev_no === void 0) throw new HttpError(404, "not_found", "Revision not found");
  if (row.blob_key !== null || row.nbytes === null) throw new HttpError(415, "unsupported_kind", "This version has no text body; use the content download");
  if (pin && row.sha256 !== pin.h) throw new HttpError(409, "revision_changed", "The version this cursor reads has changed; start again without cursor");
  const nbytes = row.nbytes;
  const bytes = await getTextRange(ctx.env, row, offset, Math.min(maxBytes, Math.max(0, nbytes - offset)));
  // An R2 await must not let a revoked grant, trashed artifact or changed version escape the SQL access fence.
  const checked = await db(ctx).prepare(select).bind(...az.params, row.rev_no, artifactId, projectId).first();
  if (!checked?.allowed || checked.trashed_at || !checked.head_rev) throw new HttpError(404, "not_found", "Artifact not found");
  if (checked.rev_no !== row.rev_no || checked.sha256 !== row.sha256 || checked.body_key !== row.body_key) throw new HttpError(409, "revision_changed", "The version this cursor reads has changed; start again without cursor");
  row.head_rev = checked.head_rev;
  if (offset > nbytes || offset > 0 && offset < nbytes && (bytes[0] & 192) === 128) throw new HttpError(400, "invalid_cursor", "cursor is not a read cursor for this document; start again without cursor");
  const out = {
    artifact_id: artifactId, kind: row.kind, revision: row.rev_no, sha256: row.sha256, mime: row.mime, size: nbytes,
    head_revision: row.head_rev, stale: row.head_rev !== row.rev_no,
    offset, content_bytes: maxBytes, text: "", text_encoded_bytes: maxBytes, max_bytes: maxBytes, encoding: mcp ? "mcp" : "json",
    eof: false, next_cursor: rtCursorEncode(projectId, artifactId, row.rev_no, row.sha256, Math.max(nbytes, 1))
  };
  // Everything except the text, at its largest possible size; the text gets the rest of max_bytes.
  const idBytes = Number.isInteger(ctx.rpcIdBytes) ? ctx.rpcIdBytes : RT_DEFAULT_ID_BYTES;
  const tooSmall = () => new HttpError(422, "max_bytes_too_small", "max_bytes is too small for this response; pass a larger max_bytes (or a shorter request id)");
  const budget = maxBytes - rtEncodedSize(out, mcp, idBytes);
  if (budget < 26) throw tooSmall();
  let i = 0, cost = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    const n = b < 128 ? 1 : b >= 240 ? 4 : b >= 224 ? 3 : b >= 192 ? 2 : 1;
    if (i + n > bytes.length) break;
    // Stored bodies are valid UTF-8; a stray byte would decode to U+FFFD (3 bytes), so it is costed as one.
    const c = n > 1 ? (mcp ? 2 * n : n) : b >= 128 ? (mcp ? 6 : 3) : rtAsciiCost(b, mcp);
    if (cost + c > budget) break;
    cost += c;
    i += n;
  }
  const end = offset + i;
  if (i === 0 && end < nbytes) throw tooSmall();
  out.text = new TextDecoder().decode(bytes.subarray(0, i));
  out.content_bytes = i;
  out.text_encoded_bytes = cost;
  out.eof = end >= nbytes;
  out.next_cursor = out.eof ? null : rtCursorEncode(projectId, artifactId, row.rev_no, row.sha256, end);
  if (rtEncodedSize(out, mcp, idBytes) > maxBytes) throw tooSmall();
  return out;
}

export { RT_ID_TOO_LONG, RT_KINDS_ALL, RT_KINDS_DOCS, readTextChunk, rtChunkLimit, rtFit, rtIdBytes, rtQuery, rtReadAuthzSql };
