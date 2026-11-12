// App Files API (/v1/app/files): an app's own text files, addressed by path, in its approved destination.
import { clientLiveSql } from "../oauth/server.js";

/**
 * SQL fence: the publisher is live and its destination is still valid. write: also require an enabled app client
 * (DISABLED_CLIENT_BLOCKS). Params, in order: publisher id, token epoch, project id, folder id (or null).
 */
export function baseSql(write) {
  return `EXISTS (SELECT 1 FROM publishers pb JOIN app_clients ac ON ac.id = pb.app_client_id
  WHERE pb.id = ? AND pb.token_epoch = ? AND pb.revoked_at IS NULL AND ${clientLiveSql(write)}
    AND pb.project_id = ? AND pb.folder_id IS ?
    AND (pb.folder_id IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id = pb.folder_id AND f.project_id = pb.project_id)))`;
}
/** Params for baseSql, for the publisher row `p`. */
export const baseParams = (p) => [p.id, p.token_epoch, p.project_id, p.folder_id ?? null];
