// Shell version (docs/offline.md): a fingerprint of exactly the bytes the service worker caches (SHELL_PATHS).
// Served at /shell-version and as X-Shell-Version on every shell file, so an installed app downloads the shell only
// when it changed, and never keeps files from two versions. Computed once per isolate (the bytes are constants of
// this Worker version). cyrb53: a fast 53-bit hash; this detects changes, it is not a security check.
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

