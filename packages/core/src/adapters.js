// Adapter seam (docs/architecture.md#packages-and-adapters). Core decides who can see what; adapters supply the parts
// that differ between installations: how people sign in, how much they may use, what happens around a workspace's
// life, extra routes, and mail. createWorker() attaches the adapters to env under a Symbol, so every module reads
// them from the env it already has (spreads such as {...env} keep Symbol keys).

import { workerSecretKeyProvider } from "./crypto/worker-secret-keys.js";

const ADAPTERS = Symbol.for("agent-library.adapters");

/** Identity with no external sign-in (local dev or tests): browser sign-in only through LOCAL_DEV_LOGIN. */
export const noIdentity = {
  name: "none",
  /** Does a browser sign-in provider front this installation? */
  enabled: () => false,
  /** Can more than one person sign in? (MULTI_USER=1/0 overrides; see tenancy.js multiUserInstall.) */
  multiUser: () => true,
  /** POST /auth/access-login: verified { issuer, subject, email|null } for a person, or throw HttpError. */
  async login() { return null; },
  /** Every cookie request while enabled(env): the provider's current identity { issuer, subject }. Throw (or return
   *  null, which core turns into 401) when the provider's token is missing or invalid. Not called when disabled. */
  async session() { return null; },
  /** Every bearer request: a provider gate in front of agents (throws to refuse). */
  async bearer() {},
  /**
   * Sign-in by redirect (consent sign-in on the OAuth host; browser sign-in when browserSignIn(env)):
   * an object { origins(), start({ redirectUri, state, verifier, nonce, choice, email, mayCreateAccount(email) -> Promise<bool> }), finish({ url, redirectUri, verifier, nonce }),
   * choices?() } whose finish() returns { issuer, subject, email|null, emailVerified }. choices() lists sign-in options
   * ({ id, label, email?: true }) shown as buttons (and an email field); the picked id arrives as `choice`. start() may
   * return a same-origin path (e.g. "check your email") instead of the provider's URL. Core's generic OIDC client is
   * identity/oidc.js (oidcFromEnv / oidcClient). null = not configured.
   */
  upstream: () => null,
  /** Does the app host sign people in through upstream() (GET /auth/signin)? */
  browserSignIn: () => false,
  /** May a first sign-in create an account (multi-user installs; SIGNUP_ALLOWLIST still applies)? */
  createAccounts: () => false,
  /** Only for upstreams that admit a single configured owner: link an unknown identity to the one existing person. */
  linkSoleOwner: () => false
};

/** Unlimited: every operation is allowed (core's own hard limits still apply). */
export const unlimited = {
  name: "unlimited",
  /** Throw HttpError(402/413) to refuse. op: "workspace.create" | "invite.create" | ... ; info: { workspaceId, ... }. */
  async check() {},
  /**
   * Usage limits core enforces inside each write (limits.js): { storage_bytes, projects, members, agents } for
   * { workspaceId }, { owned_workspaces } for { principalId }. Missing = unlimited. See planEntitlements (PLAN_LIMITS).
   */
  async limits() { return {}; },
  /**
   * Billing shown to workspace admins (hosted): null = no billing. Otherwise { plan, status?, period_end? (renews),
   * ends_at? (scheduled to end; then period_end is null), notice?, suspended_reason?,
   * actions: [{ id, label, path }] } where each path is a same-origin POST /api/... route (the installation's own
   * adapter route) that answers { url } to send the browser to (checkout, billing portal).
   */
  async billing() { return null; }
};

export const noLifecycle = {
  async workspaceCreated() {},
  async workspaceDeleted() {},
  /**
   * An invitation was created; acceptUrl is the one-time link. Hosted returns { emailed: true } if it was sent, or
   * { emailed: false, failed: true } if sending was expected but didn't happen (the page then says so).
   */
  async inviteCreated() {}
};

export const logMailer = { async send(m) { console.log("mail_not_sent", JSON.stringify({ to_domain: String(m?.to ?? "").split("@")[1] ?? null, subject: m?.subject ?? null })); } };

/**
 * keyProvider (workspace data keys for content encryption; docs/encryption.md#workspace-keys): wraps and unwraps a
 * data key for ctx { workspaceId, keyId, masterVersion }. configured(env) -> bool (throws if malformed),
 * currentVersion(env) -> positive integer, wrap(env, raw32Bytes, ctx) -> string, unwrap(env, wrapped, ctx) -> a
 * non-extractable HKDF CryptoKey with usages ["deriveKey"]. configured and currentVersion are synchronous; core checks
 * every result (crypto/keys.js). The default reads Worker secrets (crypto/worker-secret-keys.js); a hosted installation
 * may supply a KMS-backed one, which replaces the default whole: it must define all four methods.
 */
const KEY_PROVIDER_METHODS = ["configured", "currentVersion", "wrap", "unwrap"];
const DEFAULTS = Object.freeze({ identity: noIdentity, entitlements: unlimited, lifecycle: noLifecycle, mailer: logMailer, keyProvider: workerSecretKeyProvider, routes: [] });

/** Fill unset adapters (and unset methods) with the defaults. A supplied keyProvider is used whole, never merged. */
export function resolveAdapters(a = {}) {
  const routes = Array.isArray(a.routes) ? a.routes : [];
  for (const r of routes) {
    if (typeof r?.handler !== "function" || !(typeof r.path === "string" || r.path instanceof RegExp)) throw new Error("adapter route needs a path (string or RegExp) and a handler");
    // A /g or /y RegExp keeps lastIndex between requests, so matches would depend on earlier requests.
    if (r.path instanceof RegExp && (r.path.global || r.path.sticky)) throw new Error("adapter route RegExp must not use the g or y flag");
  }
  const out = { routes: Object.freeze(routes.map((r) => Object.freeze({ ...r }))) };
  for (const k of ["identity", "entitlements", "lifecycle", "mailer"]) out[k] = Object.freeze({ ...DEFAULTS[k], ...(a[k] ?? {}) });
  // Never mixed with the Worker-secret provider: half of one and half of the other would wrap and unwrap under
  // different keys, or quietly use Worker secrets an installation meant to replace.
  if (a.keyProvider) {
    const missing = KEY_PROVIDER_METHODS.filter((m) => typeof a.keyProvider[m] !== "function");
    if (missing.length) throw new Error(`adapter keyProvider must define ${KEY_PROVIDER_METHODS.join(", ")}; missing: ${missing.join(", ")}`);
    out.keyProvider = Object.freeze({ ...a.keyProvider });
  } else out.keyProvider = Object.freeze({ ...DEFAULTS.keyProvider });
  return Object.freeze(out);
}
const RESOLVED_DEFAULTS = resolveAdapters();

export function withAdapters(env, adapters) {
  return env && env[ADAPTERS] === adapters ? env : { ...env, [ADAPTERS]: adapters };
}
/** Fails closed: core code only runs inside createWorker(), so an env without adapters is a wiring bug. */
export function adapters(env) {
  const a = env?.[ADAPTERS];
  if (!a) throw new Error("Agent Library adapters are not attached; build the Worker with createWorker()");
  return a;
}
/** For tests and tools that call core directly: the default adapters (no sign-in provider, unlimited). */
export const defaultAdapters = () => RESOLVED_DEFAULTS;

/**
 * Run a lifecycle hook after the change is committed. Hooks never undo the core operation, and are capped at
 * HOOK_MS so a slow provider can't hold the response. Arguments can carry secrets (an invitation's one-time link),
 * so only the error's name is logged. Returns the hook's result (null if none), or { hookFailed: true } if it threw or
 * timed out.
 */
export const HOOK_MS = 5000;
export async function notify(env, hook, ...args) {
  const fn = adapters(env).lifecycle[hook];
  if (typeof fn !== "function") return null;
  let timer;
  try {
    return (await Promise.race([Promise.resolve().then(() => fn(env, ...args)), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "HookTimeout" })), HOOK_MS); })])) ?? null;
  } catch (e) { console.error("lifecycle_hook_failed", hook, e?.name ?? "Error"); return { hookFailed: true }; }
  finally { clearTimeout(timer); }
}
