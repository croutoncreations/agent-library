// Test isolation guard: every listener has its own port (see test/ports.mjs) and no file hard-codes one.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
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

test("parallel worktrees can use an isolated range; invalid offsets fail before binding", () => {
  const probe = (offset, extra = {}) => {
    const env = { ...process.env, ...extra };
    if (offset === undefined) delete env.AGENT_LIBRARY_TEST_PORT_OFFSET;
    else env.AGENT_LIBRARY_TEST_PORT_OFFSET = offset;
    return spawnSync(process.execPath, ["--input-type=module", "-e", "import { allBoundPorts } from './test/ports.mjs'; console.log(JSON.stringify(allBoundPorts()))"],
      { cwd: ROOT, env, encoding: "utf8" });
  };
  const baseline = probe("0"), isolated = probe("6000");
  assert.equal(baseline.status, 0); assert.equal(isolated.status, 0);
  const a = JSON.parse(baseline.stdout), b = JSON.parse(isolated.stdout);
  assert.deepEqual(b, a.map((p) => p + 6000));
  assert.ok(b.every((p) => p < 32768));
  const ranges = [a, JSON.parse(probe("3000").stdout), b];
  const alias = probe(undefined, { AGENT_LIBRARY_TEST_PORT_SHIFT: "3000" });
  assert.equal(alias.status, 0); assert.deepEqual(JSON.parse(alias.stdout), ranges[1]);
  assert.deepEqual(JSON.parse(probe("6000", { AGENT_LIBRARY_TEST_PORT_SHIFT: "3000" }).stdout), b, "OFFSET takes precedence");
  assert.deepEqual(JSON.parse(probe("0", { AGENT_LIBRARY_TEST_PORT_SHIFT: "3000" }).stdout), a, "explicit zero takes precedence");
  assert.notEqual(probe(undefined, { AGENT_LIBRARY_TEST_PORT_SHIFT: "1000" }).status, 0);
  const combined = ranges.flat();
  assert.equal(new Set(combined).size, combined.length, "all supported concurrent ranges are disjoint");
  for (const bad of ["-1", "1000", "2000", "4000", "6001", "7000", "7001", "0.5", "invalid"]) assert.notEqual(probe(bad).status, 0);
});
