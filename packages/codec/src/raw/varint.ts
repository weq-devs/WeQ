/**
 * Protobuf varint codec — schema-free, returns BigInt to keep i64 precision.
 *
 * Wire format: 7 bits per byte, MSB = continuation. Max 10 bytes (64-bit + sign).
 * We deliberately return `bigint` for everything so we never silently truncate
 * a uin / msg_id / timestamp at JS's 2^53 boundary.
 */

export interface VarintResult {
  /** Decoded value as bigint. Callers can `Number(v)` if they know it fits. */
  value: bigint;
  /** Number of bytes consumed. */
  size: number;
}

export class VarintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VarintError';
  }
}

/** Read one varint starting at `offset`. Throws if it overflows 10 bytes. */
export function readVarint(buf: Uint8Array, offset: number): VarintResult {
  let value = 0n;
  let shift = 0n;
  let i = 0;
  while (i < 10) {
    if (offset + i >= buf.length) {
      throw new VarintError(`varint at offset ${offset} truncated`);
    }
    const byte = buf[offset + i]!;
    value |= BigInt(byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) {
      return { value, size: i };
    }
    shift += 7n;
  }
  throw new VarintError(`varint at offset ${offset} exceeds 10 bytes`);
}

/** Zig-zag decode an unsigned bigint produced by readVarint (sint32/sint64). */
export function zigzagDecode(v: bigint): bigint {
  return (v >> 1n) ^ -(v & 1n);
}

/** Zig-zag encode a signed bigint back into the unsigned form on the wire. */
export function zigzagEncode(v: bigint): bigint {
  return (v << 1n) ^ (v >> 63n);
}

/** Encode a non-negative bigint as varint bytes. Used by tests and future encode path. */
export function writeVarint(value: bigint): Uint8Array {
  if (value < 0n) {
    // Protobuf encodes negative int32/int64 as 10-byte two's complement.
    value = value & ((1n << 64n) - 1n);
  }
  const out: number[] = [];
  while (value > 0x7fn) {
    out.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  out.push(Number(value));
  return new Uint8Array(out);
}
