/**
 * A tiny runtime, schema-driven protobuf codec.
 *
 * SnowLuma compiles `pb<tag, T>`-annotated interfaces into encoders at build
 * time (its `proton` Vite plugin). We don't want a build step here, so instead
 * a message is described by a plain {@link ProtoMessage} schema (field name →
 * tag + type) and encoded/decoded at runtime. The wire format and the proto3
 * default-omission rules match SnowLuma's generated code exactly:
 *
 *   - varint  (int32/uint32/int64/uint64/sint32/sint64/bool) → wire type 0
 *   - len-delimited (string/bytes/nested message)            → wire type 2
 *   - scalar defaults are OMITTED (0 / 0n / "" / empty bytes / false), message
 *     fields emit when non-null, repeated emits every element.
 *
 * 32-bit ints decode to `number`; 64-bit ints decode to `bigint` so large ids
 * (batchId / uploadTime) keep full precision. On encode, numeric fields accept
 * `number | bigint | string`.
 */

// ─────────────────────────── schema ───────────────────────────

export type ScalarType =
  | 'int32'
  | 'uint32'
  | 'sint32'
  | 'int64'
  | 'uint64'
  | 'sint64'
  | 'bool'
  | 'string'
  | 'bytes'
  /** IEEE-754 双精度，wire type 1（小端 8 字节）。位置共享的经纬度用它。 */
  | 'double'
  /** IEEE-754 单精度，wire type 5（小端 4 字节）。 */
  | 'float';

/** A nested-message field type. Use {@link message} to build one. */
export interface ProtoMessage {
  readonly fields: readonly ProtoField[];
}

export interface ProtoField {
  /** Object key this field maps to. */
  readonly name: string;
  /** Protobuf field number. */
  readonly tag: number;
  /** Scalar kind, or a nested message schema. */
  readonly type: ScalarType | ProtoMessage;
  /** True for `repeated` fields (encoded as one entry per element). */
  readonly repeated?: boolean;
  /** Emit scalar defaults when field presence matters for captured QQ packets. */
  readonly force?: boolean;
}

/** Build a nested-message schema. */
export function message(fields: readonly ProtoField[]): ProtoMessage {
  return { fields };
}

function isMessage(type: ScalarType | ProtoMessage): type is ProtoMessage {
  return typeof type !== 'string';
}

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

/** Wire type a scalar/message encodes to. */
function wireOf(type: ScalarType | ProtoMessage): number {
  if (isMessage(type)) return WIRE_LEN;
  if (type === 'double') return WIRE_64BIT;
  if (type === 'float') return WIRE_32BIT;
  return type === 'string' || type === 'bytes' ? WIRE_LEN : WIRE_VARINT;
}

// ─────────────────────────── writer ───────────────────────────

class Writer {
  private readonly buf: number[] = [];

  varint(value: bigint): void {
    let v = value;
    while (v > 0x7fn) {
      this.buf.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.buf.push(Number(v));
  }

  tag(field: number, wire: number): void {
    this.varint((BigInt(field) << 3n) | BigInt(wire));
  }

  lenDelim(bytes: Uint8Array): void {
    this.varint(BigInt(bytes.length));
    for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i]!);
  }

  /** 固定 8 字节，小端（wire type 1，protobuf 的 double/fixed64）。 */
  fixed64(value: bigint): void {
    for (let i = 0n; i < 8n; i++) this.buf.push(Number((value >> (i * 8n)) & 0xffn));
  }

  /** 固定 4 字节，小端（wire type 5，protobuf 的 float/fixed32）。 */
  fixed32(value: number): void {
    for (let i = 0; i < 4; i++) this.buf.push((value >>> (i * 8)) & 0xff);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

function toBigInt(v: number | bigint | string): bigint {
  return typeof v === 'bigint' ? v : BigInt(v);
}

/** IEEE-754 double → 64 位无符号整数（按位，不做数值转换）。 */
function doubleBits(d: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d, true);
  return view.getBigUint64(0, true);
}

/** 64 位无符号整数 → IEEE-754 double。 */
function bitsToDouble(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return view.getFloat64(0, true);
}

/** IEEE-754 float → 32 位无符号整数。 */
function floatBits(f: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, f, true);
  return view.getUint32(0, true);
}

/** 32 位无符号整数 → IEEE-754 float。 */
function bitsToFloat(bits: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
}

/** zigzag-encode a signed bigint into its unsigned varint form. */
function zigzag(n: bigint): bigint {
  return BigInt.asUintN(64, (n << 1n) ^ (n >> 63n));
}

function writeScalar(
  w: Writer,
  type: ScalarType,
  tag: number,
  value: unknown,
  force: boolean,
): void {
  switch (type) {
    case 'bool': {
      const b = value === true;
      if (force || b) {
        w.tag(tag, WIRE_VARINT);
        w.varint(b ? 1n : 0n);
      }
      return;
    }
    case 'string': {
      const s = String(value);
      if (force || s !== '') {
        w.tag(tag, WIRE_LEN);
        w.lenDelim(UTF8_ENCODER.encode(s));
      }
      return;
    }
    case 'bytes': {
      const b = value as Uint8Array;
      if (force || b.length > 0) {
        w.tag(tag, WIRE_LEN);
        w.lenDelim(b);
      }
      return;
    }
    case 'sint32':
    case 'sint64': {
      const n = toBigInt(value as number | bigint | string);
      if (force || n !== 0n) {
        w.tag(tag, WIRE_VARINT);
        w.varint(zigzag(n));
      }
      return;
    }
    case 'double': {
      const d = Number(value);
      // proto3 默认省略 0；用 +0 比较让 -0 也算 0（IEEE 的 -0 在 wire 上有区别，
      // 但业务上没人靠它区分，省一字节）。
      if (force || d !== 0) {
        w.tag(tag, WIRE_64BIT);
        w.fixed64(doubleBits(d));
      }
      return;
    }
    case 'float': {
      const f = Math.fround(Number(value));
      if (force || f !== 0) {
        w.tag(tag, WIRE_32BIT);
        w.fixed32(floatBits(f));
      }
      return;
    }
    default: {
      // int32 / uint32 / int64 / uint64 — two's-complement to 64 bits so that
      // negatives are sign-extended exactly like protobuf expects.
      const n = toBigInt(value as number | bigint | string);
      if (force || n !== 0n) {
        w.tag(tag, WIRE_VARINT);
        w.varint(BigInt.asUintN(64, n));
      }
    }
  }
}

function writeField(w: Writer, field: ProtoField, value: unknown, force: boolean): void {
  if (isMessage(field.type)) {
    if (value == null) return;
    w.tag(field.tag, WIRE_LEN);
    w.lenDelim(encode(field.type, value as Record<string, unknown>));
    return;
  }
  writeScalar(w, field.type, field.tag, value, force);
}

/** Encode `obj` against `schema` into protobuf bytes. */
export function encode(schema: ProtoMessage, obj: Record<string, unknown>): Uint8Array {
  const w = new Writer();
  for (const field of schema.fields) {
    const value = obj[field.name];
    if (value == null) continue;
    if (field.repeated) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item == null) continue;
        writeField(w, field, item, true); // repeated: emit every element
      }
    } else {
      writeField(w, field, value, field.force === true); // singular: proto3 default-omission unless forced
    }
  }
  return w.finish();
}

// ─────────────────────────── reader ───────────────────────────

class Reader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.data.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte: number;
    do {
      byte = this.data[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return result;
  }

  tag(): { field: number; wire: number } {
    const t = this.varint();
    return { field: Number(t >> 3n), wire: Number(t & 7n) };
  }

  lenDelim(): Uint8Array {
    const len = Number(this.varint());
    const out = this.data.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** 读固定 8 字节小端（wire type 1）。 */
  fixed64(): bigint {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getBigUint64(0, true);
  }

  /** 读固定 4 字节小端（wire type 5）。 */
  fixed32(): number {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getUint32(0, true);
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2: {
        // Read the length varint FIRST (it advances pos), THEN jump. Writing
        // `this.pos += Number(this.varint())` would capture the old pos on the
        // left, lose the varint's own advance, and drift by the length bytes.
        const len = Number(this.varint());
        this.pos += len;
        return;
      }
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`protobuf: unknown wire type ${wire}`);
    }
  }
}

function readScalar(r: Reader, type: ScalarType): unknown {
  switch (type) {
    case 'bool':
      return r.varint() !== 0n;
    case 'string':
      return UTF8_DECODER.decode(r.lenDelim());
    case 'bytes':
      return r.lenDelim().slice();
    case 'int32':
      return Number(BigInt.asIntN(32, r.varint()));
    case 'uint32':
      return Number(BigInt.asUintN(32, r.varint()));
    case 'sint32':
      return Number(BigInt.asIntN(32, unzigzag(r.varint())));
    case 'int64':
      return BigInt.asIntN(64, r.varint());
    case 'uint64':
      return r.varint();
    case 'sint64':
      return BigInt.asIntN(64, unzigzag(r.varint()));
    case 'double':
      return bitsToDouble(r.fixed64());
    case 'float':
      return bitsToFloat(r.fixed32());
  }
}

/** zigzag-decode an unsigned bigint back to its signed value. */
function unzigzag(n: bigint): bigint {
  return (n >> 1n) ^ -(n & 1n);
}

/** Decode protobuf `data` against `schema` into a plain object. */
export function decode(schema: ProtoMessage, data: Uint8Array): Record<string, unknown> {
  const byTag = new Map<number, ProtoField>();
  for (const f of schema.fields) byTag.set(f.tag, f);

  const r = new Reader(data);
  const out: Record<string, unknown> = {};

  while (!r.eof) {
    const { field, wire } = r.tag();
    const def = byTag.get(field);
    if (!def || wire !== wireOf(def.type)) {
      r.skip(wire);
      continue;
    }

    const value = isMessage(def.type) ? decode(def.type, r.lenDelim()) : readScalar(r, def.type);

    if (def.repeated) {
      const arr = (out[def.name] as unknown[] | undefined) ?? [];
      arr.push(value);
      out[def.name] = arr;
    } else {
      out[def.name] = value;
    }
  }

  return out;
}
