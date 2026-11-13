// node:sqlite with every migration applied, behind D1's prepare/bind/first/all/run/batch surface (a batch is one
// transaction). Counts calls (one per first/all/run/batch, like D1 round trips) and can pause or intercept a call.
// Synthetic fixtures only; every INSERT names its columns. node:sqlite does not enforce D1's limits (bound values per
// statement, statement size), so tests assert the design's bounds themselves.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./helpers.mjs";

const MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const AT = "2026-11-11T00:00:00.000Z";

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
    batch: (list) => call("batch", { qs: list.map((s) => s.q), ps: list.map((s) => s.p), n: list.length }, () => {
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
