#!/usr/bin/env node
// Export a commit's tracked files (never the working tree) into a fresh directory for publishing,
// then refuse if anything looks private. Gitignored files (wrangler.toml, deploy/production.json,
// AGENTS.local.md, .self-host*.json, private/) can never be included because only `git archive` is used.
//
//   node scripts/release/export-public.mjs <out-dir> [ref=HEAD]
//
// Extra blocked patterns (your own hostnames, account IDs, names) go one regex per line in the
// gitignored file `.release-denylist` at the repo root (lines starting with # are comments).
// Deliberate exceptions go in `.release-allowlist` as `path:regex` lines; an exception excuses only the
// exact text it matches (e.g. `README.md:github\.com/my-org/agent-library`), never the rest of the line.
// Findings name the file, line and rule number only; matched text and pattern text are never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const [out, ref = 'HEAD'] = process.argv.slice(2);
if (!out) { console.error('usage: export-public.mjs <out-dir> [ref]'); process.exit(2); }
if (existsSync(out) && readdirSync(out).length) { console.error(`${out} is not empty`); process.exit(2); }
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
if (git('status', '--porcelain', '--untracked-files=no')) console.warn('note: uncommitted changes are NOT exported; exporting', sha);

const lines = (f) => {
  const p = join(root, f);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
};
const compile = (p, where) => { try { return new RegExp(p, 'gi'); } catch { console.error(`${where} is not a valid regex; nothing was exported`); process.exit(2); } };
// Rules: generic secret shapes, then the installation's own identifiers from the local denylist.
const generic = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
];
const rules = [
  ...generic.map((re, i) => ({ re, label: `generic secret rule ${i + 1}` })),
  ...lines('.release-denylist').map((p, i) => ({ re: compile(p, `.release-denylist line ${i + 1}`), label: `.release-denylist rule ${i + 1}` })),
];
const allow = lines('.release-allowlist').map((l, i) => {
  const at = l.indexOf(':');
  if (at <= 0 || at === l.length - 1) { console.error(`.release-allowlist line ${i + 1} must be path:regex`); process.exit(2); }
  return { path: l.slice(0, at), re: compile(l.slice(at + 1), `.release-allowlist line ${i + 1}`) };
});
// Character ranges on a line that an allowlist entry for this file explicitly covers.
const allowedRanges = (rel, line) => {
  const r = [];
  for (const a of allow) if (a.path === rel) for (const m of line.matchAll(a.re)) r.push([m.index, m.index + m[0].length]);
  return r;
};
const forbiddenFiles = [/^wrangler\.toml$/, /^deploy\/production\.json$/, /^AGENTS\.local\.md$/, /^\.self-host.*\.json$/, /^private\//, /^\.devx\//, /^\.pi\//, /^\.env/, /^\.release-(deny|allow)list$/];

// Rules are compiled above (an invalid one exits before anything is written); only now extract.
mkdirSync(out, { recursive: true });
// No shell: the archive goes straight from git into tar.
// Run from the repo root: from a subdirectory, git archive would export only that subdirectory.
try {
  const tarball = execFileSync('git', ['archive', '--format=tar', sha], { cwd: root, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-f', '-', '-C', out], { input: tarball });
} catch (e) { rmSync(out, { recursive: true, force: true }); console.error(`export failed (${e.code || e.status || e.name}); nothing was left behind`); process.exit(1); }
if (!readdirSync(out).length) { console.error('export produced no files; refusing'); process.exit(1); }

const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(out, p);
    const st = lstatSync(p); // never follow links
    if (st.isSymbolicLink()) { hits.push(`${rel}: symbolic link (not scanned; publish real files)`); continue; }
    if (st.isDirectory()) { walk(p); continue; }
    if (forbiddenFiles.some((r) => r.test(rel))) hits.push(`${rel}: private file must not be published`);
    const buf = readFileSync(p);
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split('\n').forEach((line, i) => {
      let ranges;
      for (const { re, label } of rules) {
        for (const m of line.matchAll(re)) {
          ranges ??= allowedRanges(rel, line);
          const [s, e] = [m.index, m.index + m[0].length];
          // Excused only if an allowlisted match fully covers this exact match.
          if (!ranges.some(([as, ae]) => as <= s && e <= ae)) hits.push(`${rel}:${i + 1}: ${label}`);
        }
      }
    });
  }
};
// Any failure while scanning deletes the export, so an unscanned tree is never left behind.
try { walk(out); } catch (e) { rmSync(out, { recursive: true, force: true }); console.error(`scan failed (${e.code || e.name}); the export was deleted`); process.exit(1); }
if (!existsSync(join(root, '.release-denylist'))) console.warn('note: no .release-denylist at the repo root; only generic secret patterns were checked');
if (hits.length) {
  rmSync(out, { recursive: true, force: true });
  console.error(`refusing: ${hits.length} finding(s) in the export of ${sha}; the export was deleted (matched text not printed):\n  ${[...new Set(hits)].slice(0, 50).join('\n  ')}`);
  process.exit(1);
}
console.log(`exported ${sha} to ${out}: clean`);
