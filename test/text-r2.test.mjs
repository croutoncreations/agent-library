import { test } from "node:test";
import assert from "node:assert/strict";
import { putText, getText, getTextRange } from "../packages/core/src/content-store.js";

test("text storage and legacy fallback preserve UTF-8 byte ranges", async () => {
  const objects = new Map();
  const env = { BLOBS: {
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key, options) {
      let bytes = objects.get(key);
      if (!bytes) return null;
      if (options?.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
      return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    }
  } };
  const text = "aé🙂z", key = "text/p/a/r";
  const stored = await putText(env, { projectId: "p" }, key, text);
  assert.equal(stored.size, 8);
  assert.match(stored.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await getText(env, { body_key: key, body: null }), text);
  assert.equal(await getText(env, { body: text }), text);
  for (let offset = 0; offset < 8; offset++) {
    assert.deepEqual(await getTextRange(env, { body_key: key }, offset, 2), await getTextRange(env, { body: text }, offset, 2));
  }
});
