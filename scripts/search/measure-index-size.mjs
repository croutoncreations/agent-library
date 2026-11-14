#!/usr/bin/env node
// Database size of the full-text index for N synthetic 10 KB documents: the old design (an FTS5 table that stores a copy
// of every title and body, migration 0014) against the contentless table of migration 0031. Node's built-in SQLite only;
// nothing here touches Cloudflare. Usage: node scripts/search/measure-index-size.mjs [N=2000]
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKENIZE = "tokenize='unicode61 remove_diacritics 2'";
export const DESIGNS = {
  'stored copy (0014)': `CREATE VIRTUAL TABLE s USING fts5(artifact_id UNINDEXED, revision_id UNINDEXED, sha256 UNINDEXED, title, body, ${TOKENIZE})`,
  'contentless (0031)': `CREATE VIRTUAL TABLE s USING fts5(title, body, content='', contentless_delete=1, ${TOKENIZE})`,
};

/** Deterministic prose-like text of about `bytes` bytes: a Zipf-ish mix of common and rare words, so the index is realistic. */
export function syntheticText(seed, bytes = 10240) {
  let x = seed * 2654435761 >>> 0;
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const common = 'the of and to in is that it for as with was on be by this are at from or an have not but they which one you all'.split(' ');
  const out = [];
  let size = 0;
  while (size < bytes) {
    const w = next() < 0.6 ? common[Math.floor(next() ** 2 * common.length)] : 'w' + Math.floor(next() ** 2 * 20000).toString(36);
    out.push(w);
    size += w.length + 1;
  }
  return out.join(' ');
}

export function measure(count) {
  const dir = mkdtempSync(join(tmpdir(), 'al-index-size-'));
  const rows = {};
  try {
    for (const [name, ddl] of Object.entries(DESIGNS)) {
      const file = join(dir, name.replace(/\W+/g, '-') + '.db');
      const db = new DatabaseSync(file);
      db.exec(ddl);
      const stored = name.startsWith('stored');
      const insert = db.prepare(stored ? 'INSERT INTO s (rowid, artifact_id, revision_id, sha256, title, body) VALUES (?, ?, ?, ?, ?, ?)' : 'INSERT INTO s (rowid, title, body) VALUES (?, ?, ?)');
      db.exec('BEGIN');
      for (let i = 1; i <= count; i++) {
        const text = syntheticText(i), title = 'Synthetic document ' + i;
        if (stored) insert.run(i, 'art_' + i, 'rev_' + i, 'a'.repeat(64), title, text); else insert.run(i, title, text);
      }
      db.exec('COMMIT');
      db.exec("INSERT INTO s(s) VALUES('optimize')");
      db.exec('VACUUM');
      const found = db.prepare("SELECT count(*) AS n FROM s WHERE s MATCH 'the AND of'").get().n;
      db.close();
      rows[name] = { bytes: statSync(file).size, matches_for_the_AND_of: found };
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = Number(process.argv[2] ?? 2000);
  const rows = measure(count);
  const [a, b] = Object.values(rows);
  const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';
  console.log(`${count} synthetic documents of ${syntheticText(1).length} bytes each (${mib(count * syntheticText(1).length)} of text)`);
  for (const [name, r] of Object.entries(rows)) console.log(`${name.padEnd(20)} ${String(r.bytes).padStart(10)} bytes  ${mib(r.bytes).padStart(10)}  ${r.bytes / count | 0} bytes/doc`);
  console.log(`contentless is ${(100 * b.bytes / a.bytes).toFixed(1)}% of the stored-copy size (${(a.bytes / b.bytes).toFixed(2)}x smaller)`);
}
