// The authorization shell shared by App Connect's routes: the publisher's service context, its current-authorization
// check (re-read from the database on every request) and the localhost-only test pause.
import { memberRoleSql, readOnlyError } from "../tenancy.js";
import { HttpError } from "../util.js";

export const APP_DISABLED = "This app has been disabled by the owner of this library";

/** The service context of a publisher's own request (its principal is the publisher's, never a person's). */
export function pubCtx(env, p, requestId) {
  return {
    env,
    requestId,
    publisher: true,
    principal: { id: p.principal_id, kind: "agent", label: `publisher:${p.display_name}` },
    grant: { id: p.id, project_id: p.project_id, can_write: 1 }
  };
}

/**
 * The publisher's current authorization, re-read now. Write mode (default): an active workspace and the creator a
 * member. Read mode ({ read: true }): a suspended workspace stays readable. Both: not revoked, same token epoch, an
 * enabled app client, the destination unchanged and valid. `db` is the database handle holding the publisher.
 */
export async function assertStillAuthorized(db, p, { read = false } = {}) {
  const row = await db.prepare(`SELECT pb.token_epoch,pb.revoked_at,pb.project_id,pb.folder_id,ac.disabled_at AS client_disabled,
    (SELECT w.status FROM workspaces w WHERE w.id = COALESCE(pj.workspace_id, 'wsp_' || pj.owner_id)) AS ws_status,
    ${memberRoleSql("pj.id", "member", "COALESCE(pb.created_by, pb.owner_principal_id)")} AS creator_ok,
    ${memberRoleSql("pj.id", "member", "COALESCE(pb.created_by, pb.owner_principal_id)", true)} AS creator_ok_suspended,CASE WHEN pb.folder_id IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM folders f WHERE f.id=pb.folder_id AND f.project_id=pb.project_id) END AS folder_valid
    FROM publishers pb JOIN app_clients ac ON ac.id=pb.app_client_id JOIN projects pj ON pj.id=pb.project_id WHERE pb.id=?`).bind(p.id).first();
  if (!row || row.revoked_at !== null || row.token_epoch !== p.token_epoch) throw new HttpError(401, "unauthenticated", "Publisher/client revoked or token superseded; reconnect required");
  if (row.client_disabled !== null) throw new HttpError(401, "unauthenticated", APP_DISABLED);
  const scopeOk = row.project_id === p.project_id && (row.folder_id ?? null) === (p.folder_id ?? null) && row.folder_valid;
  // Only a publisher that would otherwise be allowed learns the workspace is suspended.
  if (!read && row.ws_status === "suspended" && scopeOk && row.creator_ok_suspended) throw readOnlyError();
  if (!scopeOk || !(read ? row.creator_ok_suspended : row.creator_ok)) throw new HttpError(403, "scope_mismatch", "Publisher destination unavailable or changed");
}

/** Test hooks run only with AC_TEST_HOOKS = "1" on a localhost or 127.0.0.1 host (never in an installation). */
export const testHooksOn = (env, req) => env.AC_TEST_HOOKS === "1" && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(new URL(req.url).host);
/**
 * Test hook: pause for the `x-test-pause-before-batch-ms` header's value (at most 5 s). The pause announces itself in
 * the server log with the request's x-test-pause-tag, so a race test can act exactly while the request is paused.
 */
export async function testPause(env, req) {
  if (!testHooksOn(env, req)) return;
  const ms = Number(req.headers.get("x-test-pause-before-batch-ms"));
  if (!Number.isInteger(ms) || ms <= 0) return;
  const tag = req.headers.get("x-test-pause-tag");
  console.log(JSON.stringify({ event: "test_pause_entered", tag: tag && /^[A-Za-z0-9_-]{1,40}$/.test(tag) ? tag : null }));
  await new Promise((r) => setTimeout(r, Math.min(ms, 5e3)));
}
