// Read a maintained packages/core/src/ module as plain script text for vm-based unit tests: strips its `import` and `export`
// statements so the test supplies dependencies (fakes or real helpers) through the vm context or Function params.
// The code under test is exactly the shipped module body.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function moduleScript(rel) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  return text
    .replace(/^import \{[^}]*\} from "[^"]+";\n/gm, "")
    .replace(/^import \w+ from "[^"]+"(?: with \{[^}]*\})?;\n/gm, "")
    .replace(/^export \{[^}]*\};\n?/gm, "")
    .replace(/^export (const|let|var|function|async function|class) /gm, "$1 ");
}
