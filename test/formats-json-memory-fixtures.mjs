// Synthetic JSON assembled in bounded chunks so fixture construction is not the heap test.
const MAX = 10 * 1048576;
export function jsonFixture(shape, baselineAccepted = false) {
  const bytes = new Uint8Array(MAX), encoder = new TextEncoder();
  let size = 2, count = 0, seed = 23;
  const object = shape === "keys" || shape === "keys-baseline";
  const measurements = shape === "extra" || shape === "ordinary";
  const prefix = measurements ? '{"schema":"agentlib.measurements/1","records":[' : object ? "{" : "[";
  const suffix = measurements ? "]}" : object ? "}" : "]";
  size = prefix.length + suffix.length;
  let offset = encoder.encodeInto(prefix, bytes).written;
  for (;;) {
    let value;
    if (object) value = JSON.stringify(count.toString(36)) + ":0";
    else if (shape === "chains") {
      value = "0";
      for (let d = 0; d < 63; d++) value = '{"k' + (count * 63 + d).toString(36) + '":' + value + '}';
    } else if (shape === "combinations") {
      const keys = [];
      while (keys.length < 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const key = (seed >>> 8) % 40;
        if (!keys.includes(key)) keys.push(key);
      }
      value = "{" + keys.map(k => '"k' + k + '":0').join(",") + "}";
    } else if (shape === "numbers") value = "1";
    else if (shape === "empty") value = "{}";
    else {
      value = '{"id":"' + count.toString(36) + '","recorded_at":"x","metric":"m","value":1,"unit":"u"';
      if (shape === "ordinary") value += ',"date":"2000-01-01","source_id":""';
      else {
        value += ',"date":"2000-01-01"';
        for (let k = 0; k < 5; k++) value += ',"k' + (count * 5 + k).toString(36) + '":0';
      }
      value += "}";
    }
    const cap = shape === "ordinary" ? 100000 : shape === "numbers" ? 1000000 : shape === "empty" ? 3000000 : shape === "keys-baseline" ? 999999 : baselineAccepted && shape === "chains" ? 15624 : baselineAccepted && shape === "combinations" ? 199999 : Infinity;
    if (count >= cap || size + value.length + (count ? 1 : 0) > MAX) break;
    const part = (count ? "," : "") + value;
    offset += encoder.encodeInto(part, bytes.subarray(offset)).written;
    size += part.length; count++;
  }
  offset += encoder.encodeInto(suffix, bytes.subarray(offset)).written;
  return { text: new TextDecoder().decode(bytes.subarray(0, offset)), count, measurements };
}
