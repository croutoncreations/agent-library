// Synthetic shapes shared by the constrained-heap regression children.
export const MAX = 10 * 1048576;
export const measurementHeader = "id,recorded_at,date,metric,value,unit,source_id\n";
export function csvFixture(shape) {
  if (shape === "tiny") return { text: "h\n" + "a\n".repeat((MAX - 2) / 2), rows: (MAX - 2) / 2, outputLength: MAX * 1.5 };
  if (shape === "normal") {
    const header = "a,b,c,d,e,f,g,h,i,j\n", rows = 100000;
    const width = Math.floor((MAX - header.length) / rows), extra = (MAX - header.length) % rows;
    const row = "a,".repeat(9) + "x".repeat(width - 19);
    return { text: header + (row + "x\n").repeat(extra) + (row + "\n").repeat(rows - extra), rows, outputLength: MAX + rows + 1 };
  }
  if (shape === "measurements") {
    const rows = 100000, suffix = ",x,,m,1,u,\n";
    const idLength = Math.floor((MAX - measurementHeader.length) / rows) - suffix.length;
    // Allocate bytes, not a retained array/rope of 100,000 generated rows.
    const bytes = new Uint8Array(measurementHeader.length + rows * (idLength + suffix.length));
    const encoder = new TextEncoder();
    bytes.set(encoder.encode(measurementHeader));
    let offset = measurementHeader.length;
    for (let i = 0; i < rows; i++) offset += encoder.encodeInto(String(i).padStart(idLength, "x") + suffix, bytes.subarray(offset)).written;
    return { text: new TextDecoder().decode(bytes), rows, outputLength: bytes.length + rows + 1 };
  }
  throw new Error(`Unknown CSV fixture: ${shape}`);
}
