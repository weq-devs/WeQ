/**
 * 原始 protobuf 遍历工具 —— 不依赖 schema，把一段字节按 wire-format 逐字段
 * 展开成 `tag:value`，保证连未知字段/装扮等数据也不会丢。
 *
 * 用途：
 *   - {@link dumpProto} 递归打印全部字段（varint 十进制、可读 UTF-8 字符串、
 *     bytes 十六进制、嵌套 message 递归展开）。
 *   - {@link extractPath} 按 [tag, index] 路径从响应字节里抠出指定字段的
 *     原始字节（比如第一条消息 body），供 hex 打印 / 二次解析。
 */

import { bytesToHex } from '../oidb/shared';

// ---------- 底层 reader ----------

class RawReader {
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
      if (this.pos >= this.data.length) throw new Error('varint 越界');
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
    if (this.pos + len > this.data.length) throw new Error('len-delimited 越界');
    const out = this.data.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.data.length) throw new Error('定长字段越界');
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** 判断 len-delimited 内容是否更像可读 UTF-8 文本。 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (s.length === 0) return false;
    let printable = 0;
    for (const ch of s) {
      const code = ch.codePointAt(0)!;
      // 允许空白、常见标点、中日韩等；控制字符（除 \t\n\r）算不可打印。
      if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) printable += 1;
    }
    return printable / s.length >= 0.9;
  } catch {
    return false;
  }
}

/** 尝试把字节解析成完整合法的 protobuf message，失败返回 null。 */
function tryParseMessage(bytes: Uint8Array): RawReader | null {
  try {
    const r = new RawReader(bytes);
    while (!r.eof) {
      const { wire } = r.tag();
      switch (wire) {
        case 0:
          r.varint();
          break;
        case 1:
          r.take(8);
          break;
        case 2:
          r.lenDelim();
          break;
        case 5:
          r.take(4);
          break;
        default:
          return null;
      }
    }
    return r;
  } catch {
    return null;
  }
}

function quoteText(bytes: Uint8Array): string {
  const s = new TextDecoder().decode(bytes);
  // 转义控制字符，避免输出被终端吃掉。
  return JSON.stringify(s);
}

// ---------- 遍历输出 ----------

export interface DumpOptions {
  /** 嵌套 message 也附上整段 hex（默认只在叶子 bytes 上打印 hex）。 */
  hexNested?: boolean;
}

export interface DumpEntry {
  path: string;
  tag: number;
  wire: number;
  kind: 'varint' | 'fixed64' | 'fixed32' | 'string' | 'bytes' | 'message';
  value: string;
  hex?: string;
  len: number;
}

/**
 * 递归遍历 protobuf 字节，返回全部字段条目（含嵌套展开）。
 * path 形如 `1.3.6[0].2`（字段号层级，重复字段带 [index]）。
 */
export function walkProto(bytes: Uint8Array, opts: DumpOptions = {}): DumpEntry[] {
  const out: DumpEntry[] = [];
  const counts = new Map<string, number>();

  const bump = (path: string): number => {
    const n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    return n;
  };

  const walk = (data: Uint8Array, parent: string): void => {
    const r = new RawReader(data);
    while (!r.eof) {
      const { field, wire } = r.tag();
      const base = parent ? `${parent}.${field}` : `${field}`;
      const idx = bump(base);
      const path = idx > 1 ? `${base}[${idx - 1}]` : base;

      switch (wire) {
        case 0: {
          const v = r.varint();
          out.push({ path, tag: field, wire, kind: 'varint', value: v.toString(), len: 0 });
          break;
        }
        case 1: {
          const b = r.take(8);
          out.push({
            path,
            tag: field,
            wire,
            kind: 'fixed64',
            value: bytesToHex(b),
            hex: bytesToHex(b),
            len: 8,
          });
          break;
        }
        case 2: {
          const b = r.lenDelim();
          if (looksLikeText(b)) {
            out.push({
              path,
              tag: field,
              wire,
              kind: 'string',
              value: quoteText(b),
              len: b.length,
            });
            break;
          }
          const nested = tryParseMessage(b);
          if (nested && b.length >= 2) {
            out.push({
              path,
              tag: field,
              wire,
              kind: 'message',
              value: '',
              len: b.length,
              hex: opts.hexNested ? bytesToHex(b) : undefined,
            });
            walk(b, path);
            break;
          }
          out.push({
            path,
            tag: field,
            wire,
            kind: 'bytes',
            value: bytesToHex(b),
            hex: bytesToHex(b),
            len: b.length,
          });
          break;
        }
        case 5: {
          const b = r.take(4);
          out.push({
            path,
            tag: field,
            wire,
            kind: 'fixed32',
            value: bytesToHex(b),
            hex: bytesToHex(b),
            len: 4,
          });
          break;
        }
        default:
          throw new Error(`protobuf: 未知 wire type ${wire} @${path}`);
      }
    }
  };

  walk(bytes, '');
  return out;
}

function formatEntry(e: DumpEntry): string {
  const head = `tag=${e.tag} wire=${e.wire} len=${e.len}`;
  switch (e.kind) {
    case 'varint':
      return `${head} varint=${e.value} (0x${BigInt(e.value).toString(16)})`;
    case 'string':
      return `${head} string=${e.value}`;
    case 'bytes':
      return `${head} bytes=${e.value}`;
    case 'fixed64':
    case 'fixed32':
      return `${head} ${e.kind}=${e.value}`;
    case 'message':
      return e.hex
        ? `${head} message${e.hex.length > 120 ? ` hex=${e.hex.slice(0, 120)}…(+${e.hex.length - 120})` : ` hex=${e.hex}`}`
        : `${head} message`;
  }
}

/** 把整段字节递归展开成多行 `path | tag | wire | value` 文本。 */
export function dumpProto(bytes: Uint8Array, opts: DumpOptions = {}): string {
  const lines = walkProto(bytes, opts).map((e) => {
    const indent = '  '.repeat(Math.max(0, e.path.split('.').length - 1));
    return `${indent}${e.path}  ${formatEntry(e)}`;
  });
  return lines.join('\n');
}

// ---------- JSON 树输出 ----------
//
// 叶子直接是裸值，不标类型：
//   varint  -> number（超出 2^53-1 时保留为字符串，避免丢精度）
//   UTF-8   -> string
//   bytes   -> hex 字符串
// 嵌套 message 直接是普通对象（key=字段号，重复字段为数组）。

export type ProtoJsonLeaf = number | string;

export type ProtoJsonNode = ProtoJsonLeaf | ProtoJsonMap;

/** 字段号字符串 -> 节点；同一字段重复出现时收敛为数组（按出现顺序）。 */
export type ProtoJsonMap = { [key: string]: ProtoJsonNode | ProtoJsonNode[] };

/**
 * 把一段 protobuf 字节转成嵌套 JSON 树，key 是字段号（重复字段为数组）。
 */
export function protoToJson(bytes: Uint8Array): ProtoJsonMap {
  const out: ProtoJsonMap = {};

  const push = (target: ProtoJsonMap, key: string, node: ProtoJsonNode): void => {
    const existing = target[key];
    if (existing === undefined) {
      target[key] = node;
    } else if (Array.isArray(existing)) {
      existing.push(node);
    } else {
      target[key] = [existing, node];
    }
  };

  const walk = (data: Uint8Array, target: ProtoJsonMap): void => {
    const r = new RawReader(data);
    while (!r.eof) {
      const { field, wire } = r.tag();
      const key = String(field);
      switch (wire) {
        case 0: {
          const v = r.varint();
          const n = Number(v);
          push(target, key, Number.isSafeInteger(n) ? n : v.toString());
          break;
        }
        case 1: {
          const b = r.take(8);
          push(target, key, bytesToHex(b));
          break;
        }
        case 2: {
          const b = r.lenDelim();
          if (looksLikeText(b)) {
            push(target, key, new TextDecoder().decode(b));
            break;
          }
          const nested = tryParseMessage(b);
          if (nested && b.length >= 2) {
            const children: ProtoJsonMap = {};
            walk(b, children);
            push(target, key, children);
            break;
          }
          push(target, key, bytesToHex(b));
          break;
        }
        case 5: {
          const b = r.take(4);
          push(target, key, bytesToHex(b));
          break;
        }
        default:
          throw new Error(`protobuf: 未知 wire type ${wire}`);
      }
    }
  };

  walk(bytes, out);
  return out;
}

// ---------- 按路径提取原始字节 ----------

export interface PathStep {
  /** protobuf 字段号。 */
  tag: number;
  /** 重复字段取第几个（0 起）。默认取第一个。 */
  index?: number;
}

/**
 * 沿 [tag, index] 路径提取嵌套 len-delimited 字段的原始字节。
 * 例：group 响应第一条消息 = extractPath(resp, [{tag:3}, {tag:6, index:0}])
 *     c2c   响应第一条消息 = extractPath(resp, [{tag:7, index:0}])
 * 找不到返回 null。
 */
export function extractPath(bytes: Uint8Array, steps: PathStep[]): Uint8Array | null {
  let data = bytes;
  for (const step of steps) {
    const r = new RawReader(data);
    let hits = 0;
    let found: Uint8Array | null = null;
    while (!r.eof) {
      const { field, wire } = r.tag();
      if (wire !== 2) {
        // 非 len-delimited 直接跳过，保持游标正确。
        switch (wire) {
          case 0:
            r.varint();
            break;
          case 1:
            r.take(8);
            break;
          case 5:
            r.take(4);
            break;
          default:
            return null;
        }
        continue;
      }
      const b = r.lenDelim();
      if (field === step.tag) {
        if (hits === (step.index ?? 0)) {
          found = b;
          break;
        }
        hits += 1;
      }
    }
    if (!found) return null;
    data = found;
  }
  return data;
}
