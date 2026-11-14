import { getTextPrefix, mapContent } from "../content-store.js";

// The one module that writes the full-text index (artifact_search, a contentless FTS5 table; migration 0031). D1 keeps
// only the inverted index: no title or body is stored, so a document's entries change only by inserting its complete
// text again. Every function takes a D1 handle (not the Worker env, so the index can move to its own database) and
// returns prepared statements for the caller to put in the SAME batch as the change that moves a current head, a title
// or a trash state. There are no triggers. A search joins artifact_search_keys (the stable search id, plus the
// revision, hash and title that were indexed) and ignores any entry that no longer matches the current head, so a stale
// entry is never returned; artifact_search_missing reports it until it is rebuilt.

// Indexed text is cut to the first 1 MiB (1,048,576 UTF-8 bytes, at a character boundary). With a contentless index
// this no longer costs storage; it bounds the size of one bound parameter and the CPU spent tokenizing one document.
const INDEX_TEXT_MAX_BYTES = 1048576;
function indexableText(text) {
  if (text.length <= INDEX_TEXT_MAX_BYTES / 4) return text;
  const bytes = new TextEncoder().encode(text.slice(0, INDEX_TEXT_MAX_BYTES));
  let end = Math.min(bytes.length, INDEX_TEXT_MAX_BYTES);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

// A published artifact that is not in the trash (?1 is its id): the only kind of artifact the index holds.
const INDEXABLE = "EXISTS (SELECT 1 FROM artifacts a WHERE a.id = ?1 AND a.head_rev > 0 AND a.trashed_at IS NULL)";
const IS_HEAD = "EXISTS (SELECT 1 FROM artifacts a WHERE a.id = ?1 AND a.head_rev > 0 AND a.trashed_at IS NULL AND a.head_revision_id = ?2)";

/**
 * Statements that make `text` (empty for a file: it is indexed by its title only) the indexed body of the artifact's
 * head `revisionId`, under the artifact's title as it is when the batch runs. Each is a no-op unless that revision is,
 * at that point of the batch, the artifact's untrashed head, so a save that lost its race, or one that is not
 * authorized, leaves the previous entry in place. Put them after the statements that insert the artifact or revision.
 * @param {D1Database} db
 * @param {{ artifactId: string, revisionId: string, sha256: string, text: string }} doc
 */
export function indexDocument(db, { artifactId, revisionId, sha256, text }) {
  return [
    db.prepare(`INSERT OR IGNORE INTO artifact_search_keys (artifact_id) SELECT ?1 WHERE ${IS_HEAD}`).bind(artifactId, revisionId),
    db.prepare(`DELETE FROM artifact_search WHERE rowid = (SELECT search_id FROM artifact_search_keys WHERE artifact_id = ?1) AND ${IS_HEAD}`).bind(artifactId, revisionId),
    db.prepare(`INSERT INTO artifact_search (rowid, title, body)
      SELECT k.search_id, a.title, ?3 FROM artifacts a JOIN artifact_search_keys k ON k.artifact_id = a.id
      WHERE a.id = ?1 AND a.head_rev > 0 AND a.trashed_at IS NULL AND a.head_revision_id = ?2`).bind(artifactId, revisionId, indexableText(text)),
    db.prepare(`UPDATE artifact_search_keys SET revision_id = ?2, sha256 = ?3, indexed_title = (SELECT title FROM artifacts WHERE id = ?1)
      WHERE artifact_id = ?1 AND ${IS_HEAD}`).bind(artifactId, revisionId, sha256)
  ];
}

/**
 * Statements that remove the artifact from the index unless it is (still) a published, untrashed document at that point
 * of the batch: put them after the statement that trashes it.
 * @param {D1Database} db
 */
export function unindexDocument(db, artifactId) {
  return [
    db.prepare(`DELETE FROM artifact_search WHERE rowid = (SELECT search_id FROM artifact_search_keys WHERE artifact_id = ?1) AND NOT ${INDEXABLE}`).bind(artifactId),
    db.prepare(`DELETE FROM artifact_search_keys WHERE artifact_id = ?1 AND NOT ${INDEXABLE}`).bind(artifactId)
  ];
}

/**
 * Statements that remove up to `limitParam` (a placeholder such as "?2") index entries of the artifacts that match
 * `condition` (SQL over `artifacts a`; every placeholder of it and of the limit is numbered and bound by `params`),
 * whatever their state. For a project's purge: run them, repeatedly, before its artifact rows are deleted.
 * @param {D1Database} db
 */
export function unindexMany(db, condition, params, limitParam) {
  const keys = `SELECT k.search_id FROM artifact_search_keys k WHERE k.artifact_id IN (SELECT a.id FROM artifacts a WHERE ${condition}) ORDER BY k.search_id LIMIT ${limitParam}`;
  return [
    db.prepare(`DELETE FROM artifact_search WHERE rowid IN (${keys})`).bind(...params),
    db.prepare(`DELETE FROM artifact_search_keys WHERE search_id IN (${keys})`).bind(...params)
  ];
}

/**
 * The text to index for a head revision row ({ body_key, body } or a file's { blob_key }): "" for a file, and for a text
 * object that is gone (logged), so one broken document is still found by its title and cannot stop a rebuild.
 */
async function indexTextOf(env, row) {
  if (row.blob_key) return "";
  try { return await getTextPrefix(env, row, INDEX_TEXT_MAX_BYTES); }
  catch (error) {
    if (error?.code !== "blob_missing") throw error;
    console.error(JSON.stringify({ event: "search_index_text_missing" }));
    return "";
  }
}

// Inline (legacy) bodies are cut in SQL, so a 10 MiB legacy body is not read into the Worker for a 1 MiB index.
const HEAD_TEXT_SQL = `r.blob_key, r.body_key, CASE WHEN r.body_key IS NULL THEN substr(r.body, 1, ${INDEX_TEXT_MAX_BYTES}) END AS body`;

/**
 * The indexed text of an artifact's current head (trashed or not), for a change that is not a new version (a title or
 * trash change: an artifact leaving the trash is read before it is back in it). The statements from indexDocument are
 * gated on this head, so a head that moves meanwhile makes them no-ops.
 * @returns {Promise<{ revisionId: string, sha256: string, text: string, trashed: boolean } | null>} null when it has no head
 */
export async function headIndexInput(env, artifactId) {
  const row = await env.DB.prepare(`SELECT r.id AS revision_id, r.sha256, a.trashed_at, ${HEAD_TEXT_SQL}
    FROM artifacts a JOIN revisions r ON r.id = a.head_revision_id AND r.artifact_id = a.id AND r.project_id = a.project_id AND r.rev_no = a.head_rev
    WHERE a.id = ? AND a.head_rev > 0`).bind(artifactId).first();
  return row ? { revisionId: row.revision_id, sha256: row.sha256, text: await indexTextOf(env, row), trashed: row.trashed_at !== null } : null;
}

/** Index, or remove, one artifact from its stored text outside any save. */
export async function reindexArtifact(env, artifactId) {
  const head = await headIndexInput(env, artifactId);
  await env.DB.batch(head && !head.trashed ? indexDocument(env.DB, { artifactId, ...head }) : unindexDocument(env.DB, artifactId));
}

/**
 * After a metadata change, re-index the artifact if the index no longer matches it (a concurrent save moved the head
 * between reading its text and the batch). Never throws: a failure leaves the entry reported missing, which search
 * answers with 503 until the cron's rebuild repairs it.
 */
export async function repairIfStale(env, artifactId) {
  try {
    if (!await env.DB.prepare("SELECT 1 AS missing FROM artifact_search_missing WHERE id = ?").bind(artifactId).first("missing")) return;
    await reindexArtifact(env, artifactId);
  } catch {
    console.error(JSON.stringify({ event: "search_repair_failed" }));
  }
}

/**
 * Bootstrap and repair (cron, every run): re-index up to `limit` documents the completeness probe reports
 * missing or stale, then mark search ready once none is (the probe is the same metadata-only scan every search runs). After migration 0031 every existing document is missing, so
 * repeated runs rebuild the whole index from R2 (or legacy inline) text. Safe to repeat and to run concurrently: each
 * document is one atomic batch. A document that fails stays missing and is retried by the next run. The limit keeps a run
 * within a Free plan Worker's 50 subrequests (a read and a batch per document, at most one R2 read each).
 * @returns {Promise<{ processed: number, failed: number, ready: boolean }>}
 */
export async function rebuildSearchIndex(env, { limit = 15 } = {}) {
  const rows = (await env.DB.prepare("SELECT id FROM artifact_search_missing LIMIT ?").bind(limit).all()).results;
  let failed = 0;
  await mapContent(rows, async (row) => {
    try { await reindexArtifact(env, row.id); }
    catch (error) { failed++; console.error(JSON.stringify({ event: "search_rebuild_failed", code: error?.code ?? null })); }
  });
  await env.DB.prepare("UPDATE artifact_search_state SET ready = 1 WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM artifact_search_missing)").run();
  const ready = !!await env.DB.prepare("SELECT ready FROM artifact_search_state WHERE id = 1").first("ready");
  return { processed: rows.length, failed, ready };
}
