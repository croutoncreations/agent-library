// Browser sign-in on the app host through the identity adapter's upstream (hosted: Supabase or any OIDC provider).
//   GET /auth/signin[?next=#/...]  -> 302 to the provider (PKCE S256 + nonce + state)
//   GET /auth/callback?code&state  -> verify, map to a person (identity/accounts.js), new app session, 302 to the app
// The transaction (state, verifier, nonce, next) is kept in KV under a hash of state for 10 minutes, single use, and
// bound to this browser by an HttpOnly cookie holding a second random value.
import { adapters } from "../adapters.js";
import { SESSION_COOKIE } from "../auth.js";
import { HttpError, nowMs, randomId, sha256Hex } from "../util.js";
import { principalForIdentity } from "./accounts.js";
import { randomToken } from "./jwt.js";

const TX_COOKIE = "al_signin";
const TX_TTL = 600;
const SESSION_MS = 30 * 864e5;

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

export function browserSignInEnabled(env) {
  const id = adapters(env).identity;
  return !!id.browserSignIn(env) && !!id.upstream(env);
}

function page(status, title, msg, url) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:15vh auto;padding:0 16px;color:#18181b}a{color:#2563eb}@media (prefers-color-scheme:dark){body{background:#0a0a0d;color:#ececef}a{color:#60a5fa}}</style>
<h1>${esc(title)}</h1><p>${esc(msg)}</p><p><a href="/auth/signin">Try again</a> · <a href="/">Back to Agent Library</a></p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": `${TX_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=0${secure(url)}` } });
}

/** The sign-in options the app shows ({ id, label, email? }); [] = one "Continue" button. */
export function signinChoices(env) {
  if (!browserSignInEnabled(env)) return [];
  const c = adapters(env).identity.upstream(env).choices?.() ?? [];
  return c.filter((x) => typeof x?.id === "string" && /^[a-z0-9_-]{1,32}$/.test(x.id) && typeof x.label === "string").map((x) => ({ id: x.id, label: x.label.slice(0, 60), email: !!x.email }));
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,}$/;

/** GET /auth/signin?choice=&next=  or  POST /auth/signin (form: choice, email, next; same-origin only). */
export async function signinStart(req, env, url) {
  if (!browserSignInEnabled(env)) throw new HttpError(404, "not_found", "Not found");
  const up = adapters(env).identity.upstream(env);
  let params = url.searchParams;
  if (req.method === "POST") {
    if (req.headers.get("origin") !== url.origin) throw new HttpError(403, "bad_origin", "Cross-origin requests are not allowed");
    if (Number(req.headers.get("content-length") ?? 0) > 4096) throw new HttpError(413, "too_large", "Request body too large");
    params = new URLSearchParams(await req.text());
  }
  const choices = signinChoices(env);
  const choice = params.get("choice") ?? (choices.length === 1 ? choices[0].id : null);
  const picked = choices.find((c) => c.id === choice);
  if (choices.length && !picked) return page(400, "Choose how to sign in", "Pick one of the sign-in options.", url);
  let email = null;
  if (picked?.email) {
    if (req.method !== "POST") return page(400, "Enter your email", "Enter your email address to get a sign-in link.", url);
    email = String(params.get("email") ?? "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return page(400, "Check your email address", "That doesn't look like an email address.", url);
  }
  const state = randomToken(32), bind = randomToken(32), verifier = randomToken(64), nonce = randomToken(32);
  await env.OAUTH_KV.put(`signin:${await sha256Hex(state)}`, JSON.stringify({ bind: await sha256Hex(bind), verifier, nonce, next: safeNext(params.get("next")) }), { expirationTtl: TX_TTL });
  const target = await up.start({ redirectUri: `${url.origin}/auth/callback`, state, verifier, nonce, choice: picked?.id ?? null, email });
  // A same-origin path (e.g. the adapter's "check your email" page) or the provider's absolute URL.
  const location = target.startsWith("/") && !target.startsWith("//") ? url.origin + target : target;
  // SameSite=Lax: the provider's redirect back is a top-level GET from another site.
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer",
    "set-cookie": `${TX_COOKIE}=${bind}; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=${TX_TTL}${secure(url)}` } });
}

export async function signinCallback(req, env, url) {
  if (!browserSignInEnabled(env)) throw new HttpError(404, "not_found", "Not found");
  const state = url.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return page(400, "Sign-in didn't complete", "The sign-in link is incomplete. Start again.", url);
  const key = `signin:${await sha256Hex(state)}`;
  const tx = await env.OAUTH_KV.get(key, "json");
  const bind = cookie(req, TX_COOKIE);
  if (!tx || !bind || await sha256Hex(bind) !== tx.bind) return page(400, "Sign-in didn't complete", "This sign-in was started in another browser or has expired. Start again here.", url);
  await env.OAUTH_KV.delete(key);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return page(401, "Sign-in cancelled", "Nothing changed. You can sign in again.", url);
  let ident, who;
  try {
    ident = await adapters(env).identity.upstream(env).finish({ url, redirectUri: `${url.origin}/auth/callback`, verifier: tx.verifier, nonce: tx.nonce });
    who = await principalForIdentity(env, ident);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      console.log("browser_signin_refused", e.code);
      return page(e.status === 403 ? 403 : 401, "Can't sign you in", e.status === 403 ? e.message : "Your sign-in couldn't be verified. Start again.", url);
    }
    throw e;
  }
  const sid = randomId("ses", 32), csrf = randomId("csrf", 18);
  await env.DB.prepare("INSERT INTO sessions (id_hash, principal_id, csrf, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(sid), who.principalId, csrf, nowMs() + SESSION_MS).run();
  const h = new Headers({ location: `${url.origin}/${tx.next}`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  h.append("set-cookie", `${TX_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/; Max-Age=0${secure(url)}`);
  // Same cookie as every other sign-in (Strict): the app's own same-origin requests carry it.
  h.append("set-cookie", `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1e3}${secure(url)}`);
  return new Response(null, { status: 302, headers: h });
}
