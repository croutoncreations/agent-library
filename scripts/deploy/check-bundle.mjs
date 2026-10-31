#!/usr/bin/env node
// Reproducibility gate for the deploy artifact. Rebuilds the byte-pinned bundle
// (build-current-bundle.mjs + build-design-bundle.mjs + build-service-fixes.mjs
// + build-ui-fixes.mjs + build-icon-fixes.mjs + build-history-fixes.mjs + build-consent-fixes.mjs + build-session-fixes.mjs + build-upload-fixes.mjs + ... + build-read-fixes.mjs) in a temporary copy of the
// repository and requires src/index.js and the preservation manifests to be
// byte-identical to the committed ones. Never modifies the working tree.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from './lib.mjs';

const root = resolve('.');
const esbuild = createRequire(join(root, 'package.json')).resolve('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'al-bundle-'));
const outputs = ['src/index.js', 'bundle-preservation.json', 'design-bundle-preservation.json', 'service-fixes-preservation.json', 'ui-fixes-preservation.json', 'icon-fixes-preservation.json', 'history-fixes-preservation.json', 'consent-fixes-preservation.json', 'session-fixes-preservation.json', 'upload-fixes-preservation.json', 'portability-fixes-preservation.json', 'auth-fixes-preservation.json', 'app-connect-fixes-preservation.json', 'read-fixes-preservation.json', 'file-tools-fixes-preservation.json', 'search-preservation.json', 'changes-preservation.json', 'template-fixes-preservation.json', 'diagnostics-preservation.json', 'file-types-preservation.json'];
let bad = [];
try {
  cpSync(root, dir, { recursive: true, filter: (s) => !/\/(node_modules|\.git|\.wrangler|tmp|\.artifacts)(\/|$)/.test(s.slice(root.length)) });
  const env = { ...process.env, HB_ESBUILD_MODULE: esbuild };
  execFileSync('node', ['build-current-bundle.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-design-bundle.mjs', '--consent-style'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-service-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-ui-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-icon-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-history-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-consent-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-session-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-upload-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-portability-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-auth-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-app-connect-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-read-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-file-tools-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-search.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-changes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-template-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-diagnostics-fixes.mjs'], { cwd: dir, env, stdio: 'inherit' });
  execFileSync('node', ['build-file-types.mjs'], { cwd: dir, env, stdio: 'inherit' });
  for (const f of outputs) {
    const a = sha256(readFileSync(join(root, f))), b = sha256(readFileSync(join(dir, f)));
    console.log(`${a === b ? 'same' : 'DIFF'} ${f} ${b}`);
    if (a !== b) bad.push(f);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
if (bad.length) { console.error(`::error::bundle is not reproducible from source: ${bad.join(', ')} (run npm run build:design and commit the result)`); process.exit(1); }
