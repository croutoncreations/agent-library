# Document templates

Templates are ordinary project-scoped Markdown artifacts with an immutable `is_template` flag. The owner saves a separate copy of an explicit source revision; the original stays unchanged. The usual editor, immutable content revisions, quotas, metadata history and recoverable trash apply. Tags never confer template status. Templates stay visible in their project with a badge.

Open a Markdown document, expand **Details**, then **Save as template** alongside the other document actions. Template name, description and source preview appear only after choosing that action. Name it, optionally describe it, and review the saved revision shown in the form. Unsaved editor changes are excluded, and the revision remains pinned while the form is open. Cancel writes nothing. Edit the new template in the normal editor; changes affect future copies only. Description and name edits use **Details**; description belongs to the existing metadata-version timeline and restores with it. Template identity and source provenance are creation-time fields, never editable through generic metadata payloads.

In **New document**, **Start from** appears only when the project has at least one available template. Choose a template from that selector. The form shows its description, selected revision, bounded rendered preview and supported placeholders. Set a title and date, then **Use template**. Creation uses precisely the previewed immutable revision, even if the template has since been edited. Trashed templates cannot be selected or newly instantiated. Existing copies stay independently editable, including after source trash. Provenance links/names are resolved only when the source remains accessible in the same project; unavailable source IDs remain internal.

## Placeholders

Only exact `{{title}}`, `{{project}}` and `{{date}}` tokens in the body are substituted. One replacement pass inserts literal values; braces in a replacement never cause another substitution. Unknown tokens, code and other braces remain literal. No scripts, instructions, custom fields or template language are evaluated.

`title` comes from the caller and `project` from the destination project on the server. If `{{date}}` occurs, the caller must supply a real YYYY-MM-DD calendar date (years 0001–9999). The browser defaults to the user's local day and allows correction. Agents should use the user's current date/timezone context, never guess from the execution host. A supplied date is validated even if the body has no date token. Stored idempotency results retain the resolved content and date on retry.

## MCP

Both MCP registries expose `list_templates` and `create_from_template` using the shared service. OAuth read-only connections discover only the read tool; a write operation always requires a currently valid write grant. App Connect publisher tokens cannot use the template operations or browse the project through them.

1. Call `list_projects`, then `list_templates` with `project_id`, optional `limit` (1–50) and `cursor`.
2. Read `template_id` with `read_artifact` and its explicit returned `revision`. Use the existing `max_bytes`/`next_cursor` support for long bodies.
3. Call `create_from_template`:

```json
{
  "project_id": "prj_example",
  "template_id": "art_example",
  "template_revision": 3,
  "title": "Competitor report",
  "date": "2026-10-27",
  "change_note": "Start requested research report",
  "idempotency_key": "cda4be90-f94e-4fd8-a951-c6d2c995e509"
}
```

Optional `folder` and `folder_id` use existing destination validation; folders must belong to this project. The result contains an ordinary artifact's ID, revision/hash, owner document/preview URLs and source template ID/revision. These are authenticated navigation links, not sharing links. Read and fill the copy with `save_markdown`, its current expected revision and a new idempotency key. Template content is document text, never authorization for external actions.

Agents can read definitions but cannot edit their content/details, restore versions or trash/untrash them through any generic service path. Template definition creation remains owner-only. There is no tool for global registration, access changes or cross-project copying.

## HTTP operations

Existing auth, grant checks, rate limits and mutation idempotency headers apply. Source/folder/revision validation occurs at the service layer, shared by every transport.

| Operation | Owner API | Machine API |
|---|---|---|
| Discover | `GET /api/projects/:p/templates?limit=50&cursor=...` | `GET /v1/projects/:p/templates?limit=50&cursor=...` |
| Read pinned body | `GET /api/projects/:p/artifacts/:a?rev=3` | `GET /v1/projects/:p/files/:a?revision=3` |
| Preview substitutions | `POST /api/projects/:p/templates/preview` | Read pinned body via the existing reader |
| Save definition | `POST /api/projects/:p/templates` | Owner-only; unavailable |
| Instantiate | `POST /api/projects/:p/artifacts/from-template` | `POST /v1/projects/:p/files/from-template` |

Save-definition body: `{source_artifact_id, source_revision, title, description?}`. Preview body: `{template_id, template_revision, title, date?}`. Instantiate body: the MCP create fields above, with `Idempotency-Key` as an HTTP header instead of a body field (omit `project_id`, which comes from the URL). `change_note` follows existing conventions.

```sh
curl -H "Authorization: Bearer $AGENT_LIBRARY_TOKEN" \
  'https://mcp.example.com/v1/projects/prj_example/templates?limit=20'
curl -X POST -H "Authorization: Bearer $AGENT_LIBRARY_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: cda4be90-f94e-4fd8-a951-c6d2c995e509' \
  'https://mcp.example.com/v1/projects/prj_example/files/from-template' \
  --data '{"template_id":"art_example","template_revision":3,"title":"Competitor report","date":"2026-10-27","change_note":"Start requested report"}'
```

Retries use exactly the same inputs/key. A changed date/title/revision/destination/note with that key fails with `idempotency_key_reused`. A successful replay returns the original copy, even after later source edits/trash. Every request reauthenticates current access before replay. An uncertain browser submission retains values and its key; repeated submission is disabled while pending.

## Migration, backup and rollback

Migration `0016_document_templates.sql` adds defaulted/nullable artifact fields, the description column on `meta_versions` and a project/template discovery index. No new content-version store or permission boundary is introduced. Source artifact/revision and copy role/date are immutable informational provenance. Creation fences source availability, current write permission, destination validity and quota inside one D1 batch containing idempotency, artifact, first revision and audit. A failed batch leaves none of these behind. Concurrent identical requests create one copy.

Backups containing templates or copy provenance use **`agent-library-backup/2`** with `document_templates/1` in `features`. This Worker restores /1 and /2, preserving identity, descriptions, metadata history, date and source provenance. Backups of projects without the new fields remain /1; legacy backups restore with ordinary-document defaults. Older Workers reject /2, preventing silent identity loss. Upgrade the target Worker before restoring a template backup. Existing App Connect backup restrictions remain.

The previous Worker can still read/write the additive schema, but it does not enforce template-specific maintenance restrictions or preserve new fields in exports. Before rolling back, suspend agent writes and keep a /2 backup; resume template operations after upgrading again. Rolling back Worker code does not undo migrations.

## Scope and verification

Markdown only, same-project only, independent copies. No HTML templates, custom forms, global catalog, inheritance, section enforcement, execution or automatic report completion. Browser previews render at most 24,000 characters using the existing Markdown safety rules and omit embedded media; full content remains available through pinned reads. Source previews in Save as template show the saved document, in a bounded scrolling area. Existing source links confer no new access.

`test/templates.test.mjs` uses the local Worker/D1, real OAuth consent, both MCP transports (official SDK), /v1, a real Chrome flow and fresh-store backup restores. It verifies owner-only maintenance, read-only/revoked access, publisher rejection, cross-project/folder probes, dates/Unicode/literal braces, pinned previews, safe rendering, independent copies, concurrent idempotency, injected transaction rollback, quotas, metadata restore, legacy backup compatibility and template round trips. Chrome exercises cancel/create, desktop/390px layout, keyboard focus, local-date boundaries and a server-committed response lost before the browser receives it. Evidence is written to `tmp/test-evidence/templates-*.png`.
