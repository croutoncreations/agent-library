// An earlier release of this project, checked out next to this one so its own Worker and migrations can run
// (test/upgrade-from-0.1.test.mjs). It reuses this checkout's node_modules (a symlink): no npm install.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers.mjs";

const git = (args, cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Is this revision in the local clone? (A shallow CI checkout has neither tags nor older commits.) */
export function revisionAvailable(rev) {
  try { git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]); return true; } catch { return false; }
}

/** Check out `rev` at tmp/old-<label> and build its Worker with its own build command. Returns { dir, sha, migrations }. */
export function checkoutRelease(label, rev) {
  const dir = join(ROOT, "tmp", `old-${label}`);
  removeRelease(dir);
  git(["worktree", "add", "--detach", dir, rev]);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  // Releases before the modular layout commit their Worker (src/index.js) and rebuild it with build:design; the build must reproduce it.
  const buildScript = pkg.scripts?.["build:design"] ? "build:design" : "build";
  execFileSync("npm", ["run", buildScript], { cwd: dir, stdio: "ignore", env: { ...process.env, PATH: `${join(ROOT, "node_modules", ".bin")}:${process.env.PATH}` } });
  const changed = git(["status", "--porcelain", "--", "src", "migrations", "dist"], dir).trim();
  if (changed) throw new Error(`${rev} does not rebuild to its committed Worker:\n${changed}`);
  const migrations = readdirSync(join(dir, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  return { dir, sha: git(["rev-parse", "HEAD"], dir).trim(), migrations };
}

/** Remove a checkout made by checkoutRelease (also a leftover of an interrupted run). */
export function removeRelease(dir) {
  if (existsSync(dir)) { try { git(["worktree", "remove", "--force", dir]); } catch { rmSync(dir, { recursive: true, force: true }); } }
  git(["worktree", "prune"]);
}
