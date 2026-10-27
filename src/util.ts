export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export const nowIso = () => new Date().toISOString();
export const nowMs = () => Date.now();

export function randomId(prefix: string, bytes = 12): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + "_" + b64url(b);
}

export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...headers },
  });
}

export function errorBody(e: HttpError) {
  return { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } };
}

export function str(v: unknown, name: string, max: number, opts: { min?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null) {
    if (opts.optional) return "";
    throw new HttpError(400, "invalid_input", `${name} is required`);
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_input", `${name} must be a string`);
  if (v.length < (opts.min ?? 0)) throw new HttpError(400, "invalid_input", `${name} too short`);
  if (v.length > max) throw new HttpError(413, "too_large", `${name} exceeds ${max} characters`);
  return v;
}

export function int(v: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new HttpError(400, "invalid_input", `${name} must be an integer in [${min}, ${max}]`);
  return v;
}

export function idemKey(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(v))
    throw new HttpError(400, "idempotency_key_required", "Idempotency key (8-128 chars [A-Za-z0-9._:-]) is required");
  return v;
}
