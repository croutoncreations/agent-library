# Ranked search

Home → **Search library** searches current published heads across the owner's projects. Existing project list search is unchanged. Agents get the read-only `search_artifacts` tool on both MCP implementations. Publishers do not get general search. No external search service, embeddings, model call or new binding is used.

## Contract and examples

```json
{"query":"annual subscriptions","project_ids":["planning","notes"],"limit":20}
```

Call `search_artifacts` with this object. Omit `project_ids` for all currently readable projects; `[]` means no projects. The optional filters are `kind`, `updated_after`, `updated_before`, `limit` and `cursor`. Kind is one of markdown/html/json/csv/binary; timestamps are ISO datetimes, exclusive bounds. Limits: query 200 UTF-16 code units, 1–16 distinct words, 20 explicit project IDs, default page 20 and maximum 50. Unknown fields and malformed filters return `invalid_input` (400).

HTTP: `GET /api/search?query=annual%20subscriptions` (owner session), or `GET /v1/search?query=annual%20subscriptions&project_ids=planning,notes&limit=20` (API-key bearer). The machine endpoint follows the existing `/v1` API-key authentication convention. OAuth read scopes are enforced by the MCP host; legacy grants use their existing project scope. No grants or client registrations are changed by searching.

Response:

```json
{"results":[{"project_id":"planning","project_title":"Planning","artifact_id":"art_example","title":"Annual subscriptions","kind":"markdown","matched_field":"title","snippet":"Renew annually in January.","indexed_body":true,"revision":3,"sha256":"<revision hash>","updated_at":"2026-10-27T12:00:00.000Z","web_url":"https://library.example.com/p/planning/a/art_example?v=3","preview_url":"https://library.example.com/p/planning/a/art_example/preview?v=3"}],"has_more":false,"next_cursor":null}
```

Each excerpt is plain source text, at most 500 characters; HTML source is displayed as text, never executed. Binary matches use titles only and `indexed_body:false`. JSON/CSV follow the existing App Connect feature flag; OAuth connections approved without file access cannot search binaries. Title-only matches still show a short body excerpt or their title. UI highlighting uses text nodes; it is decorative and may differ from FTS accent folding.

## Lexical semantics and ranking

NFC-normalize, trim and collapse whitespace. Extract Unicode letter/number/mark runs, deduplicate them and join individually quoted FTS5 tokens with AND. All words must occur somewhere in the title or body. Case and accents fold under D1's `unicode61 remove_diacritics 2`; punctuation and quotation marks separate words. There are no phrase, prefix, boolean or SQL operators: `a OR b` searches for all three words. Punctuation-only queries are rejected. No stemming or question interpretation is attempted. Unicode scripts follow unicode61 word boundaries (for example, contiguous CJK text is one token).

Score is 1000 for an exact full title using SQLite `lower()`, plus one for each query word appearing in the lowered title. SQLite's title score folds ASCII case; FTS matching supports wider Unicode case/accent folding. Ties use updated time descending, then artifact ID ascending. No BM25 or corpus statistics: inaccessible files cannot influence ordering, snippets, pagination or counts. `has_more` reflects an additional *authorized* row (or results deferred by the response budget); there is no total-count endpoint.

Pagination is live, not a snapshot. Opaque HMAC-signed cursors expire after 15 minutes. They encode only a query/filter/identity binding hash, expiry and the last score/time/ID, never bodies or permission decisions. A random installation-local signing key is generated once in D1 by the migration and never returned over the API. Pagination performs no KV reads or writes, so it cannot consume the KV write quota used by OAuth. The query, filter and limit must remain the same; malformed, expired or mismatched cursors return `invalid_cursor` (400). Every page rechecks current grants and ownership inside candidate selection. Scope removal applies immediately; an explicit inaccessible project gets the same 404 as a nonexistent project. Static corpora have no duplicate/missing rows. Edits between pages can move documents across the boundary, causing omissions or repeats; restart for a fresh traversal.

The service budgets the full 64 KiB JSON-RPC envelope, including the duplicated text/structured result and request ID. If necessary it shortens the page and resumes after the last returned hit. MCP IDs above 1024 encoded bytes are rejected without echoing them. HTTP results share this conservative page budget.

## Required infrastructure / rollout

1. Apply additive migration **0014_ranked_search.sql** through the existing pipeline. It adds FTS5, a stable integer search-key map, readiness/signing state and maintenance triggers; existing tables are unchanged. On an existing installation the readiness flag starts at zero. A fresh empty installation starts ready.
2. Deploy the new Worker. Until backfill completes, Home hides the search entry, both MCP catalogs omit the tool, and direct HTTP searches return `503 search_initializing`. A direct browser deep link explains that search is being prepared. The owner-only `/api/search/status` reports `ready` without counts or content. Actual searches check both activation state and current-head completeness; it never presents a partial index as a confident empty result.
3. Run the bounded backfill **after rollout**, from the beginning:

   ```sh
   node scripts/search/backfill.mjs --config wrangler.local.toml --local --after 0 --limit 25
   ```

   Use `--persist-to <directory>` for a test installation. For an operator-authorized production rollout, use the installation's generated config and `--remote` instead of `--local`. No remote operation was run for this PR. Repeat with `--after <next_after_rowid>` until `processed=0` **and `ready=1`**. Each invocation touches at most 50 artifacts (default 25). Repeating a batch is safe; metadata versions, revisions and timestamps are unchanged. A completeness check controls activation, so skipping ahead or reaching an empty batch cannot enable an incomplete index. The index may become ready earlier if all remaining heads were already indexed by live writes. If a pass ends with `ready=0`, restart from zero to repair any missing/stale entries.
4. After any database restore/import, restart the backfill from zero. Search uses explicit `INTEGER PRIMARY KEY` identities from `artifact_search_keys` and joins by artifact ID; VACUUM or changes to the implicit `artifacts.rowid` do not break result identity. The scan's `--after` value is a temporary maintenance cursor: do not reuse it across a restore/import.

The previous Worker remains compatible. Its ordinary writes maintain the index, but generation insert triggers are deliberately excluded to preserve exact D1 commit-count checks. The new Worker indexes generations in the publication transaction. If a rollback's old Worker publishes a generation, the completeness probe suppresses search after re-upgrade until backfill repairs it. Worker rollback leaves the derived index in place.

Triggers cover ordinary create, publish/save, title changes, restore, trash/untrash, imports and legacy App Connect revision insertion, including either head/revision insertion order. New-Worker generation publication indexes all committed parts explicitly inside its atomic batch. They keep only the current nontrashed head. There is no asynchronous indexing lag after backfill. Search joins the current head's revision ID/hash/title and committed generation state in the same statement as live authorization, so stale entries cannot disclose old text as a current hit. Publisher staged parts are not artifacts and cannot match. Index bodies stay inside D1, with one body per current artifact plus FTS postings; storage/write costs increase with current text volume. The application’s existing text and project quotas bound ordinary artifacts; App Connect retains its larger quotas. Results and Worker memory are bounded; common-term queries can still scan/sort many index matches in D1.

Cloudflare's [supported SQL extensions](https://developers.cloudflare.com/d1/sql-api/sql-statements/#supported-sqlite-extensions) document FTS5; the pinned real local Wrangler/workerd tests exercise these statements. Production capability/latency was not probed. **Operational caveat:** Cloudflare [documents limitations for D1 exports involving virtual tables](https://developers.cloudflare.com/d1/best-practices/import-export-data/). Operators using whole-database SQL exports must review that workflow before rollout; project backups and D1 Time Travel remain separate mechanisms. The [deployment recovery runbook](deploy-pipeline.md#destructive-migrations) uses a verified Time Travel bookmark instead of whole-database SQL export. No resource IDs, domains, cloud credentials, DNS, Access policy, cron or binding changes are required. The signing key is internal derived-feature state in D1, not a new Worker secret.

## Verification

`node --test test/ranked-search.test.mjs` uses local D1, real HTTP, the official legacy MCP SDK client, the OAuth/publisher harness and Chrome. It covers ranking, buried matches, static pagination, query-bound cursors, grant scope changes, lifecycle/backfill, concurrent versions, Unicode/operators, safe browser highlights, keyboard/filter behavior, loading/empty/error views and complete wire budgets. Screenshots and a reproducible six-project/300-document performance sample are written to `tmp/proof-of-work/ranked-search/`; `benchmark.json` reports corpus size, body/response bytes, elapsed request time and SQL query count. The unfiltered first-page search service executes two SQL SELECTs (readiness/key and candidates); explicit project filters add one authorization SELECT. Authentication and MCP tool-catalog activation checks are additional transport work. MCP catalogs and direct search tool calls read only the singleton activation flag; they never run the corpus completeness scan. Initialize, ping and unrelated tool calls make no search-state query. A failed activation query hides search while preserving the existing tool catalog. Actual searches still perform the full metadata completeness probe, and `/api/search/status` does the same for the owner UI. Cursor signing uses WebCrypto without KV operations. Readiness checks inspect metadata and indexed head identities, not full bodies, but their cost grows with corpus size. These are local measurements, not production targets.

PDF extraction, OCR, video transcription, semantic search, guest sharing and finer-than-project permissions are outside this feature.

Concurrent checkouts can run checks in a separate port bank: `AGENT_LIBRARY_TEST_PORT_OFFSET=3000 npm test` (integer 0–5000). Every harness listener still takes its port from `test/ports.mjs`; choose a free bank.

KV quota note: the previous design wrote one opaque cursor per page to the shared OAuth KV namespace. This implementation uses stateless signatures instead; search pagination consumes none of those writes. Cloudflare’s [KV limits](https://developers.cloudflare.com/kv/platform/limits/) list 1,000 writes per day on the Free plan, shared with other application use.

Local development: migration 0014 is unreleased and changed during PR review. Disposable local databases that applied an earlier PR revision retain its old triggers; use a fresh local persistence directory when testing the revised migration. This is not a production reset procedure.
