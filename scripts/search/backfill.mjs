#!/usr/bin/env node
// One bounded, restartable batch. Never loads document bodies into Node or out of the installation.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function backfillSql(after = 0, limit = 25) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('after must be >=0; limit must be 1-50');
  const range = `SELECT rowid FROM artifacts WHERE rowid>${after} ORDER BY rowid LIMIT ${limit}`;
  // The no-op title update invokes the same current-head trigger used by the old and new Workers.
  return `UPDATE artifacts SET title=title WHERE rowid IN (${range});\nUPDATE artifact_search_state SET ready=CASE WHEN NOT EXISTS(SELECT 1 FROM artifact_search_missing) THEN 1 ELSE 0 END WHERE id=1;\nSELECT COALESCE(MAX(rowid),${after}) AS next_after_rowid, COUNT(*) AS processed, (SELECT ready FROM artifact_search_state WHERE id=1) AS ready FROM (${range});`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), get = (n) => { const i=args.indexOf(n); return i<0 ? undefined : args[i+1]; };
  if (!get('--config') || (args.includes('--remote') === args.includes('--local'))) throw Error('Pass --config <file> and exactly one of --local / --remote. Remote execution requires operator authorization.');
  const after=Number(get('--after') ?? 0), limit=Number(get('--limit') ?? 25);
  const cmd=['d1','execute','DB','--config',get('--config'),args.includes('--remote')?'--remote':'--local','--command',backfillSql(after,limit),'--json'];
  if (get('--persist-to')) cmd.push('--persist-to',get('--persist-to'));
  process.stdout.write(execFileSync('wrangler',cmd,{encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}}));
}
