/**
 * Robust, schema-driven protobuf assembler for collection blobs.
 *
 * Why not `ProtoMsg.decode` (strict protobuf-ts)? QQ pads some bodies (notably
 * `locationSummary`) with a run of trailing `0x00` bytes. Strict protobuf reads
 * that as a field-number-0 tag and throws — yet QQ's own native parser (and
 * napcat) tolerate it. Blindly trimming the buffer is ambiguous because length
 * prefixes count the padding and a legitimately-empty trailing LEN field also
 * ends in `0x00`.
 *
 * The codebase already ships a lenient walker (`@weq/codec/raw`) that simply
 * stops when the wire stops making sense. We decode with it, then map the
 * resulting field tree onto a `ProtoField` schema by tag — giving named, typed
 * output that is immune to trailing padding and unknown extra fields.
 */

import { decode as rawDecode, type RawField, type Guess } from '@weq/codec/raw';
import { ScalarType, type ProtoFieldType, type ProtoMessageType } from '@weq/codec';

/** Decode `bytes` against `schema`, tolerating trailing padding / extras. */
export function decodeMessage(bytes: Uint8Array, schema: ProtoMessageType): Record<string, unknown> {
  return assemble(rawDecode(bytes), schema);
}

function assemble(fields: RawField[], schema: ProtoMessageType): Record<string, unknown> {
  const byTag = new Map<number, RawField[]>();
  for (const f of fields) {
    const arr = byTag.get(f.tag);
    if (arr) arr.push(f);
    else byTag.set(f.tag, [f]);
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    const def = schema[key]!;
    const matches = byTag.get(def.no);
    if (!matches || matches.length === 0) continue;

    if (def.repeat) {
      const vals = matches.map((m) => fieldValue(m, def)).filter((v) => v !== undefined);
      if (vals.length > 0) out[key] = vals;
    } else {
      // Last one wins, matching protobuf's "latest field on the wire" rule.
      const v = fieldValue(matches[matches.length - 1]!, def);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

function fieldValue(f: RawField, def: ProtoFieldType): unknown {
  if (def.kind === 'message') {
    const nested = guess(f, 'len-nested');
    if (nested) return assemble(nested.value as RawField[], (def.type as () => ProtoMessageType)());
    const bytes = guess(f, 'len-bytes');
    if (bytes) return assemble(rawDecode(bytes.value as Uint8Array), (def.type as () => ProtoMessageType)());
    return undefined;
  }
  return scalarValue(f, def.type as ScalarType);
}

function scalarValue(f: RawField, t: ScalarType): unknown {
  switch (t) {
    case ScalarType.STRING:
      return stringOf(f);
    case ScalarType.BYTES:
      return bytesOf(f);
    case ScalarType.BOOL:
      return intOf(f) !== 0n;
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE:
      return floatOf(f);
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return intOf(f);
    default:
      // 32-bit integer family — return a plain number.
      return Number(intOf(f));
  }
}

function guess(f: RawField, kind: Guess['kind']): Guess | undefined {
  return f.guesses.find((g) => g.kind === kind);
}

function stringOf(f: RawField): string {
  const utf8 = guess(f, 'len-utf8');
  if (utf8) return utf8.value as string;
  const bytes = guess(f, 'len-bytes');
  if (bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes.value as Uint8Array);
    } catch {
      return '';
    }
  }
  return '';
}

function bytesOf(f: RawField): Uint8Array {
  const bytes = guess(f, 'len-bytes');
  return bytes ? (bytes.value as Uint8Array) : new Uint8Array(0);
}

function intOf(f: RawField): bigint {
  const v = guess(f, 'varint-uint64');
  if (v) return v.value as bigint;
  const i64 = guess(f, 'i64-fixed');
  if (i64) return i64.value as bigint;
  const i32 = guess(f, 'i32-fixed');
  if (i32) return BigInt(i32.value as number);
  return 0n;
}

function floatOf(f: RawField): number {
  const f32 = guess(f, 'i32-float');
  if (f32) return f32.value as number;
  const f64 = guess(f, 'i64-double');
  if (f64) return f64.value as number;
  const fx = guess(f, 'i32-fixed');
  if (fx) return fx.value as number;
  return Number(intOf(f));
}
