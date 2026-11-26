// Rendered HTML page fixes (runs last, after build-app-connect-files.mjs; no migration).
// The page wrapper written around a sanitized HTML document (renderHtmlDocument in // src/html.ts) declared
// html{color-scheme:light dark}. The app shows the page on a white canvas (iframe.htmlview, and the offline copy),
// so on a dark-mode device the browser's default text turned white on white and plain pages looked blank. The
// wrapper now declares the light scheme that matches that canvas; a page that styles itself for dark mode
// (@media (prefers-color-scheme: dark)) still adapts, because the media query follows the device, not the
// declared scheme. Exact, once-matching patch inside that module; every other byte stays unchanged.
// No config, credentials, database or network is used.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('app-connect-files-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-app-connect-files.mjs before build-html-page-fixes.mjs');
const once = (needle, what) => { const i = input.indexOf(needle); if (i < 0 || input.indexOf(needle, i + 1) >= 0) throw Error('Expected exactly one ' + what); return i; };
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
const PATCHES = [
  ['html: the page wrapper declares the light scheme of its white canvas', '// src/html.ts',
    '<style>html{color-scheme:light dark}body{margin:0;padding:16px;',
    '<style>html{color-scheme:light}body{margin:0;padding:16px;'],
];
const spans = PATCHES.map(([name, module, find, replace]) => {
  const a = once(find, name);
  if (moduleOf(a) !== module) throw Error(`${name}: anchor is in ${moduleOf(a)}, expected ${module}`);
  return { name, module, a, b: a + find.length, find, replace };
}).sort((x, y) => x.a - y.a);
let out = '', pos = 0;
const gaps = [];
for (const s of spans) { gaps.push(input.slice(pos, s.a)); out += input.slice(pos, s.a) + s.replace; pos = s.b; }
gaps.push(input.slice(pos)); out += input.slice(pos);
writeFileSync('src/index.js', out);
const meta = { base_app_connect_files_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')),
  patches: spans.map((s) => ({ name: s.name, module: s.module, find_sha256: sha(s.find), replace_sha256: sha(s.replace) })) };
writeFileSync('html-page-fixes-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('HTML page fixes bundle: ' + sha(out));
