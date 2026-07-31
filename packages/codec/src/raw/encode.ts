/**
 * Editable protobuf tree — the model behind the BLOB lightbox's Protobuf tab.
 *
 * `decode()` produces a read-only view where every field carries all plausible
 * interpretations of its bytes. This layer turns that into something a user can
 * mutate (change a value, drop a field, add a field) and then serialize back.
 *
 * The serializer is deliberately conservative: a node that was never touched is
 * re-emitted as a verbatim slice of the ORIGINAL buffer, tag varint and all. So
 * editing one string deep inside a message leaves every other byte — including
 * non-canonical varint padding and fields we failed to interpret — bit-identical.
 * Only the path from the root down to an edited node is rebuilt.
 */

import { decode } from './decode';
import type { RawField } from './types';
import type { WireType } from './wire';
import { readVarint, writeVarint, zigzagDecode, zigzagEncode } from './varint';

/** How the user is currently reading (and editing) one field's payload. */
export type PbValue =
  /** Wire 0, plain unsigned. `text` is decimal. */
  | { kind: 'varint'; text: string }
  /** Wire 0, sint32/sint64. `text` is the decoded signed decimal. */
  | { kind: 'zigzag'; text: string }
  /** Wire 0, restricted to 0/1. */
  | { kind: 'bool'; on: boolean }
  /** Wire 0 read as an epoch time. `text` stays the raw decimal so edits are exact. */
  | { kind: 'timestamp'; unit: 'sec' | 'ms'; text: string }
  /** Wire 1 / 5, unsigned integer. `text` is decimal. */
  | { kind: 'fixed'; bits: 32 | 64; text: string }
  /** Wire 1 / 5, IEEE float. `text` is decimal. */
  | { kind: 'float'; bits: 32 | 64; text: string }
  /** Wire 2, valid UTF-8. */
  | { kind: 'utf8'; text: string }
  /** Wire 2, opaque bytes. `hex` is continuous lowercase. */
  | { kind: 'bytes'; hex: string }
  /** Wire 2, nested message — the value lives in `children`. */
  | { kind: 'nested' };

export interface PbNode {
  /** Stable React key. Assigned on build/insert, never reused. */
  id: string;
  tag: number;
  wireType: WireType;
  /**
   * Where this field's bytes sit in the buffer it was decoded from, or null for
   * a field the user inserted. Only meaningful while `dirty` is false.
   */
  origin: { start: number; size: number } | null;
  /** Non-null exactly when `value.kind === 'nested'`. */
  children: PbNode[] | null;
  value: PbValue;
  /** Set on this node and every ancestor when anything below changes. */
  dirty: boolean;
}

export class PbEncodeError extends Error {
  constructor(
    message: string,
    /** Tag numbers from the root down to the offending field. */
    readonly path: number[],
  ) {
    super(message);
    this.name = 'PbEncodeError';
  }
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `pb${idCounter}`;
}

// ── build ───────────────────────────────────────────────────────────────────

/** Decode `buf` and wrap it in an editable tree. Never throws. */
export function buildEditTree(buf: Uint8Array): PbNode[] {
  return fromRaw(decode(buf));
}

function fromRaw(fields: RawField[]): PbNode[] {
  return fields.map((f) => {
    const nested = f.guesses.find((g) => g.kind === 'len-nested');
    // Only descend when the payload parses cleanly to its end — a partial nested
    // parse is far more often a coincidence than a real message.
    if (nested?.kind === 'len-nested' && nested.consumedAll) {
      return {
        id: nextId(),
        tag: f.tag,
        wireType: f.wireType,
        origin: { start: f.start, size: f.size },
        children: fromRaw(nested.value),
        value: { kind: 'nested' } as PbValue,
        dirty: false,
      };
    }
    return {
      id: nextId(),
      tag: f.tag,
      wireType: f.wireType,
      origin: { start: f.start, size: f.size },
      children: null,
      value: valueFromGuesses(f),
      dirty: false,
    };
  });
}

/**
 * The interpretation to show first — the decoder already ranked by confidence.
 *
 * `len-nested` is deliberately skipped: `fromRaw` only descends when the payload
 * consumes to its end, so reaching here with a nested guess means it was partial
 * (a coincidence, not a message). Honoring it would yield `kind: 'nested'` with
 * no children — a row that can neither be expanded nor edited.
 */
function valueFromGuesses(f: RawField): PbValue {
  const g = f.guesses.find((x) => x.kind !== 'len-nested');
  switch (g?.kind) {
    case 'varint-uint64':
      return { kind: 'varint', text: g.value.toString() };
    case 'varint-int64-zigzag':
      return { kind: 'zigzag', text: g.value.toString() };
    case 'varint-bool':
      return { kind: 'bool', on: g.value };
    case 'varint-timestamp-sec':
      return { kind: 'timestamp', unit: 'sec', text: String(g.value.getTime() / 1000) };
    case 'varint-timestamp-ms':
      return { kind: 'timestamp', unit: 'ms', text: String(g.value.getTime()) };
    case 'i64-fixed':
      return { kind: 'fixed', bits: 64, text: g.value.toString() };
    case 'i64-double':
      return { kind: 'float', bits: 64, text: String(g.value) };
    case 'i32-fixed':
      return { kind: 'fixed', bits: 32, text: String(g.value) };
    case 'i32-float':
      return { kind: 'float', bits: 32, text: String(g.value) };
    case 'len-utf8':
      return { kind: 'utf8', text: g.value };
    case 'len-bytes':
      return { kind: 'bytes', hex: toHex(g.value) };
    default:
      // No usable guess (empty payload / unreadable) — fall back to raw bytes.
      return { kind: 'bytes', hex: '' };
  }
}

// ── alternative interpretations ─────────────────────────────────────────────

/**
 * Every way the given payload can be read, for the "cycle interpretation"
 * control. Derived from live bytes (not from the original decode) so it stays
 * correct after the user edits a value.
 */
export function valueAlternatives(wireType: WireType, payload: Uint8Array): PbValue[] {
  switch (wireType) {
    case 0: {
      let v: bigint;
      try {
        v = readVarint(payload, 0).value;
      } catch {
        return [{ kind: 'varint', text: '0' }];
      }
      const out: PbValue[] = [{ kind: 'varint', text: v.toString() }];
      if (v === 0n || v === 1n) out.push({ kind: 'bool', on: v === 1n });
      out.push({ kind: 'timestamp', unit: 'sec', text: v.toString() });
      out.push({ kind: 'timestamp', unit: 'ms', text: v.toString() });
      out.push({ kind: 'zigzag', text: zigzagDecode(v).toString() });
      return out;
    }
    case 1: {
      if (payload.length !== 8) return [{ kind: 'fixed', bits: 64, text: '0' }];
      const dv = view(payload);
      return [
        { kind: 'fixed', bits: 64, text: dv.getBigUint64(0, true).toString() },
        { kind: 'float', bits: 64, text: String(dv.getFloat64(0, true)) },
      ];
    }
    case 5: {
      if (payload.length !== 4) return [{ kind: 'fixed', bits: 32, text: '0' }];
      const dv = view(payload);
      return [
        { kind: 'fixed', bits: 32, text: String(dv.getUint32(0, true)) },
        { kind: 'float', bits: 32, text: String(dv.getFloat32(0, true)) },
      ];
    }
    case 2: {
      const out: PbValue[] = [];
      if (parsesAsNested(payload)) out.push({ kind: 'nested' });
      const s = tryUtf8(payload);
      if (s !== null) out.push({ kind: 'utf8', text: s });
      out.push({ kind: 'bytes', hex: toHex(payload) });
      return out;
    }
  }
}

function parsesAsNested(payload: Uint8Array): boolean {
  if (payload.length === 0) return false;
  const fields = decode(payload);
  if (fields.length === 0) return false;
  const last = fields[fields.length - 1]!;
  return last.start + last.size === payload.length;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function tryUtf8(payload: Uint8Array): string | null {
  try {
    const s = UTF8.decode(payload);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return null;
    }
    return s;
  } catch {
    return null;
  }
}

// ── mutation helpers ────────────────────────────────────────────────────────

/**
 * Replace one node (found by id) with `fn`'s result, marking it and every
 * ancestor dirty. Returns a new array; untouched subtrees keep their identity.
 */
export function updateNode(nodes: PbNode[], id: string, fn: (node: PbNode) => PbNode): PbNode[] {
  let hit = false;
  const next = nodes.map((n) => {
    if (n.id === id) {
      hit = true;
      return { ...fn(n), dirty: true };
    }
    if (!n.children) return n;
    const kids = updateNode(n.children, id, fn);
    if (kids === n.children) return n;
    hit = true;
    return { ...n, children: kids, dirty: true };
  });
  return hit ? next : nodes;
}

/** Drop one node by id, marking its ancestors dirty. */
export function removeNode(nodes: PbNode[], id: string): PbNode[] {
  if (nodes.some((n) => n.id === id)) {
    return nodes.filter((n) => n.id !== id);
  }
  let hit = false;
  const next = nodes.map((n) => {
    if (!n.children) return n;
    const kids = removeNode(n.children, id);
    if (kids === n.children) return n;
    hit = true;
    return { ...n, children: kids, dirty: true };
  });
  return hit ? next : nodes;
}

/**
 * Append a field at the end of `parentId`'s children (or of the root list when
 * `parentId` is null). Protobuf ignores field order, so appending is the least
 * surprising placement.
 */
export function appendNode(nodes: PbNode[], parentId: string | null, child: PbNode): PbNode[] {
  if (parentId === null) return [...nodes, child];
  return updateNode(nodes, parentId, (n) => ({
    ...n,
    children: [...(n.children ?? []), child],
  }));
}

/** A blank inserted field, ready for the user to fill in. */
export function newNode(tag: number, wireType: WireType): PbNode {
  return {
    id: nextId(),
    tag,
    wireType,
    origin: null,
    children: null,
    value: defaultValue(wireType),
    dirty: true,
  };
}

function defaultValue(wireType: WireType): PbValue {
  switch (wireType) {
    case 0:
      return { kind: 'varint', text: '0' };
    case 1:
      return { kind: 'fixed', bits: 64, text: '0' };
    case 5:
      return { kind: 'fixed', bits: 32, text: '0' };
    case 2:
      return { kind: 'bytes', hex: '' };
  }
}

/**
 * Switch a node to a different reading of the same bytes. Purely a display
 * change, so this does NOT mark the node dirty — re-encoding `value` yields
 * the identical payload.
 */
export function reinterpret(
  nodes: PbNode[],
  id: string,
  value: PbValue,
  original: Uint8Array,
): PbNode[] {
  return mapNode(nodes, id, (n) => {
    if (value.kind !== 'nested') {
      return { ...n, value, children: null };
    }
    // Entering nested view: parse the payload into children. `decode` numbers
    // offsets from the start of whatever buffer it is handed, so shift them to
    // stay absolute in `original` — the encoder slices clean nodes from there.
    const payload = payloadOf(n, [n.tag], original);
    const children = fromRaw(decode(payload));
    const base = n.dirty || !n.origin ? null : n.origin.start + (n.origin.size - payload.length);
    return { ...n, value, children: base === null ? detach(children) : shift(children, base) };
  });
}

/** Rebase origins onto the outer buffer. */
function shift(nodes: PbNode[], delta: number): PbNode[] {
  return nodes.map((n) => ({
    ...n,
    origin: n.origin ? { start: n.origin.start + delta, size: n.origin.size } : null,
    children: n.children ? shift(n.children, delta) : null,
  }));
}

/** Drop origins entirely — used when the parent's bytes no longer live in the
 *  original buffer, so no descendant can be sliced from it. */
function detach(nodes: PbNode[]): PbNode[] {
  return nodes.map((n) => ({
    ...n,
    origin: null,
    children: n.children ? detach(n.children) : null,
  }));
}

/** Like updateNode but without the dirty flags — for display-only changes. */
function mapNode(nodes: PbNode[], id: string, fn: (n: PbNode) => PbNode): PbNode[] {
  let hit = false;
  const next = nodes.map((n) => {
    if (n.id === id) {
      hit = true;
      return fn(n);
    }
    if (!n.children) return n;
    const kids = mapNode(n.children, id, fn);
    if (kids === n.children) return n;
    hit = true;
    return { ...n, children: kids };
  });
  return hit ? next : nodes;
}

// ── encode ──────────────────────────────────────────────────────────────────

/**
 * Serialize the tree. `original` must be the buffer the tree was built from —
 * clean nodes are copied straight out of it.
 *
 * @throws {PbEncodeError} when a node's value text can't be encoded.
 */
export function encodeEditTree(nodes: PbNode[], original: Uint8Array): Uint8Array {
  return concat(nodes.map((n) => encodeNode(n, original, [])));
}

function encodeNode(node: PbNode, original: Uint8Array, parents: number[]): Uint8Array {
  if (!node.dirty && node.origin) {
    return original.subarray(node.origin.start, node.origin.start + node.origin.size);
  }
  const path = [...parents, node.tag];
  const payload = payloadOf(node, path, original);
  const key = writeVarint((BigInt(node.tag) << 3n) | BigInt(node.wireType));
  return node.wireType === 2
    ? concat([key, writeVarint(BigInt(payload.length)), payload])
    : concat([key, payload]);
}

/** This field's payload bytes (no tag key, no LEN prefix) from its current value. */
export function payloadOf(node: PbNode, path: number[], original?: Uint8Array): Uint8Array {
  const v = node.value;
  switch (v.kind) {
    case 'varint':
    case 'timestamp':
      return writeVarint(bigintOf(v.text, path));
    case 'zigzag':
      return writeVarint(zigzagEncode(bigintOf(v.text, path)));
    case 'bool':
      return writeVarint(v.on ? 1n : 0n);
    case 'fixed': {
      const buf = new Uint8Array(v.bits / 8);
      const dv = view(buf);
      if (v.bits === 64) dv.setBigUint64(0, BigInt.asUintN(64, bigintOf(v.text, path)), true);
      else dv.setUint32(0, Number(BigInt.asUintN(32, bigintOf(v.text, path))), true);
      return buf;
    }
    case 'float': {
      const n = Number(v.text);
      if (!Number.isFinite(n)) {
        throw new PbEncodeError(`"${v.text}" 不是有效的浮点数`, path);
      }
      const buf = new Uint8Array(v.bits / 8);
      const dv = view(buf);
      if (v.bits === 64) dv.setFloat64(0, n, true);
      else dv.setFloat32(0, n, true);
      return buf;
    }
    case 'utf8':
      return new TextEncoder().encode(v.text);
    case 'bytes':
      return fromHex(v.hex, path);
    case 'nested':
      return concat(
        (node.children ?? []).map((c) => encodeNode(c, original ?? new Uint8Array(0), path)),
      );
  }
}

function bigintOf(text: string, path: number[]): bigint {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    throw new PbEncodeError(`"${text}" 不是有效的整数`, path);
  }
  return BigInt(t);
}

// ── byte helpers ────────────────────────────────────────────────────────────

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex: string, path: number[]): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new PbEncodeError('Hex 必须是偶数个十六进制字符', path);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
