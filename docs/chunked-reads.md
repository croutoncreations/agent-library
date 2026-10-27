# Chunked text reads

Status: implemented. Build step `build-read-fixes.mjs` (after `build-app-connect-fixes.mjs`, before `build-file-tools-fixes.mjs`), sources in `src/reads/`, tests in `test/chunked-reads-unit.test.mjs`, `test/chunked-reads.test.mjs` and `test/oauth-chatgpt.test.mjs`. No migration.

## Why

Text documents (Markdown, HTML, JSON, CSV) can be up to 1 MiB. `read_artifact` returns the whole body in one result, and MCP results carry it twice (as JSON text in `content[0].text` and again in `structuredContent`), so a long document can be several MiB on the wire and larger than many clients accept. A caller can now read any text version in bounded chunks and put it back together exactly.

## Contract

Entry points (one shared service function, `readTextChunk`, with the same authorization for all of them):

| Transport | Call |
|---|---|
| OAuth MCP (`artifacts-mcp` host) | `read_artifact` with `max_bytes` and/or `cursor` |
| Legacy MCP (`/mcp` on the app host) | `read_artifact` with `max_bytes` and/or `cursor` |
| Machine API | `GET /v1/projects/:p/files/:f/text?max_bytes=&cursor=&revision=` |
| Browser API (owner) | `GET /api/projects/:p/artifacts/:a/text?max_bytes=&cursor=&revision=` |

Without `max_bytes` or `cursor` (or with both `null`), `read_artifact` works exactly as before (whole body, previous shape).

A chunk returns: `text`, `offset` and `content_bytes` (UTF-8 bytes of the document this chunk covers), `size` (whole version in bytes), `revision` and `sha256` (the pinned version), `head_revision` and `stale` (whether a newer version exists now), `eof`, `next_cursor`, `max_bytes`, `encoding` (`json` or `mcp`) and `text_encoded_bytes` (what the text costs once encoded).

- **`max_bytes` bounds the whole encoded response, not only the content.** Default 65536, range 4096 to 524288. For `/v1` and the browser API that is the JSON response body. For MCP it is the full JSON-RPC response, including the text twice (once JSON-in-a-string) and the request's JSON-RPC id, which is echoed back. A budget too small for the fixed fields returns `422 max_bytes_too_small`. The bound covers **error replies** of chunked MCP reads too: a chunked `read_artifact` call whose JSON-RPC id is longer than 1024 bytes (as JSON) is refused with HTTP 400 / JSON-RPC `-32600` and `id: null` before any reply echoes the id; any other reply to a chunked read (tool errors, unknown arguments, `project_required` with its project list, rate limits) that would exceed `max_bytes` is replaced by a compact error of the same kind (`response_too_large`, or the same JSON-RPC error code). An invalid `max_bytes` bounds error replies at 4096. Calls without `cursor`/`max_bytes` are not affected. Not bounded by `max_bytes`: authentication failures (401) and the legacy endpoint's 429, which never echo the id and are under 200 bytes. Content bytes per chunk are therefore smaller than `max_bytes`, and shrink for text with many escapes (quotes, backslashes, control characters) or non-ASCII characters.
- **Pinned version.** The cursor names the project, document, revision number, the version's sha256 and the byte offset. Every chunk is read from that one immutable version, so concurrent saves never mix in. A cursor whose version no longer has that hash returns `409 revision_changed`: start again without a cursor. To read the newest content after a long read, check `stale` / `head_revision`.
- **UTF-8 safe.** Chunks end on code-point boundaries. A cursor whose offset points inside a code point is rejected. Joining every chunk's `text` gives the exact document, and `sha256` lets the caller check it.
- **Access is checked on every chunk.** A cursor carries no access. Each chunk re-checks the caller's access to the project and the trash state in the same D1 statement that reads its bytes: legacy grant, API key, OAuth connection and its project list, or ownership. Revoking or expiring access, or removing the project from a key or connection, stops the next chunk (the transport's usual 401 at authentication, or 404 if access ended after authentication). Trashing the document returns 404 for everyone, as `read_artifact` already does. Untrashing lets the same cursor continue.
- **Kinds.** OAuth MCP and `/v1` read Markdown and HTML; with App Connect on, JSON and CSV too, which keeps the existing per-transport kind rules. The legacy MCP and the browser API read any text kind. Binaries return 415: use the content download, which already supports `Range`.

## Not in scope

There is no streaming or Range over `/content` for text, and no change to `MCP_TEXT_MAX`, write limits, list pagination or history paging.

## Verification

- `test/chunked-reads-unit.test.mjs` runs the shared function against the real migrations in `node:sqlite`. It covers exact reconstruction of a >256 KiB document, a seeded fuzz of the wire bound (both encodings, long and odd JSON-RPC ids), version pinning and `revision_changed`, trash, kinds, cursor tampering, and access that ends **between authentication and the chunk's own statement** for every principal type. A live server can only reach that last case by timing.
- `test/chunked-reads.test.mjs` uses the real Worker (`wrangler dev`) with `/v1`, the legacy MCP (SDK client plus raw JSON-RPC for wire sizes) and the browser API. It covers saves racing chunk reads, and revoke and trash between chunks; there, revocation is caught by authentication (401).
- `test/oauth-chatgpt.test.mjs` covers the OAuth MCP endpoint: reconstruction, wire bound including a long id, and revoking the connection between chunks.
