// Node memory is an estimate, not a measurement of the Worker's 128 MB isolate. Boundary/timer samples can miss
// synchronous allocation spikes; maxRSS is process-lifetime peak (including setup). Output objects are discarded.
// Samples collect first: these are retained-copy ceilings, not total allocation or runtime peak-memory guarantees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const MiB = 1048576;
// Three fresh-child runs: heap <= 6.23 MiB; buffers <= 10.14 MiB (one input), 20.14 MiB (two inputs).
// About 6 MiB margin, less than one more full document (the smallest here is 9.59 MiB).
for (const [shape, copies, heapMiB, buffersMiB] of [["ascii", 1, 12, 16], ["two-byte", 1, 12, 16], ["csv", 1, 12, 16], ["json", 1, 12, 16], ["invalid", 1, 12, 16], ["two-byte", 2, 12, 26]]) {
  test(`text upload finish 64 MiB heap: ${shape}, ${copies} simultaneous`, () => {
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--expose-gc", "--input-type=module", "-e", `
      import { runTextUploadMemory } from "./test/text-uploads-memory-fixture.mjs";
      console.log("TEXT_UPLOAD_MEMORY " + JSON.stringify(await runTextUploadMemory(${JSON.stringify(shape)}, ${copies})));
    `], { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.signal ?? ""} ${child.error ?? ""}\n${child.stderr}`);
    const report = JSON.parse(child.stdout.split("TEXT_UPLOAD_MEMORY ")[1]);
    assert.equal(report.reads, 1); assert.equal(report.writes, shape === "invalid" ? 0 : 1);
    if (copies === 2) assert.deepEqual(report.outcomes.slice().sort(), [200, "text_finish_busy"]);
    console.log("TEXT_UPLOAD_MEMORY " + JSON.stringify(report));
    assert.ok(report.heap <= heapMiB * MiB, `${shape}: sampled JS heap ${report.heap} exceeds ${heapMiB} MiB`);
    assert.ok(report.arrayBuffers <= buffersMiB * MiB, `${shape}: sampled arrayBuffers ${report.arrayBuffers} exceeds ${buffersMiB} MiB`);
  });
}
