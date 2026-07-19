/**
 * Slice the next field off a protobuf message at the wire-format level,
 * without any schema. Returns the tag, wire type, payload slice, and the
 * source-buffer offsets so callers can highlight bytes in a hex viewer.
 *
 * Wire types per https://protobuf.dev/programming-guides/encoding/:
 *   0 — VARINT (int32/64, uint32/64, sint32/64, bool, enum)
 *   1 — I64    (fixed64, sfixed64, double)
 *   2 — LEN    (string, bytes, embedded messages, packed repeated)
 *   5 — I32    (fixed32, sfixed32, float)
 * Wire types 3/4 (group start/end) are obsolete; we reject them.
 */

import { readVarint, } from './varint';

export type WireType = 0 | 1 | 2 | 5;

export interface WireField {
  /** Field number (tag). */
  tag: number;
  /** Protobuf wire type. */
  wireType: WireType;
  /**
   * Slice of the source buffer that *is the payload* (does not include the
   * tag varint or the LEN prefix). For VARINT this is just the varint bytes
   * themselves; for LEN it's the value, with the length prefix stripped.
   */
  payload: Uint8Array;
  /** Offset in the source buffer where this field's tag varint begins. */
  start: number;
  /** Total bytes consumed (tag varint + length prefix + payload). */
  size: number;
}

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

/** Read one field at `offset`. Returns null when offset == buf.length. */
export function readField(buf: Uint8Array, offset: number): WireField | null {
  if (offset >= buf.length) return null;

  let cursor = offset;
  let key: ReturnType<typeof readVarint>;
  try {
    key = readVarint(buf, cursor);
  } catch (e) {
    throw new WireError(`bad tag at offset ${offset}: ${(e as Error).message}`);
  }
  cursor += key.size;

  const wireType = Number(key.value & 0x7n) as WireType;
  const tag = Number(key.value >> 3n);

  if (tag === 0) {
    throw new WireError(`invalid field number 0 at offset ${offset}`);
  }

  switch (wireType) {
    case 0: {
      // VARINT — slice from cursor up to the end of the value
      let v: ReturnType<typeof readVarint>;
      try {
        v = readVarint(buf, cursor);
      } catch (e) {
        throw new WireError(`bad varint payload at tag ${tag}: ${(e as Error).message}`);
      }
      return {
        tag,
        wireType,
        payload: buf.subarray(cursor, cursor + v.size),
        start: offset,
        size: cursor - offset + v.size,
      };
    }
    case 1: {
      // I64 — 8 bytes
      if (cursor + 8 > buf.length) {
        throw new WireError(`I64 payload truncated at tag ${tag}`);
      }
      return {
        tag,
        wireType,
        payload: buf.subarray(cursor, cursor + 8),
        start: offset,
        size: cursor - offset + 8,
      };
    }
    case 2: {
      // LEN — varint length, then that many bytes
      let len: ReturnType<typeof readVarint>;
      try {
        len = readVarint(buf, cursor);
      } catch (e) {
        throw new WireError(`bad LEN prefix at tag ${tag}: ${(e as Error).message}`);
      }
      cursor += len.size;
      const lengthN = Number(len.value);
      if (cursor + lengthN > buf.length) {
        throw new WireError(`LEN payload truncated at tag ${tag} (need ${lengthN}, have ${buf.length - cursor})`);
      }
      return {
        tag,
        wireType,
        payload: buf.subarray(cursor, cursor + lengthN),
        start: offset,
        size: cursor - offset + lengthN,
      };
    }
    case 5: {
      // I32 — 4 bytes
      if (cursor + 4 > buf.length) {
        throw new WireError(`I32 payload truncated at tag ${tag}`);
      }
      return {
        tag,
        wireType,
        payload: buf.subarray(cursor, cursor + 4),
        start: offset,
        size: cursor - offset + 4,
      };
    }
    default:
      throw new WireError(`obsolete/invalid wire type ${wireType} at tag ${tag}`);
  }
}

/** Iterate every top-level field. Stops on first WireError (caller catches). */
export function* iterFields(buf: Uint8Array): Generator<WireField> {
  let offset = 0;
  while (offset < buf.length) {
    const f = readField(buf, offset);
    if (!f) return;
    yield f;
    offset = f.start + f.size;
  }
}

// Re-export so callers don't have to depend on varint.ts directly.
export { VarintError } from './varint';
