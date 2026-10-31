// File types in the browser UI (src/file-types/*). Runs last, after build-diagnostics-fixes.mjs.
//  - Lists show a specific type ("PNG image", "MP4 video", "PDF", or the stored MIME type) instead of "File".
//  - Home can filter by type and sort by type (saved with the other Home view preferences).
//  - List rows (Home, project, search, offline) show a small thumbnail for images and videos.
// The owner list route adds the head revision's MIME type only when the browser asks (?include=mime), and owner search
// results carry it for human sessions only, so MCP, /v1 and default /api response shapes are unchanged.
// Exact, once-matching patches, each checked to sit in its named module; every other byte is preserved.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('diagnostics-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-diagnostics-fixes.mjs first');
const read = (f) => readFileSync('src/file-types/' + f, 'utf8');
const SOURCES = ['home-types.js', 'browser.js', 'browser.css'];
const src = Object.fromEntries(SOURCES.map((f) => [f, read(f)]));
// Inserted into template literals: no backtick or interpolation; the CSS literal is not raw, so no backslashes either.
for (const f of SOURCES) if (/[`]|\$\{/.test(src[f]) || (f.endsWith('.css') && src[f].includes('\\'))) throw Error(f + ' would break its template literal');
const once = (needle, what) => { const i = input.indexOf(needle); if (i < 0 || input.indexOf(needle, i + 1) >= 0) throw Error('Expected exactly one ' + what); return i; };
const moduleOf = (i) => { const m = input.lastIndexOf('\n// src/', i); return input.slice(m + 1, input.indexOf('\n', m + 1)); };
const SERVICE = '// src/service.ts', HOME = '// src/home.ts', UI = '// src/ui.ts', INDEX = '// src/index.ts';
const PATCHES = [
  // ---------------------------------------------------------------- server
  ['owner list: head revision MIME type on request', SERVICE,
    'SELECT ${ART_COLS} FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id',
    'SELECT ${ART_COLS}, r.mime AS head_mime FROM artifacts a LEFT JOIN revisions r ON r.id = a.head_revision_id'],
  ['owner list: add mime only when asked', SERVICE,
    '    artifacts: rows.map((a) => artifactView(a, appConnectEnabled(ctx.env))),\n',
    '    artifacts: rows.map((a) => q.withMime ? { ...artifactView(a, appConnectEnabled(ctx.env)), mime: a.head_mime ?? null } : artifactView(a, appConnectEnabled(ctx.env))),\n'],
  ['owner list route: ?include=mime', INDEX,
    'trashed: url.searchParams.get("trashed") === "1", kind, folderId }));',
    'trashed: url.searchParams.get("trashed") === "1", kind, folderId, withMime: ctx.principal.kind === "human" && url.searchParams.get("include") === "mime" }));'],
  ['search: select the head revision MIME type', SERVICE,
    'a.kind, a.updated_at, r.rev_no, r.sha256,\n',
    'a.kind, a.updated_at, r.rev_no, r.sha256, r.mime,\n'],
  ['search: MIME type in owner browser results only', SERVICE,
    'revision: r.rev_no, sha256: r.sha256, updated_at: r.updated_at,',
    'revision: r.rev_no, sha256: r.sha256, updated_at: r.updated_at, ...(ctx.principal?.kind === "human" && !ctx.oauthConnection && !ctx.apiCredential ? { mime: r.mime } : {}),'],
  // ---------------------------------------------------------------- Home module (HOME_JS)
  ['home: type preference default', HOME,
    '  function empty() { return { favorites: [], tab: "recent", sort: "newest" }; }',
    '  function empty() { return { favorites: [], tab: "recent", sort: "newest", type: "all" }; }'],
  ['home: read type sort and type filter', HOME,
    '      if (["newest", "oldest", "title"].indexOf(v.sort) >= 0) out.sort = v.sort;',
    '      if (["newest", "oldest", "title", "type"].indexOf(v.sort) >= 0) out.sort = v.sort;\n      if (TYPES.indexOf(v.type) >= 0) out.type = v.type;'],
  ['home: save type filter', HOME,
    'JSON.stringify({ favorites: v.favorites, tab: v.tab, sort: v.sort })',
    'JSON.stringify({ favorites: v.favorites, tab: v.tab, sort: v.sort, type: v.type })'],
  ['home: prefs keeps the type filter unless given', HOME,
    '  function prefs(uid, tab, sort) { var v = read(uid); v.tab = tab; v.sort = sort; write(uid, v); }',
    '  function prefs(uid, tab, sort, type) { var v = read(uid); v.tab = tab; v.sort = sort; if (type !== undefined) v.type = type; write(uid, v); }'],
  ['home: type grouping helper', HOME, '  function order(rows, mode) {\n', src['home-types.js'] + '  function order(rows, mode) {\n'],
  ['home: sort by type, then title', HOME,
    '      if (mode !== "title") {\n',
    '      if (mode === "type") { var d = TYPES.indexOf(typeOf(a)) - TYPES.indexOf(typeOf(b)); if (d) return d; }\n      if (mode !== "title" && mode !== "type") {\n'],
  ['home: list pages carry the MIME type', HOME,
    '"/artifacts";\n          if (s.cursor !== null) path += "?cursor=" + encodeURIComponent(s.cursor);',
    '"/artifacts?include=mime";\n          if (s.cursor !== null) path += "&cursor=" + encodeURIComponent(s.cursor);'],
  ['home: keep the MIME type on each row', HOME,
    's.rows.push({ pid: s.p.id, id: a.id, title: a.title, kind: a.kind, updated_at: a.updated_at, revision: a.revision });',
    's.rows.push({ pid: s.p.id, id: a.id, title: a.title, kind: a.kind, mime: typeof a.mime === "string" ? a.mime : null, updated_at: a.updated_at, revision: a.revision });'],
  ['home: export type helpers', HOME,
    '  return { read: read, has: has, toggle: toggle, prefs: prefs, order: order,',
    '  return { typeOf: typeOf, TYPES: TYPES, read: read, has: has, toggle: toggle, prefs: prefs, order: order,'],
  // ---------------------------------------------------------------- browser UI
  ['ui: styles', UI, 'var APP_CSS = `', 'var APP_CSS = `' + src['browser.css']],
  ['ui: video icon', UI, '  braces: [', '  video: ["M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M17 10l4-2.5v9L17 14"],\n  braces: ['],
  ['ui: thumbnails and type filter helpers', UI, '// ---------- home: authorized', src['browser.js'] + '// ---------- home: authorized'],
  ['ui: icon by file type', UI,
    'function kindIcon(a) { return a.kind === "binary" ? (/^image\\//.test(a.mime || "") ? "image" : "file") : a.kind === "csv" ? "table" : a.kind === "json" ? "braces" : "doc"; }',
    'function kindIcon(a) { var t = HOME.typeOf(a); return t === "image" ? "image" : t === "video" ? "video" : t === "csv" ? "table" : t === "json" ? "braces" : t === "file" ? "file" : "doc"; }'],
  ['ui: specific file label', UI,
    'function kindLabel(a) { return a.kind === "markdown" ? "Doc" : a.kind === "html" ? "Page" : a.kind === "csv" ? "CSV" : a.kind === "json" ? "JSON" : "File"; }',
    'function kindLabel(a) {\n  if (a.kind === "binary") { var m = typeof a.mime === "string" ? a.mime.toLowerCase() : ""; return FILE_MIME_LABELS[m] || m || "File"; }\n  return a.kind === "markdown" ? "Doc" : a.kind === "html" ? "Page" : a.kind === "csv" ? "CSV" : a.kind === "json" ? "JSON" : "File";\n}'],
  ['ui: home view reads the type filter', UI,
    '  var pref = HOME.read(uid), tab = pref.tab, mode = pref.sort;\n',
    '  var pref = HOME.read(uid), tab = pref.tab, mode = pref.sort, ftype = pref.type, typing = typeFilterSelect(pref.type);\n'],
  ['ui: home sort by type option', UI,
    '[["newest", "Newest edit first"], ["oldest", "Oldest edit first"], ["title", "Title A–Z"]]',
    '[["newest", "Newest edit first"], ["oldest", "Oldest edit first"], ["title", "Title A–Z"], ["type", "Type"]]'],
  ['ui: filtered and re-sorted views wait for the complete list', UI,
    'if (partial && (tab === "favorites" || mode !== "newest"))',
    'if (partial && (tab === "favorites" || mode !== "newest" || ftype !== "all"))'],
  ['ui: home applies the type filter', UI,
    'selected = rows.filter(function (a) { return tab !== "favorites" || HOME.has(fav, a.pid, a.id); });',
    'selected = rows.filter(function (a) { return (tab !== "favorites" || HOME.has(fav, a.pid, a.id)) && (ftype === "all" || HOME.typeOf(a) === ftype); });'],
  ['ui: home row thumbnail', UI,
    '        h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon(kindIcon(a))),\n        h("div", { class: "grow" }, rowLink(href, a.title), details),',
    '        fileThumb(a, a.pid),\n        h("div", { class: "grow" }, rowLink(href, a.title), details),'],
  ['ui: home empty state for a type filter', UI,
    '      : tab === "favorites" ? stateBox(',
    '      : ftype !== "all" && rows.some(function (a) { return tab !== "favorites" || HOME.has(fav, a.pid, a.id); }) ? stateBox("", "search", "No " + fileTypeName(ftype) + " here", "Nothing in this view matches the type filter.", h("button", { type: "button", class: "secondary", onclick: function () { ftype = "all"; typing.value = "all"; visible = HOME.EARLY; remember(); draw(); } }, "Show all types"))\n      : tab === "favorites" ? stateBox('],
  ['ui: home saves the type filter', UI, 'HOME.prefs(uid, tab, mode)', 'HOME.prefs(uid, tab, mode, ftype)'],
  ['ui: home type filter changes', UI,
    '  sorting.addEventListener("change", function () { mode = sorting.value; visible = HOME.EARLY; remember(); draw(); });\n',
    '  sorting.addEventListener("change", function () { mode = sorting.value; visible = HOME.EARLY; remember(); draw(); });\n  typing.addEventListener("change", function () { ftype = typing.value; visible = HOME.EARLY; remember(); draw(); });\n'],
  ['ui: home follows type changes from other tabs', UI,
    'pref = HOME.read(uid); tab = pref.tab; mode = pref.sort; sorting.value = mode; draw();',
    'pref = HOME.read(uid); tab = pref.tab; mode = pref.sort; sorting.value = mode; if (ftype !== pref.type) visible = HOME.EARLY; ftype = pref.type; typing.value = ftype; draw();'],
  ['ui: Home caches from before file types (rows without mime) are not shown', UI,
    '  var cached = HOME.cacheRead(uid);\n',
    '  var cached = HOME.cacheRead(uid);\n  if (cached && cached.rows.some(function (a) { return !("mime" in a); })) cached = null;\n'],
  ['ui: home toolbar type filter', UI,
    'h("label", { class: "row small muted" }, "Sort", sorting), refresh),',
    'h("label", { class: "row small muted" }, "Type", typing), h("label", { class: "row small muted" }, "Sort", sorting), refresh),'],
  ['ui: project list asks for MIME types', UI,
    '(trash ? "&trashed=1" : "");',
    '(trash ? "&trashed=1" : "") + "&include=mime";'],
  ['ui: project list row thumbnail', UI,
    'var li = h("li", trash ? null : { class: "link" }, h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon(kindIcon(a))), main,',
    'var li = h("li", trash ? null : { class: "link" }, fileThumb(a, pid, trash), main,'],
  ['ui: search result thumbnail', UI,
    'list.append(h("li", { class: "card search-hit" },',
    'list.append(h("li", { class: "card search-hit" }, fileThumb({ id: r.artifact_id, kind: r.kind, mime: r.mime, revision: r.revision }, r.project_id),'],
  ['ui: offline list thumbnail', UI,
    '      h("div", { class: "grow" }, h("a", { href: href, text: it.title }), h("small", { class: "muted", text: "rev " + it.rev',
    '      offlineThumb(it), h("div", { class: "grow" }, h("a", { href: href, text: it.title }), h("small", { class: "muted", text: "rev " + it.rev'],
  ['ui: another principal drops thumbnails', UI, 'HOME.cacheClear(principalId);', 'HOME.cacheClear(principalId); thumbClear();'],
  ['ui: session end drops thumbnails', UI, '  var wasIn = !!S.me;\n  HOME.cacheClear(null);\n', '  var wasIn = !!S.me;\n  HOME.cacheClear(null); thumbClear();\n'],
  ['ui: sign-out drops thumbnails', UI, '  clearAllDrafts();\n  HOME.cacheClear(null);\n', '  clearAllDrafts();\n  HOME.cacheClear(null); thumbClear();\n'],
];
// The UI module holds APP_HTML, APP_CSS and APP_JS: browser code patches must land inside APP_JS.
const jsStart = once('var APP_JS = String.raw`', 'APP_JS start'), jsEnd = input.indexOf('`;\n', jsStart);
const spans = PATCHES.map(([name, module, find, replace]) => {
  const a = once(find, name);
  if (moduleOf(a) !== module) throw Error(`${name}: anchor is in ${moduleOf(a)}, expected ${module}`);
  if (module === UI && name !== 'ui: styles' && !(a > jsStart && a < jsEnd)) throw Error(`${name}: anchor is outside APP_JS`);
  return { name, module, a, b: a + find.length, find, replace };
}).sort((x, y) => x.a - y.a);
for (let k = 1; k < spans.length; k++) if (spans[k].a < spans[k - 1].b) throw Error('Overlapping patches: ' + spans[k - 1].name + ' / ' + spans[k].name);
let out = '', pos = 0;
const gaps = [];
for (const s of spans) { gaps.push(input.slice(pos, s.a)); out += input.slice(pos, s.a) + s.replace; pos = s.b; }
gaps.push(input.slice(pos)); out += input.slice(pos);
writeFileSync('src/index.js', out);
const meta = { base_diagnostics_sha256: base, integrated_sha256: sha(out), preserved_outside_patches_sha256: sha(gaps.join('\u0000')),
  sources_sha256: Object.fromEntries(SOURCES.map((f) => [f, sha(src[f])])),
  patches: PATCHES.map(([name, module, find, replace]) => ({ name, module, find_sha256: sha(find), replace_sha256: sha(replace) })) };
writeFileSync('file-types-preservation.json', JSON.stringify(meta, null, 2) + '\n');
console.log('File types bundle: ' + sha(out));
