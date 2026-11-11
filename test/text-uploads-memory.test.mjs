// Node memory is an estimate, not a measurement of the Worker's 128 MB isolate. Boundary/timer samples can miss
// synchronous allocation spikes; maxRSS is process-lifetime peak (including setup). Output objects are discarded.
import { test, after } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));
// Diagnostic baseline: remove only the busy check, not decoding, validation, publication or the storage seam.
const original = readFileSync(new URL("../packages/core/src/uploads.js", import.meta.url), "utf8");
assert.ok(original.includes('if (textFinishBusy) throw new HttpError(503, "text_finish_busy"'));
const dir = mkdtempSync(join(tmpdir(), "al-tu-memory-source-")), noSlot = join(dir, "uploads-no-slot.mjs");
writeFileSync(noSlot, original.replace("if (textFinishBusy)", "if (false)").replaceAll('from "./', 'from "' + new URL("../packages/core/src/", import.meta.url).href));
after(() => rmSync(dir, { recursive: true, force: true }));
for (const [shape, copies, slot] of [["ascii", 1, true], ["two-byte", 1, true], ["csv", 1, true], ["json", 1, true], ["invalid", 1, true], ["two-byte", 2, false], ["two-byte", 2, true]]) {
  test(`text upload finish 64 MiB heap: ${shape}, ${copies} simultaneous, slot=${slot}`, () => {
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
      import { runTextUploadMemory } from "./test/text-uploads-memory-fixture.mjs";
      console.log("TEXT_UPLOAD_MEMORY " + JSON.stringify(await runTextUploadMemory(${JSON.stringify(shape)}, ${copies}, ${JSON.stringify(slot ? null : noSlot)})));
    `], { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.signal ?? ""} ${child.error ?? ""}\n${child.stderr}`);
    const report = JSON.parse(child.stdout.split("TEXT_UPLOAD_MEMORY ")[1]);
    const expectedReads = copies === 2 && slot ? 1 : copies;
    assert.equal(report.reads, expectedReads); assert.equal(report.writes, shape === "invalid" ? 0 : expectedReads);
    if (copies === 2) assert.deepEqual(report.outcomes.slice().sort(), slot ? [200, "text_finish_busy"] : [200, 200]);
    console.log("TEXT_UPLOAD_MEMORY " + JSON.stringify({ ...report, slot }));
  });
}
