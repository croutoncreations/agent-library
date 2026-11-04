// Installed-app shell (docs/offline.md). Integrated into the PWA module's SERVICE_WORKER text by
// build-offline-shell.mjs, after a header that defines SHELL (cache name) and PATHS (shell files).
// The app opens from this cache at once, with no network or a slow one: launches never wait on the network.
// Only the static shell is cached (HTML, script, styles, manifest, icons): never library data or API responses.
// Every data request still goes to the network, through Cloudflare Access; offline reading uses the copies the
// owner saved in IndexedDB.
// Updates: each launch asks the server for the shell version (/shell-version, a few bytes). Only when it differs from
// the cached shell (and from one already downloaded) is a complete new shell downloaded into NEXT in the background;
// the next launch swaps it in whole, so one launch never mixes files from two versions. Every file of a download
// must carry that same version (X-Shell-Version), so a deploy landing mid-download is never stored.
// A navigation with ?al_net=1 (sign-in through Access) goes to the network first, so Access can show its page.
var NEXT = SHELL + "-next", VKEY = "/__al-shell-version", updating = null;
// Pages that came from the network (sign-in navigations): their script and styles come from the network too, so the
// page and its files are one version even right after a deploy (best effort: a worker restart in between forgets
// the page, and its files then come from the cache). Keyed by client id; each entry holds the files still to load
// and is dropped once both have loaded, so the map stays small.
var netPages = {}, NET_FILES = ["/app.js", "/app.css"];
function noop() {}
// Background requests give up after this long: on a link that accepts connections but never answers, a request left
// hanging holds one of the browser's few connections to this host, and the page's own requests (sign-in, Try
// again) queue behind it. A worker also keeps one update attempt "running" until it settles.
var BG_TIMEOUT_MS = 20000;
function bgFetch(url) {
  var c = new AbortController(), t = setTimeout(function () { c.abort(); }, BG_TIMEOUT_MS);
  return fetch(url, { credentials: "same-origin", cache: "no-store", signal: c.signal }).then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
}
// The shell version a cache holds, or null (no cache, or no complete shell in it).
function versionOf(name) {
  return caches.has(name).then(function (has) {
    if (!has) return null;
    return caches.open(name).then(function (c) { return c.match(VKEY); }).then(function (r) { return r ? r.text() : null; });
  });
}
// Download every shell file; all must report the same version (want, if given). Resolves { list, version }.
function fetchShell(want) {
  return Promise.all(PATHS.map(function (p) {
    return bgFetch(p).then(function (r) {
      // Only a real 200 same-origin response (never an Access redirect or sign-in page).
      var ct = r.headers.get("content-type") || "";
      // HTML only for "/", and nothing else may be HTML (a sign-in or error page in place of the script or styles).
      if (!r.ok || r.redirected || r.type !== "basic" || (p === "/") !== (ct.indexOf("text/html") === 0)) throw new Error("shell fetch failed: " + p);
      // Read each body at once: unread bodies would hold the browser's few connections per host while the rest wait.
      return r.blob().then(function (b) {
        // "/" must be this app's page (it loads /app.js), never a sign-in or interstitial page answered in its place.
        return (p === "/" ? b.text() : Promise.resolve("")).then(function (t) {
          if (p === "/" && t.indexOf('<script src="/app.js"') < 0) throw new Error("not the app shell");
          return [p, new Response(b, { status: 200, headers: r.headers }), r.headers.get("x-shell-version") || ""];
        });
      });
    });
  })).then(function (list) {
    var v = want || list[0][2];
    if (!v || list.some(function (x) { return x[2] !== v; })) throw new Error("shell files from different versions");
    return { list: list, version: v };
  });
}
function store(name, got) {
  return caches.open(name).then(function (c) {
    return Promise.all(got.list.map(function (x) { return c.put(x[0], x[1]); }))
      .then(function () { return c.put(VKEY, new Response(got.version)); }); // written last: marks the cache complete
  });
}
function refresh() {
  if (!updating) updating = bgFetch("/shell-version")
    .then(function (r) { if (!r.ok || r.redirected || r.type !== "basic") throw new Error("no version"); return r.json(); })
    .then(function (d) {
      var v = d && d.version;
      if (!v) return;
      return Promise.all([versionOf(SHELL), versionOf(NEXT)]).then(function (have) {
        if (have[0] === v) return have[1] ? caches.delete(NEXT) : null; // current (drop any other download, e.g. after a rollback)
        if (have[1] === v) return; // already downloaded; swapped in on the next launch
        return fetchShell(v).then(function (got) { return caches.delete(NEXT).then(function () { return store(NEXT, got); }); });
      });
    })
    .catch(noop)
    .then(function () { updating = null; });
  return updating;
}
// Swap in a complete downloaded shell (all PATHS and its version present); an incomplete one is dropped. Best effort:
// skipped while more than one window is listed. A window that already loaded keeps its script and styles in memory,
// so a swap at the same moment only changes what its later manifest and icon requests see.
function promote() {
  if (updating) return Promise.resolve();
  var keys = PATHS.concat([VKEY]);
  return self.clients.matchAll({ type: "window" }).then(function (ws) {
    if (ws.length > 1) return;
    return caches.has(NEXT).then(function (has) {
      if (!has) return;
      return caches.open(NEXT).then(function (n) {
        return Promise.all(keys.map(function (p) { return n.match(p); })).then(function (rs) {
          if (rs.some(function (r) { return !r; })) return;
          return caches.open(SHELL).then(function (c) { return Promise.all(rs.map(function (r, i) { return c.put(keys[i], r); })); });
        });
      }).then(function () { return caches.delete(NEXT); });
    });
  }).catch(noop);
}
function offline() { return new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }); }
function fromCache(key) { return caches.open(SHELL).then(function (c) { return c.match(key); }); }
self.addEventListener("install", function (e) {
  // All or nothing: if the shell can't be fetched completely, installation fails and the current worker stays.
  e.waitUntil(fetchShell(null).then(function (got) { return store(SHELL, got); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== SHELL && k !== NEXT; }).map(function (k) { return caches.delete(k); })); })
    .then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  var nav = e.request.mode === "navigate";
  // Only app-shell navigations (/ and the app's /p/... deep links, the server's WEB_ROUTE) use the cached shell.
  // Other navigations (e.g. a PDF opened in a new tab) are never touched or cached.
  if (nav && !(u.pathname === "/" || u.pathname === "/index.html" || /^\/p\/([^/]+)(?:\/a\/([^/]+)(?:\/(preview|edit))?)?\/?$/.test(u.pathname))) return;
  var key = nav ? "/" : u.pathname;
  if (!nav && PATHS.indexOf(key) < 0) return; // data and everything else: browser default (network)
  if (nav && /[?&]al_net=1(&|$)/.test(u.search)) {
    var page = e.resultingClientId;
    e.respondWith(fetch(e.request).then(function (r) {
      // This app's page from the network (not an Access redirect or sign-in page): load its files from the network too.
      if (page && r.ok && r.headers.get("x-shell-version")) netPages[page] = NET_FILES.slice();
      return r;
    }).catch(function () { return fromCache(key).then(function (hit) { return hit || offline(); }); }));
    return;
  }
  var pending = !nav && netPages[e.clientId];
  if (pending && pending.indexOf(key) >= 0) {
    pending.splice(pending.indexOf(key), 1);
    if (!pending.length) delete netPages[e.clientId];
    e.respondWith(fetch(e.request).catch(function () { return fromCache(key).then(function (hit) { return hit || offline(); }); }));
    return;
  }
  var ready = nav ? promote() : Promise.resolve();
  e.respondWith(ready.then(function () { return fromCache(key); }).then(function (hit) {
    return hit || fetch(e.request).catch(offline);
  }));
  if (nav) e.waitUntil(ready.then(refresh));
});
