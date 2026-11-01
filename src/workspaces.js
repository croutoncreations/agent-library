// Workspace administration (docs/workspaces.md): human-only. Every mutation re-checks the actor's role inside the
// same statement, and the "at least one owner" rule is enforced in SQL so two concurrent demotions can't both win.
import { requireHuman } from "./auth.js";
import { ROLES, ROLE_RANK, requireWorkspaceRole, workspaceRoleSql } from "./tenancy.js";
import { HttpError, nowIso, nowMs, randomId, sha256Hex, str } from "./util.js";

export const INVITE_DAYS = 14;
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

function wsAudit(env, ctx, workspaceId, action, objectId, result, gate = "", gateParams = []) {
  return env.DB.prepare(
    `INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id) SELECT ?, ?, NULL, ?, ?, ?, ?, ?${gate ? ` WHERE ${gate}` : ""}`
  ).bind(nowIso(), ctx.principal.id, action, objectId, result, ctx.requestId, workspaceId, ...gateParams);
}
function role(v, allowOwner) {
  const r = String(v ?? "");
  if (!ROLES.includes(r) || (!allowOwner && r === "owner")) throw new HttpError(400, "invalid_input", `role must be one of ${(allowOwner ? ROLES : ROLES.filter((x) => x !== "owner")).join(", ")}`);
  return r;
}
function wsName(v) {
  const n = str(v, "name", 80, { min: 1 }).trim();
  if (!n || /[\u0000-\u001f\u007f]/.test(n)) throw new HttpError(400, "invalid_input", "name must be 1-80 characters");
  return n;
}

export async function listWorkspaces(ctx) {
  requireHuman(ctx);
  const r = await ctx.env.DB.prepare(
    `SELECT w.id, w.name, w.personal, w.status, w.plan, w.created_at, m.role,
       (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count
     FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.principal_id = ?
     WHERE w.status <> 'deleting' ORDER BY w.personal DESC, w.created_at LIMIT 200`
  ).bind(ctx.principal.id).all();
  return { workspaces: r.results.map((w) => ({ ...w, personal: !!w.personal })) };
}

export async function createWorkspace(ctx, input) {
  requireHuman(ctx);
  if (ctx.env.WORKSPACE_CREATION === "off") throw new HttpError(403, "forbidden", "Creating workspaces is turned off on this installation");
  const name = wsName(input?.name);
  const id = randomId("wsp", 12), at = nowIso();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("INSERT INTO workspaces (id, name, personal, status, plan, created_by, created_at) VALUES (?, ?, 0, 'active', 'free', ?, ?)").bind(id, name, ctx.principal.id, at),
    ctx.env.DB.prepare("INSERT INTO workspace_members (workspace_id, principal_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)").bind(id, ctx.principal.id, ctx.principal.id, at),
    wsAudit(ctx.env, ctx, id, "workspace.create", id, "ok")
  ]);
  return { id, name, personal: false, status: "active", role: "owner", member_count: 1 };
}

export async function updateWorkspace(ctx, id, input) {
  requireHuman(ctx);
  await requireWorkspaceRole(ctx, id, "owner");
  const name = wsName(input?.name);
  const [r] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE workspaces AS w SET name = ? WHERE w.id = ? AND ${workspaceRoleSql("w.id", "owner")}`).bind(name, id, ctx.principal.id),
    wsAudit(ctx.env, ctx, id, "workspace.rename", id, "ok", "changes() = 1")
  ]);
  if (!r.meta.changes) throw new HttpError(403, "forbidden", "Needs the owner role in this workspace");
  return { ok: true, id, name };
}

/** Marks a shared workspace 'deleting': closed to everyone immediately. Data removal is an operator job (hosted). */
export async function deleteWorkspace(ctx, id) {
  requireHuman(ctx);
  const ws = await requireWorkspaceRole(ctx, id, "owner");
  if (ws.personal) throw new HttpError(409, "personal_workspace", "Your personal workspace can't be deleted");
  const [r] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE workspaces AS w SET status = 'deleting' WHERE w.id = ? AND w.personal = 0 AND ${workspaceRoleSql("w.id", "owner")}`).bind(id, ctx.principal.id),
    wsAudit(ctx.env, ctx, id, "workspace.delete", id, "ok", "changes() = 1")
  ]);
  if (!r.meta.changes) throw new HttpError(403, "forbidden", "Needs the owner role in this workspace");
  return { ok: true, status: "deleting" };
}

export async function listMembers(ctx, id) {
  requireHuman(ctx);
  const ws = await requireWorkspaceRole(ctx, id, "viewer");
  const m = await ctx.env.DB.prepare(
    `SELECT m.principal_id, m.role, m.created_at, p.label, p.email FROM workspace_members m JOIN principals p ON p.id = m.principal_id
     WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, m.created_at LIMIT 500`
  ).bind(id).all();
  const admin = ROLE_RANK[ws.role] >= ROLE_RANK.admin;
  const inv = admin ? await ctx.env.DB.prepare(
    `SELECT id, email, role, created_at, expires_at FROM workspace_invites WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 200`
  ).bind(id, nowMs()).all() : { results: [] };
  return {
    workspace: { id: ws.id, name: ws.name, personal: !!ws.personal, role: ws.role },
    // Emails are shown to admins only; everyone sees names and roles.
    members: m.results.map((x) => ({ principal_id: x.principal_id, label: x.label, email: admin ? x.email : null, role: x.role, created_at: x.created_at, me: x.principal_id === ctx.principal.id })),
    invites: inv.results.map((i) => ({ ...i, expires_at: new Date(i.expires_at).toISOString() }))
  };
}

// SQL guard: after this change the workspace still has an owner other than `target` (bound: workspace, target).
const OTHER_OWNER = "EXISTS (SELECT 1 FROM workspace_members o WHERE o.workspace_id = ? AND o.role = 'owner' AND o.principal_id <> ?)";

export async function setMemberRole(ctx, id, principalId, input) {
  requireHuman(ctx);
  const me = await requireWorkspaceRole(ctx, id, "admin");
  const next = role(input?.role, true);
  const cur = await ctx.env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND principal_id = ?").bind(id, principalId).first("role");
  if (!cur) throw new HttpError(404, "not_found", "Member not found");
  // Admins manage members and viewers; only owners can grant, change or remove the owner and admin roles.
  const ownerOnly = cur === "owner" || next === "owner" || cur === "admin" || next === "admin";
  if (ownerOnly && me.role !== "owner") throw new HttpError(403, "forbidden", "Only owners can change owner and admin roles");
  const need = ownerOnly ? "owner" : "admin";
  const [r] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE workspace_members AS wm SET role = ? WHERE wm.workspace_id = ? AND wm.principal_id = ? AND wm.role = ?
        AND ${workspaceRoleSql("?", need)} AND (? = 'owner' OR ${OTHER_OWNER})`)
      .bind(next, id, principalId, cur, ctx.principal.id, id, next, id, principalId),
    wsAudit(ctx.env, ctx, id, "member.role", principalId, `ok:${cur}->${next}`, "changes() = 1")
  ]);
  if (!r.meta.changes) {
    if (cur === "owner" && next !== "owner") throw new HttpError(409, "last_owner", "A workspace needs at least one owner. Make someone else an owner first.");
    throw new HttpError(409, "conflict", "The member's role changed meanwhile. Reload and try again.");
  }
  return { ok: true, principal_id: principalId, role: next };
}

export async function removeMember(ctx, id, principalId) {
  requireHuman(ctx);
  const self = principalId === ctx.principal.id;
  const me = await requireWorkspaceRole(ctx, id, self ? "viewer" : "admin");
  if (me.personal && self) throw new HttpError(409, "personal_workspace", "You can't leave your personal workspace");
  const cur = await ctx.env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND principal_id = ?").bind(id, principalId).first("role");
  if (!cur) throw new HttpError(404, "not_found", "Member not found");
  if (!self && (cur === "owner" || cur === "admin") && me.role !== "owner") throw new HttpError(403, "forbidden", "Only owners can remove owners and admins");
  const need = self ? "viewer" : cur === "owner" || cur === "admin" ? "owner" : "admin";
  const [r] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`DELETE FROM workspace_members AS wm WHERE wm.workspace_id = ? AND wm.principal_id = ? AND wm.role = ?
        AND ${workspaceRoleSql("?", need)} AND ${OTHER_OWNER}`).bind(id, principalId, cur, ctx.principal.id, id, id, principalId),
    // Per-project caps go with the membership.
    ctx.env.DB.prepare(`DELETE FROM project_members WHERE principal_id = ? AND changes() = 1 AND project_id IN
        (SELECT id FROM projects WHERE COALESCE(workspace_id, 'wsp_' || owner_id) = ?)`).bind(principalId, id),
    wsAudit(ctx.env, ctx, id, self ? "member.leave" : "member.remove", principalId, `ok:${cur}`, "NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND principal_id = ?)", [id, principalId])
  ]);
  if (!r.meta.changes) {
    if (cur === "owner") throw new HttpError(409, "last_owner", "A workspace needs at least one owner. Make someone else an owner first.");
    throw new HttpError(409, "conflict", "The member's role changed meanwhile. Reload and try again.");
  }
  return { ok: true };
}

export async function createInvite(ctx, id, input, origin) {
  requireHuman(ctx);
  const me = await requireWorkspaceRole(ctx, id, "admin");
  if (me.personal) throw new HttpError(409, "personal_workspace", "Create a shared workspace to invite people");
  const email = str(input?.email, "email", 254, { min: 3 }).trim().toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, "invalid_input", "Enter a valid email address");
  const r = role(input?.role ?? "member", false);
  if (r === "admin" && me.role !== "owner") throw new HttpError(403, "forbidden", "Only owners can invite admins");
  const already = await ctx.env.DB.prepare(
    "SELECT 1 FROM workspace_members m JOIN principals p ON p.id = m.principal_id WHERE m.workspace_id = ? AND lower(p.email) = ?"
  ).bind(id, email).first();
  if (already) throw new HttpError(409, "already_member", "That person is already a member");
  const token = randomId("inv", 32), inviteId = randomId("inv", 12), expires = nowMs() + INVITE_DAYS * 864e5;
  const [ins] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${workspaceRoleSql("?", r === "admin" ? "owner" : "admin")}`)
      .bind(inviteId, id, email, r, await sha256Hex(token), ctx.principal.id, nowIso(), expires, ctx.principal.id, id),
    wsAudit(ctx.env, ctx, id, "invite.create", inviteId, `ok:${r}`, "changes() = 1")
  ]);
  if (!ins.meta.changes) throw new HttpError(403, "forbidden", "Needs the admin role in this workspace");
  // The link is returned once. The token is in the URL fragment, so it never reaches servers or logs. Hosted delivery
  // emails it; self-host shows it to copy.
  return { id: inviteId, email, role: r, expires_at: new Date(expires).toISOString(), accept_url: `${origin}/#/invite/${token}` };
}

export async function revokeInvite(ctx, id, inviteId) {
  requireHuman(ctx);
  await requireWorkspaceRole(ctx, id, "admin");
  const [r] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE workspace_invites AS wi SET revoked_at = ? WHERE wi.id = ? AND wi.workspace_id = ? AND wi.accepted_at IS NULL AND wi.revoked_at IS NULL
        AND ${workspaceRoleSql("wi.workspace_id", "admin")}`).bind(nowMs(), inviteId, id, ctx.principal.id),
    wsAudit(ctx.env, ctx, id, "invite.revoke", inviteId, "ok", "changes() = 1")
  ]);
  if (!r.meta.changes) throw new HttpError(404, "not_found", "Invite not found or no longer pending");
  return { ok: true };
}

/** Preview an invite (signed-in person): workspace name, role, whether my email matches. Never reveals the email. */
export async function previewInvite(ctx, input) {
  requireHuman(ctx);
  const inv = await findInvite(ctx, input);
  const ws = await ctx.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(inv.workspace_id).first("name");
  const email = await myEmail(ctx);
  return { workspace_name: ws, role: inv.role, email_matches: !!email && email === inv.email, signed_in_email: email };
}

export async function acceptInvite(ctx, input) {
  requireHuman(ctx);
  const inv = await findInvite(ctx, input);
  const email = await myEmail(ctx);
  // The verified sign-in email must match: a forwarded link alone grants nothing.
  if (!email || email !== inv.email) throw new HttpError(403, "email_mismatch", "This invitation was sent to a different email address. Sign in with that address.");
  const at = nowIso(), ms = nowMs();
  const [claim, add] = await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE workspace_invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(ms, ctx.principal.id, inv.id, ms),
    // Never lowers an existing role: an owner accepting a viewer invite stays owner.
    ctx.env.DB.prepare(`INSERT INTO workspace_members (workspace_id, principal_id, role, added_by, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1
        ON CONFLICT (workspace_id, principal_id) DO NOTHING`).bind(inv.workspace_id, ctx.principal.id, inv.role, inv.invited_by, at),
    ctx.env.DB.prepare(`INSERT INTO audits (at, actor_id, project_id, action, object_id, result, request_id, workspace_id)
        SELECT ?, ?, NULL, 'invite.accept', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_invites WHERE id = ? AND accepted_by = ? AND accepted_at = ?)`)
      .bind(at, ctx.principal.id, inv.id, `ok:${inv.role}`, ctx.requestId, inv.workspace_id, inv.id, ctx.principal.id, ms)
  ]);
  if (!claim.meta.changes) throw new HttpError(410, "invite_used", "This invitation was already used, revoked or has expired");
  void add;
  return { ok: true, workspace_id: inv.workspace_id };
}

async function findInvite(ctx, input) {
  const token = str(input?.token, "token", 80, { min: 10 });
  const inv = await ctx.env.DB.prepare(
    `SELECT i.*, w.status FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!inv || inv.status !== "active") throw new HttpError(404, "not_found", "Invitation not found");
  if (inv.revoked_at !== null || inv.accepted_at !== null || inv.expires_at <= nowMs()) throw new HttpError(410, "invite_used", "This invitation was already used, revoked or has expired");
  return inv;
}
async function myEmail(ctx) {
  const e = await ctx.env.DB.prepare("SELECT email FROM principals WHERE id = ?").bind(ctx.principal.id).first("email");
  return e ? String(e).toLowerCase() : null;
}
