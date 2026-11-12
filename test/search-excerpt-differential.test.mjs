// Search excerpts are rebuilt in JavaScript (rsExcerpt) instead of FTS5 snippet(). Compare the shipped code with real
// snippet() in node:sqlite, on an index with the tokenizer and column layout of migrations/0014_ranked_search.sql.
// Latin, digits and CJK must be identical. For every script, an excerpt that differs must be the start of the text:
// JavaScript may match fewer words than the index (then it falls back), never words the index did not match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createContext, runInContext } from "node:vm";
import { moduleScript } from "./module-source.mjs";

const ctx = createContext({});
runInContext(moduleScript("packages/core/src/search/unicode61.js"), ctx);
runInContext(moduleScript("packages/core/src/search/service.js"), ctx);
const shipped = runInContext("rsExcerpt", ctx);
const rsExcerpt = (source, terms) => shipped(source, terms);

const db = new DatabaseSync(":memory:");
db.exec(`CREATE VIRTUAL TABLE artifact_search USING fts5(
  artifact_id UNINDEXED, revision_id UNINDEXED, sha256 UNINDEXED, title, body,
  tokenize='unicode61 remove_diacritics 2'
)`);
const insert = db.prepare("INSERT INTO artifact_search (rowid, artifact_id, revision_id, sha256, title, body) VALUES (1, 'a', 'r', 's', 't', ?)");
const select = db.prepare(`SELECT body, substr(snippet(artifact_search,4,'','',' … ',40),1,500) AS plain,
  snippet(artifact_search,4,'[[',']]',' … ',40) AS marked FROM artifact_search WHERE artifact_search MATCH ?`);
/** The one indexed row's snippet() for these terms, or null when the body does not match. */
function sqliteSnippet(body, terms) {
  db.exec("DELETE FROM artifact_search");
  insert.run(body);
  const row = select.get(terms.map((t) => '"' + t + '"').join(" AND "));
  if (row) assert.equal(row.body, body, "harness read the row it inserted");
  return row ?? null;
}

let seed = 20261111;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n; }; // low LCG bits are periodic
const pick = (a) => a[rnd(a.length)];
const SCRIPTS = {
  latin: { exact: true, words: ["alpha", "Beta", "gamma", "café", "Café", "résumé", "naïve", "Zürich", "über", "straße", "ÉCOLE", "ångström", "piñata", "x1", "v2", "Q3", "the", "of", "and", "plan", "data", "co", "op", "łódź", "lodz", "øre", "œuvre"] },
  digits: { exact: true, words: ["1", "22", "333", "4096", "16384", "0", "7", "12", "99", "2026"] },
  cjk: { exact: true, words: ["日本", "日本語の文章です", "中文", "東京", "한국어", "テスト", "漢字"] },
  cyrillic: { words: ["мой", "мои", "ёлка", "елка", "Ёж", "еж", "йод", "иод", "слово", "Москва", "мир"] },
  greek: { words: ["καλημέρα", "καλημερα", "Αθήνα", "Αθηνα", "λόγος", "λογος", "ψυχή", "ψυχη", "σοφία"] },
  hebrew: { words: ["שָׁלוֹם", "שלום", "סֵפֶר", "ספר", "מילה", "בַּיִת", "בית"] },
  arabic: { words: ["كِتَاب", "كتاب", "سَلَام", "سلام", "مدرسة", "قَلَم", "قلم"] },
};
const SEPARATORS = [" ", " ", " ", " ", ". ", ", ", "\n", "\n\n", ": ", " - ", "; ", "! ", "? ", " (", ") ", "  ", "\t", ".\n", " | ", " # ", "\u3002", "\u00a0"];
const LENGTHS = [3, 8, 20, 39, 40, 41, 60, 120, 400];
// The service's query words: NFC, lower case, letter/number/mark runs (rsNormalize).
const queryWords = (s) => s.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];

test("rsExcerpt agrees with FTS5 snippet() and never centres on a word the index did not match", () => {
  const counts = { cases: 0, matched: 0, identical: 0, fallback: 0 }, byScript = {};
  const names = Object.keys(SCRIPTS);
  for (let i = 0; i < 3500; i++) {
    const name = names[i % names.length], { words, exact } = SCRIPTS[name];
    const vocab = name === "digits" ? [...words, ...SCRIPTS.latin.words.slice(0, 8)] : [...words, ...SCRIPTS.digits.words.slice(0, 3)];
    let body = rnd(5) === 0 ? "  " : "";
    const used = [];
    for (let n = pick(LENGTHS), k = 0; k < n; k++) { const w = pick(vocab); used.push(w); body += w + pick(SEPARATORS); }
    if (rnd(3) === 0) body = body.trimEnd();
    if (rnd(4) === 0) body = body.normalize("NFD");
    const terms = [...new Set(Array.from({ length: 1 + rnd(3) }, () => queryWords((rnd(3) === 0 ? (w) => w.normalize("NFD") : (w) => w)(pick(rnd(4) === 0 ? vocab : used)))).flat())].slice(0, 3);
    if (!terms.length) continue;
    counts.cases++;
    const row = sqliteSnippet(body, terms);
    if (!row) continue;
    counts.matched++;
    const s = (byScript[name] ??= { matched: 0, identical: 0, fallback: 0 });
    s.matched++;
    const mine = rsExcerpt(body, terms).slice(0, 500);
    if (mine === row.plain) { counts.identical++; s.identical++; continue; }
    const where = JSON.stringify({ name, terms, body: body.slice(0, 300), sqlite: row.marked.slice(0, 300), mine });
    assert.ok(!exact, "Latin, digits and CJK must be identical to snippet(): " + where);
    assert.equal(mine, rsExcerpt(body, ["\u0001"]).slice(0, 500), "a differing excerpt must be the start of the text: " + where);
    counts.fallback++; s.fallback++;
  }
  console.log("DIFFERENTIAL", JSON.stringify({ ...counts, byScript }));
  assert.ok(counts.matched >= 2000, `compared ${counts.matched} matching documents`);
});

// Shapes where folding every mark away (NFD) matched words that the index keeps apart.
test("words the index keeps apart do not attract the excerpt", () => {
  const filler = (w, n) => Array.from({ length: n }, (_, i) => w + i).join(" ");
  for (const [body, terms] of [
    ["мой мой мой " + filler("слово", 80) + " мои " + filler("конец", 10), ["мои"]],
    ["καλημέρα " + filler("λέξη", 80) + " καλημερα " + filler("τέλος", 10), ["καλημερα"]],
    ["שָׁלוֹם " + filler("מילה", 80) + " שלום סוף", ["שלום"]],
    ["café " + filler("word", 80) + " cafe end", ["cafe"]],
    ["Ab. \u0301Cd " + filler("w", 80) + " e\u0305cd cd", ["cd"]],
  ]) assert.equal(rsExcerpt(body, terms), sqliteSnippet(body, terms).plain, body.slice(0, 20));
});

// Every code point, alone between "a" and "b", tokenizes and folds as the index does.
test("the tokenizer tables reproduce unicode61 remove_diacritics 2 for every code point", () => {
  const vocab = new DatabaseSync(":memory:");
  vocab.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE v USING fts5vocab(t, instance);");
  const ins = vocab.prepare("INSERT INTO t(rowid, body) VALUES (?, ?)"), texts = [];
  vocab.exec("BEGIN");
  for (let c = 0; c <= 0x10ffff; c++) if (c < 0xd800 || c > 0xdfff) { const s = "a" + String.fromCodePoint(c) + "b"; texts[c] = s; ins.run(c + 1, s); }
  vocab.exec("COMMIT");
  const index = [];
  for (const r of vocab.prepare("SELECT doc, term FROM v ORDER BY doc, offset").iterate()) (index[r.doc - 1] ??= []).push(r.term);
  const tokenize = runInContext("(s) => Array.from(s.matchAll(U61_TOKEN), (m) => u61FoldToken(m[0]))", ctx);
  const wrong = [];
  for (let c = 0; c < texts.length; c++) if (texts[c] && JSON.stringify(tokenize(texts[c])) !== JSON.stringify(index[c] ?? [])) wrong.push(c.toString(16));
  assert.deepEqual(wrong.slice(0, 20), []);
});

// An excerpt with no word in it is empty, so the service shows the title instead (`rsExcerpt(…) || r.title`).
test("a prefix with no complete word gives an empty excerpt", () => {
  assert.equal(rsExcerpt("- ".repeat(9000), ["x"]), "", "only separators beyond the prefix");
  assert.equal(rsExcerpt("w".repeat(20000), ["x"]), "", "one word longer than the prefix");
  assert.equal(rsExcerpt("w".repeat(20000) + " x", ["x"]), "", "the match lies beyond the prefix");
});
