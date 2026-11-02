// Adapter seam (docs/architecture.md#packages-and-adapters). Core decides who can see what; adapters supply the parts
// that differ between installations: how people sign in, how much they may use, what happens around a workspace's
// life, extra routes, and mail. createWorker() attaches the adapters to env under a Symbol, so every module reads
// them from the env it already has (spreads such as {...env} keep Symbol keys).

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
  /** Every cookie request: the provider's current identity { issuer, subject } (null = no provider check). */
  async session() { return null; },
  /** Every bearer request: a provider gate in front of agents (throws to refuse). */
  async bearer() {}
};

/** Unlimited: every operation is allowed (core's own hard limits still apply). */
export const unlimited = {
  name: "unlimited",
  /** Throw HttpError(402/413) to refuse. op: "workspace.create" | "invite.create" | ... ; info: { workspaceId, ... }. */
  async check() {}
};

export const noLifecycle = {
  async workspaceCreated() {},
  async workspaceDeleted() {},
  /** An invitation was created; acceptUrl is the one-time link (hosted emails it). */
  async inviteCreated() {}
};

export const logMailer = { async send(m) { console.log("mail_not_sent", JSON.stringify({ to_domain: String(m?.to ?? "").split("@")[1] ?? null, subject: m?.subject ?? null })); } };

const DEFAULTS = Object.freeze({ identity: noIdentity, entitlements: unlimited, lifecycle: noLifecycle, mailer: logMailer, routes: [] });

/** Fill unset adapters (and unset methods) with the defaults. */
export function resolveAdapters(a = {}) {
  const out = { routes: Array.isArray(a.routes) ? a.routes : [] };
  for (const k of ["identity", "entitlements", "lifecycle", "mailer"]) out[k] = Object.freeze({ ...DEFAULTS[k], ...(a[k] ?? {}) });
  return Object.freeze(out);
}
const RESOLVED_DEFAULTS = resolveAdapters();

export function withAdapters(env, adapters) {
  return env && env[ADAPTERS] === adapters ? env : { ...env, [ADAPTERS]: adapters };
}
export function adapters(env) {
  return env?.[ADAPTERS] ?? RESOLVED_DEFAULTS;
}

/** Run a lifecycle hook after the change is committed. Hooks never undo or block the core operation. */
export async function notify(env, hook, ...args) {
  try { await adapters(env).lifecycle[hook]?.(env, ...args); }
  catch (e) { console.error("lifecycle_hook_failed", hook, e?.message ?? String(e)); }
}
