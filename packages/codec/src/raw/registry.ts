/**
 * Tag-indexed view of one schema object.
 *
 * Loaded `proto/**\/*.ts` modules expose plain `ProtoMessageType` objects
 * (instances of the NapProto DSL). At runtime each one is just a record of
 * `{ fieldName: ProtoField(tag, type, optional?, repeat?) }` — enough to build
 * a `tag → FieldInfo` lookup without any code generation or compile step.
 *
 * `sanitize.ts` uses this to decide, per tag, whether the wire type actually
 * present can satisfy the declaration. For naming fields in a decoded tree see
 * `../dictionary` instead — that flattens every schema into one global table.
 */

import type { ProtoMessageType, ProtoFieldType, ScalarType } from '../core';

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
