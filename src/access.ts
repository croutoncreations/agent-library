// Cloudflare Access identity for the hosted deployment. Verifies the Cf-Access-Jwt-Assertion header
// (RS256) against the team's published certs, exact AUD, issuer and expiry. Principal identity is the
// verified issuer/subject; the email is additionally checked against the configured owner allowlist.
import { HttpError } from "./util";

// ACCESS_CERTS_URL is a test seam only: honoured solely for loopback http URLs (a deployed Worker cannot
// reach loopback, so a misconfiguration fails closed). Production always uses https://<team>/cdn-cgi/access/certs.
export type AccessEnv = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; OWNER_EMAIL?: string; ACCESS_CERTS_URL?: string };
export type AccessIdentity = { issuer: string; subject: string; email: string | null; serviceToken: boolean };

let certCache: { url: string; at: number; keys: Map<string, CryptoKey> } | null = null;

const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

function certsUrl(env: AccessEnv, team: string): string {
  const o = env.ACCESS_CERTS_URL;
  if (o && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[A-Za-z0-9/_.-]*$/.test(o)) return o;
  return `https://${team}/cdn-cgi/access/certs`;
}

async function keysFor(url: string, refresh = false): Promise<Map<string, CryptoKey>> {
  if (!refresh && certCache && certCache.url === url && Date.now() - certCache.at < 300_000) return certCache.keys;
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(503, "access_certs_unavailable", "Cannot fetch Access signing keys");
  const body = (await r.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? [])
    keys.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  certCache = { url, at: Date.now(), keys };
  return keys;
}

export const accessEnabled = (env: AccessEnv) => !!(env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD);

/**
 * Verifies the Cloudflare Access JWT (signature, exact AUD, issuer, expiry). With requireOwner (default),
 * the token must be a *user* token whose email is the configured owner; service-token JWTs (no email)
 * are rejected. requireOwner=false accepts any valid Access token for this app (user or service token);
 * it is used as an outer layer only and never grants access by itself.
 */
export async function verifyAccess(req: Request, env: AccessEnv, opts: { requireOwner?: boolean } = {}): Promise<AccessIdentity> {
  const requireOwner = opts.requireOwner ?? true;
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD, owner = env.OWNER_EMAIL;
  if (!team || !aud || !owner || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))
    throw new HttpError(401, "access_not_configured", "Hosted identity is not configured");
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) throw new HttpError(401, "unauthenticated", "Cloudflare Access login required");
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new HttpError(401, "unauthenticated", "Malformed Access token");
  let header: any, claims: any;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
  } catch { throw new HttpError(401, "unauthenticated", "Malformed Access token"); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new HttpError(401, "unauthenticated", "Unsupported Access token");
  const url = certsUrl(env, team);
  let key = (await keysFor(url)).get(header.kid);
  if (!key) key = (await keysFor(url, true)).get(header.kid);
  if (!key) throw new HttpError(401, "unauthenticated", "Unknown Access signing key");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new HttpError(401, "unauthenticated", "Bad Access token signature");
  const now = Math.floor(Date.now() / 1000);
  const auds: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new HttpError(401, "unauthenticated", "Access token audience mismatch");
  if (claims.iss !== `https://${team}`) throw new HttpError(401, "unauthenticated", "Access token issuer mismatch");
  if (typeof claims.exp !== "number" || claims.exp <= now || (typeof claims.nbf === "number" && claims.nbf > now + 60))
    throw new HttpError(401, "unauthenticated", "Access token expired");
  const isUser = typeof claims.email === "string" && claims.email !== "" && typeof claims.sub === "string" && claims.sub !== "";
  if (requireOwner) {
    if (!isUser) throw new HttpError(401, "unauthenticated", "A user login is required (service tokens cannot sign in)");
    if (claims.email.toLowerCase() !== owner.toLowerCase()) throw new HttpError(403, "forbidden", "Not the configured owner");
  }
  return { issuer: claims.iss, subject: String(claims.sub ?? ""), email: isUser ? claims.email : null, serviceToken: !isUser };
}
