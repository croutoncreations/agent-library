# Synthetic table shapes (mirrors a real planning document's structure; all content invented)

Intro paragraph before the tables. The tables below match the column counts, cell lengths, inline code and identifiers of a long planning note.

## Products

| Product | Repository | Notes |
|---|---|---|
| Lantern | `example-org/lantern-web` | Static site, deploys on merge to `main`; previews per PR. |
| Kestrel API | `example-org/kestrel-api` | Worker service with a long description that wraps several times on a phone so the column must stay readable instead of shrinking to one word per line. |
| Atlas CLI | `example-org/atlas-cli-with-a-rather-long-repository-name` | Release tags only. |

## Readiness matrix

| Repo | CI | Auto-merge | Protection | PR volume | Deployment | Readiness |
|---|---|---|---|---|---|---|
| `lantern-web` | Lint, unit and visual checks run on every push; the visual job takes about nine minutes and is the slowest gate. | Enabled for docs-only PRs via `automerge:docs` label. | Required review from one owner; status checks `ci/test` and `ci/lint` required. | ~40/week, mostly dependency bumps and copy changes. | Merge to `main` deploys to staging, then a manual promote. | **Ready** once `ci/visual` is made required. |
| `kestrel-api` | Unit tests only; integration suite runs nightly against a disposable database. | Not enabled. | Branch protection on, but admins can bypass. | ~12/week. | Tag push deploys via `deploy.yml`. | Needs integration tests on PRs. |
| `atlas-cli` | Matrix build across three OS images. | Enabled. | Signed commits required. | ~5/week. | Release workflow publishes binaries. | **Ready** |

## Backlog

| # | Item | Owner | Size |
|---|---|---|---|
| 1 | Require visual check | Web | S |
| 2 | PR integration tests | API | M |
| 3 | Auto-merge label policy | Platform | S |
| 4 | Owner: platform team<br>Reviewer: on-call<BR />See `runbook.md` | Platform | M |

## Targeted test runs

| Language | Test file pattern | Targeted run |
|---|---|---|
| TypeScript | `src/**/*.test.ts`, `test/**/*.spec.ts` | `npx vitest run --changed origin/main -- src/features/billing/invoice-preview.test.ts` |
| Python | `tests/test_*.py` | `pytest -q tests/test_invoice_preview.py::test_rounding_with_a_long_parametrized_identifier` |
| Go | `*_test.go` | `go test ./internal/billing/... -run TestInvoicePreview` |

## Reviewers

| Reviewer | Vendor | Status |
|---|---|---|
| Static analysis bot | Example Vendor | Trial ends next month; see https://example.com/docs/a/very/long/path/that/should/wrap/without/overflowing/the/page |
| Dependency bot | Example Vendor Two | Active |
| Release-notes bot | In-house | Proposed |

## Services

| Service | Today | Needed<br>by quarter |
|---|---|---|
| Preview environments | Manual, per request; someone runs the `preview-up` script and pastes the URL into the PR description, which is slow and often forgotten. | Automatic per PR with teardown on merge or close, and a link posted by the bot. |
| Merge queue | None. | GitHub merge queue on `main` for repositories with more than ten PRs per week. |
| Identifier example | `svc_7f3c2a9e1b4d4f6a8c0e2b5d7f9a1c3e5b7d9f1a` | An unbroken identifier that must wrap or scroll inside the table, never the page. |

| Left | Center | Right |
|:---|:---:|---:|
| a | b | 1,234.50 |
| [link text](https://example.com/x) | *em* and **strong** | `9.99` |
| pipe \| escaped | ` code \| with pipe ` | end |

Closing paragraph after the tables.
