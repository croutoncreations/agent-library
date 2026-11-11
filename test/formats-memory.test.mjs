// Exercise the shipped parser in fresh 64 MiB heaps, without bundler/test-runner overhead in the children.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const shape of ["tiny", "normal", "measurements"]) for (const operation of ["checkFile", "spreadsheetSafeCsv"]) {
  test(`formats bounded heap: ${operation} ${shape} CSV`, () => {
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { checkFile, spreadsheetSafeCsv, MEASUREMENTS } from "./packages/core/src/formats.js";
      import { csvFixture } from "./test/formats-memory-fixtures.mjs";
      const { text, rows, outputLength } = csvFixture(${JSON.stringify(shape)});
      ${operation === "checkFile" ? `assert.equal(checkFile("csv", text, ${shape === "measurements" ? "MEASUREMENTS" : "null"}).row_count, rows);` : `const output = spreadsheetSafeCsv(text); assert.equal(typeof output === "string" ? Buffer.byteLength(output) : output.length, outputLength);`}
    `], { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.signal ?? ""} ${child.error ?? ""}\n${child.stderr}`);
  });
}
