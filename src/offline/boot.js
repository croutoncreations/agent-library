// ---------- boot (docs/offline.md) ----------
// The installed app's shell comes from the service worker cache at once (src/offline/sw.js); boot decides what to
// show. When this device has saved copies, signing in is waited for at most BOOT_WAIT_MS: after that the saved
// copies open (read-only) while signing in continues in the background, and when it succeeds the offline banner
// offers the live library (it never switches under the reader). Without saved copies there is nothing else to
// show, so boot waits for the network as before.
var BOOT_WAIT_MS = 3000;
// "pending": still signing in behind the saved copies; "ready": signed in, the live library is one tap away;
// "signin": hosted, Cloudflare Access needs the owner to sign in again.
var bootState = null, bootIdentity = null;
// Hosted: an expired Cloudflare Access session answers with a redirect to its (cross-origin) sign-in page, which a
// fetch reports as a network error, exactly like being offline. Tell the two apart without following the redirect.
async function accessWantsSignIn() {
  if (!hostedApp()) return false;
  try { return (await fetch("/api/me", { credentials: "same-origin", cache: "no-store", redirect: "manual" })).type === "opaqueredirect"; }
  catch (e) { return false; }
}
function bootSignIn() {
  return (async function () {
    try { return await api("GET", "/api/me", undefined, { noAuthRedirect: true }); }
    catch (e1) {
      if (e1.status === 0 && await accessWantsSignIn()) throw new ApiError(401, { error: { code: "access_signin", message: "Sign in with Cloudflare Access" } });
      // Hosted: exchange the verified Cloudflare Access identity for an app session (no passphrase).
      if (e1.status !== 401 || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) throw e1;
      await api("POST", "/auth/access-login", {}, { noAuthRedirect: true });
      return await api("GET", "/api/me", undefined, { noAuthRedirect: true });
    }
  })();
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
// Retry from the network: hosted goes through Access (a plain reload would come from the cached shell); if the
// network still fails, the worker answers from the cache and the saved copies open again.
function retryOnline(e) { e.preventDefault(); if (hostedApp()) signInNavigate(); else location.reload(); }
function offlineBanner() {
  if (bootState === "ready") return h("p", { class: "banner offline-banner", role: "status" }, "You're connected. These are the copies saved on this device. ",
    h("a", { href: "#", onclick: function (e) { e.preventDefault(); goOnline(); } }, "Open the live library"));
  if (bootState === "pending") return h("p", { class: "banner offline-banner", role: "status" }, "Connecting… Meanwhile, here are the copies saved on this device (read-only). ",
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
  var signIn = bootSignIn().then(function (me) { return { me: me }; }, function (e) { return { err: e }; });
  var r = null;
  // Known offline: no wait at all. Otherwise a short one, so a fast connection still opens the live library.
  if (await bootHasSaved()) r = await Promise.race([signIn, new Promise(function (res) { setTimeout(res, navigator.onLine === false ? 0 : BOOT_WAIT_MS, null); })]);
  else r = await signIn;
  if (!r) {
    // Slow or no connection: open the saved copies now; keep signing in behind them.
    S.offline = true; bootState = "pending";
    signIn.then(function (late) {
      if (!S.offline) return;
      if (late.me) { bootIdentity = late.me; bootState = "ready"; }
      else bootState = late.err && late.err.status === 401 && hostedApp() ? "signin" : null;
      refreshOfflineBanners();
    });
  } else if (r.me) {
    if (!(await bootApply(r.me))) return viewLogin("Bearer-token principals cannot use the browser app.");
  } else {
    var e = r.err;
    S.me = null;
    // Hosted, Access itself signed out (the cached shell never passed Access): saved copies stay readable with a
    // sign-in link, since Access's page may not load on a poor connection. Without saved copies, go to its sign-in
    // page (at most once a minute; otherwise the hosted Sign in view offers it).
    if (e && e.status === 401 && hostedApp()) {
      if (await bootHasSaved()) { S.offline = true; bootState = "signin"; }
      else if (reloadForSignIn()) return;
    } else if (e && e.status === 0) {
      // No network (or Access sign-in page unreachable): open saved offline copies instead of a dead login form.
      await offSweep();
      var saved = []; try { saved = await OFF.all("items"); } catch (e2) {}
      if (saved.length || !navigator.onLine) S.offline = true;
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
