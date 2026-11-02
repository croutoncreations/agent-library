#!/usr/bin/env node
// Build the Worker (dist/worker/index.js = deploy/production.json "main") from packages/core/src/, then copy it
// into the isolated directory wrangler.toml [env.hosted] uploads from, and verify the bytes.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadTarget, loadWrangler, hostedConfig, sha256 } from './lib.mjs';
import { buildWorker } from '../build.mjs';

const t = loadTarget();
const upload = hostedConfig(loadWrangler(), t.wranglerEnv).main;
if (upload === t.main || !upload.startsWith('dist/')) throw new Error(`[env.${t.wranglerEnv}] main must be an isolated dist/ path, got ${upload}`);
await buildWorker({ outfile: t.main });
const src = readFileSync(t.main);
rmSync(dirname(upload), { recursive: true, force: true });
mkdirSync(dirname(upload), { recursive: true });
writeFileSync(upload, src);
const a = sha256(src), b = sha256(readFileSync(upload));
if (a !== b) throw new Error('staged bundle differs from source');
console.log(`staged ${t.main} -> ${upload} (sha256 ${a})`);
