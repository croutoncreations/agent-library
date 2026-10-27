// ---------- version history (docs/version-history.md) ----------
// Who and why, for a new content or metadata version: [via_kind, via_id, via_label, client_info, change_note].
// via_* is derived by the server from the access path; client_info and change_note are self-reported.
function provenance(ctx, input) {
  let via;
  if (ctx.via) via = ctx.via;
  else if (ctx.publisher) via = { kind: "publisher", id: ctx.grant?.id ?? null, label: String(ctx.principal.label ?? "").replace(/^publisher:/, "") };
  else if (ctx.principal.kind === "human") via = { kind: "browser", id: null, label: null };
  else via = { kind: "grant", id: ctx.grant?.id ?? null, label: ctx.principal.label ?? null };
  const raw = input?.change_note;
  let note = null;
  if (raw !== void 0 && raw !== null) {
    if (typeof raw !== "string") throw new HttpError(400, "invalid_input", "change_note must be a string");
    if (raw.length > CHANGE_NOTE_MAX) throw new HttpError(413, "too_large", `change_note exceeds ${CHANGE_NOTE_MAX} characters`);
    note = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() || null;
  }
  const label = via.label === null || via.label === void 0 ? null : String(via.label).slice(0, 120);
  return [via.kind, via.id ?? null, label, ctx.clientInfo ?? null, note];
}
// Display name for a version's author, from data already on the row (no lookups of other principals).
function whoLabel(r, me) {
  if (r.via_kind === "browser") return r.author_id === me ? "You" : "Owner";
  // Before 0010, OAuth connections (and API keys) wrote as the owner's own principal, so an owner-authored version
  // without via_kind may be the owner or a connected app: say so rather than claim it (never grouped as autosaves).
  if (!r.via_kind && r.author_id === me) return LEGACY_OWNER_LABEL;
  if (r.via_kind === "oauth") return r.via_label || "Connected app";
  if (r.via_kind === "api_key") return r.via_label || "API key";
  if (r.via_kind === "publisher") return r.via_label || "Connected app";
  // Versions written by App Connect publishing (its pinned module inserts revisions directly, without via_*) and
  // versions from before 0010: fall back to the author principal's label ("publisher:<app>" -> "<app>").
  if (typeof r.author_label === "string" && r.author_label.startsWith("publisher:")) return r.author_label.slice(10) || "Connected app";
  return r.via_label || r.author_label || r.author_id;
}
const LEGACY_OWNER_LABEL = "You or a connected app";
const HISTORY_PAGE = 50;
async function historyPage(ctx, projectId, artifactId, opts) {
  const before = opts.cursor === void 0 || opts.cursor === null || opts.cursor === "" ? null : int(Number(opts.cursor), "cursor", 1);
  // Direct rev_no range (no "? IS NULL OR") so SQLite seeks the UNIQUE (artifact_id, rev_no) index on every page.
  const cols = `SELECT r.rev_no AS rev, r.id, r.size, r.sha256, r.mime, r.author_id, r.restored_from, r.created_at,
       r.via_kind, r.via_id, r.via_label, r.client_info, r.change_note, p.kind AS author_kind, p.label AS author_label
     FROM revisions r LEFT JOIN principals p ON p.id = r.author_id
     WHERE r.artifact_id = ? AND r.project_id = ?`;
  const r = await (before === null
    ? db(ctx).prepare(`${cols} ORDER BY r.rev_no DESC LIMIT ?`).bind(artifactId, projectId, HISTORY_PAGE + 1)
    : db(ctx).prepare(`${cols} AND r.rev_no < ? ORDER BY r.rev_no DESC LIMIT ?`).bind(artifactId, projectId, before, HISTORY_PAGE + 1)).all();
  const rows = r.results.slice(0, HISTORY_PAGE);
  const me = ctx.principal.kind === "human" ? ctx.principal.id : null;
  const out2 = {
    revisions: rows.map((v) => ({
      rev: v.rev, id: v.id, size: v.size, sha256: v.sha256, mime: v.mime, author_id: v.author_id, restored_from: v.restored_from, created_at: v.created_at,
      who: whoLabel(v, me), via: v.via_kind ? { kind: v.via_kind, id: v.via_id, label: v.via_label } : null,
      client_info: v.client_info, change_note: v.change_note
    })),
    next_cursor: r.results.length > HISTORY_PAGE ? String(rows[rows.length - 1].rev) : null
  };
  if (!before) {
    const mh = await metaHistory(ctx, projectId, artifactId, true);
    out2.meta_versions = mh.meta_versions;
    out2.meta_next_cursor = mh.next_cursor;
  }
  return out2;
}
// Line diff (Myers) with hard caps so memory stays far below the Worker's 128 MiB on any pair of 1 MiB inputs:
//   - the shared prefix/suffix is never materialised as ops (only the hunks' context lines are built);
//   - the Myers trace (sum of 2d+3 ints per step) is capped at TRACE_INTS; beyond it the changed middle is reported
//     as a full replacement (truncated: true);
//   - at most MAX_OUT changed lines are returned in hunks (counts stay exact; truncated: true).
function lineDiff(a, b) {
  // STEPS bounds CPU for the free plan's 10 ms/request: every diagonal visited and every line compared counts
  // (~2-4 ms at the cap). Typical edits finish far below it; big rewrites come back as a replacement (truncated).
  // Pathological line counts (e.g. a 1 MiB file of empty lines) are summarised instead of diffed line by line.
  const MAX_LINES = 20000;
  const count = (s) => { let k = 1; for (let i = s.indexOf("\n"); i >= 0 && k <= MAX_LINES; i = s.indexOf("\n", i + 1)) k++; return k; };
  if (count(a) > MAX_LINES || count(b) > MAX_LINES) return { added: null, removed: null, hunks: [], truncated: true, too_many_lines: true };
  const A = a.split("\n"), B = b.split("\n"), N = A.length, M = B.length, TRACE_INTS = 4e6, MAX_OUT = 2e3, STEPS = 2e5;
  let pre = 0;
  while (pre < N && pre < M && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < N - pre && suf < M - pre && A[N - 1 - suf] === B[M - 1 - suf]) suf++;
  const n = N - pre - suf, m = M - pre - suf;
  const a2 = (i) => A[pre + i], b2 = (j) => B[pre + j];
  let ops = null, traceInts = 0, steps = 0, cut = false;
  // ops over the changed middle only, compact codes in one Uint8Array: 0 = same, 1 = removed, 2 = added.
  const replaceAll = () => { const o = new Uint8Array(n + m); o.fill(1, 0, n); o.fill(2, n); return o; };
  if (n === 0 || m === 0) ops = replaceAll();
  else {
    const off = n + m, v = new Int32Array(2 * off + 2), trace = [];
    // D (the edit distance) bounds the work: beyond MAX_D changed lines the result could not be shown in full anyway.
    const MAX_D = 500;
    outer: for (let d = 0; d <= n + m; d++) {
      if (d > MAX_D || (traceInts += 2 * d + 3) > TRACE_INTS) { cut = true; break; }
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || k !== d && v[off + k - 1] < v[off + k + 1] ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a2(x) === b2(y)) { x++; y++; steps++; }
        v[off + k] = x;
        if (++steps > STEPS) { cut = true; break outer; }
        if (x >= n && y >= m) {
          // Backtrack into a reversed op list: n + m - (matched) entries, at most n + m.
          const rev = new Uint8Array(n + m);
          let len = 0, cx = n, cy = m;
          for (let dd = d; dd > 0; dd--) {
            // trace[dd] holds v[off-dd-1 .. off+dd+1]: diagonal k sits at index k + dd + 1.
            const pv = trace[dd], kk = cx - cy, at = (q) => pv[q + dd + 1];
            const prevK = kk === -dd || kk !== dd && at(kk - 1) < at(kk + 1) ? kk + 1 : kk - 1;
            const px = at(prevK), py = px - prevK;
            while (cx > px && cy > py) { rev[len++] = 0; cx--; cy--; }
            if (cx === px) { rev[len++] = 2; cy--; } else { rev[len++] = 1; cx--; }
          }
          while (cx > 0 && cy > 0) { rev[len++] = 0; cx--; cy--; }
          ops = rev.subarray(0, len).reverse();
          break outer;
        }
      }
    }
    if (!ops) ops = replaceAll();
  }
  let added = 0, removed = 0;
  for (let i = 0; i < ops.length; i++) { if (ops[i] === 2) added++; else if (ops[i] === 1) removed++; }
  // Hunks with up to CTX unchanged lines around changes; changes closer than 2*CTX+1 share a hunk. Unchanged lines
  // (from the prefix, the middle or the suffix) are only read when they are context, never copied wholesale.
  const CTX = 3, hunks = [];
  let ai = pre, bi = pre, cur = null, gap = 0, out = 0; // gap: unchanged lines since the last change in cur
  const closeHunk = () => { if (!cur) return; for (let t = 0; t < Math.min(gap, CTX); t++) cur.lines.push(" " + A[cur.aEnd + t]); cur = null; };
  for (let i = 0; i < ops.length; i++) {
    const c = ops[i];
    if (c === 0) { if (cur && ++gap > 2 * CTX) closeHunk(); ai++; bi++; continue; }
    // Output cap: stop building hunks here. The open hunk gets no trailing context (lines after this point may be
    // changes, not context); added/removed are already exact.
    if (out >= MAX_OUT) { cut = true; cur = null; break; }
    if (cur && gap) { for (let t = 0; t < gap; t++) cur.lines.push(" " + A[cur.aEnd + t]); }
    if (!cur) {
      const k = Math.min(CTX, ai, bi);
      cur = { a_start: ai - k + 1, b_start: bi - k + 1, lines: [], aEnd: ai };
      for (let t = k; t > 0; t--) cur.lines.push(" " + A[ai - t]);
      hunks.push(cur);
    }
    cur.lines.push(c === 1 ? "-" + A[ai] : "+" + B[bi]);
    out++; gap = 0;
    if (c === 1) ai++; else bi++;
    cur.aEnd = ai;
  }
  // Trailing context may run into the unchanged suffix.
  if (cur) { gap = Math.min(CTX, N - cur.aEnd); closeHunk(); }
  return { added, removed, hunks: hunks.map(({ a_start, b_start, lines }) => ({ a_start, b_start, lines })), truncated: cut };
}
async function diffRevisions(ctx, projectId, artifactId, fromQ, toQ) {
  await authorizeProject(ctx, projectId, false);
  // The trash takes a document away from agents: only the owner can diff a trashed document
  // (as with history; read_artifact refuses trashed documents for everyone).
  const a = await loadArtifact(ctx, projectId, artifactId, { allowTrashed: ctx.principal.kind === "human" });
  const to = toQ === null || toQ === void 0 || toQ === "" ? a.head_rev : int(Number(toQ), "to", 1);
  const from = fromQ === null || fromQ === void 0 || fromQ === "" ? Math.max(1, to - 1) : int(Number(fromQ), "from", 1);
  const rs = await db(ctx).prepare("SELECT rev_no, body, blob_key, size, sha256, mime FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no IN (?, ?)").bind(artifactId, projectId, from, to).all();
  const A = rs.results.find((r) => r.rev_no === from), B = rs.results.find((r) => r.rev_no === to);
  if (!A || !B) throw new HttpError(404, "not_found", "Revision not found");
  const side = (r) => ({ rev: r.rev_no, size: r.size, sha256: r.sha256, mime: r.mime });
  if (A.blob_key || B.blob_key || typeof A.body !== "string" || typeof B.body !== "string")
    return { from: side(A), to: side(B), binary: true, identical: A.sha256 === B.sha256 };
  if (A.sha256 === B.sha256) return { from: side(A), to: side(B), binary: false, identical: true, added: 0, removed: 0, hunks: [], truncated: false };
  return { from: side(A), to: side(B), binary: false, identical: false, ...lineDiff(A.body, B.body) };
}
// ---------- metadata versions ----------
// The first metadata change after 0010 records the prior state as a baseline row (author: whoever created the
// document, i.e. revision 1's author). INSERT OR IGNORE keeps it to exactly one row even under concurrent retries.
function metaBaselineInsert(ctx, a, gate, gp) {
  return db(ctx).prepare(
    `INSERT OR IGNORE INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT author_id FROM revisions WHERE artifact_id = ? AND project_id = ? AND rev_no = 1), ?), NULL, NULL, NULL, NULL, 'baseline', NULL, ?
     WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM meta_versions WHERE artifact_id = ? AND project_id = ?)`
  ).bind(randomId("mvb"), a.id, a.project_id, a.meta_version, a.title, a.folder, a.tags, a.trashed_at ? 1 : 0, a.id, a.project_id, ctx.principal.id, a.updated_at ?? nowIso(), ...gp, a.id, a.project_id);
}
function metaVersionInsert(ctx, a, version, v, input, gate, gp) {
  const note = input?.change_note ?? (v.restoredFrom ? "Restored details from version " + v.restoredFrom : null);
  return db(ctx).prepare(
    `INSERT INTO meta_versions (id, artifact_id, project_id, version, title, folder, tags, trashed, author_id, via_kind, via_id, via_label, client_info, change_note, restored_from, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`
  ).bind(randomId("mv"), a.id, a.project_id, version, v.title, v.folder, v.tags, v.trashed ? 1 : 0, ctx.principal.id, ...provenance(ctx, { change_note: note }), v.restoredFrom, nowIso(), ...gp);
}
async function metaHistory(ctx, projectId, artifactId, authorized = false, cursor) {
  if (!authorized) {
    await authorizeProject(ctx, projectId, false);
    await loadArtifact(ctx, projectId, artifactId, { allowTrashed: ctx.principal.kind === "human" });
  }
  const before = cursor === void 0 || cursor === null || cursor === "" ? null : int(Number(cursor), "cursor", 1);
  const cols = `SELECT m.version, m.title, m.folder, m.tags, m.trashed, m.author_id, m.via_kind, m.via_id, m.via_label, m.client_info, m.change_note, m.restored_from, m.created_at,
       p.label AS author_label
     FROM meta_versions m LEFT JOIN principals p ON p.id = m.author_id
     WHERE m.artifact_id = ? AND m.project_id = ?`;
  const r = await (before === null
    ? db(ctx).prepare(`${cols} ORDER BY m.version DESC LIMIT ?`).bind(artifactId, projectId, HISTORY_PAGE + 1)
    : db(ctx).prepare(`${cols} AND m.version < ? ORDER BY m.version DESC LIMIT ?`).bind(artifactId, projectId, before, HISTORY_PAGE + 1)).all();
  const rows = r.results.slice(0, HISTORY_PAGE);
  const next_cursor = r.results.length > HISTORY_PAGE ? String(rows[rows.length - 1].version) : null;
  const me = ctx.principal.kind === "human" ? ctx.principal.id : null;
  return { next_cursor, meta_versions: rows.map((m) => ({
    version: m.version, title: m.title, folder: m.folder, tags: JSON.parse(m.tags), trashed: !!m.trashed, created_at: m.created_at,
    baseline: m.change_note === "baseline" && !m.via_kind,
    who: m.change_note === "baseline" && !m.via_kind ? "Before history was recorded" : whoLabel(m, me),
    via: m.via_kind ? { kind: m.via_kind, id: m.via_id, label: m.via_label } : null,
    client_info: m.client_info, change_note: m.change_note === "baseline" && !m.via_kind ? null : m.change_note, restored_from: m.restored_from
  })) };
}
// Restore title, folder and tags (and trash state) from an earlier metadata version, as a new metadata version.
// Restoring a trashed state, or out of the trash, follows the same rules as trash/untrash (updateMetadata).
async function restoreMetadata(ctx, projectId, artifactId, input, key) {
  await authorizeProject(ctx, projectId, true);
  const expected = int(input.expected_meta_version, "expected_meta_version", 1);
  const from = int(input.from_version, "from_version", 1);
  const row = await db(ctx).prepare("SELECT title, folder, tags, trashed FROM meta_versions WHERE artifact_id = ? AND project_id = ? AND version = ?").bind(artifactId, projectId, from).first();
  if (!row) {
    // A trashed document doesn't exist for agents: answer as for any other missing document, so an agent can't
    // probe which details versions it has.
    if (ctx.principal.kind !== "human") await loadArtifact(ctx, projectId, artifactId);
    throw new HttpError(404, "not_found", "Metadata version not found");
  }
  // Agents restore title, folder and tags only; the trash state is left as it is (moving into or out of the trash
  // stays a deliberate action: the owner's, or an agent's explicit trash tool where one exists).
  const keepTrash = ctx.principal.kind !== "human";
  return updateMetadata(ctx, projectId, artifactId, {
    expected_meta_version: expected, title: row.title, folder: row.folder, tags: JSON.parse(row.tags),
    ...keepTrash ? {} : { trashed: !!row.trashed },
    change_note: input.change_note
  }, key, { restoredFrom: from });
}
