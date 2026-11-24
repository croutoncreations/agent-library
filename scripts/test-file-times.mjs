// node --test reporter: one JSON line per test file, `{"file":"a.test.mjs","seconds":12.3}`, measured by the runner
// itself (hooks and server start-up included). CI writes these next to the normal output so that
// `node scripts/test-shard.mjs --update-weights <files...>` can refresh scripts/test-weights.json from real runs.
import { basename } from "node:path";

export default async function* fileTimes(source) {
  for await (const event of source) {
    if (event.type !== "test:summary" || !event.data.file) continue;
    yield JSON.stringify({ file: basename(event.data.file), seconds: Math.round(event.data.duration_ms / 100) / 10 }) + "\n";
  }
}
