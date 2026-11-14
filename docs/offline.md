# Offline launch and the installed app shell

Status: implemented. Build step `build-offline-shell.mjs` (last in `npm run build:design`). Sources: `src/offline/sw.js` (service worker body) and `src/offline/boot.js` (browser boot). Tests: `test/offline-shell.test.mjs`.

## What it does

- **Instant launch.** The service worker keeps the app shell in the Cache API (`/`, `/app.js`, `/app.css`, the manifest and two icons) and answers app navigations (`/`, `/index.html`, `/p/:pid[/a/:aid[/preview|/edit]]`) from that cache first. A launch never waits on the network to show the app.
- **Offline page first on a slow or dead connection.** Boot waits at most 3 seconds for sign-in (`/api/me`, plus `/auth/access-login` when hosted). If the browser reports it is offline, boot doesn't wait at all. After that it opens the offline page: the saved copies, read-only, or, with none, how to save some. The banner says "Connecting…" while signing in continues in the background.
  - If sign-in succeeds and saved copies are on screen, the banner offers **Open the live library**; the app never switches pages under the reader. With nothing saved, the live library opens at once.
  - Only a definite sign-out (a 401 from the app or Access) leads to a sign-in screen. No network, a timeout, or a server, proxy or captive-portal answer only means the library couldn't be reached, which shows the offline page.
  - A definite refusal from the library itself (another 4xx with an app error code, such as `409 identity_changed`) shows its message, next to the saved copies if there are any. The app doesn't retry it on its own, since retrying can't help; **Try again** still does.
- **Dead links that come back.** A phone can report a connection that answers nothing. Requests sent over it are cancelled after 15 seconds (20 in the service worker); otherwise they hold the browser's few connections to the host and every later request, **Try again** included, queues behind them.
  - **Try again** signs in again in place (no page load). It starts a fresh attempt even while one is running, opens the live library when it succeeds, and otherwise says it still can't reach the library. A new attempt cancels the one it replaces, so a late session exchange can't replace the session (and CSRF token) the live app is using.
  - The app also retries on its own when the network comes back (`online`), when it returns to the screen, and every 30 seconds while visible; those offer the live library rather than switching to it.
- **Updates, only when the app changed.** Each launch asks `GET /shell-version` for the current shell version, a few bytes. The version is a fingerprint the Worker computes from the exact bytes it serves for the shell files, so it changes only when a deploy changes them. If it matches the cached shell, nothing is downloaded. If it differs, the complete new shell is downloaded once, in the background, into a second cache (`<name>-next`). Every file must carry that version in `X-Shell-Version`, so a deploy landing mid-download is never stored. The next launch swaps the new shell in all at once, so one launch never mixes files from two versions. A failed or partial download is dropped and retried on a later launch. As a best effort, the swap is skipped while more than one app window is listed. A window that already loaded keeps its script and styles in memory, so a swap at the same moment only affects its later manifest and icon requests. A deploy reaches an installed app on the launch after the one that downloaded it. An app left open never updates until it is reopened or reloaded.
  - During that one launch, the old script may ask for an editor bundle that the new deploy no longer serves. The editor then falls back to the plain text box until the next launch.
  - An update downloads the whole shell, about 90 KB compressed, mostly `app.js`. No deltas: it's one bundled file that changes with nearly every deploy, and a diff/patch scheme would cost more than it saves.

## What is never cached

- Very large projects: **Keep project offline** lists a project 40 pages at a time and so syncs only its first 2,000 items. Documents beyond that are not kept, even if the project's cap (`PROJECT_ARTIFACT_LIMIT`, default 1,000, at most 10,000) allows more.
- Library data: API responses, content, previews and files. Every data request still goes to the network through Cloudflare Access. Offline reading uses only the copies the owner saved in IndexedDB (read-only, removed on sign-out; see Settings → Offline).
- Anything other than an exact shell file or app route. A PDF opened in a new tab, for example, is left to the browser.
- A shell response that is not a plain same-origin `200`. Access redirects and sign-in pages are rejected: `/` must be the app's own page (it loads `/app.js`), and no other shell file may be HTML.

## Cloudflare Access

A cached shell skips Access for the HTML, script and styles, which contain no user data. Every API call still passes Access. API calls send `X-Requested-With`, so an expired Access session answers with a 401. If Access answers with a redirect to its sign-in page instead, a fetch reports it as a network error, just like being offline. As a fallback, boot repeats `/api/me` with `redirect: "manual"`: an opaque redirect means Access wants a sign-in. When Access has signed out:

- with saved copies, they open with a **Sign in to open the live library** link;
- without saved copies, the app navigates to Access sign-in once a minute at most, as before.

Sign-in navigations use `/?al_net=1&t=<now>`. The worker sends these to the network first, so Access can show its page. When the answer is this app's page, the worker loads that page's script and styles from the network too, so the page and its files are one version even right after a deploy. This is best effort: if the browser restarts the worker between the page and its files, the files come from the cache. Boot then removes the parameter from the address bar. The offline banner's **Try again** is not a navigation (see "Dead links that come back"); when Access has signed out, the banner links to a sign-in navigation instead.

Tests: `test/offline-network.test.mjs` runs the hosted app behind a stand-in for Access, with the cached shell in real Chrome, through each network failure, with and without saved copies: airplane mode, refused connections, a dead link (staying dead; coming back with Try again, on its own, or on reopening), dying while live, a very slow link, a captive portal, a 502, Access signed out, a refused sign-in, Try again during a slow session exchange, flapping, and reading a saved document when the connection returns. Also `test/offline-shell.test.mjs` (loopback: stalled network, a dead link that comes back with and without Try again, no network, updates, `al_net`) and the "cached shell" cases in `test/hosted-session.test.mjs` (an unreachable network with nothing saved shows the offline page, never Sign in) (a stand-in for Access that answers an expired session with a 401 for API calls and its sign-in page for page loads; it also checks that the background refresh never caches that page). Not tested against a real Cloudflare Access deployment, and the redirect fallback isn't tested.

## Changing the shell

Changing `SHELL_PATHS`, or the shell cache name in `build-offline-shell.mjs`, makes installed apps drop old caches when the new worker activates. The worker body is pinned by hash in the build step. If it changes upstream, review it before re-pinning.
