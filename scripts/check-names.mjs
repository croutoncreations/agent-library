#!/usr/bin/env node
// Fail on any undefined or misspelled identifier in src/ (TS2304/TS2552/TS2662/TS2663) using tsc with checkJs
// (tsconfig.names.json). esbuild would otherwise treat a leftover reference as a global and the Worker would only
// fail at runtime. Type-compatibility diagnostics are reported as a count but not enforced: the modules are
// JavaScript (decisions D7). Any configuration error (TS5xxx, TS2688, ...) fails the check rather than passing it.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const r = spawnSync('npx', ['--no-install', 'tsc', '-p', 'tsconfig.names.json'], { cwd: root, encoding: 'utf8' });
const lines = (r.stdout + r.stderr).split('\n').filter((l) => /error TS\d+:/.test(l));
const NAME = /error TS(2304|2552|2662|2663):/;
// Type-level diagnostics tolerated in untyped JS; everything else (config, resolution, syntax) is a failure.
const TYPE_ONLY = /error TS(2339|2345|2550|2741|2769|2322|2554|2353|2551|2531|2532|2367|2362|2363|2365|2349|2571|18046|18047|18048):/;
const bad = lines.filter((l) => NAME.test(l) || !TYPE_ONLY.test(l));
if (r.error || bad.length) { console.error((bad.length ? bad : [String(r.error)]).map((l) => `::error::${l}`).join('\n')); process.exit(1); }
console.log(`names OK: no undefined identifiers in src/ (${lines.length} type-level diagnostics in untyped JS not enforced)`);
