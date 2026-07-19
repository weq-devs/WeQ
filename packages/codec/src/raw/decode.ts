/**
 * Schema-free recursive decoder. Walks the wire format and produces a tree of
 * `RawField`s, each annotated with every plausible interpretation of its
 * payload bytes. No schema needed — the wire format is self-describing enough
 * to recover the field number, wire type, and length of every field.
 *
 * Heuristics for LEN fields (`len-utf8`, `len-nested`, `len-bytes`):
 *  - Always emit `len-bytes` (zero cost, always valid).
 *  - Try nested decode; if every sub-field parses to the end with sane tag
 *    numbers (1..~100000), emit `len-nested` with high confidence.
 *  - Try UTF-8; if every byte is valid and the result contains no control
 *    characters other than common whitespace, emit `len-utf8`. Higher
 *    confidence when the string is non-ASCII (catches CJK, drops random
 *    bytes that happen to be valid ASCII).
 *
 * For VARINT we always emit the raw uint64 plus context-dependent extras
 * (bool if 0/1, timestamps if in a plausible epoch range).
 */

import type { RawField, Guess } from './types';
import { iterFields, readField, WireError, type WireField } from './wire';
import { readVarint, zigzagDecode } from './varint';

const SEC_2000 = 946684800n;
const SEC_2100 = 4102444800n;
const MS_2000 = SEC_2000 * 1000n;
const MS_2100 = SEC_2100 * 1000n;

/** Decode a top-level protobuf payload. Never throws — partial parses surface
 *  as `len-bytes` fallbacks at the offending nesting level. */
export function decode(buf: Uint8Array): RawField[] {
  return decodeTopLevel(buf, 0);
}

function decodeTopLevel(buf: Uint8Array, baseOffset: number): RawField[] {
  const out: RawField[] = [];
  try {
    for (const wf of iterFields(buf)) {
      out.push(fieldFromWire(wf, buf, baseOffset));
    }
  } catch {
    // partial parse: leave what we've got; caller will see len-bytes guesses
    // at the parent level if needed.
  }
  return out;
}

function fieldFromWire(wf: WireField, _src: Uint8Array, baseOffset: number): RawField {
  return {
    tag: wf.tag,
    wireType: wf.wireType,
    start: baseOffset + wf.start,
    size: wf.size,
    guesses: guessesFor(wf, baseOffset + wf.start + (wf.size - wf.payload.length)),
  };
}

function guessesFor(wf: WireField, payloadAbsStart: number): Guess[] {
  switch (wf.wireType) {
    case 0:
      return guessVarint(wf.payload);
    case 1:
      return guessI64(wf.payload);
    case 5:
      return guessI32(wf.payload);
    case 2:
      return guessLen(wf.payload, payloadAbsStart);
    default:
      return [];
  }
}

function guessVarint(payload: Uint8Array): Guess[] {
  let v: bigint;
  try {
    v = readVarint(payload, 0).value;
  } catch {
    return [];
  }
  const guesses: Guess[] = [{ kind: 'varint-uint64', value: v, confidence: 0.5 }];

  if (v === 0n || v === 1n) {
    guesses.unshift({ kind: 'varint-bool', value: v === 1n, confidence: 0.6 });
  }

  // Timestamp ranges. ms first (more common in QQ NT) so it ranks above sec
  // when both fit.
  if (v >= MS_2000 && v < MS_2100) {
    const ms = Number(v);
    if (Number.isFinite(ms)) {
      guesses.push({ kind: 'varint-timestamp-ms', value: new Date(ms), confidence: 0.7 });
    }
  } else if (v >= SEC_2000 && v < SEC_2100) {
    const s = Number(v);
    if (Number.isFinite(s)) {
      guesses.push({ kind: 'varint-timestamp-sec', value: new Date(s * 1000), confidence: 0.7 });
    }
  }

  // zigzag — always emit but low confidence (only meaningful for sint32/64)
  if (v > 0n) {
    guesses.push({ kind: 'varint-int64-zigzag', value: zigzagDecode(v), confidence: 0.2 });
  }

  return guesses;
}

function guessI64(payload: Uint8Array): Guess[] {
  if (payload.length !== 8) return [];
  const dv = new DataView(payload.buffer, payload.byteOffset, 8);
  const u = dv.getBigUint64(0, true);
  const f = dv.getFloat64(0, true);
  const out: Guess[] = [{ kind: 'i64-fixed', value: u, confidence: 0.5 }];
  if (Number.isFinite(f) && Math.abs(f) > 1e-6 && Math.abs(f) < 1e16) {
    out.push({ kind: 'i64-double', value: f, confidence: 0.2 });
  }
  return out;
}

function guessI32(payload: Uint8Array): Guess[] {
  if (payload.length !== 4) return [];
  const dv = new DataView(payload.buffer, payload.byteOffset, 4);
  const u = dv.getUint32(0, true);
  const f = dv.getFloat32(0, true);
  const out: Guess[] = [{ kind: 'i32-fixed', value: u, confidence: 0.5 }];
  if (Number.isFinite(f) && Math.abs(f) > 1e-6 && Math.abs(f) < 1e10) {
    out.push({ kind: 'i32-float', value: f, confidence: 0.2 });
  }
  return out;
}

function guessLen(payload: Uint8Array, payloadAbsStart: number): Guess[] {
  const out: Guess[] = [];

  // 1. Always emit raw bytes as a fallback.
  const bytesGuess: Guess = {
    kind: 'len-bytes',
    value: payload,
    confidence: 0.1,
  };

  // 2. Try nested decode. If we cleanly consume every byte with plausible
  //    tags, this is the most likely interpretation.
  const nested = tryNested(payload, payloadAbsStart);
  if (nested) {
    out.push({
      kind: 'len-nested',
      value: nested.fields,
      consumedAll: nested.consumedAll,
      confidence: nested.consumedAll ? 0.9 : 0.4,
    });
  }

  // 3. Try UTF-8.
  const utf8 = tryUtf8(payload);
  if (utf8 !== null) {
    // CJK / high-codepoint strings get bonus confidence — pure-ASCII random
    // bytes are too easy to mistake for "valid" strings.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 有意检测非 ASCII(含控制字符)以判断编码
    const hasHighCodepoint = /[^\x00-\x7f]/.test(utf8);
    out.push({
      kind: 'len-utf8',
      value: utf8,
      confidence: hasHighCodepoint ? 0.85 : 0.55,
    });
  }

  out.push(bytesGuess);
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

function tryNested(
  payload: Uint8Array,
  payloadAbsStart: number,
): { fields: RawField[]; consumedAll: boolean } | null {
  if (payload.length === 0) return null;
  const fields: RawField[] = [];
  let offset = 0;
  try {
    while (offset < payload.length) {
      const wf = readField(payload, offset);
      if (!wf) break;
      // Sanity: real protobuf field numbers are 1..2^29-1, but in practice
      // anything past ~200000 is almost certainly garbage from misinterpretation.
      if (wf.tag < 1 || wf.tag > 200000) return null;
      fields.push({
        tag: wf.tag,
        wireType: wf.wireType,
        start: payloadAbsStart + wf.start,
        size: wf.size,
        guesses: guessesFor(wf, payloadAbsStart + wf.start + (wf.size - wf.payload.length)),
      });
      offset = wf.start + wf.size;
    }
  } catch (e) {
    if (e instanceof WireError) {
      // Partial nested: only report if we got at least one good field.
      return fields.length > 0 ? { fields, consumedAll: false } : null;
    }
    throw e;
  }
  return { fields, consumedAll: offset === payload.length };
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function tryUtf8(payload: Uint8Array): string | null {
  if (payload.length === 0) return '';
  try {
    const s = UTF8_DECODER.decode(payload);
    // Reject if any C0 control char other than \t\n\r appears — those are
    // never in legitimate display strings.
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        return null;
      }
    }
    return s;
  } catch {
    return null;
  }
}
