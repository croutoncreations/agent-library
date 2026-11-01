#!/usr/bin/env node
// CI: the Worker builds from src/ reproducibly (two builds in fresh temp dirs are byte-identical), loads as an
// ES module, and contains only installation-neutral values. Replaces the old byte-pinned bundle check.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorker } from './build.mjs';

const problems = [];
const dirs = [mkdtempSync(join(tmpdir(), 'al-build-a-')), mkdtempSync(join(tmpdir(), 'al-build-b-'))];
try {
  const [a, b] = [await buildWorker({ outfile: join(dirs[0], 'index.js') }), await buildWorker({ outfile: join(dirs[1], 'index.js') })];
  if (a.sha256 !== b.sha256) problems.push(`non-deterministic build: ${a.sha256} != ${b.sha256}`);
  const text = readFileSync(a.outfile, 'utf8');
  const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  if (JSON.stringify(imports) !== JSON.stringify(['cloudflare:workers'])) problems.push(`unexpected runtime imports: ${imports.join(', ')}`);
  if (!/^export \{/m.test(text) || !/as default/.test(text)) problems.push('missing default export');
  // No operator hostnames, gateways or owner identities are compiled in; they all come from config.
  if (/cc-hosted-mcp-gateway|workers\.dev\/upstream|cloudflareaccess\.com\/cdn-cgi|@gmail\.com|artifacts\.croutoncreations\.com/.test(text)) problems.push('installation-specific value in the build');
  if (!problems.length) console.log(`build OK: reproducible (sha256 ${a.sha256}, ${a.bytes} bytes)`);
} finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
if (problems.length) { console.error(problems.map((p) => `::error::${p}`).join('\n')); process.exit(1); }
