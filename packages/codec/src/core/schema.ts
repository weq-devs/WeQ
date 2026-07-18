/**
 * Schema DSL — schema-as-object protobuf description.
 *
 * Defines `ProtoField` and `ProtoMsg`: the runtime layer wraps
 * `@protobuf-ts/runtime` so we can write protobuf shapes as plain object
 * literals (`{ str: ProtoField(1, ScalarType.STRING) }`) without a .proto
 * file or codegen step.
 *
 * Encode behavior: only fields the caller actually supplied appear on the
 * wire. There is no notion of "schema default" — every field is either
 * present (and emitted) or absent (and omitted). Element-level interfaces
 * use TS `?` to mark which wire fields are optional vs guaranteed per kind.
 */

// @ts-nocheck — heavy type-level recursion that exceeds TS's inference budget
// for any sane error message; the runtime contracts are nonetheless sound.

import {
  MessageType,
  type PartialMessage,
  RepeatType,
  ScalarType,
  LongType,
} from '@protobuf-ts/runtime';
import type { PartialFieldInfo } from '@protobuf-ts/runtime/build/types/reflection-info';

export { ScalarType } from '@protobuf-ts/runtime';

export type LowerCamelCase<S extends string> = CamelCaseHelper<S, false, true>;

export type CamelCaseHelper<
  S extends string,
  CapNext extends boolean,
  IsFirstChar extends boolean,
> = S extends `${infer F}${infer R}`
  ? F extends '_'
    ? CamelCaseHelper<R, true, false>
    : F extends `${number}`
      ? `${F}${CamelCaseHelper<R, true, false>}`
      : CapNext extends true
        ? `${Uppercase<F>}${CamelCaseHelper<R, false, false>}`
        : IsFirstChar extends true
          ? `${Lowercase<F>}${CamelCaseHelper<R, false, false>}`
          : `${F}${CamelCaseHelper<R, false, false>}`
  : '';

export type ScalarTypeToTsType<T extends ScalarType> = T extends
  | ScalarType.DOUBLE
  | ScalarType.FLOAT
  | ScalarType.INT32
  | ScalarType.FIXED32
  | ScalarType.UINT32
  | ScalarType.SFIXED32
  | ScalarType.SINT32
  ? number
  : T extends
        | ScalarType.INT64
        | ScalarType.UINT64
        | ScalarType.FIXED64
        | ScalarType.SFIXED64
        | ScalarType.SINT64
    ? bigint
    : T extends ScalarType.BOOL
      ? boolean
      : T extends ScalarType.STRING
        ? string
        : T extends ScalarType.BYTES
          ? Uint8Array
          : never;

/**
 * Options accepted by `ProtoField`.
 */
export interface ProtoFieldOpts<O extends boolean = boolean, R extends boolean = boolean> {
  /** protobuf3 `optional` modifier. */
  optional?: O;
  /** protobuf `repeated` — TS type becomes T[]. */
  repeat?: R;
}

export interface BaseProtoFieldType<T, O extends boolean, R extends boolean> {
  kind: 'scalar' | 'message';
  no: number;
  type: T;
  optional: O;
  repeat: R;
}

export interface ScalarProtoFieldType<T extends ScalarType, O extends boolean, R extends boolean>
  extends BaseProtoFieldType<T, O, R> {
  kind: 'scalar';
}

export interface MessageProtoFieldType<
  T extends () => ProtoMessageType,
  O extends boolean,
  R extends boolean,
> extends BaseProtoFieldType<T, O, R> {
  kind: 'message';
}

export type ProtoFieldType =
  | ScalarProtoFieldType<ScalarType, boolean, boolean>
  | MessageProtoFieldType<() => ProtoMessageType, boolean, boolean>;

export type ProtoMessageType = {
  [key: string]: ProtoFieldType;
};

/**
 * Describe a single protobuf field by its wire-format tag number and type.
 *
 * @example
 *   // scalar
 *   text: ProtoField(123, ScalarType.STRING, { optional: true }),
 *   // nested message, repeated
 *   elems: ProtoField(2, () => Elem, { optional: true, repeat: true }),
 */
export function ProtoField<
  T extends ScalarType,
  O extends boolean = false,
  R extends boolean = false,
>(
  no: number,
  type: T,
  opts?: ProtoFieldOpts<O, R>,
): ScalarProtoFieldType<T, O, R>;
export function ProtoField<
  T extends () => ProtoMessageType,
  O extends boolean = false,
  R extends boolean = false,
>(
  no: number,
  type: T,
  opts?: ProtoFieldOpts<O, R>,
): MessageProtoFieldType<T, O, R>;
export function ProtoField(
  no: number,
  type: ScalarType | (() => ProtoMessageType),
  opts?: ProtoFieldOpts,
): ProtoFieldType {
  const optional = (opts?.optional ?? false) as boolean;
  const repeat = (opts?.repeat ?? false) as boolean;

  if (typeof type === 'function') {
    return {
      kind: 'message',
      no,
      type,
      optional,
      repeat,
    } as ProtoFieldType;
  }
  return {
    kind: 'scalar',
    no,
    type,
    optional,
    repeat,
  } as ProtoFieldType;
}

export type ProtoFieldReturnType<T, E extends boolean> =
  NonNullable<T> extends ScalarProtoFieldType<infer S, infer _O, infer _R>
    ? ScalarTypeToTsType<S>
    : T extends NonNullable<MessageProtoFieldType<infer S, infer _O, infer _R>>
      ? NonNullable<ProtoStructType<ReturnType<S>, E>>
      : never;

export type RequiredFieldsBaseType<T, E extends boolean> = {
  [K in keyof T as T[K] extends { optional: true } ? never : LowerCamelCase<K & string>]: T[K] extends {
    repeat: true;
  }
    ? ProtoFieldReturnType<T[K], E>[]
    : ProtoFieldReturnType<T[K], E>;
};

export type OptionalFieldsBaseType<T, E extends boolean> = {
  [K in keyof T as T[K] extends { optional: true } ? LowerCamelCase<K & string> : never]?: T[K] extends {
    repeat: true;
  }
    ? ProtoFieldReturnType<T[K], E>[]
    : ProtoFieldReturnType<T[K], E>;
};

export type RequiredFieldsType<T, E extends boolean> = E extends true
  ? Partial<RequiredFieldsBaseType<T, E>>
  : RequiredFieldsBaseType<T, E>;

export type OptionalFieldsType<T, E extends boolean> = E extends true
  ? Partial<OptionalFieldsBaseType<T, E>>
  : OptionalFieldsBaseType<T, E>;

export type ProtoStructType<T, E extends boolean> = RequiredFieldsType<T, E> & OptionalFieldsType<T, E>;

export type ProtoEncodeStructType<T> = ProtoStructType<T, true>;
export type ProtoDecodeStructType<T> = ProtoStructType<T, false>;

function is64Bit(t: ScalarType): boolean {
  return (
    t === ScalarType.INT64 ||
    t === ScalarType.UINT64 ||
    t === ScalarType.FIXED64 ||
    t === ScalarType.SFIXED64 ||
    t === ScalarType.SINT64
  );
}

class ProtoMsgCore<T extends ProtoMessageType> {
  private readonly _field: PartialFieldInfo[];
  private readonly _proto_msg: MessageType<ProtoStructType<T, boolean>>;
  private static cache = new WeakMap<ProtoMessageType, ProtoMsgCore<any>>();

  private constructor(fields: T) {
    this._field = Object.keys(fields).map((key) => {
      const field = fields[key];
      if (field.kind === 'scalar') {
        const repeatType = field.repeat
          ? [ScalarType.STRING, ScalarType.BYTES].includes(field.type)
            ? RepeatType.UNPACKED
            : RepeatType.PACKED
          : RepeatType.NO;
        return {
          no: field.no,
          name: key,
          kind: 'scalar',
          T: field.type,
          L: is64Bit(field.type) ? LongType.BIGINT : undefined,
          opt: field.optional,
          repeat: repeatType,
        };
      }
      if (field.kind === 'message') {
        return {
          no: field.no,
          name: key,
          kind: 'message',
          repeat: field.repeat ? RepeatType.PACKED : RepeatType.NO,
          T: () => ProtoMsgCore.getInstance(field.type())._proto_msg,
        };
      }
      throw new Error(`Unknown field kind: ${(field as { kind: string }).kind}`);
    }) as PartialFieldInfo[];
    this._proto_msg = new MessageType<ProtoStructType<T, boolean>>('weq', this._field);
  }

  static getInstance<T extends ProtoMessageType>(fields: T): ProtoMsgCore<T> {
    let instance = ProtoMsgCore.cache.get(fields);
    if (!instance) {
      instance = new ProtoMsgCore(fields);
      ProtoMsgCore.cache.set(fields, instance);
    }
    return instance;
  }

  /**
   * Pure wire serializer — emits exactly what the caller provided. Fields
   * the caller didn't set are omitted from the wire bytes.
   */
  encode(data: ProtoEncodeStructType<T>): Uint8Array {
    return this._proto_msg.toBinary(
      this._proto_msg.create(data as PartialMessage<ProtoEncodeStructType<T>>),
    );
  }

  decode(data: Uint8Array): ProtoDecodeStructType<T> {
    return this._proto_msg.fromBinary(data) as ProtoDecodeStructType<T>;
  }
}

/**
 * Wrap a schema definition into something with `encode` / `decode` methods.
 *
 * @example
 *   const Text = { str: ProtoField(1, ScalarType.STRING, { optional: true }) };
 *   const msg = new ProtoMsg(Text);
 *   const bytes = msg.encode({ str: 'hi' });
 *   const back = msg.decode(bytes);     // { str: 'hi' }
 */
export class ProtoMsg<T extends ProtoMessageType> {
  private core: ProtoMsgCore<T>;

  constructor(fields: T) {
    this.core = ProtoMsgCore.getInstance(fields);
  }

  encode(data: ProtoEncodeStructType<T>): Uint8Array {
    return this.core.encode(data);
  }

  decode(data: Uint8Array): ProtoDecodeStructType<T> {
    return this.core.decode(data);
  }
}
