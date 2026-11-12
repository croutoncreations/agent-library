// node:sqlite with every migration applied, behind D1's prepare/bind/first/all/run/batch surface (a batch is one
// transaction), for the blind-token tests. Counts calls (one per first/all/run/batch, like D1 round trips) and can
// pause or intercept a call. Synthetic fixtures only; every INSERT names its columns. node:sqlite does not enforce
// D1's limits (bound values per statement, statement size), so tests assert the design's bounds themselves.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./helpers.mjs";

const MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const AT = "2026-11-11T00:00:00.000Z";

/** Token values bound in a statement: the lengths of its JSON-array bindings (?REM, ?ADD). */
const tokenValues = (p) => p.reduce((n, v) => n + (typeof v === "string" && v.startsWith("[") ? JSON.parse(v).length : 0), 0);

export function mkWorld() {
  const sql = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) sql.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  const world = { sql, calls: 0, log: [], before: null, after: null };
  const execOne = (q, p) => {
    const s = sql.prepare(q);
    if (s.columns().length) return { results: s.all(...p).map((r) => ({ ...r })), meta: { changes: 0 } };
    const r = s.run(...p);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const call = async (kind, detail, fn) => {
    world.calls++;
    world.log.push({ kind, ...detail });
    if (world.before) await world.before({ kind, ...detail });
    const out = fn();
    if (world.after) await world.after({ kind, ...detail, out });
    return out;
  };
  const stmt = (q, p = []) => ({
    q, p, bind: (...b) => stmt(q, b),
    first: (c) => call("first", { q, params: p.length }, () => { const r = execOne(q, p).results[0] ?? null; return c ? r?.[c] ?? null : r; }),
    all: () => call("all", { q, params: p.length }, () => execOne(q, p)),
    run: () => call("run", { q, params: p.length }, () => execOne(q, p)),
  });
  world.DB = {
    prepare: (q) => stmt(q),
    batch: (list) => call("batch", { qs: list.map((s) => s.q), n: list.length, tokenValues: list.reduce((n, s) => n + tokenValues(s.p), 0) }, () => {
      sql.exec("BEGIN");
      try { const out = list.map((s) => execOne(s.q, s.p)); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; }
    }),
  };
  return world;
}

export const one = (world, q, ...p) => { const r = world.sql.prepare(q).get(...p); return r ? { ...r } : r; };
export const all = (world, q, ...p) => world.sql.prepare(q).all(...p).map((r) => ({ ...r }));
export const run = (world, q, ...p) => world.sql.prepare(q).run(...p);

/** A person, a workspace they created and a live project in it. */
export function seedWorkspace(world, { principal = "hum_a", workspace = "wsp_a", project = "proj_a", status = "active" } = {}) {
  if (!one(world, "SELECT 1 AS x FROM principals WHERE id = ?", principal))
    run(world, "INSERT INTO principals (id, kind, issuer, subject, label, created_at) VALUES (?, 'human', 'synthetic', ?, 'Synthetic', ?)", principal, principal, AT);
  if (!one(world, "SELECT 1 AS x FROM workspaces WHERE id = ?", workspace))
    run(world, "INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES (?, 'Synthetic', 0, ?, 'free', ?, ?)", workspace, status, principal, AT);
  run(world, "INSERT INTO projects (id, owner_id, title, created_at, workspace_id) VALUES (?, ?, 'Synthetic', ?, ?)", project, principal, AT, workspace);
  return { principal, workspace, project };
}
/** A text artifact whose head is revision `rev`. */
export function seedDoc(world, { project = "proj_a", artifact, rev = `rev_${artifact}`, kind = "markdown" }) {
  run(world, `INSERT INTO artifacts (id, project_id, kind, title, head_rev, head_revision_id, created_at, updated_at)
    VALUES (?, ?, ?, 'Synthetic', 1, ?, ?, ?)`, artifact, project, kind, rev, AT, AT);
  return { artifact, rev, project };
}
export const setHead = (world, artifact, rev) => run(world, "UPDATE artifacts SET head_revision_id = ?, head_rev = head_rev + 1 WHERE id = ?", rev, artifact);

/** Charged units per scope from the stored rows: 5 per document row plus its tokens. */
export function expectedCounters(world) {
  const out = {};
  for (const r of all(world, `SELECT d.workspace_id AS w, d.owner_id AS o, 5 + (SELECT COUNT(*) FROM search_tokens s WHERE s.doc_id = d.doc_id) AS n FROM search_token_docs d`)) {
    for (const scope of ["w:" + r.w, "o:" + r.o, "i"]) out[scope] = (out[scope] ?? 0) + r.n;
  }
  return out;
}
export function counters(world) {
  return Object.fromEntries(all(world, "SELECT scope, terms FROM search_term_counters").filter((r) => r.terms !== 0).map((r) => [r.scope, r.terms]));
}
export const tokensOf = (world, artifact) => all(world, `SELECT lower(hex(s.token)) AS t FROM search_tokens s JOIN search_token_docs d ON d.doc_id = s.doc_id
  WHERE d.artifact_id = ? ORDER BY s.token`, artifact).map((r) => r.t);
export const docRow = (world, artifact) => one(world, "SELECT doc_id, artifact_id, project_id, workspace_id, owner_id, revision_id, key_id, token_digest, writer, gen, term_count, truncated, truncated_by FROM search_token_docs WHERE artifact_id = ?", artifact);
export const missing = (world) => all(world, "SELECT id FROM search_tokens_missing ORDER BY id").map((r) => r.id);
