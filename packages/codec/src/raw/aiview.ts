/**
 * RvNode / Guess → 纯 JSON 视图（CyberChef「Protobuf Decode」风格）。
 *
 * 供 MCP 的 blob 解码工具复用：字段号当键、嵌套 message 内联展开、重复 tag
 * 合并成数组；能当可读文本的 bytes 直接给字符串，其余给小写 hex（`0x…`），
 * 超大 bytes 截断。类型信息不写进 JSON —— 调用方需要时另外给字段名图例。
 */

import type { Guess, RawField } from './types';
import { zigzagDecode } from './varint';
import { bytesToHex, rvIntDisplay, tryUtf8, type RvNode, type RvValue } from './reverse';

/** 纯 JSON 值。 */
export type JsonValue = number | string | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** > 这么多 hex 字符的 bytes 只给摘要（头 2048 字符）。 */
const MAX_BYTES_HEX = 4096;

export interface JsonRenderCtx {
  /** 是否出现过被截断的 bytes。 */
  truncatedHex: boolean;
  /** 树里出现过的 field tag，调用方可以按需查字段名词典。 */
  tags: Set<number>;
}

export function newJsonRenderCtx(): JsonRenderCtx {
  return { truncatedHex: false, tags: new Set() };
}

function hexOf(bytes: Uint8Array, ctx: JsonRenderCtx): string {
  const full = bytesToHex(bytes);
  if (full.length <= MAX_BYTES_HEX) return `0x${full}`;
  ctx.truncatedHex = true;
  return `0x${full.slice(0, 2048)}…(+${full.length - 2048} hex chars)`;
}

function bigintJson(n: bigint): number | string {
  return n >= -9007199254740991n && n <= 9007199254740991n ? Number(n) : n.toString();
}

/** RvValue → 纯 JSON。 */
export function rvValueToJsonView(v: RvValue, ctx: JsonRenderCtx): JsonValue {
  switch (v.k) {
    case 'int':
      return bigintJson(rvIntDisplay(v));
    case 'float':
      return Number.isFinite(v.n) ? v.n : String(v.n);
    case 'fixed': {
      if (v.bytes.length === 8) {
        const dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, 8);
        return bigintJson(dv.getBigUint64(0, true));
      }
      const dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, 4);
      return dv.getUint32(0, true);
    }
    case 'str':
      return v.text;
    case 'bytes': {
      if (v.nested) return rvNodesToJsonView(v.nested, ctx);
      if (v.bytes.length === 0) return '';
      const utf8 = tryUtf8(v.bytes);
      return utf8 !== null ? utf8 : hexOf(v.bytes, ctx);
    }
    case 'obj':
      return rvNodesToJsonView(v.fields, ctx);
    case 'list': {
      // JCE LIST 的元素各自带 tag；tag 0（常态）→ 普通数组。
      if (v.items.every((it) => it.tag === 0)) {
        return v.items.map((it) => rvValueToJsonView(it.value, ctx));
      }
      return v.items.map((it) => ({ [String(it.tag)]: rvValueToJsonView(it.value, ctx) }));
    }
    case 'map': {
      const out: { [k: string]: JsonValue } = {};
      for (const e of v.entries) out[rvKeyString(e.key)] = rvValueToJsonView(e.value.value, ctx);
      return out;
    }
  }
}

/** RvNode[] → `{ tag: value }`；重复 tag 按出现顺序合并成数组。 */
export function rvNodesToJsonView(nodes: RvNode[], ctx: JsonRenderCtx): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  /** tag → 该 tag 已经写入的值；再次出现时升级成数组。 */
  const seen = new Map<number, JsonValue | JsonValue[]>();

  for (const n of nodes) {
    ctx.tags.add(n.tag);
    const key = String(n.tag);
    const value = rvValueToJsonView(n.value, ctx);
    const prior = seen.get(n.tag);
    if (prior === undefined) {
      seen.set(n.tag, value);
      out[key] = value;
    } else if (Array.isArray(prior)) {
      prior.push(value);
    } else {
      const arr = [prior, value];
      seen.set(n.tag, arr);
      out[key] = arr;
    }
  }
  return out;
}

function rvKeyString(key: RvValue): string {
  switch (key.k) {
    case 'int':
      return rvIntDisplay(key).toString();
    case 'str':
      return key.text;
    case 'float':
      return String(key.n);
    case 'bytes':
      return `0x${bytesToHex(key.bytes)}`;
    default:
      return '…';
  }
}

/** Guess（schema-free 兜底）里置信度最高的那个 → 纯 JSON。 */
export function guessToJsonView(guess: Guess, ctx: JsonRenderCtx): JsonValue {
  switch (guess.kind) {
    case 'varint-uint64':
      return bigintJson(guess.value);
    case 'varint-int64-zigzag':
      return bigintJson(zigzagDecode(guess.value));
    case 'varint-bool':
      return guess.value;
    case 'varint-timestamp-sec':
      return bigintJson(BigInt(Math.floor(guess.value.getTime() / 1000)));
    case 'varint-timestamp-ms':
      return bigintJson(BigInt(guess.value.getTime()));
    case 'i64-fixed':
      return bigintJson(guess.value);
    case 'i64-double':
    case 'i32-float':
      return Number.isFinite(guess.value) ? guess.value : String(guess.value);
    case 'i32-fixed':
      return guess.value;
    case 'len-utf8':
      return guess.value;
    case 'len-nested':
      return rawFieldsToJsonView(guess.value, ctx);
    case 'len-bytes': {
      if (guess.value.length === 0) return '';
      const utf8 = tryUtf8(guess.value);
      return utf8 !== null ? utf8 : hexOf(guess.value, ctx);
    }
  }
}

/** RawField[] → `{ tag: value }`，每个 tag 取置信度最高的猜测。 */
export function rawFieldsToJsonView(
  fields: RawField[],
  ctx: JsonRenderCtx,
): { [k: string]: JsonValue } {
  const out: { [k: string]: JsonValue } = {};
  for (const f of fields) {
    ctx.tags.add(f.tag);
    const guess = f.guesses[0];
    out[String(f.tag)] = guess ? guessToJsonView(guess, ctx) : null;
  }
  return out;
}
