#!/usr/bin/env node
// Build the deployable Worker from packages/core/src/ into dist/worker/index.js (one ES module, no network, no secrets).
// The output is deterministic for a given source tree, lockfile and pinned esbuild; scripts/check-build.mjs
// rebuilds it in a temp dir and compares hashes. Local dev, the test servers and the deploy pipeline all run this
// file with no_bundle, so what was tested is what ships.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ESBUILD_VERSION = '0.28.2';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWorker({ entry = join(root, 'packages/self-host/src/index.js'), outfile = join(root, 'dist/worker/index.js') } = {}) {
  const esbuild = await import('esbuild');
  if (esbuild.version !== ESBUILD_VERSION) throw new Error(`Use pinned esbuild ${ESBUILD_VERSION} (found ${esbuild.version})`);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers'],
    keepNames: true,
    loader: { '.txt': 'text' },
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  });
  const text = result.outputFiles[0].text;
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, text);
  return { outfile, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv.includes('--out') ? resolve(process.argv[process.argv.indexOf('--out') + 1]) : undefined;
  const r = await buildWorker(out ? { outfile: out } : {});
  console.log(`built ${r.outfile} (${r.bytes} bytes, sha256 ${r.sha256})`);
}
