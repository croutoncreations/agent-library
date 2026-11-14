// Signed-token verification for sign-in providers (OIDC id_tokens, provider access tokens). RS256 and ES256 only.
// Keys come from the provider's JWKS URL (cached 5 minutes; refetched once on an unknown kid).
import { HttpError } from "../util.js";

const ALGS = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } }
};
const caches = new Map();
export const b64u = (b) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export async function s256(v) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
}
const deny = (msg, status = 401) => new HttpError(status, "upstream_denied", msg);

async function keyFor(url, kid, alg) {
  for (const refresh of [false, true]) {
    let c = caches.get(url);
    if (refresh || !c || Date.now() - c.at > 3e5) {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) throw new HttpError(502, "upstream_unavailable", "Cannot fetch upstream signing keys");
      const text = await r.text();
      if (text.length > 64 * 1024) throw new HttpError(502, "upstream_unavailable", "Upstream key set too large");
      const keys = new Map();
      for (const k of JSON.parse(text).keys ?? []) {
        if (!k.kid || typeof k.kid !== "string") continue;
        const a = k.kty === "RSA" ? "RS256" : k.kty === "EC" && k.crv === "P-256" ? "ES256" : null;
        if (!a || (k.alg && k.alg !== a)) continue;
        const jwk = a === "RS256" ? { kty: "RSA", n: k.n, e: k.e } : { kty: "EC", crv: "P-256", x: k.x, y: k.y };
        try { keys.set(k.kid, { alg: a, key: await crypto.subtle.importKey("jwk", jwk, ALGS[a].import, false, ["verify"]) }); } catch {}
      }
      c = { at: Date.now(), keys };
      caches.set(url, c);
    }
    const k = c.keys.get(kid);
    if (k) return k.alg === alg ? k.key : null;
  }
  return null;
}

/**
 * Verify a JWT's signature, issuer, audience and lifetime. Returns its claims.
 * opts: { jwks, issuer (a string, or an array when the provider writes its issuer in more than one form), audience,
 *         algs = ["RS256","ES256"], azp?: clientId (required when aud has several values) }
 */
export async function verifyJwt(token, opts) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || token.length > 16384) throw deny("Missing or malformed token");
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
  } catch { throw deny("Malformed token"); }
  const algs = opts.algs ?? ["RS256", "ES256"];
  if (!algs.includes(header.alg) || !ALGS[header.alg] || typeof header.kid !== "string") throw deny("Unsupported token algorithm");
  const key = await keyFor(opts.jwks, header.kid, header.alg);
  if (!key || !await crypto.subtle.verify(ALGS[header.alg].verify, key, unb64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1])))
    throw deny("Bad token signature");
  const now = Math.floor(Date.now() / 1e3);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!(Array.isArray(opts.issuer) ? opts.issuer : [opts.issuer]).includes(claims.iss)) throw deny("Token issuer mismatch");
  if (!aud.includes(opts.audience) || (opts.azp && (aud.length > 1 || claims.azp !== undefined) && claims.azp !== opts.azp)) throw deny("Token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw deny("Token expired");
  if (typeof claims.iat === "number" && claims.iat > now + 120) throw deny("Token issued in the future");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw deny("Token not yet valid");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw deny("Token lacks a subject");
  return claims;
}
