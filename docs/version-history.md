# Version history

Status: implemented. Build step `build-history-fixes.mjs`, migration `0010_version_history.sql`, sources in `src/history/`, tests in `test/version-history.test.mjs`.

## Goal

If an agent damages a document in the library, the owner can see what changed, who changed it and why, and get back to any earlier state in one step. Agents can do the same.

Every document is a sequence of **immutable versions**. Saving never overwrites a version; it appends one. Restoring an old version also appends one (a copy, with a pointer to its source), so a restore can itself be undone. Nothing is ever pruned or deleted.

## Decisions

| Question | Decision |
|---|---|
| May agents restore? | **Yes**: any principal with write access to the project. |
| Version title, folder, tags too? | **Yes**: details changes are immutable versions too, restorable. |
| Retention | **Keep every version forever.** No pruning, no agent purge. Trash keeps history. |
| Who/why | Agents are asked (tool descriptions) to say why in `change_note`. Who comes from the server-known connection, plus the agent's name from **standard MCP `clientInfo`**; nothing custom between tools. |
| Autosave volume | Browser autosave (1.2 s after typing pauses) keeps every save; the UI groups bursts. |

## Who made the change

| Path | `via.kind` | `via.id` / `via.label` (server-derived) | Shown as |
|---|---|---|---|
| Browser | `browser` | — | "You" |
| OAuth MCP (ChatGPT, Claude, Cursor, …) | `oauth` | connection id / OAuth `client_name` at write time | client name, "connected app" badge |
| API key (`/v1`) | `api_key` | key id / key label | key label, "API key" badge |
| Legacy grant token (`/mcp`) | `grant` | grant id / grant label | grant label, "agent token" badge |
| App Connect publisher | `publisher` | publisher id / display name | publisher name, "publishing app" badge |
| (versions from before 0010, written by the owner's principal) | `null` | — | "You or a connected app" (never grouped into autosave bursts) |

This fixes the gap where OAuth writes were indistinguishable from the owner's: `author_id` is still the owner for OAuth (unchanged), but `via` names the connection. Versions written before 0010 don't record the path, so an owner-authored one can't be told apart from a ChatGPT/Claude edit; they are labelled neutrally instead of "You".

**Agent name (self-reported, shown as "via …"):** standard MCP only.
- MCP 2026-07-28 clients send `params._meta["io.modelcontextprotocol/clientInfo"]` on every request; recorded per version.
- Older clients send `clientInfo` once in `initialize`; the server remembers it on the OAuth connection / grant (`client_info` column) and uses it when a request carries none.
- An MCP gateway shows as its OAuth client; if it forwards the downstream agent's `_meta` clientInfo (standard pass-through), that name is recorded. No gateway-specific code.

**Why:** `change_note` (≤ 280 chars; optional so older clients keep working, but the field, the write tools and the MCP server instructions all ask agents to always set it) on `create_markdown`, `save_markdown`, `restore_revision`, `restore_metadata` (both MCP endpoints) and on `/v1` create/save/restore bodies. Restores default to "Restored version N".

## Data model (`0010_version_history.sql`, additive only)

- `revisions` + `via_kind, via_id, via_label, client_info, change_note` (NULL on older versions).
- `oauth_connections.client_info`, `grants.client_info`: last `initialize` clientInfo.
- `meta_versions` (immutable): `version` = `artifacts.meta_version` after the change; title, folder, tags, trashed, author, via, client_info, change_note, restored_from. The first details change after deploy also writes a **baseline** row for the prior state (once, `INSERT OR IGNORE`, gated in the same batch).
- Backup export/restore round-trips all of it.

## API

| Operation | Browser API | MCP (both endpoints) | `/v1` |
|---|---|---|---|
| List versions (50/page, newest first, `cursor` = last rev seen) | `GET …/history?cursor=` | `artifact_history {cursor}` (+ `version_url` per version) | `GET …/revisions?cursor=` |
| Details versions | in `history` first page, `GET …/meta-history` | in `artifact_history.meta_versions` | `GET …/meta-versions` |
| Diff (line hunks; binary: sizes/hashes only) | `GET …/diff?from=&to=` | `diff_revisions` | `GET …/diff?from=&to=` |
| Restore content | `POST …/restore` | `restore_revision` | `POST …/revisions/:n/restore` |
| Restore details | `POST …/meta-restore` | `restore_metadata` | `POST …/meta-versions/:n/restore` |

All restores need the current `expected_revision` / `expected_meta_version` and an idempotency key; stale → 409 with the current value; same-key retry → replay. Protected publisher sources and trashed documents keep their existing refusals.

**Agents and the trash.** The trash takes a document away from agents. For them, diff, details history and details restore of a trashed document return 404, as `read_artifact` and `artifact_history` already did; the owner can still see everything. When an agent restores details, it gets back the title, folder and tags; the trash state stays as it is. Only the owner's restore (browser) restores the trash state too. That way `restore_metadata` doesn't give OAuth connections a new trash/untrash ability (`trash_artifact` exists only on the legacy endpoint).

**Diff limits (free plan, 10 ms CPU).** Diffs use Myers with three hard caps:
- **Edit distance:** at most 500 changed lines.
- **Work:** at most 200k steps.
- **Size:** inputs of at most 20,000 lines.

Measured worst case is about 8 ms CPU for a 1 MiB rewrite; a typical edit takes about 0.4 ms. Past the edit-distance or work cap, the changed middle is reported as one replacement (`truncated: true`). Over the line cap, the response is `too_many_lines: true` with no hunks, and the UI points to "Show full text". Memory stays capped by `TRACE_INTS` / `MAX_OUT`.

## Browser UI (History tab)

- One timeline: content versions (`v7`) then a "Title, folder and tags" section (`d3`), each with who, badge, "via <client>", relative time, size change, restored-from, and the change note.
- Three or more consecutive autosaves of yours within 10 minutes (no note, not a restore) collapse into "v1–6 · You · N edits"; expandable. Agent and app versions are never grouped.
- Opening a version shows its diff (current: what changed in it; older: against current), "Restore this version", "Compare with current", "What changed in vN", "Show full text" and a copy-link button.
- Data files: CSV versions show the same line diff. JSON versions are compared by value instead: each added, removed or changed value is listed by path (`$.limits.rows 50000 → 100000`), so one-line minified JSON and formatting-only edits read correctly. The JSON comparison runs in the browser on the two versions' text and lists at most 300 changes. "Preview vN" shows that version as a table or tree.
- Deep link `/p/:p/a/:a?v=N` (also the `version_url` agents get) opens the History tab on that version, through sign-in.

## Not done / follow-ups

- Live-check the standard clientInfo pass-through from real clients (ChatGPT, Claude, Cursor) after deploy; locally it's proven with the official MCP SDK client and a raw 2026-style `_meta` request.
- "Undo this change" shortcut on the Home list after an agent edit (the History tab covers it now).
- Owner note box on browser saves: not added (owner is identified as "You").
