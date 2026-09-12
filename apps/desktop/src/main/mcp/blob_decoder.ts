/**
 * Blob → AI-readable view for protobuf / JCE reverse engineering.
 *
 * This is the MCP-side twin of WeQ's renderer "Protobuf/JCE 逆向" panel and
 * the BLOB hex viewer: it exposes the already-shipped `@weq/codec/raw`
 * decoders (strict protobuf/JCE + the schema-free guess tree) plus the global
 * tag → field-name dictionary, so a model can decode hex it gets back from
 * `execute_sql` without any local tooling.
 *
 * Output is deliberately compact JSON — no byte offsets, no per-guess
 * confidence noise for every value; where the strict parse fails we fall back
 * to the schema-free decoder and keep the best guess per field.
 */

import {
  bytesToBase64,
  bytesToHex,
  decode as rawDecodeGuess,
  parseInput,
  rvIntDisplay,
  rvTimestampRange,
  tryDecodeJce,
  tryDecodeProtobuf,
  tryUtf8,
  zigzagDecode,
  type Guess,
  type RawField,
  type RvInputFormat,
  type RvNode,
  type RvValue,
} from '@weq/codec/raw';
import { lookupTag } from '@weq/codec/dictionary';

export type BlobFormat = 'auto' | 'protobuf' | 'jce';
export type BlobEncoding = RvInputFormat;

/** JSON-safe decoded value. */
export type AiDecodedValue =
  | { t: 'int'; value: string; notes?: string[] }
  | { t: 'float'; value: number | string }
  | { t: 'text'; value: string }
  | {
      t: 'bytes';
      length: number;
      hex: string;
      truncatedHex: boolean;
      utf8?: string;
      base64?: string;
      notes?: string[];
    }
  | { t: 'object'; fields: AiDecodedField[] }
  | { t: 'list'; items: AiDecodedField[] }
  | { t: 'map'; entries: Array<{ key: string; value: AiDecodedField }> };

/** One decoded wire field, enriched with the QQ global dictionary when known. */
export interface AiDecodedField {
  tag: number;
  field?: string;
  fieldCandidates?: string[];
  value: AiDecodedValue;
}

export interface BlobDecodeResult {
  ok: boolean;
  /** Which decoder produced the tree. */
  kind: 'protobuf' | 'jce' | 'guess' | 'none';
  bytes: number;
  /** Only present for strict parses. */
  consumedAll?: boolean;
  fields: AiDecodedField[];
  /** Human note for the schema-free fallback. */
  guessNote?: string;
  error?: string;
}

/** > this many hex characters in one bytes value is summarized, not dumped. */
const MAX_BYTES_HEX = 4096;

/** hex with a safe size cap (keeps giant DB blobs from flooding the reply). */
function hexPreview(bytes: Uint8Array): { hex: string; truncated: boolean } {
  const full = bytesToHex(bytes);
  if (full.length <= MAX_BYTES_HEX) return { hex: full, truncated: false };
  const head = full.slice(0, 1024);
  const tail = full.slice(-1024);
  return {
    hex: `${head}…（中间省略 ${full.length - 2048} 字符）…${tail}`,
    truncated: true,
  };
}

function tagName(tag: number): { field?: string; fieldCandidates?: string[] } {
  const lookup = lookupTag(tag);
  if (lookup.status === 'known') return { field: lookup.names[0]?.name };
  if (lookup.status === 'ambiguous') {
    return { fieldCandidates: lookup.names.map((n) => n.name) };
  }
  return {};
}

function bigintJson(n: bigint): string {
  return n >= -9007199254740991n && n <= 9007199254740991n ? String(Number(n)) : n.toString();
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** RvValue → AiDecodedValue (recursive). */
function rvValueView(v: RvValue, depth: number): AiDecodedValue {
  if (depth > 24) return { t: 'bytes', length: 0, hex: '…', truncatedHex: true };
  switch (v.k) {
    case 'int': {
      const notes: string[] = [];
      if (v.raw === 0n || v.raw === 1n) notes.push(`可能是 bool ${v.raw === 1n}`);
      const ts = rvTimestampRange(v.raw);
      if (ts) notes.push(`可能是时间戳(${ts.unit}) → ${fmtDate(ts.value)}`);
      const out: AiDecodedValue = {
        t: 'int',
        value: bigintJson(rvIntDisplay(v)),
        ...(notes.length ? { notes } : {}),
      };
      return out;
    }
    case 'float':
      return { t: 'float', value: Number.isFinite(v.n) ? v.n : String(v.n) };
    case 'fixed': {
      const view = bytesValue(v.bytes);
      const dv =
        v.bytes.length === 8
          ? new DataView(v.bytes.buffer, v.bytes.byteOffset, 8)
          : v.bytes.length === 4
            ? new DataView(v.bytes.buffer, v.bytes.byteOffset, 4)
            : null;
      if (!dv) return view;
      const notes: string[] = [];
      if (v.bytes.length === 8) {
        notes.push(`uint64 → ${dv.getBigUint64(0, true)}`);
        const f = dv.getFloat64(0, true);
        if (Number.isFinite(f)) notes.push(`double → ${f}`);
      } else {
        notes.push(`uint32 → ${dv.getUint32(0, true)}`);
        const f = dv.getFloat32(0, true);
        if (Number.isFinite(f)) notes.push(`float → ${f}`);
      }
      if (notes.length) return { ...view, notes } as AiDecodedValue;
      return view;
    }
    case 'str':
      return { t: 'text', value: v.text };
    case 'bytes':
      return bytesValue(v.bytes);
    case 'obj':
      return { t: 'object', fields: rvNodesToFields(v.fields, depth + 1) };
    case 'list':
      return {
        t: 'list',
        items: v.items.map((item) => {
          const { field, fieldCandidates } = tagName(item.tag);
          return {
            tag: item.tag,
            ...(field ? { field } : fieldCandidates ? { fieldCandidates } : {}),
            value: rvValueView(item.value, depth + 1),
          };
        }),
      };
    case 'map':
      return {
        t: 'map',
        entries: v.entries.map((e) => ({
          key: rvKeyLabel(e.key),
          value: fieldView(e.value, depth + 1),
        })),
      };
  }
}

function bytesValue(bytes: Uint8Array): AiDecodedValue {
  const { hex, truncated } = hexPreview(bytes);
  const out: Extract<AiDecodedValue, { t: 'bytes' }> = {
    t: 'bytes',
    length: bytes.length,
    hex,
    truncatedHex: truncated,
  };
  const text = tryUtf8(bytes);
  if (text) out.utf8 = text.length > 2000 ? `${text.slice(0, 2000)}…（已截断）` : text;
  if (bytes.length > 0 && bytes.length <= 512) out.base64 = bytesToBase64(bytes);
  return out;
}

function fieldView(node: RvNode, depth: number): AiDecodedField {
  const { field, fieldCandidates } = tagName(node.tag);
  return {
    tag: node.tag,
    ...(field ? { field } : fieldCandidates ? { fieldCandidates } : {}),
    value: rvValueView(node.value, depth),
  };
}

function rvNodesToFields(nodes: RvNode[], depth = 0): AiDecodedField[] {
  return nodes.map((n) => fieldView(n, depth));
}

function rvKeyLabel(key: RvValue): string {
  switch (key.k) {
    case 'int':
      return bigintJson(rvIntDisplay(key));
    case 'float':
      return String(key.n);
    case 'str':
      return key.text;
    case 'bytes':
      return `bytes:${bytesToHex(key.bytes)}`;
    default:
      return '…';
  }
}

// ── schema-free fallback ────────────────────────────────────────────────────

function bestGuess(field: RawField): Guess | null {
  return field.guesses[0] ?? null;
}

function guessValue(guess: Guess, depth: number): AiDecodedValue {
  if (depth > 24) return { t: 'bytes', length: 0, hex: '…', truncatedHex: true };
  switch (guess.kind) {
    case 'varint-uint64':
      return intWithHint(guess.value);
    case 'varint-int64-zigzag':
      return { t: 'int', value: bigintJson(zigzagDecode(guess.value)) };
    case 'varint-bool':
      return { t: 'int', value: guess.value ? '1' : '0', notes: ['可能是 bool'] };
    case 'varint-timestamp-sec':
      return {
        t: 'int',
        value: String(guess.value.getTime() / 1000),
        notes: [`时间戳(秒) → ${guess.value.toISOString()}`],
      };
    case 'varint-timestamp-ms':
      return {
        t: 'int',
        value: String(guess.value.getTime()),
        notes: [`时间戳(毫秒) → ${guess.value.toISOString()}`],
      };
    case 'i64-fixed':
      return { t: 'int', value: bigintJson(guess.value), notes: ['fixed64'] };
    case 'i64-double':
      return { t: 'float', value: guess.value };
    case 'i32-fixed':
      return { t: 'int', value: String(guess.value), notes: ['fixed32'] };
    case 'i32-float':
      return { t: 'float', value: guess.value };
    case 'len-utf8':
      return { t: 'text', value: guess.value };
    case 'len-nested':
      return { t: 'object', fields: rawFieldsView(guess.value, depth + 1) };
    case 'len-bytes':
      return bytesValue(guess.value);
  }
}

function intWithHint(value: bigint): AiDecodedValue {
  const notes: string[] = [];
  if (value === 0n || value === 1n) notes.push(`可能是 bool ${value === 1n}`);
  const ts = rvTimestampRange(value);
  if (ts) notes.push(`可能是时间戳(${ts.unit}) → ${fmtDate(ts.value)}`);
  return { t: 'int', value: bigintJson(value), ...(notes.length ? { notes } : {}) };
}

function rawFieldsView(fields: RawField[], depth = 0): AiDecodedField[] {
  return fields.map((f) => {
    const { field, fieldCandidates } = tagName(f.tag);
    const guess = bestGuess(f);
    return {
      tag: f.tag,
      ...(field ? { field } : fieldCandidates ? { fieldCandidates } : {}),
      value: guess
        ? guessValue(guess, depth)
        : { t: 'bytes', length: 0, hex: '', truncatedHex: false },
    };
  });
}

// ── public API ──────────────────────────────────────────────────────────────

/** Decode already-parsed bytes with strict protobuf/JCE, then guess fallback. */
export function decodeBlobBytes(buf: Uint8Array, format: BlobFormat): BlobDecodeResult {
  if (buf.length === 0) {
    return { ok: false, kind: 'none', bytes: 0, fields: [], error: '输入为空' };
  }

  const strict = (
    decode: () => RvNode[] | null,
    kind: 'protobuf' | 'jce',
  ): BlobDecodeResult | null => {
    const nodes = decode();
    return nodes
      ? {
          ok: true,
          kind,
          bytes: buf.length,
          consumedAll: true,
          fields: rvNodesToFields(nodes),
        }
      : null;
  };
  if (format === 'protobuf') {
    return (
      strict(() => tryDecodeProtobuf(buf), 'protobuf') ?? {
        ok: false,
        kind: 'none',
        bytes: buf.length,
        fields: [],
        error: '无法按 protobuf 完整解析（可能需要剥离外层长度头/信封，或改用 auto 看猜测树）。',
      }
    );
  }
  if (format === 'jce') {
    return (
      strict(() => tryDecodeJce(buf), 'jce') ?? {
        ok: false,
        kind: 'none',
        bytes: buf.length,
        fields: [],
        error: '无法按 JCE 完整解析（可能需要剥离外层长度头/信封，或改用 auto 看猜测树）。',
      }
    );
  }

  const proto = strict(() => tryDecodeProtobuf(buf), 'protobuf');
  if (proto) return proto;
  const jce = strict(() => tryDecodeJce(buf), 'jce');
  if (jce) return jce;

  // Schema-free decoder always returns something for non-empty input; mark the
  // result honestly as a guess so models don't treat field numbers as fact.
  const guessFields = rawFieldsView(rawDecodeGuess(buf));
  return {
    ok: true,
    kind: guessFields.length ? 'guess' : 'none',
    bytes: buf.length,
    fields: guessFields,
    guessNote:
      '未能按 protobuf 或 JCE 完整解析，以下为 schema-free 猜测（field 名仅来自 QQ 全局 tag 词典，小 tag 无全局含义）。',
  };
}

/** Decode user-supplied hex/base64 text (separators and 0x prefixes allowed). */
export function decodeBlobText(
  text: string,
  encoding: BlobEncoding,
  format: BlobFormat,
): BlobDecodeResult {
  try {
    const buf = parseInput(text, encoding);
    return decodeBlobBytes(buf, format);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'none',
      bytes: 0,
      fields: [],
      error: `输入解析失败：${message}`,
    };
  }
}

/** Decode a hex string already produced by DbExplorer (blob cells). */
export function decodeBlobHex(hex: string, format: BlobFormat): BlobDecodeResult {
  return decodeBlobText(hex, 'hex', format);
}
