// ---------- boot (docs/offline.md) ----------
// The installed app's shell comes from the service worker cache at once (src/offline/sw.js); boot decides what to
// show. When this device has saved copies, signing in is waited for at most BOOT_WAIT_MS: after that the saved
// copies open (read-only) while signing in continues in the background, and when it succeeds the offline banner
// offers the live library (it never switches under the reader). Without saved copies there is nothing else to
// show, so boot waits for the network as before.
var BOOT_WAIT_MS = 3000;
// A request that gets no answer at all (a dead link the phone still reports as connected) is cancelled after this
// long. Otherwise it holds its connection forever, and every later request, Try again included, queues behind it.
var BOOT_REQUEST_MS = 15000, RETRY_EVERY_MS = 30000;
// "pending": signing in behind the offline page; "ready": signed in, the live library is one tap away;
// "signin": hosted, Cloudflare Access needs the owner to sign in again; "failed": Try again couldn't reach the library;
// "refused": the library answered with a definite error (bootError), which retrying won't fix.
var bootState = null, bootIdentity = null, bootHasCopies = false, bootError = "";
// A request signal that aborts after BOOT_REQUEST_MS, or earlier when its sign-in attempt is superseded (attempt).
function bootSignal(attempt) {
  var c = new AbortController(), t = setTimeout(function () { c.abort(); }, BOOT_REQUEST_MS);
  if (attempt) { if (attempt.aborted) c.abort(); else attempt.addEventListener("abort", function () { clearTimeout(t); c.abort(); }); }
  return c.signal;
}
// Hosted: an expired Cloudflare Access session answers with a redirect to its (cross-origin) sign-in page, which a
// fetch reports as a network error, exactly like being offline. Tell the two apart without following the redirect.
async function accessWantsSignIn(attempt) {
  if (!hostedApp()) return false;
  try { return (await fetch("/api/me", { credentials: "same-origin", cache: "no-store", redirect: "manual", signal: bootSignal(attempt) })).type === "opaqueredirect"; }
  catch (e) { return false; }
}
// An answer that isn't this app's /api/me (a captive portal or proxy page, an error page) means the library wasn't
// reached, the same as no network.
function bootMe(me) {
  if (!me || !me.principal) throw new ApiError(0, { error: { code: "network", message: "The library could not be reached" } });
  return me;
}
// attempt: the AbortSignal of this sign-in attempt. Aborting it cancels every request of the attempt, so a superseded
// session exchange can't land later and replace the session (and CSRF token) a newer attempt already applied.
function bootSignIn(attempt) {
  return (async function () {
    try { return bootMe(await api("GET", "/api/me", undefined, { noAuthRedirect: true, signal: bootSignal(attempt) })); }
    catch (e1) {
      if (e1.status === 0 && await accessWantsSignIn(attempt)) throw new ApiError(401, { error: { code: "access_signin", message: "Sign in with Cloudflare Access" } });
      // Hosted: exchange the verified Cloudflare Access identity for an app session (no passphrase).
      if (e1.status !== 401 || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) throw e1;
      await api("POST", "/auth/access-login", {}, { noAuthRedirect: true, signal: bootSignal(attempt) });
      return bootMe(await api("GET", "/api/me", undefined, { noAuthRedirect: true, signal: bootSignal(attempt) }));
    }
  })();
}
// Signed out for sure: the app or Cloudflare Access answered 401.
function bootSignedOut(e) { return !!e && e.status === 401; }
// The library itself answered with a definite refusal (an app error code, e.g. 409 identity_changed or 403): show
// it; retrying won't help. Everything else that isn't a 401 (no network, a timeout, a 5xx, a proxy or captive-portal
// page) only means the library couldn't be reached, which shows the offline page, never a sign-in screen.
function bootRefused(e) {
  return !!e && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429 && !!e.code && e.code !== "network";
}
// Use a signed-in identity. False for a non-human principal.
async function bootApply(me) {
  API_BASE_HINT = me.api_base || "See your installation configuration"; S.me = me.principal; S.csrf = me.csrf;
  if (S.me.kind !== "human") { S.me = null; return false; }
  purgeForeignDrafts(S.me.id);
  await offCheckOwner(S.me.id);
  await offSweep();
  return true;
}
async function bootHasSaved() {
  await offSweep();
  try { return (await OFF.all("items")).length > 0; } catch (e) { return false; }
}
// Sign in through Cloudflare Access: a real network navigation (?al_net=1 bypasses the cached shell; the
// timestamp makes it a new URL even if the current one is the same). Boot strips the parameter again.
function signInNavigate() { location.replace("/?al_net=1&t=" + Date.now() + (location.hash || "")); }
// What a finished sign-in attempt means for the offline page. explicit: the owner tapped Try again, so success opens
// the live library at once; otherwise it is only offered while they read (it never switches under the reader).
function bootSettle(r, explicit) {
  if (!S.offline) return;
  if (r.me) {
    bootIdentity = r.me; bootState = "ready";
    if (explicit || !bootHasCopies) return goOnline();
  } else if (bootSignedOut(r.err) && hostedApp()) {
    bootState = "signin";
    if (!bootHasCopies && reloadForSignIn()) return;
  } else if (bootSignedOut(r.err) && !bootHasCopies) {
    // Local development: the passphrase form (nothing saved to read meanwhile).
    bootState = null; S.offline = false; return route();
  } else if (bootRefused(r.err)) {
    bootError = r.err.message;
    if (!bootHasCopies) { bootState = null; S.offline = false; return viewLogin(bootError); }
    bootState = "refused";
  } else bootState = explicit ? "failed" : null;
  refreshOfflineBanners();
}
// Reach the library again in place. Not a page load: on a dead link that would queue behind the stuck requests and
// leave the screen unchanged. Automatic retries wait for a running attempt; a tap starts a fresh one at once (the
// running one may be stuck on a link that has since died). A new attempt cancels the one it replaces, so only the
// newest attempt decides what happens and only its session can be applied.
// fresh: the network just came back or the app is back on screen, so an attempt that has been running a while is
// probably stuck on the old, dead link; replace it instead of waiting for it to time out.
// Automatic retries stop after a sign-out or a definite refusal; only a tap tries again then.
var retrySeq = 0, retrying = false, retryExplicit = false, retryStarted = 0, retryCtl = null;
function retryAttempt() { if (retryCtl) retryCtl.abort(); retryCtl = new AbortController(); return { seq: ++retrySeq, signal: retryCtl.signal }; }
function retryFinish(seq, r) {
  if (seq !== retrySeq) return; // superseded (and cancelled): the newer attempt decides
  var was = retryExplicit; retrying = false; retryExplicit = false; retryCtl = null;
  bootSettle(r, was);
}
function retrySignIn(explicit, fresh) {
  if (!S.offline || bootState === "ready" || ((bootState === "signin" || bootState === "refused") && !explicit)) return;
  if (retrying && !explicit && !(fresh && Date.now() - retryStarted > BOOT_WAIT_MS)) return;
  var a = retryAttempt(); retrying = true; retryExplicit = retryExplicit || !!explicit; retryStarted = Date.now();
  bootState = "pending"; refreshOfflineBanners();
  bootSignIn(a.signal).then(function (me) { return { me: me }; }, function (e) { return { err: e }; }).then(function (r) { retryFinish(a.seq, r); });
}
function retryOnline(e) { e.preventDefault(); if (bootState === "signin") return signInNavigate(); retrySignIn(true); }
// Retry on its own when the network comes back, when the app comes back to the screen, and every so often meanwhile.
window.addEventListener("online", function () { retrySignIn(false, true); });
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") retrySignIn(false, true); });
setInterval(function () { if (document.visibilityState === "visible" && navigator.onLine !== false) retrySignIn(false); }, RETRY_EVERY_MS);
function offlineBanner() {
  if (bootState === "ready") return h("p", { class: "banner offline-banner", role: "status" }, "You're connected. These are the copies saved on this device. ",
    h("a", { href: "#", onclick: function (e) { e.preventDefault(); goOnline(); } }, "Open the live library"));
  if (bootState === "pending") return h("p", { class: "banner offline-banner", role: "status" }, "Connecting… Meanwhile, here are the copies saved on this device (read-only). ",
    h("a", { href: "#", onclick: retryOnline }, "Try again"));
  if (bootState === "failed") return h("p", { class: "banner offline-banner", role: "status" }, "Still can't reach the library. Showing copies saved on this device (read-only). ",
    h("a", { href: "#", onclick: retryOnline }, "Try again"));
  if (bootState === "refused") return h("p", { class: "banner offline-banner", role: "status" }, bootError + " Showing copies saved on this device (read-only). ",
    h("a", { href: "#", onclick: retryOnline }, "Try again"));
  if (bootState === "signin") return h("p", { class: "banner offline-banner", role: "status" }, "Showing copies saved on this device (read-only). ",
    h("a", { href: "#", onclick: function (e) { e.preventDefault(); signInNavigate(); } }, "Sign in to open the live library"));
  return h("p", { class: "banner offline-banner" }, "Offline: showing copies saved on this device (read-only). ",
    h("a", { href: "#", onclick: retryOnline }, "Try again"));
}
function refreshOfflineBanners() {
  document.querySelectorAll(".offline-banner").forEach(function (b) { b.replaceWith(offlineBanner()); });
}
async function goOnline() {
  var me = bootIdentity; bootIdentity = null; bootState = null;
  if (!me || !S.offline) return;
  S.offline = false;
  if (!(await bootApply(me))) return viewLogin("Bearer-token principals cannot use the browser app.");
  route();
  setTimeout(function () { offRefreshAll().catch(function () {}); }, 1500);
}
(async function boot() {
  var a0 = retryAttempt();
  var signIn = bootSignIn(a0.signal).then(function (me) { return { me: me }; }, function (e) { return { err: e }; });
  var hasSaved = bootHasCopies = await bootHasSaved();
  // Known offline: no wait at all. Otherwise a short one, so a fast connection still opens the live library.
  var r = await Promise.race([signIn, new Promise(function (res) { setTimeout(res, navigator.onLine === false ? 0 : BOOT_WAIT_MS, null); })]);
  if (!r) {
    // Slow or no connection: open the saved copies (or the offline page) now; keep signing in behind them. A tap on
    // Try again meanwhile replaces this attempt with a fresh one.
    S.offline = true; bootState = "pending"; retrying = true; retryStarted = Date.now() - BOOT_WAIT_MS;
    signIn.then(function (late) { retryFinish(a0.seq, late); });
  } else if (r.me) {
    retryCtl = null;
    if (!(await bootApply(r.me))) return viewLogin("Bearer-token principals cannot use the browser app.");
  } else {
    var e = r.err;
    S.me = null; retryCtl = null;
    if (bootSignedOut(e) && hostedApp()) {
      // Hosted, Access itself signed out (the cached shell never passed Access): saved copies stay readable with a
      // sign-in link, since Access's page may not load on a poor connection. Without saved copies, go to its sign-in
      // page (at most once a minute; otherwise the hosted Sign in view offers it).
      if (hasSaved) { S.offline = true; bootState = "signin"; }
      else if (reloadForSignIn()) return;
    } else if (bootRefused(e)) {
      // The library answered with a definite error: show it (with the saved copies, if any). No automatic retries.
      bootError = e.message;
      if (!hasSaved) return viewLogin(bootError);
      S.offline = true; bootState = "refused";
    } else if (!bootSignedOut(e)) {
      // The library couldn't be reached: the offline page (saved copies, or how to save some), never a sign-in form.
      S.offline = true;
    }
  }
  // Resume: an explicit link wins; a bare launch (installed app start, reload after Android discarded it)
  // returns to the last place this user was. A reload of the same URL also restores scroll/tab/editor.
  var st = resumeLoad();
  if (st && (S.me || S.offline)) {
    if (launchedBare && st.hash && st.hash !== "#/") history.replaceState(null, "", "/" + st.hash);
    if (st.hash === (location.hash || "#/")) resumePending = st;
  }
  route();
  if (S.me) setTimeout(function () { offRefreshAll().catch(function () {}); }, 1500);
})();
