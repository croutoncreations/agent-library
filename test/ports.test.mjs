// Test isolation guard: every listener has its own port (see test/ports.mjs) and no file hard-codes one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";
import { allBoundPorts } from "./ports.mjs";

test("every bound port is unique and outside the OS ephemeral ranges", () => {
  const ports = allBoundPorts();
  const dupes = ports.filter((p, i) => ports.indexOf(p) !== i);
  assert.deepEqual(dupes, [], "ports shared between listeners");
  for (const p of ports) assert.ok(p >= 1024 && p < 32768, `port ${p} must be in 1024-32767`);
});

test("tests take listening ports only from test/ports.mjs", () => {
  const files = [
    ...readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".mjs") && f !== "ports.mjs").map((f) => join("test", f)),
    ...readdirSync(join(ROOT, "test", "fixtures")).filter((f) => f.endsWith(".mjs")).map((f) => join("test", "fixtures", f)),
    ...readdirSync(ROOT).filter((f) => f.endsWith(".mjs")),
  ];
  // A numeric literal passed as a server port or to listen() is a hard-coded port.
  const hard = /startServer\([^,]+,\s*\d|startAppConnectServer\(\{\s*port:\s*\d|\.listen\(\s*\d|\b(?:PORT|_PORT|HOP)\s*=\s*\d/;
  const offenders = files.filter((f) => readFileSync(join(ROOT, f), "utf8").split("\n").some((l) => hard.test(l)));
  assert.deepEqual(offenders, []);
});
