/**
 * Protobuf / JCE 通用逆向解析 —— 妙妙工具「Protobuf/JCE 逆向」使用。
 *
 * 输出统一为 {tag: value} 形式的简洁 AST，类型不写进 JSON；可转换的值由
 * 前端渲染时附加转换按钮（hex ↔ 文本、bytes ↔ 嵌套 protobuf/JCE 等）。
 *
 * JCE 编码规则严格对齐 QQHook 的 TarsParser / TarsInputStream（QQ 真实包）：
 *   - 头字节：低 4 位 = type，高 4 位 = tag；tag == 15 时再读 1 字节作为完整 tag。
 *   - 类型：0 BYTE, 1 SHORT, 2 INT, 3 LONG, 4 FLOAT, 5 DOUBLE,
 *           6 STRING1, 7 STRING4, 8 MAP, 9 LIST, 10 STRUCT_BEGIN,
 *           11 STRUCT_END, 12 ZERO_TAG, 13 SIMPLE_LIST。
 *   - 容器 size 用 read(0, 0, true) 编码：size 本身是一个 tag=0 的带头字段
 *     （ZERO_TAG / BYTE / SHORT / INT）。仅当该读法非法时兜底尝试老版
 *     JCE 的无头紧凑长度（首字节高位置 1 表示两字节大端长度），不影响正常
 *     QQ 数据的解析。
 *   - 数值为 Java 大端语义（byte/short/int/long 带符号），float/double 大端。
 */

import { iterFields, WireError } from './wire';
import { readVarint, zigzagDecode } from './varint';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 一个字段：{tag: value}。tag 恒为数字，value 为任意取值。 */
export interface RvNode {
  tag: number;
  value: RvValue;
}

export type RvValue =
  /** 整数：protobuf varint（bits=0）或 JCE 定宽整数。raw 为无符号原值。 */
  | { k: 'int'; raw: bigint; bits: 0 | 8 | 16 | 32 | 64; signed: boolean }
  /** 浮点：JCE float/double。 */
  | { k: 'float'; n: number }
  /** protobuf wire 1/5 定长块（fixed32/64、float/double/sfixed）。 */
  | { k: 'fixed'; bytes: Uint8Array; bits: 32 | 64 }
  /** 文本：JCE STRING1/STRING4。 */
  | { k: 'str'; text: string; bytes: Uint8Array }
  /** 原始字节：protobuf LEN 字段、JCE SIMPLE_LIST。 */
  | { k: 'bytes'; bytes: Uint8Array }
  /** 嵌套对象：protobuf 嵌套消息 / JCE STRUCT。 */
  | { k: 'obj'; fields: RvNode[] }
  /** JCE LIST：元素各自带 head。 */
  | { k: 'list'; items: RvNode[] }
  /** JCE MAP：键值对，键可为任意标量。 */
  | { k: 'map'; entries: RvMapEntry[] };

export interface RvMapEntry {
  key: RvValue;
  value: RvNode;
}

/** 复制用 JSON 值。 */
export type RvJson = number | string | boolean | RvJson[] | { [k: string]: RvJson };

export class ReverseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReverseError';
  }
}

// ---------------------------------------------------------------------------
// 输入解码：hex / base64
// ---------------------------------------------------------------------------

export type RvInputFormat = 'auto' | 'hex' | 'base64';

/** 去掉分隔符（空格、冒号、0x 前缀）后是否为合法 hex。 */
export function looksLikeHex(text: string): boolean {
  const clean = text.replace(/[\s:]/g, '').replace(/^0x/i, '');
  return clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean);
}

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.replace(/[\s:]/g, '').replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/** 不依赖 btoa/Buffer 的 base64 编码，渲染层与 Node 测试通用。 */
export function bytesToBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const a = b[i]!;
    const c1 = i + 1 < b.length ? b[i + 1]! : 0;
    const c2 = i + 2 < b.length ? b[i + 2]! : 0;
    out += B64_CHARS[a >> 2]!;
    out += B64_CHARS[((a & 3) << 4) | (c1 >> 4)]!;
    out += i + 1 < b.length ? B64_CHARS[((c1 & 15) << 2) | (c2 >> 6)]! : '=';
    out += i + 2 < b.length ? B64_CHARS[c2 & 63]! : '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s/g, '');
  if (clean.length === 0 || clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    return null;
  }
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 按指定格式把输入文本转成字节；auto 时优先按 hex 判定。 */
export function parseInput(text: string, format: RvInputFormat = 'auto'): Uint8Array {
  const t = text.trim();
  if (!t) throw new ReverseError('输入为空');
  if (format === 'hex' || (format === 'auto' && looksLikeHex(t))) {
    const bytes = hexToBytes(t);
    if (!bytes) throw new ReverseError('无效的 hex 输入（需要偶数个十六进制字符）');
    return bytes;
  }
  const bytes = base64ToBytes(t);
  if (!bytes) throw new ReverseError('无效的 base64 输入');
  return bytes;
}

// ---------------------------------------------------------------------------
// UTF-8 工具
// ---------------------------------------------------------------------------

const RV_UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const RV_UTF8 = new TextDecoder('utf-8');

/** 严格 UTF-8 解码；空字节或非法序列返回 null。 */
export function tryUtf8(b: Uint8Array): string | null {
  if (b.length === 0) return null;
  try {
    const s = RV_UTF8_FATAL.decode(b);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** 宽松 UTF-8 解码（无效字节替换为 U+FFFD），用于 JCE 字符串。 */
export function decodeUtf8Loose(b: Uint8Array): string {
  return RV_UTF8.decode(b);
}

// ---------------------------------------------------------------------------
// protobuf 解码
// ---------------------------------------------------------------------------

/** 递归解码 protobuf 顶层消息，返回 {tag: value} 字段列表。失败抛 WireError。 */
export function decodeProtobuf(buf: Uint8Array): RvNode[] {
  const nodes: RvNode[] = [];
  for (const wf of iterFields(buf)) {
    let value: RvValue;
    switch (wf.wireType) {
      case 0:
        value = { k: 'int', raw: readVarint(wf.payload, 0).value, bits: 0, signed: false };
        break;
      case 1:
        value = { k: 'fixed', bytes: wf.payload.slice(), bits: 64 };
        break;
      case 2:
        value = { k: 'bytes', bytes: wf.payload.slice() };
        break;
      case 5:
        value = { k: 'fixed', bytes: wf.payload.slice(), bits: 32 };
        break;
      default:
        throw new WireError(`wire type ${wf.wireType} not supported`);
    }
    nodes.push({ tag: wf.tag, value });
  }
  return nodes;
}

/** 尝试按 protobuf 完整解析（全部字节被消费、无错误），失败返回 null。 */
export function tryDecodeProtobuf(buf: Uint8Array): RvNode[] | null {
  if (buf.length === 0) return null;
  try {
    const nodes = decodeProtobuf(buf);
    return nodes.length > 0 ? nodes : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JCE 解码（对齐 QQHook TarsParser）
// ---------------------------------------------------------------------------

export const JCE_T = {
  BYTE: 0,
  SHORT: 1,
  INT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  STRING1: 6,
  STRING4: 7,
  MAP: 8,
  LIST: 9,
  STRUCT_BEGIN: 10,
  STRUCT_END: 11,
  ZERO_TAG: 12,
  SIMPLE_LIST: 13,
} as const;

interface JceHead {
  tag: number;
  type: number;
  headSize: number;
}

/** 单容器元素的最小字节数（防御性上限用）。 */
const MAX_CONTAINER_SIZE = 1_000_000;

class JceReader {
  private readonly buf: Uint8Array;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  private get remaining(): number {
    return this.buf.length - this.pos;
  }

  private readHead(): JceHead {
    if (this.pos >= this.buf.length) throw new ReverseError('JCE: 头字节截断');
    const b = this.buf[this.pos]!;
    const type = b & 0x0f;
    let tag = (b >> 4) & 0x0f;
    let headSize = 1;
    if (tag === 15) {
      if (this.pos + 1 >= this.buf.length) throw new ReverseError('JCE: 扩展 tag 截断');
      tag = this.buf[this.pos + 1]!;
      headSize = 2;
    }
    this.pos += headSize;
    return { tag, type, headSize };
  }

  private readU8(): number {
    if (this.pos >= this.buf.length) throw new ReverseError('JCE: 数据截断');
    return this.buf[this.pos++]!;
  }

  private readU16(): number {
    if (this.pos + 2 > this.buf.length) throw new ReverseError('JCE: 数据截断');
    const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!;
    this.pos += 2;
    return v;
  }

  private readU32(): number {
    if (this.pos + 4 > this.buf.length) throw new ReverseError('JCE: 数据截断');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    const v = dv.getUint32(0, false);
    this.pos += 4;
    return v;
  }

  private readU64(): bigint {
    if (this.pos + 8 > this.buf.length) throw new ReverseError('JCE: 数据截断');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    const v = dv.getBigUint64(0, false);
    this.pos += 8;
    return v;
  }

  private readF32(): number {
    if (this.pos + 4 > this.buf.length) throw new ReverseError('JCE: 数据截断');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    const v = dv.getFloat32(0, false);
    this.pos += 4;
    return v;
  }

  private readF64(): number {
    if (this.pos + 8 > this.buf.length) throw new ReverseError('JCE: 数据截断');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    const v = dv.getFloat64(0, false);
    this.pos += 8;
    return v;
  }

  private readBytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new ReverseError(`JCE: 数据截断（需要 ${n} 字节）`);
    }
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /**
   * 容器 size：按 QQHook 的 read(0, 0, true) 读取（带头字段，tag=0）。
   * 只有该读法非法时，才回退到老版 JCE 的无头紧凑长度。
   */
  private readSize(): number {
    const saved = this.pos;
    try {
      const head = this.readHead();
      if (head.tag !== 0) throw new ReverseError('JCE: size 字段 tag 非 0');
      switch (head.type) {
        case JCE_T.ZERO_TAG:
          return 0;
        case JCE_T.BYTE:
          return this.readU8();
        case JCE_T.SHORT:
          return this.readU16();
        case JCE_T.INT: {
          const v = this.readU32();
          if (v > 0x7fffffff) throw new ReverseError('JCE: size 超出 int 范围');
          return v;
        }
        default:
          throw new ReverseError(`JCE: 非法 size 类型 ${head.type}`);
      }
    } catch {
      this.pos = saved;
      return this.readSizeCompact();
    }
  }

  /** 老版 JCE 无头紧凑长度：(b & 0x80) == 0 → b，否则 ((b & 0x7f) << 8) | next。 */
  private readSizeCompact(): number {
    if (this.pos >= this.buf.length) throw new ReverseError('JCE: size 截断');
    const b = this.buf[this.pos++]!;
    if ((b & 0x80) === 0) return b;
    if (this.pos >= this.buf.length) throw new ReverseError('JCE: size 截断');
    return ((b & 0x7f) << 8) | this.buf[this.pos++]!;
  }

  private guardSize(size: number, minBytesPer: number): void {
    if (size < 0 || size > MAX_CONTAINER_SIZE || size * minBytesPer > this.remaining + 2) {
      throw new ReverseError(`JCE: 容器 size ${size} 不合理`);
    }
  }

  /** 顶层：读到 STRUCT_END 或缓冲区结束。 */
  readTopLevel(): RvNode[] {
    const nodes: RvNode[] = [];
    while (this.pos < this.buf.length) {
      const head = this.readHead();
      if (head.type === JCE_T.STRUCT_END) break;
      nodes.push({ tag: head.tag, value: this.readValue(head.type) });
    }
    return nodes;
  }

  private readValue(type: number): RvValue {
    switch (type) {
      case JCE_T.BYTE:
        return { k: 'int', raw: BigInt(this.readU8()), bits: 8, signed: true };
      case JCE_T.SHORT:
        return { k: 'int', raw: BigInt(this.readU16()), bits: 16, signed: true };
      case JCE_T.INT:
        return { k: 'int', raw: BigInt(this.readU32()), bits: 32, signed: true };
      case JCE_T.LONG:
        return { k: 'int', raw: this.readU64(), bits: 64, signed: true };
      case JCE_T.FLOAT:
        return { k: 'float', n: this.readF32() };
      case JCE_T.DOUBLE:
        return { k: 'float', n: this.readF64() };
      case JCE_T.STRING1: {
        const len = this.readU8();
        const bytes = this.readBytes(len);
        return { k: 'str', text: decodeUtf8Loose(bytes), bytes };
      }
      case JCE_T.STRING4: {
        const len = this.readU32();
        if (len > 0x7fffffff) throw new ReverseError('JCE: 字符串过长');
        const bytes = this.readBytes(len);
        return { k: 'str', text: decodeUtf8Loose(bytes), bytes };
      }
      case JCE_T.MAP:
        return this.readMap();
      case JCE_T.LIST:
        return this.readList();
      case JCE_T.STRUCT_BEGIN:
        return { k: 'obj', fields: this.readStruct() };
      case JCE_T.STRUCT_END:
        throw new ReverseError('JCE: 意外的 STRUCT_END');
      case JCE_T.ZERO_TAG:
        return { k: 'int', raw: 0n, bits: 0, signed: false };
      case JCE_T.SIMPLE_LIST:
        return this.readSimpleList();
      default:
        throw new ReverseError(`JCE: 未知类型 ${type}`);
    }
  }

  private readStruct(): RvNode[] {
    const fields: RvNode[] = [];
    while (this.pos < this.buf.length) {
      const head = this.readHead();
      if (head.type === JCE_T.STRUCT_END) break;
      fields.push({ tag: head.tag, value: this.readValue(head.type) });
    }
    return fields;
  }

  private readList(): RvValue {
    const size = this.readSize();
    this.guardSize(size, 1);
    const items: RvNode[] = [];
    for (let i = 0; i < size; i++) {
      const head = this.readHead();
      items.push({ tag: head.tag, value: this.readValue(head.type) });
    }
    return { k: 'list', items };
  }

  private readMap(): RvValue {
    const size = this.readSize();
    this.guardSize(size, 2);
    const entries: RvMapEntry[] = [];
    for (let i = 0; i < size; i++) {
      const kh = this.readHead();
      const key = this.readValue(kh.type);
      const vh = this.readHead();
      entries.push({ key, value: { tag: vh.tag, value: this.readValue(vh.type) } });
    }
    return { k: 'map', entries };
  }

  private readSimpleList(): RvValue {
    const head = this.readHead();
    if (head.type !== JCE_T.BYTE) {
      throw new ReverseError('JCE: SIMPLE_LIST 元素类型必须是 BYTE');
    }
    const size = this.readSize();
    this.guardSize(size, 1);
    return { k: 'bytes', bytes: this.readBytes(size) };
  }
}

/** 解码 JCE 顶层消息。失败抛 ReverseError。 */
export function decodeJce(buf: Uint8Array): RvNode[] {
  return new JceReader(buf).readTopLevel();
}

/** 尝试按 JCE 完整解析，失败返回 null。 */
export function tryDecodeJce(buf: Uint8Array): RvNode[] | null {
  if (buf.length === 0) return null;
  try {
    const nodes = decodeJce(buf);
    return nodes.length > 0 ? nodes : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 展示辅助：数值、分组、JSON 序列化
// ---------------------------------------------------------------------------

/** 定宽无符号值 → 有符号（Java 语义）。 */
export function twoComplement(raw: bigint, bits: number): bigint {
  const mask = (1n << BigInt(bits)) - 1n;
  const sign = 1n << BigInt(bits - 1);
  const m = raw & mask;
  return m >= sign ? m - (1n << BigInt(bits)) : m;
}

/** int 节点默认展示值：JCE 定宽按有符号，protobuf varint 按无符号。 */
export function rvIntDisplay(v: { raw: bigint; bits: number; signed: boolean }): bigint {
  return v.signed && v.bits > 0 ? twoComplement(v.raw, v.bits) : v.raw;
}

/** bigint 超出 JS 安全整数时用字符串表示，避免精度丢失。 */
function bigintToJson(n: bigint): RvJson {
  return n >= -9007199254740991n && n <= 9007199254740991n ? Number(n) : n.toString();
}

/** 按 tag 分组；同 tag 多次出现 → 数组（protobuf repeated / JCE 重复字段）。 */
export function groupRvNodes(nodes: RvNode[]): { tag: number; values: RvValue[] }[] {
  const map = new Map<number, RvValue[]>();
  for (const n of nodes) {
    let arr = map.get(n.tag);
    if (!arr) {
      arr = [];
      map.set(n.tag, arr);
    }
    arr.push(n.value);
  }
  return [...map.entries()].map(([tag, values]) => ({ tag, values }));
}

/** 转成简洁 {tag: value} JSON；bytes 默认 hex 字符串，重复 tag 合并为数组。 */
export function rvNodesToJson(nodes: RvNode[]): { [k: string]: RvJson } {
  const out: { [k: string]: RvJson } = {};
  for (const g of groupRvNodes(nodes)) {
    out[String(g.tag)] =
      g.values.length === 1 ? rvValueToJson(g.values[0]!) : g.values.map(rvValueToJson);
  }
  return out;
}

export function rvValueToJson(v: RvValue): RvJson {
  switch (v.k) {
    case 'int':
      return bigintToJson(rvIntDisplay(v));
    case 'float':
      return Number.isFinite(v.n) ? v.n : String(v.n);
    case 'fixed': {
      if (v.bytes.length === 8) {
        const dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, 8);
        return bigintToJson(dv.getBigUint64(0, true));
      }
      const dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, 4);
      return dv.getUint32(0, true);
    }
    case 'str':
      return v.text;
    case 'bytes':
      // 默认显示：合法可打印 UTF-8 当作文本，否则 hex（转换按钮切换）
      return tryUtf8(v.bytes) ?? bytesToHex(v.bytes);
    case 'obj':
      return rvNodesToJson(v.fields);
    case 'list':
      return v.items.map((it) => rvValueToJson(it.value));
    case 'map': {
      const out: { [k: string]: RvJson } = {};
      for (const e of v.entries) out[rvKeyToJson(e.key)] = rvValueToJson(e.value.value);
      return out;
    }
  }
}

function rvKeyToJson(key: RvValue): string {
  switch (key.k) {
    case 'int':
      return rvIntDisplay(key).toString();
    case 'str':
      return key.text;
    case 'float':
      return String(key.n);
    case 'bytes':
      return `hex:${bytesToHex(key.bytes)}`;
    default:
      return '…';
  }
}

/** 供 UI 判断一个值是否可转 bool（0/1）。 */
export function rvCanBool(v: RvValue): v is Extract<RvValue, { k: 'int' }> {
  return v.k === 'int' && (v.raw === 0n || v.raw === 1n);
}

const SEC_2000 = 946684800n;
const SEC_2100 = 4102444800n;
const MS_2000 = SEC_2000 * 1000n;
const MS_2100 = SEC_2100 * 1000n;

/** 数值是否落在常见时间戳区间（秒或毫秒）。 */
export function rvTimestampRange(raw: bigint): { unit: 'sec' | 'ms'; value: number } | null {
  if (raw >= MS_2000 && raw < MS_2100) return { unit: 'ms', value: Number(raw) };
  if (raw >= SEC_2000 && raw < SEC_2100) return { unit: 'sec', value: Number(raw) * 1000 };
  return null;
}

/** zigzag 解码（仅 varint 语义下有意义）。 */
export function rvZigzag(v: RvValue): bigint | null {
  return v.k === 'int' ? zigzagDecode(v.raw) : null;
}
