import { ICONS } from "./pwa-icons.js";

var MANIFEST2 = JSON.stringify({
  id: "/",
  name: "Agent Library",
  short_name: "Library",
  description: "Your private library of agent documents and files.",
  start_url: "/?source=pwa",
  scope: "/",
  display: "standalone",
  display_override: ["standalone", "minimal-ui"],
  orientation: "any",
  background_color: "#0a0a0d",
  theme_color: "#0a0a0d",
  icons: [
    { src: "/icons/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/app-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
});
var SHELL_CACHE = "al-shell-v2";
var SHELL_PATHS = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icons/app-icon-192.png", "/icons/app-apple-180.png"];
var SERVICE_WORKER = `"use strict";
var SHELL = ${JSON.stringify(SHELL_CACHE)}, PATHS = ${JSON.stringify(SHELL_PATHS)};
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(PATHS.map(function (p) {
      return fetch(p, { credentials: "same-origin", cache: "no-store" }).then(function (r) { if (r.ok && !r.redirected) return c.put(p, r); }).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== SHELL; }).map(function (k) { return caches.delete(k); })); })
    .then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  var nav = e.request.mode === "navigate";
  // Only app-shell navigations (/ and /p/... deep links) fall back to the cached shell. Other navigations
  // (e.g. a PDF opened in a new tab) are never touched or cached.
  if (nav && !(u.pathname === "/" || u.pathname === "/index.html" || /^\\/p\\//.test(u.pathname))) return;
  var key = nav ? "/" : u.pathname;
  if (!nav && PATHS.indexOf(key) < 0) return; // data and everything else: browser default (network)
  e.respondWith(fetch(e.request).then(function (r) {
    // Refresh the shell copy only from a real 200 same-origin response (never an Access redirect/login page).
    var ct = r.headers.get("content-type") || "";
    if (r.ok && !r.redirected && r.type === "basic" && (!nav || ct.indexOf("text/html") === 0)) { var copy = r.clone(); caches.open(SHELL).then(function (c) { return c.put(key, copy); }); }
    return r;
  }).catch(function () {
    return caches.open(SHELL).then(function (c) { return c.match(key); }).then(function (hit) {
      return hit || new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    });
  }));
});
`;
var ICON_BYTES = new Map(Object.entries(ICONS).map(([k, v]) => [k, Uint8Array.from(atob(v), (c) => c.charCodeAt(0))]));
function servePwa(path) {
  if (path === "/manifest.webmanifest")
    return new Response(MANIFEST2, { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" } });
  if (path === "/sw.js")
    return new Response(SERVICE_WORKER, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
  const m = /^\/icons\/([a-z0-9-]+\.png)$/.exec(path);
  if (m && ICON_BYTES.has(m[1]))
    return new Response(ICON_BYTES.get(m[1]), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  return null;
}

export { servePwa };
