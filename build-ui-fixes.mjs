// UI fixes integration step (run AFTER build-service-fixes.mjs).
// Starts from the service-fixes bundle 087789d7 and replaces exact, hash-pinned regions inside the browser
// home module (// src/home.ts) and UI module (// src/ui.ts) only; every byte outside those modules must stay
// identical. Each anchor must match exactly once. The TypeScript sources are NOT rebuilt (see build-design-bundle.mjs).
// No config, credentials, database or network is used.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const SERVICE='b2fdc93fd5be675b049f0a6361b3538b9a0fa3ecbf11b15fe75cd9fada827853';
const input=readFileSync('src/index.js','utf8');
if(sha(input)!==SERVICE)throw Error('Input is not the service-fixes bundle 087789d7; run build-service-fixes.mjs first');
const once=(s,needle,what,from=0)=>{const i=s.indexOf(needle,from);if(i<0||s.indexOf(needle,i+1)>=0)throw Error('Expected exactly one '+what);return i;};
const start=once(input,'// src/home.ts\n','home module start');
const end=once(input,'\n// src/pwa-icons.ts\n','ui module end')+1;
once(input,'// src/ui.ts\n','ui module start');
const oldMod=input.slice(start,end);

// Home loads each project's first page (the API returns newest edits first, so those pages already hold the
// newest documents overall), shows them, then finishes pagination and the access re-check in the background.
// The last complete list is kept for this browser tab (sessionStorage, per user) and shown at once on return.
const HOME_LOAD=String.raw`  var CACHE = "al:homecache:";
  function cacheKey(uid) { return CACHE + encodeURIComponent(uid); }
  function cacheRead(uid) {
    if (!uid) return null;
    try {
      var v = JSON.parse(sessionStorage.getItem(cacheKey(uid)) || "null");
      return v && v.uid === uid && Array.isArray(v.rows) && Array.isArray(v.projects) && Number.isFinite(v.at) ? v : null;
    } catch (e) { return null; }
  }
  function cacheWrite(uid, result) {
    if (!uid) return;
    try { sessionStorage.setItem(cacheKey(uid), JSON.stringify({ uid: uid, rows: result.rows, projects: result.projects, at: Date.now() })); } catch (e) {}
  }
  // keepUid null clears every user's cached list (sign-out, session end).
  function cacheClear(keepUid) {
    var keep = keepUid ? cacheKey(keepUid) : null;
    try { for (var i = sessionStorage.length - 1; i >= 0; i--) { var k = sessionStorage.key(i); if (k && k.indexOf(CACHE) === 0 && k !== keep) sessionStorage.removeItem(k); } } catch (e) {}
  }
  // Home shows this many rows before "Show more"; the early result is exact for exactly these.
  var EARLY = 50;
  async function load(call, current, early) {
    function check() { if (!current()) { var e = new Error("Home navigation changed"); e.cancelled = true; throw e; } }
    check(); var first = await call("GET", "/api/projects"); check();
    var projects = first.projects;
    var states = projects.map(function (p) { return { p: p, rows: [], cursor: null, seen: new Set(), done: false, failed: false }; });
    // Fetches one page (firstOnly) or the remaining pages. No hard-coded project whitelist or silent page truncation.
    async function scan(s, firstOnly) {
      try {
        do {
          check(); var path = "/api/projects/" + encodeURIComponent(s.p.id) + "/artifacts";
          if (s.cursor !== null) path += "?cursor=" + encodeURIComponent(s.cursor);
          var result = await call("GET", path); check();
          result.artifacts.forEach(function (a) {
            if (a.project_id === s.p.id && !a.trashed && typeof a.id === "string" && typeof a.title === "string")
              s.rows.push({ pid: s.p.id, id: a.id, title: a.title, kind: a.kind, updated_at: a.updated_at, revision: a.revision });
          });
          s.cursor = result.next_cursor == null ? null : String(result.next_cursor);
          if (s.cursor !== null) {
            if (s.seen.has(s.cursor) || s.seen.size >= 1000) throw new Error("Home pagination incomplete");
            s.seen.add(s.cursor);
          }
        } while (s.cursor !== null && !firstOnly);
        if (s.cursor === null) s.done = true;
      } catch (e) {
        if (e.cancelled || e.status === 401) throw e;
        s.rows = []; s.done = true; s.failed = e.status !== 403 && e.status !== 404;
      }
    }
    // Bounded concurrency.
    async function pool(items, firstOnly) {
      var next = 0;
      async function worker() { while (next < items.length) await scan(items[next++], firstOnly); }
      await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker)); check();
    }
    function collect(list) {
      var allowed = new Map(list.map(function (p) { return [p.id, p.title]; })), all = [], dedup = new Set();
      states.forEach(function (s) {
        if (!allowed.has(s.p.id)) return;
        s.rows.forEach(function (a) {
          var k = JSON.stringify([a.pid, a.id]); if (dedup.has(k)) return; dedup.add(k);
          all.push(Object.assign({}, a, { project_title: allowed.get(a.pid) }));
        });
      });
      var bad = states.filter(function (s) { return s.failed && allowed.has(s.p.id); }).map(function (s) { return s.p.id; });
      return { rows: all, projects: list, failed: bad.length, failedPids: bad };
    }
    function stamp(a) { return a ? Date.parse(a.updated_at) : NaN; }
    await pool(states, true);
    // The early list must equal the first EARLY rows of the complete "newest" order. Unfetched rows of a project
    // are no newer than the last row fetched, so they can only enter if that row ties with or is newer than the
    // cutoff row (the API breaks ties by id, the list by title): fetch further first. Unparseable times are not shown early.
    while (early) {
      var open = states.filter(function (s) { return !s.done; });
      if (!open.length) break;
      var top = order(collect(projects).rows, "newest"), cut = stamp(top[EARLY - 1]);
      if (!Number.isFinite(cut) || open.some(function (s) { return !Number.isFinite(stamp(s.rows[s.rows.length - 1])); })) break;
      var tied = open.filter(function (s) { return stamp(s.rows[s.rows.length - 1]) >= cut; });
      if (!tied.length) { early(collect(projects)); break; }
      await pool(tied, true);
    }
    await pool(states.filter(function (s) { return !s.done; }), false);
    // Access may be revoked during a scan; drop the entire project's metadata, including earlier pages.
    var final = await call("GET", "/api/projects"); check();
    return collect(final.projects);
  }
  return { read: read, has: has, toggle: toggle, prefs: prefs, order: order, load: load, EARLY: EARLY, cacheRead: cacheRead, cacheWrite: cacheWrite, cacheClear: cacheClear };
})();` + '`;';

const VIEW_HOME=String.raw`async function viewHome() {
  var uid = S.me.id, alive = true, seq = 0, rows = [], visible = HOME.EARLY, failed = 0, partial = false, loadedAt = 0;
  var pref = HOME.read(uid), tab = pref.tab, mode = pref.sort;
  var msg = h("p", { class: "msg", role: "status", "aria-live": "polite" });
  var list = h("ul", { class: "list home-list", "aria-label": "Home documents" }), empty = h("div", { hidden: true });
  // A filter over one list (not separate panels): a labelled group of toggle buttons with aria-pressed.
  var recent = h("button", { type: "button", "aria-pressed": "false" }, "Recently edited"), favorites = h("button", { type: "button", "aria-pressed": "false" }, "Favorites");
  var homeTabs = h("div", { class: "tabs", role: "group", "aria-label": "Show" }, recent, favorites);
  function markFilter() { recent.setAttribute("aria-pressed", String(tab !== "favorites")); favorites.setAttribute("aria-pressed", String(tab === "favorites")); }
  var more = h("button", { type: "button", class: "secondary", hidden: true }, "Show more");
  var refresh = h("button", { type: "button", class: "ghost" }, icon("refresh"), "Refresh");
  var sorting = h("select", { "aria-label": "Sort documents" }, [["newest", "Newest edit first"], ["oldest", "Oldest edit first"], ["title", "Title A–Z"]].map(function (x) { return h("option", { value: x[0], selected: mode === x[0], text: x[1] }); }));
  function current(my) { return alive && !!S.me && S.me.id === uid && my === seq; }
  function draw() {
    if (!alive || !S.me || S.me.id !== uid) return;
    markFilter();
    // First pages are exact only for the newest documents; other views wait for the full list.
    if (partial && (tab === "favorites" || mode !== "newest")) { list.hidden = false; empty.hidden = true; more.hidden = true; skeletonRows(list, 4); return; }
    doneLoading(list);
    var fav = HOME.read(uid), selected = rows.filter(function (a) { return tab !== "favorites" || HOME.has(fav, a.pid, a.id); });
    selected = HOME.order(selected, mode); list.replaceChildren();
    selected.slice(0, visible).forEach(function (a) {
      var href = "#/p/" + enc(a.pid) + "/a/" + enc(a.id);
      var stamp = Number.isFinite(Date.parse(a.updated_at)) ? "Edited " + fmtDate(a.updated_at) : "Edit time unavailable";
      var details = h("span", { class: "meta", text: kindLabel(a) + " · " + a.project_title + " · " + stamp + " · rev " + a.revision });
      list.append(h("li", { class: "link", dataset: { projectId: a.pid, artifactId: a.id } },
        h("span", { class: "ficon-sm", "aria-hidden": "true" }, icon(kindIcon(a))),
        h("div", { class: "grow" }, rowLink(href, a.title), details),
        h("span", { class: "badge", text: kindLabel(a) }), favoriteButton(a.pid, a.id, draw, a.title)));
    });
    list.hidden = !selected.length; empty.replaceChildren(); empty.hidden = !!selected.length;
    if (!selected.length) empty.append(failed ? stateBox("error", "alert", "Nothing could be loaded", "Some projects didn't respond. Nothing was changed. Try again.", h("button", { type: "button", class: "secondary", onclick: function () { load(); } }, icon("refresh"), "Try again"))
      : tab === "favorites" ? stateBox("", "home", "No favorites yet", "Star a document from its page or from Recently edited to keep it here. Favorites are saved on this device.")
      : stateBox("", "doc", "No documents yet", "Open a project to write your first document, or connect an app to publish into one.", h("a", { class: "btn", href: "#/projects" }, icon("folder"), "Open projects")));
    more.hidden = partial || selected.length <= visible;
  }
  function remember() { try { HOME.prefs(uid, tab, mode); } catch (e) { showMsg(msg, "View preferences could not be saved in this browser."); } }
  // quiet: a list is already on screen (cached or earlier load); refresh it in place without the skeleton.
  async function load(quiet) {
    quiet = quiet === true;
    var my = ++seq; refresh.disabled = true; showMsg(msg, ""); markFilter();
    if (!quiet) { rows = []; failed = 0; partial = false; visible = HOME.EARLY; list.hidden = false; empty.hidden = true; more.hidden = true; skeletonRows(list, 4); }
    try {
      var result = await HOME.load(api, function () { return current(my); }, function (early) {
        if (quiet || !current(my)) return;
        early.projects.forEach(function (p) { projectTitles[p.id] = p.title; });
        rows = early.rows; failed = early.failed; partial = true; draw();
      });
      if (!current(my)) return;
      var kept = new Set();
      if (quiet && result.failed) {
        // A project that errored during an in-place refresh keeps the rows already shown for it (403/404 still remove them).
        var keep = new Set(result.failedPids), titles = new Map(result.projects.map(function (p) { return [p.id, p.title]; }));
        rows.forEach(function (a) { if (keep.has(a.pid)) { result.rows.push(Object.assign({}, a, { project_title: titles.get(a.pid) })); kept.add(a.pid); } });
      }
      rows = result.rows; failed = result.failedPids.filter(function (pid) { return !kept.has(pid); }).length; partial = false; loadedAt = Date.now();
      result.projects.forEach(function (p) { projectTitles[p.id] = p.title; });
      if (!result.failed) HOME.cacheWrite(uid, result);
      draw();
      if (kept.size && failed) showMsg(msg, "Some projects couldn't refresh or load. Documents from earlier are shown where available. Refresh to retry.");
      else if (kept.size) showMsg(msg, "Some projects couldn't refresh. Their documents are shown from earlier. Refresh to retry.");
      else if (failed) showMsg(msg, "Some projects could not be loaded. Showing only verified accessible documents. Refresh to retry.");
      resumeApply("home");
    } catch (e) {
      if (!current(my) || e.cancelled) return;
      if (quiet && rows.length) { showMsg(msg, "Home couldn't refresh. Showing the list from earlier. Refresh to retry."); return; }
      partial = false; doneLoading(list); list.hidden = true; empty.hidden = false; more.hidden = true;
      empty.replaceChildren(stateBox("error", "alert", "Home couldn't load", "Check your connection and try again. Your documents are unchanged.", h("button", { type: "button", class: "secondary", onclick: function () { load(); } }, icon("refresh"), "Try again")));
    } finally { if (current(my)) refresh.disabled = false; }
  }
  // Both filters show the same loaded list; switching only redraws.
  recent.addEventListener("click", function () { tab = "recent"; remember(); draw(); });
  favorites.addEventListener("click", function () { tab = "favorites"; remember(); draw(); });
  sorting.addEventListener("change", function () { mode = sorting.value; visible = HOME.EARLY; remember(); draw(); });
  more.addEventListener("click", function () { visible += HOME.EARLY; draw(); });
  refresh.addEventListener("click", function () { load(rows.length > 0 && !partial); });
  function changed(e) { if (e.key === "al:home:" + encodeURIComponent(uid)) { pref = HOME.read(uid); tab = pref.tab; mode = pref.sort; sorting.value = mode; draw(); } }
  // Returning to the tab refreshes in place at most once a minute, and retries a load that never completed.
  function foreground() { if (!document.hidden && !refresh.disabled && (!loadedAt || Date.now() - loadedAt > 60000)) load(rows.length > 0 && !partial); }
  window.addEventListener("storage", changed); document.addEventListener("visibilitychange", foreground);
  S.cleanups.push(function () { alive = false; ++seq; window.removeEventListener("storage", changed); document.removeEventListener("visibilitychange", foreground); });
  shell([{ t: "Home" }], pageHead("Home", { sub: "Recently edited documents across your projects. Favorites are saved for your account on this device.",
      actions: h("a", { class: "btn secondary", href: "#/projects" }, icon("folder"), "All projects") }),
    h("div", { class: "toolbar" }, homeTabs, h("span", { class: "spacer" }),
      h("label", { class: "row small muted" }, "Sort", sorting), refresh),
    msg, list, empty, more);
  // Show this tab's last complete list at once, then refresh it in place.
  var cached = HOME.cacheRead(uid);
  if (cached) {
    rows = cached.rows; loadedAt = cached.at;
    cached.projects.forEach(function (p) { projectTitles[p.id] = p.title; });
    draw(); await load(true);
  } else await load();
}
`;

// [name, start anchor, end anchor (exclusive; null = start anchor only), sha256 of the replaced region, replacement]
const REGIONS=[
 ['home: first pages first, then background pagination; per-tab cache helpers',
  '  async function load(call, current) {\n','\n\n// src/editor-bundle.ts\n',
  '2e809d530f12706a0457cad6f435e03f023d4a704aab5b7c0544d86ca04acc6e',HOME_LOAD],
 ['ui: viewHome shows cached or first-page results without a full reload',
  'async function viewHome() {\n','\n// ---------- ',
  '20763b9167100f8ba0045e8349a19916e1304e554b128ac4ec55b9059844eed1',VIEW_HOME],
 ['ui: sign-out clears cached home lists',
  '  clearAllDrafts();\n  resumeClear();\n',null,null,'  clearAllDrafts();\n  HOME.cacheClear(null);\n  resumeClear();\n'],
 ['ui: session end clears cached home lists',
  '  var wasIn = !!S.me;\n',null,null,'  var wasIn = !!S.me;\n  HOME.cacheClear(null);\n'],
 ['ui: a project title fetched after a document opened also replaces the project id in its metadata line',
  '  var h1 = app.querySelector("h1[data-project-title]");\n',null,null,
  '  app.querySelectorAll(".doc-meta [data-project-title]").forEach(function (el) { if (el.dataset.projectTitle === pid && projectTitles[pid]) el.textContent = projectTitles[pid]; });\n  var h1 = app.querySelector("h1[data-project-title]");\n'],
 ['ui: the document metadata line marks its project name so it can be updated',
  '  var docMeta = h("p", { class: "doc-meta", text: (isHtml ? "Page" : "Doc") + " · " + (projectTitles[pid] || pid) + " · updated " + fmtDate(A.meta.updated_at) });\n',null,null,
  '  var docMeta = h("p", { class: "doc-meta" }, (isHtml ? "Page" : "Doc") + " · ", h("span", { dataset: { projectTitle: pid }, text: projectTitles[pid] || pid }), " · updated " + fmtDate(A.meta.updated_at));\n'],
 ['ui: another principal signing in drops other users\' cached home lists',
  '  var mine = "al:draft:" + principalId + ":";\n',null,null,'  HOME.cacheClear(principalId);\n  var mine = "al:draft:" + principalId + ":";\n'],
];
let mod=oldMod;const regions=[];
for(const [name,a,b,pin,rep] of REGIONS){
 const i=once(mod,a,name);
 const j=b===null?i+a.length:mod.indexOf(b,i);
 if(j<0)throw Error('No end anchor for '+name);
 const old=mod.slice(i,j);
 if(pin&&sha(old)!==pin)throw Error('Region changed for '+name+': '+sha(old));
 regions.push({name,replaced_sha256:sha(old)});
 mod=mod.slice(0,i)+rep+mod.slice(j);
}
const out=input.slice(0,start)+mod+input.slice(end);
if(out.slice(0,start)!==input.slice(0,start)||!out.endsWith(input.slice(end)))throw Error('Bytes outside the home and ui modules changed');
writeFileSync('src/index.js',out);
const meta={base_service_sha256:SERVICE,integrated_sha256:sha(out),
 preserved_prefix_sha256:sha(input.slice(0,start)),preserved_suffix_sha256:sha(input.slice(end)),
 home_ui_modules_sha256:{service:sha(oldMod),candidate:sha(mod)},patched_modules:['src/home.ts','src/ui.ts'],regions};
writeFileSync('ui-fixes-preservation.json',JSON.stringify(meta,null,2)+'\n');
console.log(JSON.stringify(meta,null,1));
