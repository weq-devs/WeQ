/**
 * Schema-aware annotation layer for the raw decoder.
 *
 * Loaded `proto/**\/*.ts` modules expose plain `ProtoMessageType` objects
 * (instances of the NapProto DSL). At runtime each one is just a record of
 * `{ fieldName: ProtoField(tag, type, optional?, repeat?) }` — that's enough
 * for us to build a `tag → FieldInfo` lookup table and walk a `RawField[]`
 * tree alongside it to produce `AnnotatedField`s for the UI.
 *
 * No code generation, no compile step: the registry can be rebuilt at any
 * time from whatever modules the renderer currently has loaded, so Vite HMR
 * on `proto/*.ts` flows straight through to the annotation pane.
 */

import type { ProtoMessageType, ProtoFieldType } from '../core';
import { ScalarType } from '../core';
import type { RawField, Guess } from './types';
import type { WireType } from './wire';

/** One field's metadata in a flat, lookup-friendly shape. */
export interface FieldInfo {
  /** Field number on the wire. */
  tag: number;
  /** The name given in the schema object (camelCased already by the schema layer). */
  name: string;
  /** Scalar (e.g. STRING) or 'message' for nested. */
  kind: 'scalar' | 'message';
  /** Only set when kind === 'scalar'. */
  scalarType?: ScalarType;
  /**
   * Only set when kind === 'message'. The lazy reference to the sub-schema —
   * call it to get the nested ProtoMessageType.
   */
  messageRef?: () => ProtoMessageType;
  optional: boolean;
  repeat: boolean;
}

/** Compiled tag-indexed lookup for one schema. */
export class SchemaIndex {
  readonly byTag = new Map<number, FieldInfo>();
  /** The schema object this was built from — used for nested lookups. */
  readonly schema: ProtoMessageType;
  /** Human-readable label like "c2c_msg.C2cMsgBody". Set by the loader. */
  readonly qualifiedName: string;

  constructor(schema: ProtoMessageType, qualifiedName: string) {
    this.schema = schema;
    this.qualifiedName = qualifiedName;
    for (const [name, raw] of Object.entries(schema)) {
      const info = fieldInfo(name, raw as ProtoFieldType);
      this.byTag.set(info.tag, info);
    }
  }
}

function fieldInfo(name: string, f: ProtoFieldType): FieldInfo {
  if (f.kind === 'scalar') {
    return {
      tag: f.no,
      name,
      kind: 'scalar',
      scalarType: f.type,
      optional: f.optional,
      repeat: f.repeat,
    };
  }
  return {
    tag: f.no,
    name,
    kind: 'message',
    messageRef: f.type,
    optional: f.optional,
    repeat: f.repeat,
  };
}

/** Per-tag annotation result, ready for the UI to render next to a RawField. */
export interface AnnotatedField {
  raw: RawField;
  /** Children for LEN fields that resolve to a nested message. */
  children?: AnnotatedField[];
  /** Schema match outcome — drives the badge in the UI. */
  match:
    | { kind: 'unknown' /* no FieldInfo for this tag */ }
    | { kind: 'matched'; info: FieldInfo; preferredGuess: Guess }
    | {
        kind: 'type-mismatch';
        info: FieldInfo;
        reason: string;
        preferredGuess: Guess;
      };
}

/**
 * Walk a `RawField[]` tree and pair every node with the matching `FieldInfo`
 * from `index` (or `unknown` if not declared). Recursively descends into LEN
 * fields whose schema entry is `message`, switching to the sub-schema.
 */
export function annotate(fields: RawField[], index: SchemaIndex): AnnotatedField[] {
  return fields.map((f) => annotateOne(f, index));
}

function annotateOne(raw: RawField, index: SchemaIndex): AnnotatedField {
  const info = index.byTag.get(raw.tag);

  if (!info) {
    // Unknown tag — still recurse into nested LEN guesses so users can see
    // structure even before declaring it.
    const nested = preferredNested(raw);
    return {
      raw,
      ...(nested ? { children: annotateChildrenAnonymously(nested.value) } : {}),
      match: { kind: 'unknown' },
    };
  }

  const check = checkTypeAgreement(raw, info);

  // If this is a message field, recurse with the sub-schema.
  if (info.kind === 'message' && info.messageRef) {
    const nested = preferredNested(raw);
    if (nested) {
      const subSchema = info.messageRef();
      const subIndex = new SchemaIndex(subSchema, `${index.qualifiedName}.${info.name}`);
      return {
        raw,
        children: annotate(nested.value, subIndex),
        match: check.ok
          ? { kind: 'matched', info, preferredGuess: nested }
          : { kind: 'type-mismatch', info, reason: check.reason, preferredGuess: nested },
      };
    }
  }

  const preferredGuess = pickPreferredGuess(raw, info);
  return {
    raw,
    match: check.ok
      ? { kind: 'matched', info, preferredGuess }
      : { kind: 'type-mismatch', info, reason: check.reason, preferredGuess },
  };
}

function annotateChildrenAnonymously(children: RawField[]): AnnotatedField[] {
  return children.map((c) => {
    const nested = preferredNested(c);
    return {
      raw: c,
      ...(nested ? { children: annotateChildrenAnonymously(nested.value) } : {}),
      match: { kind: 'unknown' as const },
    };
  });
}

function preferredNested(
  raw: RawField,
): Extract<Guess, { kind: 'len-nested' }> | undefined {
  for (const g of raw.guesses) {
    if (g.kind === 'len-nested') return g;
  }
  return undefined;
}

/** Check whether the wire type / value seen on the wire is consistent with
 *  the schema's declared type. The UI surfaces the `reason` to the user. */
function checkTypeAgreement(
  raw: RawField,
  info: FieldInfo,
): { ok: true } | { ok: false; reason: string } {
  if (info.kind === 'message') {
    if (raw.wireType !== 2) {
      return { ok: false, reason: `schema says message but wire type is ${wireName(raw.wireType)}` };
    }
    const nested = preferredNested(raw);
    if (!nested?.consumedAll) {
      return { ok: false, reason: 'schema says message but payload does not parse as nested protobuf' };
    }
    return { ok: true };
  }

  // scalar
  const expectedWire = scalarToWire(info.scalarType!);
  if (expectedWire !== raw.wireType) {
    return {
      ok: false,
      reason: `schema says ${ScalarType[info.scalarType!]} (wire ${wireName(expectedWire)}) but wire type is ${wireName(raw.wireType)}`,
    };
  }
  // Range check for varint scalars
  if (raw.wireType === 0 && info.scalarType !== undefined) {
    const u = raw.guesses.find((g) => g.kind === 'varint-uint64');
    if (u?.kind === 'varint-uint64') {
      const overflow = checkVarintRange(u.value, info.scalarType);
      if (overflow) return { ok: false, reason: overflow };
    }
  }
  return { ok: true };
}

function scalarToWire(t: ScalarType): WireType {
  switch (t) {
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return 1;
    case ScalarType.STRING:
    case ScalarType.BYTES:
      return 2;
    case ScalarType.FLOAT:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return 5;
    default:
      return 0; // INT32/64, UINT32/64, SINT32/64, BOOL, ENUM
  }
}

function checkVarintRange(value: bigint, t: ScalarType): string | null {
  switch (t) {
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.UINT32:
      if (value > 0xffffffffn) {
        return `value ${value} overflows ${ScalarType[t]} — declare as UINT64 or INT64`;
      }
      return null;
    case ScalarType.BOOL:
      if (value !== 0n && value !== 1n) {
        return `value ${value} is not a bool (expected 0 or 1)`;
      }
      return null;
    default:
      return null;
  }
}

function wireName(w: WireType): string {
  switch (w) {
    case 0:
      return 'VARINT';
    case 1:
      return 'I64';
    case 2:
      return 'LEN';
    case 5:
      return 'I32';
  }
}

/** Pick the guess most likely to match what the schema expects, so the UI
 *  shows e.g. "bool: true" instead of "uint: 1" when the schema declares bool. */
function pickPreferredGuess(raw: RawField, info: FieldInfo): Guess {
  const first = raw.guesses[0]!;
  if (info.kind !== 'scalar' || info.scalarType === undefined) return first;

  const want = matchKindFor(info.scalarType);
  if (!want) return first;
  return raw.guesses.find((g) => g.kind === want) ?? first;
}

function matchKindFor(t: ScalarType): Guess['kind'] | null {
  switch (t) {
    case ScalarType.BOOL:
      return 'varint-bool';
    case ScalarType.STRING:
      return 'len-utf8';
    case ScalarType.BYTES:
      return 'len-bytes';
    case ScalarType.DOUBLE:
      return 'i64-double';
    case ScalarType.FLOAT:
      return 'i32-float';
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return 'i64-fixed';
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return 'i32-fixed';
    default:
      return 'varint-uint64';
  }
}
