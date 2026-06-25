/**
 * Small helpers shared across OIDB/trpc specs — value coercion, retcode
 * checking, and byte→hex (the group-file download URL hex-encodes a key blob).
 */

/** Coerce number | bigint | numeric-string → number (truncated), else 0. */
export function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

/**
 * Standard OIDB response check: throw if retCode != 0, preferring `wording`
 * over `msg` for the human-facing message. Mirrors SnowLuma's `ensureRetCodeZero`.
 */
export function ensureRetCodeZero(operation: string, code: unknown, msg: unknown, wording?: unknown): void {
  const retCode = toInt(code);
  if (retCode === 0) return;
  const text =
    (typeof wording === 'string' && wording) || (typeof msg === 'string' && msg) || 'unknown error';
  throw new Error(`${operation} failed: code=${retCode} msg=${text}`);
}

/** Lowercase hex of a byte buffer. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

/** Uppercase hex — the group-file `ftn_handler` URL expects this form. */
export function bytesToHexUpper(bytes: Uint8Array): string {
  return bytesToHex(bytes).toUpperCase();
}
