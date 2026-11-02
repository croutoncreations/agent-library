// Self-host identity adapter: Cloudflare Access in front of the app host admits only OWNER_EMAIL (one person), and
// service tokens may front agents. With no Access configured (local dev), there is no provider and the install is
// multi-user so shared-workspace flows can be exercised.
import { HttpError } from "../../core/src/util.js";

function certsUrl(env, team) {
  const o = env.ACCESS_CERTS_URL;
  if (o && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[A-Za-z0-9/_.-]*$/.test(o)) return o;
  return `https://${team}/cdn-cgi/access/certs`;
}
async function keysFor(url, refresh = false) {
  if (!refresh && certCache && certCache.url === url && Date.now() - certCache.at < 3e5) return certCache.keys;
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(503, "access_certs_unavailable", "Cannot fetch Access signing keys");
  const body2 = await r.json();
  const keys = /* @__PURE__ */ new Map();
  for (const k of body2.keys ?? [])
    keys.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  certCache = { url, at: Date.now(), keys };
  return keys;
}
async function verifyAccess(req, env, opts = {}) {
  const requireOwner = opts.requireOwner ?? true;
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD, owner = env.OWNER_EMAIL;
  if (!team || !aud || !owner || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))
    throw new HttpError(401, "access_not_configured", "Hosted identity is not configured");
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) throw new HttpError(401, "unauthenticated", "Cloudflare Access login required");
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new HttpError(401, "unauthenticated", "Malformed Access token");
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
  } catch {
    throw new HttpError(401, "unauthenticated", "Malformed Access token");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new HttpError(401, "unauthenticated", "Unsupported Access token");
  const url = certsUrl(env, team);
  let key = (await keysFor(url)).get(header.kid);
  if (!key) key = (await keysFor(url, true)).get(header.kid);
  if (!key) throw new HttpError(401, "unauthenticated", "Unknown Access signing key");
  const ok2 = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok2) throw new HttpError(401, "unauthenticated", "Bad Access token signature");
  const now = Math.floor(Date.now() / 1e3);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new HttpError(401, "unauthenticated", "Access token audience mismatch");
  if (claims.iss !== `https://${team}`) throw new HttpError(401, "unauthenticated", "Access token issuer mismatch");
  if (typeof claims.exp !== "number" || claims.exp <= now || typeof claims.nbf === "number" && claims.nbf > now + 60)
    throw new HttpError(401, "unauthenticated", "Access token expired");
  const isUser = typeof claims.email === "string" && claims.email !== "" && typeof claims.sub === "string" && claims.sub !== "";
  if (requireOwner) {
    if (!isUser) throw new HttpError(401, "unauthenticated", "A user login is required (service tokens cannot sign in)");
    if (claims.email.toLowerCase() !== owner.toLowerCase()) throw new HttpError(403, "forbidden", "Not the configured owner");
  }
  return { issuer: claims.iss, subject: String(claims.sub ?? ""), email: isUser ? claims.email : null, serviceToken: !isUser };
}
var certCache, unb64url, accessEnabled;
certCache = null;
unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
accessEnabled = (env) => !!(env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD);

export const accessIdentity = {
  name: "cloudflare-access",
  enabled: (env) => accessEnabled(env),
  multiUser: (env) => !accessEnabled(env),
  login: (req, env) => verifyAccess(req, env),
  async session(req, env) { return accessEnabled(env) ? verifyAccess(req, env) : null; },
  async bearer(req, env) { if (accessEnabled(env)) await verifyAccess(req, env, { requireOwner: false }); }
};
export { accessEnabled, verifyAccess };
