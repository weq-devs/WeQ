/**
 * Schema-aware wire-type sanitizer — makes decode resilient to mis-declared
 * field types.
 *
 * Why: protobuf-ts decodes a KNOWN field using its *declared* type and never
 * checks the wire type actually present. So if a tag we guessed as e.g. UINT32
 * is really a length-delimited blob on the wire, the decoder mis-reads it,
 * derails the byte cursor, and typically throws — losing the ENTIRE message,
 * not just that one field.
 *
 * `sanitizeBytes` walks the buffer purely at the wire level (always honoring
 * the real wire type via `iterFields`, so it can never mis-read) and drops any
 * field whose wire type cannot satisfy its schema declaration. Unknown tags are
 * kept verbatim (protobuf-ts skips them into unknownFields). Nested message
 * fields are sanitized recursively. The re-emitted buffer is then safe for
 * protobuf-ts: every field it recognizes has a wire type matching the
 * declaration, so it decodes without crashing and the dropped fields simply
 * never appear on the result object.
 *
 * Scope note: it only removes genuine WIRE-TYPE conflicts (the ones that derail
 * parsing). Merely out-of-range varints are left alone — protobuf-ts truncates
 * those harmlessly, and dropping them would lose data the caller may want.
 */

import { ScalarType, type ProtoMessageType } from '../core';
import { SchemaIndex, type FieldInfo } from './registry';
import { iterFields, type WireType } from './wire';
import { writeVarint } from './varint';

const indexCache = new WeakMap<ProtoMessageType, SchemaIndex>();

function indexFor(schema: ProtoMessageType): SchemaIndex {
  let idx = indexCache.get(schema);
  if (!idx) {
    idx = new SchemaIndex(schema, 'sanitize');
    indexCache.set(schema, idx);
  }
  return idx;
}

/** Wire type a scalar declaration serializes to (mirrors registry.scalarToWire). */
function scalarWire(t: ScalarType): WireType {
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

/** Whether the wire type seen on the wire can satisfy the field's declaration. */
function wireMatches(info: FieldInfo, wireType: WireType): boolean {
  if (info.kind === 'message') return wireType === 2;
  const base = scalarWire(info.scalarType!);
  // Packed repeated numeric scalars arrive as one LEN blob (wire 2); the
  // unpacked form uses the base wire type. Accept both for repeated fields.
  if (info.repeat && base !== 2) return wireType === 2 || wireType === base;
  return wireType === base;
}

function tagKey(tag: number, wireType: WireType): Uint8Array {
  return writeVarint((BigInt(tag) << 3n) | BigInt(wireType));
}

/**
 * protobuf-ts reads STRING scalars with a *fatal* TextDecoder, so a field we
 * declared STRING that actually carries non-UTF-8 bytes (a mis-guessed tag, or
 * a nested message / raw blob) throws and loses the WHOLE message. Validate
 * here so such fields can be dropped like a wire-type conflict.
 */
const utf8Validator = new TextDecoder('utf-8', { fatal: true });
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    utf8Validator.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

interface SanitizeResult {
  out: Uint8Array;
  changed: boolean;
}

function sanitize(buf: Uint8Array, index: SchemaIndex): SanitizeResult {
  const chunks: Uint8Array[] = [];
  let changed = false;

  try {
    for (const f of iterFields(buf)) {
      const info = index.byTag.get(f.tag);

      // Unknown tag — keep verbatim; protobuf-ts skips it safely.
      if (!info) {
        chunks.push(buf.subarray(f.start, f.start + f.size));
        continue;
      }

      // Wire type conflicts with the declared type — drop the field.
      if (!wireMatches(info, f.wireType)) {
        changed = true;
        continue;
      }

      // A STRING field whose bytes aren't valid UTF-8 would crash protobuf-ts's
      // fatal decoder — drop it so the rest of the message still decodes.
      if (
        info.kind !== 'message' &&
        info.scalarType === ScalarType.STRING &&
        f.wireType === 2 &&
        !isValidUtf8(f.payload)
      ) {
        changed = true;
        continue;
      }

      // Recurse into nested messages so their mis-typed fields are cleaned too.
      if (info.kind === 'message' && info.messageRef && f.wireType === 2) {
        const sub = sanitize(f.payload, indexFor(info.messageRef()));
        if (sub.changed) {
          changed = true;
          chunks.push(tagKey(f.tag, 2), writeVarint(BigInt(sub.out.length)), sub.out);
        } else {
          chunks.push(buf.subarray(f.start, f.start + f.size));
        }
        continue;
      }

      // Scalar (or packed-repeated) field whose wire type matches — keep as-is.
      chunks.push(buf.subarray(f.start, f.start + f.size));
    }
  } catch {
    // Corrupt/truncated tail — keep the well-formed prefix accumulated so far.
    changed = true;
  }

  return { out: changed ? concat(chunks) : buf, changed };
}

/**
 * Return `buf` with every field whose wire type conflicts with `schema`
 * removed (recursively through nested messages). The result is safe to feed
 * straight into `ProtoMsg.decode` — it will not crash on the dropped fields,
 * and they simply won't appear on the decoded object. When nothing needs
 * dropping, the original buffer is returned unchanged.
 */
export function sanitizeBytes(buf: Uint8Array, schema: ProtoMessageType): Uint8Array {
  return sanitize(buf, indexFor(schema)).out;
}
