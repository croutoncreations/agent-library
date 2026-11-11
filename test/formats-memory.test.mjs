// Exercise the shipped parser in fresh 64 MiB heaps, without bundler/test-runner overhead in the children.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));

for (const shape of ["chains", "combinations", "keys", "extra"]) {
  for (const operation of shape === "extra" ? ["checkFile", "readRecordsPage"] : ["checkFile"]) {
    test(`formats bounded heap: ${operation} ${shape} JSON`, () => {
      const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { checkFile, MEASUREMENTS } from "./packages/core/src/formats.js";
        import { readRecordsPage } from "./packages/core/src/service.js";
        import { jsonFixture } from "./test/formats-json-memory-fixtures.mjs";
        const { text, count, measurements } = jsonFixture(${JSON.stringify(shape)});
        assert.ok(text.length > 9 * 1048576);
        ${operation === "checkFile" ? `assert.equal(checkFile("json", text, measurements ? MEASUREMENTS : null).record_count, measurements ? count : null);` : `const page = readRecordsPage(text, { offset: 50, limit: 10 }); assert.equal(page.records.length, 10); assert.equal(page.records[0].id, (50).toString(36)); assert.equal(page.next_cursor, "60");`}
      `], { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
      assert.equal(child.status, 0, `${child.signal ?? ""} ${child.error ?? ""}\n${child.stderr}`);
    });
  }
}

for (const shape of ["tiny", "normal", "measurements", "commas", "wide-header", "quotes", "formula", "columns"]) for (const operation of ["checkFile", "spreadsheetSafeCsv"]) {
  test(`formats bounded heap: ${operation} ${shape} CSV`, () => {
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { checkFile, spreadsheetSafeCsv, MEASUREMENTS } from "./packages/core/src/formats.js";
      import { csvFixture } from "./test/formats-memory-fixtures.mjs";
      const { text, rows, outputLength, detail, line } = csvFixture(${JSON.stringify(shape)});
      const run = () => ${operation === "checkFile" ? `checkFile("csv", text, ${shape === "measurements" ? "MEASUREMENTS" : "null"})` : "spreadsheetSafeCsv(text)"};
      if (detail) assert.throws(run, e => e.status === 422 && e.code === "invalid_content" && e.extra.format === "csv" && e.extra.line === line && e.extra.detail === detail);
      else ${operation === "checkFile" ? "assert.equal(run().row_count, rows);" : "assert.equal(run().length, outputLength);"}
    `], { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, `${child.signal ?? ""} ${child.error ?? ""}\n${child.stderr}`);
  });
}
