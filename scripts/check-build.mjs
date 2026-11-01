#!/usr/bin/env node
// CI: the Worker builds from src/ reproducibly (two builds in fresh temp dirs are byte-identical), loads as an
// ES module exporting fetch and scheduled handlers, and contains only installation-neutral values.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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
  // It loads as an ES module (cloudflare:workers stubbed) and exports the Worker handlers.
  const probe = join(dirs[0], 'probe.mjs');
  writeFileSync(probe, text.replace('import { WorkerEntrypoint } from "cloudflare:workers";', 'class WorkerEntrypoint {}'));
  const mod = await import(pathToFileURL(probe).href);
  if (typeof mod.default?.fetch !== 'function' || typeof mod.default?.scheduled !== 'function') problems.push('default export lacks fetch/scheduled handlers');
  // No operator hostnames, gateways or owner identities are compiled in; they all come from config.
  if (/cc-hosted-mcp-gateway|workers\.dev\/upstream|cloudflareaccess\.com\/cdn-cgi|@gmail\.com|artifacts\.croutoncreations\.com/.test(text)) problems.push('installation-specific value in the build');
  if (!problems.length) console.log(`build OK: reproducible (sha256 ${a.sha256}, ${a.bytes} bytes)`);
} finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
if (problems.length) { console.error(problems.map((p) => `::error::${p}`).join('\n')); process.exit(1); }
