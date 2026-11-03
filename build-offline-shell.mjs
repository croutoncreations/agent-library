// Installed app opens instantly, offline or on a slow connection (docs/offline.md; src/offline/*). Runs last, after
// build-review.mjs. Exact patches, each anchor matching exactly once and checked to sit in its named module (browser
// patches inside APP_JS); every byte outside the patched spans is preserved (manifest hash).
//   - PWA module: the service worker body (after its SHELL/PATHS header) becomes src/offline/sw.js: cache-first
//     shell with an atomic background update, instead of network-first. New shell cache name.
//   - UI module: boot becomes src/offline/boot.js (saved copies open after a short wait instead of a network
//     timeout); Access sign-in navigations bypass the cached shell.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('review-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-review.mjs first');
const SOURCES = ['src/offline/sw.js', 'src/offline/boot.js', 'src/offline/version.js'];
const src = Object.fromEntries(SOURCES.map((f) => [f, readFileSync(f, 'utf8')]));
// boot.js goes into APP_JS (String.raw template); sw.js into SERVICE_WORKER (a plain template: backslashes are escaped below).
for (const f of SOURCES) if (/[`]|\$\{/.test(src[f])) throw Error(f + ' would break its template literal');
const swText = src['src/offline/sw.js'].replace(/\\/g, '\\\\');
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
const UI = '// src/ui.ts', PWA = '// src/pwa.ts', INDEX = '// src/index.ts';
// Shell files the server answers with X-Shell-Version (route3): exact once-matching return statements.
const SHELL_RESPONSES = [
  ['app HTML', 'new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })'],
  ['app script', 'new Response(APP_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } })'],
  ['app styles', 'new Response(APP_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } })'],
];

// The current service worker body: everything after the SHELL/PATHS header up to the end of the template.
const SW_HEAD = 'var SERVICE_WORKER = `"use strict";\nvar SHELL = ${JSON.stringify(SHELL_CACHE)}, PATHS = ${JSON.stringify(SHELL_PATHS)};\n';
const swStart = input.indexOf(SW_HEAD) + SW_HEAD.length;
const swEnd = input.indexOf('`;\n', swStart);
if (swStart < SW_HEAD.length || swEnd < 0) throw Error('service worker template not found');
const swOld = input.slice(swStart, swEnd);
const SW_OLD_SHA = '6459c94f1d471f1ca7efa5eaaa7b5747dbf21213955a8fa21aa70dc059aed290';
// Pin the reviewed network-first worker: if it changes upstream, re-review it before re-pinning.
if (sha(swOld) !== SW_OLD_SHA) throw Error('Service worker body changed upstream; review it, then re-pin: ' + sha(swOld));

const BOOT_END = '  if (S.me) setTimeout(function () { offRefreshAll().catch(function () {}); }, 1500);\n})();\n';
const bootStart = input.indexOf('(async function boot() {\n'), bootEnd = input.indexOf(BOOT_END, bootStart);
if (bootStart < 0 || bootEnd < 0) throw Error('boot region not found');
const bootOld = input.slice(bootStart, bootEnd + BOOT_END.length);
const BOOT_OLD_SHA = '9f94e80e6de8a6d1940655a5c1883d263a871aae05f93e4ad8f5e9ddaa457ba5';
// Pin the reviewed boot: if it changes upstream, re-review it (and src/offline/boot.js) before re-pinning.
if (sha(bootOld) !== BOOT_OLD_SHA) throw Error('Boot changed upstream; review it, then re-pin: ' + sha(bootOld));
const OLD_BANNER = 'function offlineBanner() {\n  return h("p", { class: "banner offline-banner" }, "Offline: showing copies saved on this device (read-only). ",\n    h("a", { href: "#", onclick: function (e) { e.preventDefault(); location.reload(); } }, "Try again"));\n}\n';

// [name, module, find, replace]
const PATCHES = [
  ['pwa: new shell cache name (installed apps drop the network-first cache)', PWA, 'var SHELL_CACHE = "al-shell-v2";', 'var SHELL_CACHE = "al-shell-v3";'],
  ['pwa: cache-first shell service worker', PWA, swOld, swText],
  ['ui: registration comment', UI,
    '// Installable app (PWA): register the network-only service worker (it caches nothing). Registration is async\n// and failure is harmless (the site works the same without it).\n',
    '// Installable app (PWA): register the service worker that keeps the app shell (no library data) for instant,\n// offline launches (docs/offline.md). Registration is async and failure is harmless (the site works without it).\n'],
  ['ui: drop the sign-in navigation marker from the address bar', UI,
    'if (/[?&]source=pwa\\b/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);',
    'if (/[?&](source=pwa|al_net=1)\\b/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);'],
  ['ui: offline banner moves to the boot module', UI, OLD_BANNER, ''],
  ['ui: Access sign-in reload bypasses the cached shell', UI,
    '  } catch (e) { return false; }\n  location.reload();\n  return true;\n}\n', '  } catch (e) { return false; }\n  signInNavigate();\n  return true;\n}\n'],
  ['ui: hosted Sign in button bypasses the cached shell', UI,
    'var again = h("button", { type: "button", onclick: function () { location.reload(); } }, "Sign in");', 'var again = h("button", { type: "button", onclick: function () { signInNavigate(); } }, "Sign in");'],
  ['ui: boot opens saved copies after a short wait', UI, bootOld, src['src/offline/boot.js']],
  ['pwa: shell version (fingerprint of the cached shell bytes)', PWA, 'var ICON_BYTES = new Map(', src['src/offline/version.js'] + 'var ICON_BYTES = new Map('],
  ['pwa: manifest and icons carry the shell version', PWA,
    'function servePwa(path) {\n', 'function servePwa(path) {\n  const r = servePwaFile(path);\n  if (r && path !== "/sw.js") r.headers.set("x-shell-version", shellVersion());\n  return r;\n}\nfunction servePwaFile(path) {\n'],
  ['routing: /shell-version', INDEX,
    '  if (m === "GET" && path === "/app.js") return ', '  if (m === "GET" && path === "/shell-version") return serveShellVersion();\n  if (m === "GET" && path === "/app.js") return '],
  ...SHELL_RESPONSES.map(([n, a]) => ['routing: ' + n + ' carries the shell version', INDEX, a, a.replace('"cache-control": "no-store" }', '"cache-control": "no-store", "x-shell-version": shellVersion() }')]),
];
const jsStart = input.indexOf('var APP_JS = String.raw`'), jsEnd = input.indexOf('`;\n', jsStart);
const spans = [];
for (const [name, mod, find, replace] of PATCHES) {
  const a = input.indexOf(find);
  if (!find || a < 0 || input.indexOf(find, a + 1) >= 0) throw Error(`${name}: expected exactly one match`);
  if (moduleOf(a) !== mod) throw Error(`${name}: anchor is in ${moduleOf(a)}, expected ${mod}`);
  if (mod === UI && !(a > jsStart && a + find.length < jsEnd)) throw Error(`${name}: anchor is outside APP_JS`);
  spans.push({ name, a, b: a + find.length, replace });
}
spans.sort((x, y) => x.a - y.a);
for (let k = 1; k < spans.length; k++) if (spans[k].a < spans[k - 1].b) throw Error('Overlapping patches: ' + spans[k - 1].name + ' / ' + spans[k].name);
let out = '', pos = 0;
const gaps = [];
for (const s of spans) { gaps.push(input.slice(pos, s.a)); out += input.slice(pos, s.a) + s.replace; pos = s.b; }
gaps.push(input.slice(pos)); out += input.slice(pos);
writeFileSync('src/index.js', out);
const meta = { base_review_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')),
  sources_sha256: Object.fromEntries(SOURCES.map((f) => [f, sha(src[f])])),
  patches: PATCHES.map(([name, mod, find, replace]) => ({ name, module: mod, find_sha256: sha(find), replace_sha256: sha(replace) })) };
writeFileSync('offline-shell-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('Offline shell bundle: ' + sha(out));
