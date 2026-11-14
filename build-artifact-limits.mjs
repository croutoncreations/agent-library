// Installation-wide per-project document cap (PROJECT_ARTIFACT_LIMIT; docs/architecture.md#configuration). Runs last,
// after build-offline-shell.mjs. Exact patches, each anchor matching the stated number of times and checked to sit in
// its named module; every byte outside the patched spans is preserved (manifest hash). The review and template
// modules read the cap from their maintained sources (src/review/service.js, src/templates/service.js).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = s => createHash('sha256').update(s).digest('hex');
const input = readFileSync('src/index.js', 'utf8');
const base = JSON.parse(readFileSync('offline-shell-preservation.json', 'utf8')).integrated_sha256;
if (sha(input) !== base) throw Error('Run build-offline-shell.mjs first');
// Same logic as artifactCapFor in src/auth.ts (the snapshot keeps it for reading; this is what ships).
const CAP_HELPER = `// Per-project document cap (PROJECT_ARTIFACT_LIMIT): a positive integer from 1 to 10000, default 1000. The ceiling is
// a supported boundary, not a storage one: list paging, offline sync (stops at 2,000 items) and project backup are
// not designed for more. Anything else falls back to the default, with one config warning per Worker instance.
var ARTIFACTS_PER_PROJECT_DEFAULT = 1000, ARTIFACTS_PER_PROJECT_MAX = 10000, artifactCapWarned = false;
function artifactCapFor(env) {
  const raw = env.PROJECT_ARTIFACT_LIMIT;
  if (raw === void 0 || raw === null || raw === "") return ARTIFACTS_PER_PROJECT_DEFAULT;
  const text = String(raw);
  const n = /^[1-9]\\d{0,4}$/.test(text) ? Number(text) : 0;
  if (n >= 1 && n <= ARTIFACTS_PER_PROJECT_MAX) return n;
  if (!artifactCapWarned) {
    artifactCapWarned = true;
    console.warn(JSON.stringify({ event: "config_invalid", name: "PROJECT_ARTIFACT_LIMIT", value: text.slice(0, 40), using: ARTIFACTS_PER_PROJECT_DEFAULT, allowed: "integer 1-10000" }));
  }
  return ARTIFACTS_PER_PROJECT_DEFAULT;
}
`;
const patches = [
  ['// src/auth.ts', 'function limitsFor(env) {\n', CAP_HELPER + 'function limitsFor(env) {\n', 1],
  ['// src/auth.ts', '    readsPerMin: n(env.RATE_READS_PER_MIN, 60),',
    '    artifactsPerProject: artifactCapFor(env),\n    readsPerMin: n(env.RATE_READS_PER_MIN, 60),', 1],
  ['// src/service.ts', 'LIMITS.artifactsPerProject', 'limitsFor(ctx.env).artifactsPerProject', 1],
  ['// src/service.ts', '      artifactsPerProject: 100,', '      artifactsPerProject: 1000,', 1],
];
const spans = [];
for (const [module, find, replace, count] of patches) {
  let offset = 0, n = 0;
  while ((offset = input.indexOf(find, offset)) !== -1) {
    const start = input.lastIndexOf('\n// src/', offset) + 1;
    if (input.slice(start, input.indexOf('\n', start)) !== module) throw Error('Patch escaped ' + module);
    spans.push({ start: offset, end: offset + find.length, replace });
    offset += find.length; n++;
  }
  if (n !== count) throw Error(`Expected ${count} matches for ${find}; got ${n}`);
}
spans.sort((a, b) => a.start - b.start);
let output = '', end = 0, preserved = '';
for (const span of spans) {
  if (span.start < end) throw Error('Overlapping patches');
  const unchanged = input.slice(end, span.start);
  output += unchanged + span.replace; preserved += unchanged; end = span.end;
}
output += input.slice(end); preserved += input.slice(end);
writeFileSync('src/index.js', output);
writeFileSync('artifact-limits-preservation.json', JSON.stringify({
  base_sha256: base, integrated_sha256: sha(output), preserved_bytes_sha256: sha(preserved),
  patches: patches.map(([module, find, replace, count]) => ({ module, find_sha256: sha(find), replace_sha256: sha(replace), count })),
}, null, 2) + '\n');
console.log('Integrated the project document cap; all bytes outside exact auth/service spans preserved');
