// Optional bot check (Cloudflare Turnstile) on email sign-in links, the one sign-in option that makes us send email to
// an address anyone can type. Off unless TURNSTILE_SITE_KEY (var) is set; then TURNSTILE_SECRET_KEY (secret) is
// required and every email-link request must carry a token that Cloudflare's siteverify accepts. Provider buttons
// (Google, GitHub, OIDC) don't need it: the provider does its own bot checks.
import { HttpError } from "../util.js";

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const VERIFY = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

/** The check is on whenever TURNSTILE_SITE_KEY is set to anything (a malformed key refuses; it never skips the check). */
export function turnstileOn(env) {
  return typeof env?.TURNSTILE_SITE_KEY === "string" && env.TURNSTILE_SITE_KEY !== "";
}
/** The public site key to render the widget with, or null when the check is off or the key is malformed. */
export function turnstileSiteKey(env) {
  const k = env?.TURNSTILE_SITE_KEY;
  return typeof k === "string" && /^[0-9A-Za-z_-]{10,100}$/.test(k) ? k : null;
}
const notConfigured = (why) => {
  console.error("turnstile_not_configured", why);
  return new HttpError(503, "turnstile_not_configured", "The human check isn't configured. Try a sign-in button instead.");
};

function verifyUrl(env) {
  // Tests only: a loopback stand-in, and only with the local dev login on (never on a real installation).
  const t = env.TURNSTILE_VERIFY_URL;
  return t && env.LOCAL_DEV_LOGIN && /^http:\/\/127\.0\.0\.1:\d{2,5}\/[A-Za-z0-9/_-]*$/.test(t) ? t : VERIFY;
}

/**
 * Throws HttpError unless the request's Turnstile token is valid. No-op when the check is off.
 * token: the form's cf-turnstile-response; ip: the client IP (cf-connecting-ip).
 */
export async function requireHuman(env, token, ip, hostname) {
  if (!turnstileOn(env)) return;
  // Fail closed: a malformed key (copy-paste whitespace, quotes) or a key without its secret would otherwise let
  // every request through.
  if (!turnstileSiteKey(env)) throw notConfigured("bad_site_key");
  if (!env.TURNSTILE_SECRET_KEY) throw notConfigured("no_secret");
  if (typeof token !== "string" || !token || token.length > 2048) throw new HttpError(400, "human_check_required", "Complete the human check, then try again.");
  let r;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...ip && ip !== "local" ? { remoteip: ip } : {} });
    r = await fetch(verifyUrl(env), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(5000) });
  } catch { throw new HttpError(502, "turnstile_unavailable", "The human check couldn't be verified. Try again in a minute."); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || !j) throw new HttpError(502, "turnstile_unavailable", "The human check couldn't be verified. Try again in a minute.");
  const codes = Array.isArray(j["error-codes"]) ? j["error-codes"].map(String) : [];
  // A wrong or missing secret is our configuration, not the visitor: say so and log it loudly.
  if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret")) throw notConfigured("bad_secret");
  if (j.success !== true) {
    console.log("turnstile_failed", codes.join(",").slice(0, 80));
    throw new HttpError(400, "human_check_failed", "The human check didn't pass or expired. Try again.");
  }
  // The token must have been solved on this site (a key shared with other hostnames can't lend its tokens here).
  // Cloudflare's test keys report "example.com". Accepted only in local dev AND with one of Cloudflare's published
  // test secrets (which never validate real tokens), so a real secret can never use this exception.
  const testHost = !!env.LOCAL_DEV_LOGIN && /^[123]x0{31}AA$/.test(env.TURNSTILE_SECRET_KEY) && j.hostname === "example.com";
  if (hostname && j.hostname !== hostname && !testHost) {
    console.log("turnstile_wrong_host");
    throw new HttpError(400, "human_check_failed", "The human check didn't pass or expired. Try again.");
  }
}
