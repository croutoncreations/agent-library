# Review gating

Status: implemented. Build step `build-review.mjs` (last in `npm run build:design`), migration `0017_review_gating.sql`, sources in `src/review/`, tests in `test/review-gating.test.mjs`.

## Goal

The owner can decide, per document (with a project default), that agent edits must be reviewed before anyone else reads them (`required`), or that readers can at least tell which version was reviewed (`advisory`). Unreviewed drafts never leak into what other agents read, so a half-finished draft can't propagate into other work. With review off (the default) nothing changes.

## Review modes

| Mode | Agent saves | Readers get | A review… |
|---|---|---|---|
| `off` (default) | go live (as before) | the current version | not available |
| `advisory` | go live | the current version; `review.reviewed_revision` says which version was last approved; `read_artifact {reviewed: true}` reads it | attaches a review record to one existing version (`review_revision`) |
| `required` | become **proposals** | approved versions only (every version in the line was approved, written by the owner, or existed when review was turned on) | approving a proposal creates the version *and* its review record in one step (`review_proposal`) |

"Reviewed" is never a flag on the document. It is a review record bound to one exact version (or a proposal), so a later edit is unreviewed by construction.

- The owner's own browser edits are never gated. In `advisory` they are **not** automatically reviewed (autosave would otherwise promote half-typed drafts); the owner marks a version with **Mark as reviewed** in History.
- Turning `required` on vouches for the current version (it stays readable). Switching `required` → `advisory` records an owner review of the current version, so the reviewed version stays the same.
- Switching away from `required` leaves pending proposals pending; they can still be approved, rejected or withdrawn.
- App Connect publisher files are exempt: their mode is always `off` and the project default never applies to them.

## Who can do what

| Who | Approved line | Pending proposals: existence | Proposal contents | Review |
|---|---|---|---|---|
| Owner (browser) | yes | all | all | yes, including their own |
| Agent with **Can review** on the project | yes | all | all | yes, except proposals/versions it wrote itself |
| Proposer (same connection, API key or agent token) | yes | own | own: body, details, status, reviewer note | no |
| Any other agent with access | yes | that an edit is pending: count (`review.pending_proposals`) and, in `list_proposals`, author label, time and base version (not what it changes) | no | no |

- **Can review** is a separate permission per project (`review_grants`), granted only by the owner on the Connections pages (apps, API keys, agent tokens). It needs read access, not edit. App Connect publishers never get it. Revoking the connection, key or token, or removing the project from its scope, removes review immediately (checked live in the same statement as every review write). Replacing an API key carries its review permission over, and the replacement still counts as the author of the old key's proposals (no self-review through rotation); a reconnected app starts without it. Known limit: a reconnected OAuth app is a new connection with no link to its predecessor, so once the owner grants it review it can approve proposals its previous connection left pending (withdraw or review those first). Revoking a connection or agent token deletes its review grants. OAuth reviewers get proposed files as an inline image (up to 1 MiB) and a short-lived download link that re-checks connection, file access and review permission on each use.
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
| `trash_artifact`, trash via details | refused, `review_required` |
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
- Binary proposals are approve or reject only (`approve_with_edits_unsupported`); details on the same proposal can still be edited. Approval copies nothing: the new version points at the proposal's file.
- Approving one proposal doesn't touch others; they become stale.

## Rollback safety

Rollback of the Worker does not undo migrations, and the previous Worker knows nothing about review. Migration `0017` therefore enforces the gate in the database too:

- `review_gate_revisions` / `review_gate_meta` triggers refuse any agent (`oauth`, `api_key`, `grant`) version or details version on a `required` document unless it comes from an approved proposal. On the previous Worker, agent writes to gated documents fail closed instead of bypassing review.
- `review_default_on_insert` applies the project default to every new non-publisher document, whichever Worker creates it.

So there is one deploy and no feature variable. The previous Worker keeps working on the new schema for everything else (`test/review-gating.test.mjs` runs the previous bundle against it).

## Search, changes feed, backups

- Proposals live in their own table, so search never indexes them and the changes feed emits nothing for them. Approval emits exactly the normal event (`artifact.created`, `artifact.content_updated` or `artifact.metadata_updated`). Hidden new documents have `head_rev = 0`, which search, lists, the feed and reads already skip.
- Backups include review modes, project defaults, proposals (with proposal files) and review records, and hidden pending documents; exports with review data use schema `agent-library-backup/3`, which older Workers refuse rather than silently dropping it.

## Storage

Proposal files count toward the project's binary quota until approved (then they count once, as the version). Upload cleanup never purges a file a proposal references. The bytes of rejected, superseded or withdrawn binary proposals are purged 30 days after the decision by the existing cleanup cron; the proposal record (who, when, hash, note) is kept.

## API

| Operation | MCP (both endpoints) | `/v1` | Browser API |
|---|---|---|---|
| List proposals | `list_proposals {artifact_id?, status?, cursor?}` | `GET …/proposals` | `GET /api/projects/:p/proposals`, `GET /api/review-queue` |
| Read a proposal (body/details, diffs vs base and current, file link) | `read_proposal` | `GET …/proposals/:id` (+ `/content`) | `GET …/proposals/:id` (+ `/content`) |
| Withdraw (proposer) | `withdraw_proposal` | `POST …/proposals/:id/withdraw` | `POST …/proposals/:id/withdraw` |
| Approve / approve with edits / reject | `review_proposal` | `POST …/proposals/:id/review` | `POST …/proposals/:id/review` |
| Mark a version reviewed (advisory) | `review_revision` | `POST …/files/:f/revisions/:n/review` | `POST …/artifacts/:a/revisions/:n/review` |
| Read the reviewed version | `read_artifact {reviewed: true}` | `GET …/files/:f?revision=reviewed` | `GET …/artifacts/:a?rev=reviewed` |
| Document mode (owner) | — | — | `PUT …/artifacts/:a/review-mode` |
| Project default (owner) | — | — | `GET/PUT …/review-settings`, `POST …/review-settings/apply {expected_default}` (409 `settings_changed` if the saved default differs) |
| Can review (owner) | — | — | `PUT /api/review-grants` |

Documents in `advisory`/`required` mode, or with pending proposals, carry `review: { mode, reviewed_revision, pending_proposals }` in their views; documents with review off keep their exact previous shape. History entries carry `proposal_id` and `review { decision, who, via, note }`. Approve-with-edits attributes each part separately: the reviewer authors the part they changed (body, or title/folder/tags), the proposer keeps the rest. `revision=reviewed` (`?revision=reviewed` on `/v1` files, text and content; `?rev=reviewed` on the owner API's read and content routes; `reviewed: true` in MCP `read_artifact`, files included) returns the latest reviewed version. The browser's preview and render routes don't accept it (they show a given version or the current one).

## Browser UI

- **Home:** a "Needs review" section, shown only when there is at least one pending proposal; otherwise nothing is rendered.
- **Review screen** (`#/p/:p/review/:proposal`): who proposed what and why, the diff against the version it started from (and against the current version when stale), details changes, image/file preview, and Approve / Edit and approve / Reject with an optional note.
- **Document:** a banner when drafts are pending; review mode in Details (owner).
- **History:** "Reviewed" and "Proposed by X · approved by Y" on versions; **Mark as reviewed** on a version in advisory mode.
- **Project:** a Review tab with the project's pending proposals, the default for new documents (with kinds) and "Apply to existing documents".
- **Connections:** a **Can review** toggle per project on apps, API keys and agent tokens.
