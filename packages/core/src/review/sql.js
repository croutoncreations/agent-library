// SQL fragments shared by the document queries (service.js) and the review module (review/service.js). No imports:
// service.js reads these while it initialises, so they cannot live in a module that imports service.js.

// Newest version whose latest review is not a rejection: "the reviewed version" of an advisory document (alias `a`).
export const RV_REVIEWED_SQL = `(SELECT MAX(rv.rev_no) FROM reviews rv WHERE rv.artifact_id = a.id AND rv.rev_no IS NOT NULL AND rv.decision <> 'rejected'
  AND NOT EXISTS (SELECT 1 FROM reviews rx WHERE rx.artifact_id = rv.artifact_id AND rx.rev_no = rv.rev_no AND rx.rowid > rv.rowid))`;
// Extra columns on every artifact row read through ART_COLS: open proposal count and the advisory reviewed version.
export const RV_ART_COLS = `, (SELECT COUNT(*) FROM proposals WHERE artifact_id = a.id AND status = 'pending') AS rv_pending, CASE WHEN a.review_mode = 'advisory' THEN ${RV_REVIEWED_SQL} END AS rv_reviewed`;
