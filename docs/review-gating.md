# Review gating

Status: implemented. Migrations `0017_review_gating.sql` and `0033_proposal_text_keys.sql`, code in `packages/core/src/review/` (service, tools, backup) with its integration points in the ordinary modules, browser code in `packages/core/src/web/`, tests `test/review-gating.test.mjs` and `test/review-ui.test.mjs`.

## Goal

A workspace admin can decide, per document (with a project default), that agent edits must be reviewed before anyone else reads them (`required`), or that readers can at least tell which version was reviewed (`advisory`). Unreviewed drafts never leak into what other agents read, so a half-finished draft can't propagate into other work. With review off (the default) nothing changes.

## Review modes

| Mode | Agent saves | Readers get | A review… |
|---|---|---|---|
| `off` (default) | go live (as before) | the current version | not available |
| `advisory` | go live | the current version; `review.reviewed_revision` says which version was last approved; `read_artifact {reviewed: true}` reads it | attaches a review record to one existing version (`review_revision`) |
| `required` | become **proposals** | approved versions only (every version in the line was approved, written by a person, or existed when review was turned on) | approving a proposal creates the version *and* its review record in one step (`review_proposal`) |

"Reviewed" is never a flag on the document. It is a review record bound to one exact version (or a proposal), so a later edit is unreviewed by construction.

- **People are never gated.** Edits made in the browser, by any member of the workspace, go straight to the version line. In `advisory` they are **not** automatically reviewed (autosave would otherwise promote half-typed drafts); a reviewer marks a version with **Mark as reviewed** in History. Gating applies to what agents do: OAuth apps, API keys and agent tokens.
- Admins (and owners) of the workspace set the mode. Turning `required` on vouches for the current version (it stays readable). Switching `required` → `advisory` records an owner review of the current version, so the reviewed version stays the same.
- Switching away from `required` leaves pending proposals pending; they can still be approved, rejected or withdrawn.
- App Connect files (`/v1/app/files`) are exempt: their mode is always `off`, the project default never applies to them, and an app can't review.

## Who can do what

Reviewers are **people with write access to the project** (member, admin or owner of its active workspace; a project-level restriction below member removes it; viewers can't review) and **agent connections a workspace admin allowed to review** (Can review). Admins and owners set review modes and the project default.

| Who | Approved line | Pending proposals: existence | Proposal contents | Review |
|---|---|---|---|---|
| Member, admin, owner (browser) | yes | all | all | yes, including their own agents' proposals |
| Viewer | yes | that an edit is pending, as for any other reader (not what it changes) | no | no |
| Agent with **Can review** on the project | yes | all | all | yes, except proposals/versions it wrote itself |
| Proposer (same connection, API key or agent token) | yes | own | own: body, details, status, reviewer note | no |
| Any other agent with access | yes | that an edit is pending: count (`review.pending_proposals`) and, in `list_proposals`, author label, time and base version (not what it changes) | no | no |

- **Can review** is a separate permission per project (`review_grants`), granted only by a workspace admin or owner on the Connections pages (apps, API keys, agent tokens). It needs read access, not edit. App Connect apps never get it. It stops working at once when the connection, key or token is revoked or expires, when the project leaves its scope, or when the person who connected it loses access (checked live in the same statement as every review write). Replacing an API key carries its review permission over, and the replacement still counts as the author of the old key's proposals (no self-review through rotation); a reconnected app starts without it. Known limit: a reconnected OAuth app is a new connection with no link to its predecessor, so once an admin grants it review it can approve proposals its previous connection left pending (withdraw or review those first). Revoking a connection or agent token deletes its review grants. OAuth reviewers get proposed files as an inline image (up to 1 MiB) and a short-lived download link that re-checks connection, file access and review permission on each use; long proposed text comes through the same kind of link.
- A person who reviews can approve what any agent proposed, including an agent they connected themselves; the self-review rule is for agent connections (an agent can't approve its own work).
- Change notes, titles and bodies of other agents' proposals are never shown to non-reviewers (a note can leak content), and hidden new documents are not listed for them at all.
- OAuth connections without file access never see binary proposals; JSON/CSV follow the App Connect flag (same audience rules as the changes feed).

## Write paths on a `required` document

For agents (OAuth connections, API keys, legacy agent tokens). Owner and publisher writes behave as before.

| Operation | Result |
|---|---|
| `save_markdown`, `/v1` save, data-file save | proposal (content) |
| `restore_revision` | proposal (content, `restored_from`) |
| `upload_begin` + `upload_finish` (new version of a file) | proposal (content; the verified bytes become the proposal's file) |
| details update, `restore_metadata` | proposal (title, folder, tags) |
| `create_markdown`, `/v1` create, `create_from_template`, new file upload, in a project whose default makes the new document `required` | hidden document + proposal (content and details) |
| `trash_artifact`, trash via details | refused, `review_required` (a person can trash it) |
| comments | unchanged |

A gated write returns its usual status with `{ status: "pending_review", proposal_id, artifact_id, base_revision, base_meta_version, supersedes }`. `expected_revision` / `expected_meta_version` still have to match the current approved version (409 otherwise), and idempotency keys replay as usual, so agents that don't know about review keep working.

**One open proposal per author per document.** A new save by the same author supersedes their pending proposal (`superseded`) and starts unapproved; nothing is carried over from the superseded proposal (except for a pending new document, which needs both content and details: the part not being replaced is kept). To revise a pending **new** document, save it with `expected_revision: 0`.

## Proposal lifecycle

```
pending ──approve──────────────► approved   (new version and/or details version; proposer is the author)
        ──approve with edits───► approved   (reviewer's text/details; reviewer is the author; text kinds only)
        ──reject (note)────────► rejected
        ──author saves again───► superseded (new pending proposal)
        ──author withdraws─────► withdrawn
```

- Plain approve requires the document to still be at the proposal's base (`head_rev == base_rev` for content, `meta_version == base_meta_version` for details). Otherwise `409 proposal_stale` with the current and base values.
- **Reconcile:** approve with edits sends the reconciled body/details with `expected_revision` / `expected_meta_version` of the *current* document, so a reviewer can merge a stale proposal into the latest version. Or reject it and the author re-proposes. No automatic merge.
- Approval is one D1 batch: proposal state, live review permission, base/expected checks, the new version, details, review record, idempotency and audit. A revoked reviewer or a concurrent approval leaves nothing behind.
- Binary proposals are approve or reject only (`approve_with_edits_unsupported`); details on the same proposal can still be edited. Approval copies nothing: the new version points at the proposal's file, and a text proposal's version points at the proposal's text object.
- Approving one proposal doesn't touch others; they become stale.

## Rollback safety

Rollback of the Worker does not undo migrations, and the previous Worker knows nothing about review. Migration `0017` therefore enforces the gate in the database too:

- `review_gate_revisions` / `review_gate_meta` triggers refuse any agent (`oauth`, `api_key`, `grant`) version or details version on a `required` document unless it comes from an approved proposal. On the previous Worker, agent writes to gated documents fail closed instead of bypassing review.
- `review_default_on_insert` applies the project default to every new non-publisher document, whichever Worker creates it.

So there is one deploy and no feature variable. The previous Worker keeps working on the new schema for everything else: the migration only adds columns with defaults and new tables, which it never reads. `test/review-gating.test.mjs` checks the triggers with direct SQL inserts that simulate the previous Worker's writes; it does not run the previous bundle.

## Search, changes feed, offline copies, backups

- Proposals live in their own table, so they never reach search (the index holds only approved, live text and is written by approval like any other save), the changes feed (it emits nothing for them), agent listings or the offline copies. Approval emits exactly the normal event (`artifact.created`, `artifact.content_updated` or `artifact.metadata_updated`) and indexes the approved text. Hidden new documents have `head_rev = 0`, which search, lists, the feed and reads already skip.
- Backups include review modes, project defaults, proposals (their text inline and their files with the other files), review records, and hidden pending documents. A project export with review data **or** App Connect files or folders is `agent-library-backup/4`; import and restore also read `/1`, `/2`, `/3` (detected by the fields present: a `review` section, or app and folder fields) and `/4`. Older Workers refuse a `/4` rather than silently dropping its data.

## Storage

- **Proposal text lives in R2**, like version text (migration `0033_proposal_text_keys.sql`, `proposals.body_key`): `text/<project>/<document>/<proposal id>`, staged and published the same way as a version's text. Approving a proposal points the new version at that object (nothing is copied); approving with the reviewer's own text writes that text as an ordinary new version object. So a proposal can be as large as a version (10 MiB), and `read_proposal` returns at most 256 KiB of it inline (`body_truncated`; the whole text is at `content_path`, or a download link for OAuth connections with file access). Diffs of texts over 1 MiB are summarised, as for versions.
- **Open proposals count toward workspace storage**: their text and files, once each (then they count as the version). Binary proposal files also count toward the project's file quota until approved or purged. Hidden pending new documents do **not** count toward `items_per_project`; approving one takes an item slot (and is refused when the project is full).
- The bytes of closed proposals (rejected, superseded, withdrawn, or approved with the reviewer's own text instead) are purged **30 days after the decision** by the existing cleanup cron, text and files alike. The proposal record (who, when, hash, note) is kept; `read_proposal` says `body_purged` and the content route answers `410`. Bytes a version references (an approved proposal's text, or history reused by a restore proposal) are never purged. Upload cleanup, the content-writes sweep and project purge never delete an object a proposal still references.

## API

| Operation | MCP (both endpoints) | `/v1` | Browser API |
|---|---|---|---|
| List proposals | `list_proposals {artifact_id?, status?, cursor?}` | `GET …/proposals` | `GET /api/projects/:p/proposals`, `GET /api/review-queue` |
| Read a proposal (body/details, diffs vs base and current, file link) | `read_proposal` | `GET …/proposals/:id` (+ `/content`) | `GET …/proposals/:id` (+ `/content`) |
| Withdraw (proposer) | `withdraw_proposal` | `POST …/proposals/:id/withdraw` | `POST …/proposals/:id/withdraw` |
| Approve / approve with edits / reject | `review_proposal` | `POST …/proposals/:id/review` | `POST …/proposals/:id/review` |
| Mark a version reviewed (advisory) | `review_revision` | `POST …/files/:f/revisions/:n/review` | `POST …/artifacts/:a/revisions/:n/review` |
| Read the reviewed version | `read_artifact {reviewed: true}` | `GET …/files/:f?revision=reviewed` | `GET …/artifacts/:a?rev=reviewed` |
| Document mode (admin) | — | — | `PUT …/artifacts/:a/review-mode` |
| Project default (admin) | — | — | `GET/PUT …/review-settings`, `POST …/review-settings/apply {expected_default}` (409 `settings_changed` if the saved default differs) |
| Can review (admin) | — | — | `GET/PUT /api/review-grants` |

Documents in `advisory`/`required` mode, or with pending proposals, carry `review: { mode, reviewed_revision, pending_proposals }` in their views; documents with review off keep their exact previous shape. History entries of reviewed versions carry `review { decision, who, via, note, proposal_id, proposed_by? }`. Approve-with-edits attributes each part separately: the reviewer authors the part they changed (body, or title/folder/tags), the proposer keeps the rest. `revision=reviewed` (`?revision=reviewed` on `/v1` files, text and content; `?rev=reviewed` on the owner API's read and content routes; `reviewed: true` in MCP `read_artifact`, files included) returns the latest reviewed version. The browser's preview and render routes don't accept it (they show a given version or the current one).

## Browser UI

- **Home:** a "Needs review" section, shown only when there is at least one pending proposal in a project the person can review in; otherwise nothing is rendered.
- **Review screen** (`#/p/:p/review/:proposal`): who proposed what and why, the diff against the version it started from (and against the current version when stale), details changes, image/file preview, and Approve / Edit and approve / Reject with an optional note.
- **Document:** a banner when drafts are pending ("Review edit" opens the only one; with several, "Review edits" opens History); review mode in Details (admins).
- **History:** pending proposals for the document in a "Waiting for review" group above the versions, each with a direct **Review** link; "Reviewed" and "Proposed by X · approved by Y" on versions; **Mark as reviewed** on a version in advisory mode.
- **New document:** a Review choice that starts at the project default for the chosen type; a different choice is set right after creating (a person's first version is never gated).
- **Project:** a Review tab with the project's pending proposals, the default for new documents (Off / Optional / Required, with kinds) and "Apply to existing documents".
- **Connections:** a **Can review** toggle per project on apps, API keys and agent tokens.
