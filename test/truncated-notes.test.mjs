// The UI's "Showing the first N" notes (truncatedNote in packages/core/src/web/app.js.txt) type each list's cap as a
// number; this checks every one equals the server constant that caps that list, so the two can't drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { loadWorker } from "./load-worker.mjs";

test("truncatedNote caps in app.js.txt equal the server's list caps", async () => {
  const w = await loadWorker({
    "project-deletion.js": ["DELETED_PROJECTS_MAX"], "tenancy.js": ["VISIBLE_PROJECTS_MAX"],
    "workspaces.js": ["MEMBERS_LIST_MAX", "INVITES_LIST_MAX"], "oauth/connections.js": ["ACCESS_LIST_MAX"], "api/credentials.js": ["API_KEYS_LIST_MAX"]
  });
  const src = readFileSync(join(ROOT, "packages/core/src/web/app.js.txt"), "utf8");
  const calls = [...src.matchAll(/truncatedNote\(\w+, "(\w+)", (\d+), "([^"]+)"/g)].map((m) => [m[3], Number(m[2])]);
  const expected = {
    "deleted projects": w.DELETED_PROJECTS_MAX, "projects you can open": w.VISIBLE_PROJECTS_MAX, members: w.MEMBERS_LIST_MAX,
    "pending invitations": w.INVITES_LIST_MAX, connections: w.ACCESS_LIST_MAX, "agent tokens": w.ACCESS_LIST_MAX, "API keys": w.API_KEYS_LIST_MAX
  };
  assert.deepEqual([...new Set(calls.map(([noun]) => noun))].sort(), Object.keys(expected).sort(), "every note is checked");
  for (const [noun, n] of calls) assert.equal(n, expected[noun], `"${noun}" note`);
});
