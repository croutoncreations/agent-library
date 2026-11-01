// Load the real Worker source (src/) in Node for unit-style tests: esbuild bundles src/index.js (same options as
// scripts/build.mjs) plus a re-export of the internals a test needs, with cloudflare:workers replaced by an inert
// class. No network, accounts or secrets. Each call writes a fresh temp module.
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [];
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** exportsByModule: { "oauth/server.js": ["servers", "handleOAuthHost"], ... } (paths relative to src/). */
export async function loadWorker(exportsByModule = {}) {
  const lines = ['export { default } from "./src/index.js";'];
  for (const [mod, names] of Object.entries(exportsByModule)) lines.push(`export { ${names.join(", ")} } from "./src/${mod}";`);
  const result = await build({
    stdin: { contents: lines.join("\n"), resolveDir: ROOT, sourcefile: "load-worker-entry.js" },
    bundle: true, write: false, format: "esm", target: "es2022", platform: "neutral",
    mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"], keepNames: true, logLevel: "error",
    plugins: [{ name: "inert-cloudflare-workers", setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cw", namespace: "cw" }));
      b.onLoad({ filter: /.*/, namespace: "cw" }, () => ({ contents: "export class WorkerEntrypoint {}", loader: "js" }));
    } }],
  });
  const dir = mkdtempSync(join(tmpdir(), "al-worker-"));
  dirs.push(dir);
  const file = join(dir, "worker.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
