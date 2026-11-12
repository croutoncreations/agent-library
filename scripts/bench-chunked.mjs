#!/usr/bin/env node
// Local benchmark for the chunked object codec (packages/core/src/crypto/chunked.js): encrypts and then decrypts
// 90 MiB through the real module and prints wall and process CPU time for each. Not part of npm test. These are Node
// estimates on this machine; Worker CPU time is measured differently and must be checked in a Worker.
// Usage: node scripts/bench-chunked.mjs [MiB]
import { moduleScript } from "../test/module-source.mjs";

const { encryptChunkedStream, decryptChunkedStream, chunkedStoredLength } = new Function(
  `${moduleScript("packages/core/src/crypto/chunked.js")}\nreturn { encryptChunkedStream, decryptChunkedStream, chunkedStoredLength };`,
)();

const mib = Number(process.argv[2] || 90);
const total = mib * 1024 * 1024;
const piece = new Uint8Array(256 * 1024).map((_, i) => (i * 31) & 0xff);
const dataKey = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, ["deriveKey"]);
const objectKey = "blobs/prj_bench/art_bench/ver_1";

function source() {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= total) { c.close(); return; }
      const n = Math.min(piece.length, total - sent);
      sent += n;
      c.enqueue(piece.slice(0, n));
    },
  }, { highWaterMark: 0 });
}

async function measure(label, run) {
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const result = await run();
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  console.log(`${label}: wall ${wall.toFixed(0)} ms, cpu ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms (user ${(cpu.user / 1000).toFixed(0)}, system ${(cpu.system / 1000).toFixed(0)})`);
  return result;
}

const stored = await measure(`encrypt ${mib} MiB`, async () => {
  const parts = [];
  let n = 0;
  for await (const part of encryptChunkedStream(source(), { plaintextLength: total, dataKey, objectKey })) { parts.push(part); n += part.length; }
  if (n !== chunkedStoredLength(total)) throw new Error(`stored ${n} bytes, expected ${chunkedStoredLength(total)}`);
  return parts;
});

await measure(`decrypt ${mib} MiB`, async () => {
  let i = 0;
  const replay = new ReadableStream({ pull(c) { if (i < stored.length) c.enqueue(stored[i++]); else c.close(); } }, { highWaterMark: 0 });
  let n = 0;
  for await (const part of decryptChunkedStream(replay, { dataKey, objectKey })) n += part.length;
  if (n !== total) throw new Error(`decrypted ${n} bytes, expected ${total}`);
});
console.log(`node ${process.version}, ${process.platform}/${process.arch}; local Node estimate, not a Worker measurement`);
