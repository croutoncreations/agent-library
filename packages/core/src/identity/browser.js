// Browser sign-in on the app host through the identity adapter's upstream (hosted: Supabase or any OIDC provider).
//   GET /auth/signin?choice=&next=   -> 302 to the provider (PKCE S256 + nonce + state)
//   POST /auth/signin (choice, email, next; same-origin form) -> e.g. email link sent -> /auth/check-email
//   GET /auth/callback?code&state    -> verify, map to a person (identity/accounts.js), new app session, 302 to the app
//   GET /auth/check-email            -> "check your email" (served on both hosts)
// The transaction (state, verifier, nonce, next) is kept in KV under a hash of state for 10 minutes, single use, and
// bound to this browser by an HttpOnly cookie holding a second random value. Starting a sign-in is rate limited per
// IP, and sending an email link also per address.
import { adapters } from "../adapters.js";
import { rateLimit, sessionCookie } from "../auth.js";
import { statusPage } from "../oauth/server.js";
import { HttpError, nowMs, randomId, sha256Hex } from "../util.js";
import { mayCreateAccount, principalForIdentity } from "./accounts.js";
import { randomToken } from "./jwt.js";
import { requireHuman } from "./turnstile.js";

const TX_COOKIE = "al_signin";
const TX_TTL = 600;
const SESSION_MS = 30 * 864e5;
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;

function cookie(req, name) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
const secure = (url) => url.protocol === "https:" ? "; Secure" : "";
/** Only same-app hash routes are allowed as the return target (no open redirect). */
const safeNext = (v) => typeof v === "string" && /^#\/[A-Za-z0-9/_\-.~%?=&]{0,300}$/.test(v) ? v : "#/";
const back = (next) => "/" + (next && next !== "#/" ? next : "");

export function browserSignInEnabled(env) {
  const id = adapters(env).identity;
  return !!id.browserSignIn(env) && !!id.upstream(env);
}

/** A sign-in status page; the primary action returns to the app's sign-in card (keeping where the person was going). */
function page(status, title, msg, url, { next, icon, actions } = {}) {
  const h = new Headers({ "cache-control": "no-store" });
  h.append("set-cookie", `${TX_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=0${secure(url)}`);
  return statusPage(title, msg, { status, icon, headers: h, actions: actions ?? [{ href: back(next), label: "Back to sign in", primary: true }] });
}

/** The sign-in options the app shows ({ id, label, email? }); [] = one "Continue" button. */
export function signinChoices(env) {
  if (!browserSignInEnabled(env)) return [];
  const c = adapters(env).identity.upstream(env).choices?.() ?? [];
  return c.filter((x) => typeof x?.id === "string" && /^[a-z0-9_-]{1,32}$/.test(x.id) && typeof x.label === "string").map((x) => ({ id: x.id, label: x.label.slice(0, 60), email: !!x.email }));
}

/**
 * Rate limits for starting a sign-in (shared with the consent sign-in on the OAuth host): per IP, and per address for
 * email links. Throws HttpError 429.
 */
export async function limitSigninStart(env, req, email) {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  // OAUTH_RATE_MULTIPLIER scales these like the other OAuth-host limits (tests and busy shared egress IPs).
  const mult = env.OAUTH_RATE_MULTIPLIER && /^\d{1,6}$/.test(env.OAUTH_RATE_MULTIPLIER) ? Number(env.OAUTH_RATE_MULTIPLIER) : 1;
  const n = (v, d) => (v && /^\d{1,6}$/.test(v) ? Number(v) : d) * mult;
  await rateLimit(env, "signin:" + ip, n(env.RATE_SIGNIN_PER_MIN, 20));
  if (email) {
    await rateLimit(env, "signinmail:" + ip, n(env.RATE_SIGNIN_EMAIL_PER_MIN, 5));
    await rateLimit(env, "signinmail:" + await sha256Hex(email), Math.min(2 * mult, n(env.RATE_SIGNIN_EMAIL_PER_MIN, 5)));
  }
}

/** Errors from the adapter's start(): a page the person can act on (never raw JSON). */
export function startFailure(e) {
  if (e instanceof HttpError && e.status === 429) return { status: 429, title: "Too many sign-in attempts", msg: "Wait a minute, then try again." };
  if (e instanceof HttpError && /^human_check|^turnstile/.test(e.code ?? "")) return { status: e.status, title: "Human check", msg: e.message };
  if (e instanceof HttpError && e.status < 500) return { status: e.status, title: "Can't start sign-in", msg: e.message };
  console.error("signin_start_failed", e?.code ?? e?.name ?? "error");
  return { status: 502, title: "Sign-in is unavailable", msg: "We couldn't reach the sign-in service. Try again in a minute." };
}

/** GET /auth/signin?choice=&next=  or  POST /auth/signin (form: choice, email, next; same-origin only). */
export async function signinStart(req, env, url) {
  if (!browserSignInEnabled(env)) throw new HttpError(404, "not_found", "Not found");
  const up = adapters(env).identity.upstream(env);
  let params = url.searchParams;
  if (req.method === "POST") {
    // A same-origin form post. With Referrer-Policy: no-referrer, browsers send "Origin: null" on form posts, so
    // Sec-Fetch-Site (set by the browser, not settable by pages) is the signal; a matching Origin also counts.
    const o = req.headers.get("origin"), sfs = req.headers.get("sec-fetch-site");
    if (!(o === url.origin || (sfs === "same-origin" && (o === null || o === "null" || o === url.origin))))
      throw new HttpError(403, "bad_origin", "Cross-origin requests are not allowed");
    if (Number(req.headers.get("content-length") ?? 0) > 4096) throw new HttpError(413, "too_large", "Request body too large");
    params = new URLSearchParams(await req.text());
  }
  const next = safeNext(params.get("next"));
  const choices = signinChoices(env);
  const choice = params.get("choice") ?? (choices.length === 1 ? choices[0].id : null);
  const picked = choices.find((c) => c.id === choice);
  if (choices.length && !picked) return page(400, "Choose how to sign in", "Pick one of the sign-in options.", url, { next });
  let email = null;
  if (picked?.email) {
    if (req.method !== "POST") return page(400, "Enter your email", "Enter your email address to get a sign-in link.", url, { next });
    email = String(params.get("email") ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return page(400, "Check your email address", "That doesn't look like an email address, for example you@example.com.", url, { next });
  }
  let target;
  const state = randomToken(32), bind = randomToken(32), verifier = randomToken(64), nonce = randomToken(32);
  try {
    // Email links only: the human check runs before anything is counted, stored or sent.
    if (email) await requireHuman(env, params.get("cf-turnstile-response"), req.headers.get("cf-connecting-ip"));
    await limitSigninStart(env, req, email);
    await env.OAUTH_KV.put(`signin:${await sha256Hex(state)}`, JSON.stringify({ bind: await sha256Hex(bind), verifier, nonce, next }), { expirationTtl: TX_TTL });
    target = await up.start({ redirectUri: `${url.origin}/auth/callback`, state, verifier, nonce, choice: picked?.id ?? null, email, mayCreateAccount: (e) => mayCreateAccount(env, e) });
  } catch (e) {
    const f = startFailure(e);
    return page(f.status, f.title, f.msg, url, { next });
  }
  // A same-origin path (e.g. the "check your email" page) or the provider's absolute URL.
  const location = target.startsWith("/") && !target.startsWith("//") ? url.origin + target : target;
  // SameSite=Lax: the provider's redirect back is a top-level GET from another site.
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer",
    "set-cookie": `${TX_COOKIE}=${bind}; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=${TX_TTL}${secure(url)}` } });
}

/** After an email link was requested (served on both hosts, so the consent sign-in can use it too). */
export function checkEmailPage() {
  return statusPage("Check your email", "We've sent a sign-in link to your email address. Open it in this browser within 10 minutes. Nothing arrived? Check your spam folder, or go back and request a new link.",
    { icon: "check" });
}

/** Provider error on return: cancelled vs an expired/used email link vs anything else. */
export function callbackError(url) {
  const err = url.searchParams.get("error") ?? "", code = url.searchParams.get("error_code") ?? "";
  console.log("signin_callback_error", (code || err).slice(0, 40));
  if (/otp_expired|expired|already|used/i.test(code + " " + (url.searchParams.get("error_description") ?? "")))
    return { title: "This sign-in link has expired", msg: "Sign-in links work once, for a short time (some email scanners open them first). Request a new link." };
  if (err === "access_denied" && !code) return { title: "Sign-in cancelled", msg: "Nothing changed. You can sign in again." };
  return { title: "Sign-in didn't complete", msg: "The sign-in service couldn't finish signing you in. Try again." };
}

export async function signinCallback(req, env, url) {
  if (!browserSignInEnabled(env)) throw new HttpError(404, "not_found", "Not found");
  const state = url.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return page(400, "Sign-in didn't complete", "The sign-in link is incomplete. Start again.", url);
  const key = `signin:${await sha256Hex(state)}`;
  const tx = await env.OAUTH_KV.get(key, "json");
  const bind = cookie(req, TX_COOKIE);
  if (!tx || !bind || await sha256Hex(bind) !== tx.bind)
    return page(400, "Open the link where you started", "This sign-in was started in another browser, or it expired. If you asked for the email on another device, request a new link from this one.", url);
  await env.OAUTH_KV.delete(key);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    const f = callbackError(url);
    return page(401, f.title, f.msg, url, { next: tx.next });
  }
  let ident, who;
  try {
    ident = await adapters(env).identity.upstream(env).finish({ url, redirectUri: `${url.origin}/auth/callback`, verifier: tx.verifier, nonce: tx.nonce });
    who = await principalForIdentity(env, ident);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      console.log("browser_signin_refused", e.code);
      if (e.code === "signup_closed" || e.code === "no_account") return page(403, "No account for this sign-in", e.message, url, { actions: [{ href: "/", label: "Use a different account", primary: true }] });
      return page(e.status === 403 ? 403 : 401, "Can't sign you in", e.status === 403 ? e.message : "Your sign-in couldn't be verified. Start again.", url, { next: tx.next });
    }
    throw e;
  }
  const sid = randomId("ses", 32), csrf = randomId("csrf", 18);
  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(sid), who.principalId, csrf, nowMs() + SESSION_MS).run();
  const h = new Headers({ location: `${url.origin}/${tx.next}`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  h.append("set-cookie", `${TX_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=0${secure(url)}`);
  for (const c of sessionCookie(url, sid, SESSION_MS / 1e3)) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}
