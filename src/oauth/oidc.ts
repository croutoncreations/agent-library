// Access for SaaS (OIDC) upstream sign-in: authorization URL, code exchange and strict ID-token validation.
// Only the endpoints derived from the configured issuer are used; discovery is not trusted for host changes.
import { HttpError } from "../util";

export type OidcEnv = {
  ACCESS_OIDC_ISSUER?: string; // https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>
  ACCESS_OIDC_CLIENT_ID?: string;
  ACCESS_OIDC_CLIENT_SECRET?: string; // Worker secret
  OWNER_EMAIL?: string;
  OIDC_TEST_ENDPOINT_BASE?: string; // test seam: loopback-only override of the endpoint base
};

export type OidcIdentity = { issuer: string; subject: string; email: string };

const b64u = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export async function s256(v: string) { return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))); }

export function oidcConfig(env: OidcEnv) {
  const issuer = env.ACCESS_OIDC_ISSUER, clientId = env.ACCESS_OIDC_CLIENT_ID, secret = env.ACCESS_OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !secret || !env.OWNER_EMAIL) throw new HttpError(503, "oidc_not_configured", "Upstream sign-in is not configured");
  const prod = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/cdn-cgi\/access\/sso\/oidc\/[A-Za-z0-9]+$/.test(issuer);
  const testBase = env.OIDC_TEST_ENDPOINT_BASE && /^http:\/\/127\.0\.0\.1:\d+$/.test(env.OIDC_TEST_ENDPOINT_BASE) ? env.OIDC_TEST_ENDPOINT_BASE : null;
  if (!prod && !testBase) throw new HttpError(503, "oidc_not_configured", "ACCESS_OIDC_ISSUER must be an Access for SaaS OIDC issuer");
  const base = testBase ?? issuer;
  return { issuer, clientId, secret, owner: env.OWNER_EMAIL.toLowerCase(),
    authorization: `${base}/authorization`, token: `${base}/token`, jwks: `${base}/jwks` };
}

/**
 * Upstream login transaction secrets: a fresh PKCE verifier (RFC 7636, 43-128 unreserved chars; we use
 * 64 random bytes -> 86 base64url chars) and a nonce, generated per login. They are stored only in the
 * library's encrypted, single-use, browser-bound beginUpstream() record (10 min), never in a URL or cookie.
 */
export function newUpstreamSecrets() {
  return { verifier: randomToken(64), nonce: randomToken(32) };
}

/** Upstream authorization request: S256 challenge of the per-login verifier; scopes openid + email only. */
export async function authorizationUrl(env: OidcEnv, p: { redirectUri: string; state: string; nonce: string; verifier: string }) {
  const c = oidcConfig(env);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.verifier)) throw new Error("invalid PKCE verifier");
  const u = new URL(c.authorization);
  u.search = new URLSearchParams({
    response_type: "code", client_id: c.clientId, redirect_uri: p.redirectUri, scope: "openid email",
    state: p.state, nonce: p.nonce, code_challenge: await s256(p.verifier), code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

let jwksCache: { url: string; at: number; keys: Map<string, CryptoKey> } | null = null;
async function jwk(url: string, kid: string): Promise<CryptoKey | undefined> {
  for (const refresh of [false, true]) {
    if (refresh || !jwksCache || jwksCache.url !== url || Date.now() - jwksCache.at > 300_000) {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) throw new HttpError(502, "upstream_unavailable", "Cannot fetch upstream signing keys");
      const text = await r.text();
      if (text.length > 64 * 1024) throw new HttpError(502, "upstream_unavailable", "Upstream key set too large");
      const keys = new Map<string, CryptoKey>();
      for (const k of (JSON.parse(text).keys ?? []) as (JsonWebKey & { kid?: string })[])
        if (k.kty === "RSA" && k.kid) keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: k.kty, n: k.n, e: k.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
      jwksCache = { url, at: Date.now(), keys };
    }
    const key = jwksCache!.keys.get(kid);
    if (key) return key;
  }
  return undefined;
}

/**
 * Exchange the upstream code with BOTH client-secret authentication (HTTP Basic) and the matching PKCE
 * code_verifier, then validate the ID token strictly.
 */
export async function exchangeAndVerify(env: OidcEnv, p: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<OidcIdentity> {
  const c = oidcConfig(env);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.verifier)) throw new HttpError(401, "upstream_denied", "Login transaction is missing its PKCE verifier");
  if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(p.code)) throw new HttpError(401, "upstream_denied", "Malformed upstream code");
  const r = await fetch(c.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json",
      authorization: "Basic " + btoa(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.secret)}`) },
    body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier }).toString(),
  });
  const text = await r.text();
  if (!r.ok || text.length > 64 * 1024) throw new HttpError(401, "upstream_denied", "Upstream sign-in failed");
  let body: any;
  try { body = JSON.parse(text); } catch { throw new HttpError(401, "upstream_denied", "Upstream sign-in failed"); }
  const idt = typeof body.id_token === "string" ? body.id_token : "";
  const parts = idt.split(".");
  if (parts.length !== 3) throw new HttpError(401, "upstream_denied", "Missing ID token");
  let header: any, claims: any;
  try { header = JSON.parse(new TextDecoder().decode(unb64u(parts[0]))); claims = JSON.parse(new TextDecoder().decode(unb64u(parts[1]))); }
  catch { throw new HttpError(401, "upstream_denied", "Malformed ID token"); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new HttpError(401, "upstream_denied", "Unsupported ID token algorithm");
  const key = await jwk(c.jwks, header.kid);
  if (!key || !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]))))
    throw new HttpError(401, "upstream_denied", "Bad ID token signature");
  const now = Math.floor(Date.now() / 1000);
  const aud: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== c.issuer) throw new HttpError(401, "upstream_denied", "ID token issuer mismatch");
  if (!aud.includes(c.clientId) || (aud.length > 1 && claims.azp !== c.clientId)) throw new HttpError(401, "upstream_denied", "ID token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new HttpError(401, "upstream_denied", "ID token expired");
  if (typeof claims.iat !== "number" || claims.iat > now + 120) throw new HttpError(401, "upstream_denied", "ID token issued in the future");
  if (typeof claims.nonce !== "string" || claims.nonce !== p.nonce) throw new HttpError(401, "upstream_denied", "ID token nonce mismatch");
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string") throw new HttpError(401, "upstream_denied", "ID token lacks identity");
  if (claims.email_verified === false) throw new HttpError(403, "upstream_denied", "Email not verified");
  if (claims.email.toLowerCase() !== c.owner) throw new HttpError(403, "not_owner", "Only the configured owner may connect apps");
  return { issuer: claims.iss, subject: claims.sub, email: claims.email.toLowerCase() };
}
