import { ICONS } from "./pwa-icons.js";
import { RESERVED_HANDLES } from "./paths.js";
import { APP_CSS, APP_HTML, APP_JS } from "./ui.js";
import SW_BODY from "./web/sw.js.txt";

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
// Cache name: changing it (or SHELL_PATHS) makes installed apps drop old caches when the new worker activates.
var SHELL_CACHE = "al-shell-v3";
var SHELL_PATHS = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icons/app-icon-192.png", "/icons/app-apple-180.png"];
// The worker body is web/sw.js.txt (docs/offline.md), served verbatim after this header. RESERVED lists the first path
// segments that are never a workspace address (paths.js), so the worker only treats real project addresses as app routes.
var SERVICE_WORKER = `"use strict";
var SHELL = ${JSON.stringify(SHELL_CACHE)}, PATHS = ${JSON.stringify(SHELL_PATHS)}, RESERVED = ${JSON.stringify([...RESERVED_HANDLES])};
` + SW_BODY;
var ICON_BYTES = new Map(Object.entries(ICONS).map(([k, v]) => [k, Uint8Array.from(atob(v), (c) => c.charCodeAt(0))]));
// Shell version (docs/offline.md): a fingerprint of exactly the bytes the service worker caches (SHELL_PATHS). Served at
// /shell-version and as X-Shell-Version on every shell file, so an installed app downloads the shell only when it changed
// and never keeps files from two versions. Computed once per isolate (the bytes are constants of this Worker version).
// cyrb53: a fast 53-bit hash; this detects changes, it is not a security check.
var shellVersionValue = null;
function shellBytesFor(p) {
  if (p === "/") return APP_HTML;
  if (p === "/app.js") return APP_JS;
  if (p === "/app.css") return APP_CSS;
  if (p === "/manifest.webmanifest") return MANIFEST2;
  if (p.startsWith("/icons/")) return ICONS[p.slice("/icons/".length)] ?? p;
  return p;
}
function shellVersion() {
  if (shellVersionValue) return shellVersionValue;
  const s = SHELL_PATHS.map((p) => p + "\0" + shellBytesFor(p)).join("\0");
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
  shellVersionValue = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  return shellVersionValue;
}
function serveShellVersion() {
  return new Response(JSON.stringify({ version: shellVersion() }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
// Manifest and icons carry the shell version like the page, script and styles (the worker itself does not: it is not cached).
function servePwa(path) {
  const r = servePwaFile(path);
  if (r && path !== "/sw.js") r.headers.set("x-shell-version", shellVersion());
  return r;
}
function servePwaFile(path) {
  if (path === "/manifest.webmanifest")
    return new Response(MANIFEST2, { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" } });
  if (path === "/sw.js")
    return new Response(SERVICE_WORKER, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
  const m = /^\/icons\/([a-z0-9-]+\.png)$/.exec(path);
  if (m && ICON_BYTES.has(m[1]))
    return new Response(ICON_BYTES.get(m[1]), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  return null;
}

export { servePwa, serveShellVersion, shellVersion };
