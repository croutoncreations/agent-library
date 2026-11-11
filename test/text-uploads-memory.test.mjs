// Node memory is an estimate, not a measurement of the Worker's 128 MB isolate. Boundary/timer samples can miss
// synchronous allocation spikes; maxRSS is process-lifetime peak (including setup). Output objects are discarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));
for (const [shape, copies] of [["ascii", 1], ["two-byte", 1], ["csv", 1], ["json", 1], ["invalid", 1], ["two-byte", 2]]) {
  test(`text upload finish 64 MiB heap: ${shape}, ${copies} simultaneous`, () => {
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
      import { runTextUploadMemory } from "./test/text-uploads-memory-fixture.mjs";
      console.log("TEXT_UPLOAD_MEMORY " + JSON.stringify(await runTextUploadMemory(${JSON.stringify(shape)}, ${copies})));
    `], { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.signal ?? ""} ${child.error ?? ""}\n${child.stderr}`);
    const report = JSON.parse(child.stdout.split("TEXT_UPLOAD_MEMORY ")[1]);
    assert.equal(report.reads, copies); assert.equal(report.writes, shape === "invalid" ? 0 : copies);
    console.log("TEXT_UPLOAD_MEMORY " + JSON.stringify(report));
  });
}
