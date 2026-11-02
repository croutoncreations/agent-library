// Optional bot check (Cloudflare Turnstile) on email sign-in links, the one sign-in option that makes us send email to
// an address anyone can type. Off unless TURNSTILE_SITE_KEY (var) is set; then TURNSTILE_SECRET_KEY (secret) is
// required and every email-link request must carry a token that Cloudflare's siteverify accepts. Provider buttons
// (Google, GitHub, OIDC) don't need it: the provider does its own bot checks.
import { HttpError } from "../util.js";

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const VERIFY = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

/** The public site key to render the widget with, or null when the check is off. */
export function turnstileSiteKey(env) {
  const k = env?.TURNSTILE_SITE_KEY;
  return typeof k === "string" && /^[0-9A-Za-z_-]{10,100}$/.test(k) ? k : null;
}

function verifyUrl(env) {
  // Tests only: a loopback stand-in, and only with the local dev login on (never on a real installation).
  const t = env.TURNSTILE_VERIFY_URL;
  return t && env.LOCAL_DEV_LOGIN && /^http:\/\/127\.0\.0\.1:\d{2,5}\/[A-Za-z0-9/_-]*$/.test(t) ? t : VERIFY;
}

/**
 * Throws HttpError unless the request's Turnstile token is valid. No-op when the check is off.
 * token: the form's cf-turnstile-response; ip: the client IP (cf-connecting-ip).
 */
export async function requireHuman(env, token, ip) {
  if (!turnstileSiteKey(env)) return;
  // Fail closed: a site key without its secret would otherwise let every request through.
  if (!env.TURNSTILE_SECRET_KEY) throw new HttpError(503, "turnstile_not_configured", "The human check isn't configured. Try a sign-in button instead.");
  if (typeof token !== "string" || !token || token.length > 2048) throw new HttpError(400, "human_check_required", "Complete the human check, then try again.");
  let r;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...ip && ip !== "local" ? { remoteip: ip } : {} });
    r = await fetch(verifyUrl(env), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  } catch { throw new HttpError(502, "turnstile_unavailable", "The human check couldn't be verified. Try again in a minute."); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || !j) throw new HttpError(502, "turnstile_unavailable", "The human check couldn't be verified. Try again in a minute.");
  if (j.success !== true) {
    console.log("turnstile_failed", (j["error-codes"] ?? []).join(",").slice(0, 80));
    throw new HttpError(400, "human_check_failed", "The human check didn't pass or expired. Try again.");
  }
}
