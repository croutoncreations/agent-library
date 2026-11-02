// Map a verified sign-in identity { issuer, subject, email, emailVerified } to a person (human principal).
// Order: an existing link (upstream_identities, or the principal's own issuer/subject) -> the one existing person,
// only for identity adapters whose upstream admits a single configured owner (identity.linkSoleOwner; self-host
// Cloudflare Access) -> a new account, if the identity adapter allows sign-up.
// Sign-in claims never grant access: a new account starts with only its personal workspace (migration 0017 trigger).
import { adapters } from "../adapters.js";
import { HttpError, nowIso, randomId } from "../util.js";

/** SIGNUP_ALLOWLIST: comma-separated emails and @domains. Unset = anyone with a verified email (D16 A). */
export function signupAllowed(env, email) {
  const raw = String(env.SIGNUP_ALLOWLIST ?? "").trim();
  if (!raw) return true;
  const at = email.lastIndexOf("@");
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((e) => e.startsWith("@") ? email.slice(at) === e : email === e);
}

async function invitedEmail(env, email) {
  return !!await env.DB.prepare("SELECT 1 FROM workspace_invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(email, Date.now()).first();
}

function labelFor(email) {
  const local = (email ?? "").split("@")[0].replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 40);
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "Member";
}

/**
 * Returns { principalId, created } or throws HttpError (403 signup_closed / email_unverified / no_account).
 * opts.legacyLabel: label for the single-user fallback's message context only.
 */
export async function principalForIdentity(env, ident) {
  if (!ident?.issuer || !ident?.subject) throw new HttpError(401, "upstream_denied", "Sign-in returned no identity");
  const DB = env.DB;
  let id = await DB.prepare("SELECT principal_id FROM upstream_identities WHERE issuer = ? AND subject = ?").bind(ident.issuer, ident.subject).first("principal_id");
  id ??= await DB.prepare("SELECT id FROM principals WHERE kind = 'human' AND issuer = ? AND subject = ?").bind(ident.issuer, ident.subject).first("id");
  if (id) {
    // Keep the verified email current when this provider is how the person signs in to the app (invitations match it).
    // An owner-only consent link (self-host Access for SaaS) leaves the email from the app's own sign-in alone.
    if (ident.email && ident.emailVerified && adapters(env).identity.browserSignIn(env)) await DB.prepare("UPDATE principals SET email = ? WHERE id = ? AND email IS NOT ?").bind(ident.email, id, ident.email).run();
    return { principalId: id, created: false };
  }
  const identity = adapters(env).identity;
  if (identity.linkSoleOwner?.(env)) {
    // Owner-only upstream (it already refused every email but OWNER_EMAIL): link to the one person, who signed in to
    // the web app first. Never used for providers that admit many people.
    const humans = (await DB.prepare("SELECT id FROM principals WHERE kind = 'human' AND issuer <> 'restored'").all()).results;
    if (humans.length !== 1) throw new HttpError(403, "no_account", "Sign in to the Agent Library web app first.");
    await DB.prepare("INSERT OR IGNORE INTO upstream_identities (issuer, subject, principal_id, email, created_at) VALUES (?, ?, ?, ?, ?)").bind(ident.issuer, ident.subject, humans[0].id, ident.email ?? "", nowIso()).run();
    return { principalId: humans[0].id, created: false };
  }
  if (!ident.email || !ident.emailVerified) throw new HttpError(403, "email_unverified", "Verify your email address with your sign-in provider, then try again.");
  // Invited people can always create their account (to accept the invitation); others need sign-up to be open.
  const invited = await invitedEmail(env, ident.email);
  if (!invited && !identity.createAccounts?.(env)) throw new HttpError(403, "no_account", "There is no Agent Library account for this sign-in.");
  if (!invited && !signupAllowed(env, ident.email)) throw new HttpError(403, "signup_closed", "Sign-up isn't open for this email address yet.");
  await adapters(env).entitlements.check(env, "account.create", { email: ident.email });
  const pid = randomId("hum"), at = nowIso();
  // One statement batch: the principal (trigger: personal workspace) and its sign-in link. A concurrent first sign-in
  // for the same identity loses on the UNIQUE (issuer, subject) and re-reads the winner's account.
  try {
    await DB.batch([
      DB.prepare("INSERT INTO principals (id, kind, issuer, subject, label, created_at, email) VALUES (?, 'human', ?, ?, ?, ?, ?)").bind(pid, ident.issuer, ident.subject, labelFor(ident.email), at, ident.email),
      DB.prepare("INSERT INTO upstream_identities (issuer, subject, principal_id, email, created_at) VALUES (?, ?, ?, ?, ?)").bind(ident.issuer, ident.subject, pid, ident.email, at)
    ]);
  } catch (e) {
    if (!/UNIQUE|PRIMARY KEY/i.test(String(e?.message ?? e))) throw e;
    const winner = await DB.prepare("SELECT principal_id FROM upstream_identities WHERE issuer = ? AND subject = ?").bind(ident.issuer, ident.subject).first("principal_id");
    if (!winner) throw e;
    return { principalId: winner, created: false };
  }
  return { principalId: pid, created: true };
}
