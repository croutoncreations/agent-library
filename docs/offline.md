# Offline launch and the installed app shell

The installed app opens at once, offline or on a slow or dead connection. Sources: `packages/core/src/web/sw.js.txt` (service worker), `packages/core/src/pwa.js` (worker header, shell version, `/shell-version`), the boot section of `packages/core/src/web/app.js.txt`. Tests: `test/offline-shell.test.mjs`, `test/offline-network.test.mjs`, `test/offline-hosted.test.mjs` and the cached-shell cases in `test/hosted-session.test.mjs`.

## What it does

- **Instant launch.** The service worker keeps the app shell in the Cache API (`/`, `/app.js`, `/app.css`, the manifest and two icons, cache `al-shell-v3`) and answers app navigations from it first: `/`, `/index.html`, `/p/:pid[/a/:aid[/preview|/edit]]` and project addresses `/<workspace>/<project>[/a/<doc>[/preview|/edit]]` (first segments in `RESERVED_HANDLES` excepted). A launch never waits on the network to show the app.
- **Never from the cache:** invitation links (`/invite/…`), everything under `/auth/` (sign-in, callback, check-email), an installation's own routes (sign-up, billing, legal pages), library data (API, content, previews, files) and any other navigation (a PDF in a new tab). The worker only sees its own origin: the user-content host and the MCP host are other origins, never intercepted or cached, and neither serves `/sw.js` or `/shell-version`.
- **Slow or dead connection.** Boot waits at most 3 seconds for sign-in (`/auth/methods`, `/api/me`, and `/auth/access-login` behind Cloudflare Access); not at all when the browser knows it is offline. Then it opens the offline page: the copies saved on this device, read-only, or with none how to save some. The banner says "Connecting…" while sign-in continues.
  - When sign-in succeeds with copies on screen, the banner offers **Open the live library**; the app never switches under the reader. With nothing saved the live library opens at once.
  - Saved copies opened from an address link (`/<workspace>/<project>/a/<doc>`) are found by the project address stored with the copy.
- **Only a 401 means "sign in".** A 401 from the app (or, on a self-hosted installation, Cloudflare Access's redirect, detected with `redirect: "manual"`) is a definite sign-out. No network, a timeout, a 5xx and a captive-portal page only mean the library couldn't be reached: the offline page, never a sign-in screen. A definite refusal from the library (another 4xx with an app error code, such as `409 identity_changed`) shows its message and isn't retried on its own; **Try again** still retries.
  - **Self-hosted (Cloudflare Access):** signed out with saved copies opens them with **Sign in to open the live library** (a network navigation, `/?al_net=1&t=<now>`, so Access can show its page). Without copies, the app navigates to Access sign-in, at most once a minute.
  - **Hosted (OIDC sign-in):** a 401 shows the app's sign-in screen, whose button goes to `/auth/signin`. A device that is signed out and reaches the library never opens saved copies on its own. If the link is slow and copies are already on screen, they stay with a **Sign in to open the live library** link that opens the sign-in screen.
- **Dead links that come back.** Sign-in requests are cancelled after 15 seconds (20 in the service worker), otherwise they hold the browser's few connections to the host and every later request queues behind them. **Try again** signs in again in place, with no page load, and a new attempt cancels the one it replaces, so a late session exchange can't replace the session (and CSRF token) the live app uses. The app also retries on `online`, when it returns to the screen and every 30 seconds while visible.
- **Updates, only when the app changed.** Each launch asks `GET /shell-version` (a few bytes), a fingerprint of the exact bytes served for the shell files (computed over the filled `app.js`), so it changes only when a deploy changes them. A different version downloads the complete new shell once, in the background, into `<name>-next`. Every file must carry that version in `X-Shell-Version`, so a deploy landing mid-download is never stored. The next launch swaps it in whole (best effort: skipped while more than one app window is open), so one launch never mixes versions. An app left open updates only when reopened. The whole shell is about 90 KB compressed; no deltas.

## What is never cached

- Library data: API responses, content, previews and files always go to the network. Offline reading uses only the copies the person saved in IndexedDB (read-only, stored unencrypted, removed on sign-out or when another person signs in; Settings → Offline on this device).
- A shell response that is not a plain same-origin `200`: Access redirects and sign-in pages are rejected (`/` must be the app's own page, and no other shell file may be HTML).

## Content Security Policy

Unchanged. The worker is `worker-src 'self'`, the shell's scripts and styles are same-origin, and the shell page's CSP (including the user-content host in `frame-src` and Turnstile when enabled) is served as before and stored with the cached page.

## Not tested

Not tested against a real Cloudflare Access or a real hosted provider; the stand-ins answer the way they do (401 for API calls, a sign-in page for page loads). The Access redirect fallback (`opaqueredirect`) isn't exercised. On a shared device, saved copies stay readable offline after a session merely expires, until someone signs out or a different person signs in; they exist only if the person chose **Make available offline** or **Keep offline**.

## Changing the shell

Changing `SHELL_PATHS` or `SHELL_CACHE` in `pwa.js` makes installed apps drop old caches when the new worker activates.
