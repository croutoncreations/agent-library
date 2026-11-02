// Identity adapter for any standard OpenID Connect provider (Auth0, Okta, Google, Keycloak, Supabase's OIDC server,
// Cloudflare Access for SaaS, ...): browser sign-in at /auth/signin and the consent sign-in for ChatGPT/Claude both go
// through the provider; the app session cookie is the authority afterwards (no per-request provider token).
// Vars: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (secret), OIDC_AUTHORIZATION_URL, OIDC_TOKEN_URL, OIDC_JWKS_URL.
// New accounts: only when SIGNUP_ALLOWLIST is set (emails/@domains) or SIGNUP_OPEN=1, so pointing an installation at a
// public provider never opens it to everyone by accident. Invited emails can always create their account.
import { oidcFromEnv } from "./oidc.js";

export const oidcConfigured = (env) => !!env?.OIDC_ISSUER;

export const oidcIdentity = {
  name: "oidc",
  enabled: () => false,
  multiUser: () => true,
  async login() { return null; },
  async session() { return null; },
  async bearer() {},
  upstream: (env) => oidcFromEnv(env),
  browserSignIn: () => true,
  createAccounts: (env) => !!String(env.SIGNUP_ALLOWLIST ?? "").trim() || env.SIGNUP_OPEN === "1",
  linkSoleOwner: () => false
};
