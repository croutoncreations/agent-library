// Generic OpenID Connect sign-in (authorization code + PKCE S256 + nonce, confidential client). Used for the
// consent sign-in on the OAuth host and, when the identity adapter enables it, browser sign-in on the app host.
// The provider only says who the person is; access always comes from D1 memberships.
import { HttpError } from "../util.js";
import { s256, verifyJwt } from "./jwt.js";

/**
 * config: { issuer, clientId, clientSecret, authorization, token, jwks, scope = "openid email" }
 * Returns { start({ redirectUri, state, verifier, nonce }) -> URL string, finish({ url, redirectUri, verifier, nonce }) -> identity, origins() }
 * identity: { issuer, subject, email (lower-case) | null, emailVerified: boolean }
 */
export function oidcClient(config) {
  const c = config;
  for (const k of ["issuer", "clientId", "clientSecret", "authorization", "token", "jwks"]) if (!c?.[k]) throw new HttpError(503, "oidc_not_configured", "Sign-in is not configured");
  return {
    origins: () => [new URL(c.authorization).origin],
    async start(p) {
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.verifier)) throw new Error("invalid PKCE verifier");
      const u = new URL(c.authorization);
      u.search = new URLSearchParams({
        response_type: "code", client_id: c.clientId, redirect_uri: p.redirectUri, scope: c.scope ?? "openid email",
        state: p.state, nonce: p.nonce, code_challenge: await s256(p.verifier), code_challenge_method: "S256"
      }).toString();
      return u.toString();
    },
    async finish(p) {
      const code = p.url.searchParams.get("code") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.verifier)) throw new HttpError(401, "upstream_denied", "Login transaction is missing its PKCE verifier");
      if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) throw new HttpError(401, "upstream_denied", "Malformed upstream code");
      const r = await fetch(c.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json",
          authorization: "Basic " + btoa(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`) },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, code_verifier: p.verifier }).toString()
      });
      const text = await r.text();
      if (!r.ok || text.length > 64 * 1024) throw new HttpError(401, "upstream_denied", "Upstream sign-in failed");
      let body;
      try { body = JSON.parse(text); } catch { throw new HttpError(401, "upstream_denied", "Upstream sign-in failed"); }
      const claims = await verifyJwt(typeof body.id_token === "string" ? body.id_token : "", { jwks: c.jwks, issuer: c.issuer, audience: c.clientId, azp: c.clientId });
      if (typeof claims.iat !== "number") throw new HttpError(401, "upstream_denied", "ID token lacks iat");
      if (typeof claims.nonce !== "string" || claims.nonce !== p.nonce) throw new HttpError(401, "upstream_denied", "ID token nonce mismatch");
      const email = typeof claims.email === "string" && claims.email.length <= 254 ? claims.email.toLowerCase() : null;
      // Only an explicit email_verified=true counts: some providers omit it and let people edit their email, and the
      // verified email decides sign-up (SIGNUP_ALLOWLIST) and invitation matching. OIDC_TRUST_EMAIL=1 is the opt-in for
      // providers that only ever issue verified addresses but never send the claim.
      const verified = claims.email_verified === true || claims.email_verified === "true" || (c.trustEmail === true && claims.email_verified === undefined);
      return { issuer: claims.iss, subject: claims.sub, email, emailVerified: !!email && verified };
    }
  };
}

/** Generic OIDC from Worker vars (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_AUTHORIZATION_URL, OIDC_TOKEN_URL, OIDC_JWKS_URL). */
export function oidcFromEnv(env) {
  const https = (v) => typeof v === "string" && (/^https:\/\/[^\s/]+(\/\S*)?$/.test(v) || /^http:\/\/127\.0\.0\.1:\d+(\/\S*)?$/.test(v) && env.LOCAL_DEV_LOGIN);
  const urls = [env.OIDC_ISSUER, env.OIDC_AUTHORIZATION_URL, env.OIDC_TOKEN_URL, env.OIDC_JWKS_URL];
  if (!urls.every(https) || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) throw new HttpError(503, "oidc_not_configured", "Sign-in is not configured");
  return oidcClient({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
    authorization: env.OIDC_AUTHORIZATION_URL, token: env.OIDC_TOKEN_URL, jwks: env.OIDC_JWKS_URL, trustEmail: env.OIDC_TRUST_EMAIL === "1" });
}
