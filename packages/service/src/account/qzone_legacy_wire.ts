import { inflateSync } from 'node:zlib';
import { raw } from '@weq/codec';

type Scalar = string | number | bigint | Uint8Array;
export type JceValue = Scalar | JceValue[] | JceStruct | Map<string | number, JceValue>;
export interface JceStruct {
  fields: Record<number, JceValue>;
}
export const structure = (fields: Record<number, JceValue>): JceStruct => ({ fields });
export const map = (entries: [string | number, JceValue][]) => new Map(entries);
const MAX_BYTES = 4 * 1024 * 1024;

/** 仅编码旧空间所用的 JCE 值；下行继续复用已有严格解码器。 */
export function encodeJce(fields: Record<number, JceValue>): Buffer {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const push = (value: Buffer) => {
    bytes += value.length;
    if (bytes > MAX_BYTES) throw new Error('空间请求过大。');
    chunks.push(value);
  };
  const head = (tag: number, type: number) => {
    if (!Number.isInteger(tag) || tag < 0 || tag > 255) throw new Error('JCE 字段号无效。');
    push(Buffer.from(tag < 15 ? [(tag << 4) | type] : [0xf0 | type, tag]));
  };
  const write = (tag: number, value: JceValue, depth: number) => {
    if (depth > 24) throw new Error('空间请求嵌套过深。');
    if (typeof value === 'number' || typeof value === 'bigint') {
      if (typeof value === 'number' && !Number.isSafeInteger(value))
        throw new Error('JCE 整数无效。');
      const integer = BigInt(value);
      if (integer < -0x8000000000000000n || integer > 0x7fffffffffffffffn)
        throw new Error('JCE 整数超限。');
      if (integer === 0n) return head(tag, 12);
      const size =
        integer >= -128n && integer <= 127n
          ? 1
          : integer >= -32768n && integer <= 32767n
            ? 2
            : integer >= -2147483648n && integer <= 2147483647n
              ? 4
              : 8;
      head(tag, size === 1 ? 0 : size === 2 ? 1 : size === 4 ? 2 : 3);
      const data = Buffer.alloc(size);
      if (size === 8) data.writeBigInt64BE(integer);
      else data.writeIntBE(Number(integer), 0, size);
      return push(data);
    }
    if (typeof value === 'string') {
      const data = Buffer.from(value);
      head(tag, data.length < 256 ? 6 : 7);
      const length = Buffer.alloc(data.length < 256 ? 1 : 4);
      if (length.length === 1) length.writeUInt8(data.length);
      else length.writeUInt32BE(data.length);
      push(length);
      push(data);
      return;
    }
    if (value instanceof Uint8Array) {
      head(tag, 13);
      head(0, 0);
      write(0, value.length, depth + 1);
      push(Buffer.from(value));
      return;
    }
    if (Array.isArray(value)) {
      head(tag, 9);
      write(0, value.length, depth + 1);
      for (const item of value) write(0, item, depth + 1);
      return;
    }
    if (value instanceof Map) {
      head(tag, 8);
      write(0, value.size, depth + 1);
      for (const [key, item] of value) {
        write(0, key, depth + 1);
        write(1, item, depth + 1);
      }
      return;
    }
    head(tag, 10);
    for (const [key, item] of Object.entries(value.fields)) write(Number(key), item, depth + 1);
    head(0, 11);
  };
  for (const [key, value] of Object.entries(fields)) write(Number(key), value, 0);
  return Buffer.concat(chunks);
}

export type JceRead = string | bigint | Uint8Array | JceRead[] | Map<string, JceRead>;
function value(node: raw.RvValue): JceRead {
  switch (node.k) {
    case 'int':
      return raw.rvIntDisplay(node);
    case 'str':
      return node.text;
    case 'bytes':
      return node.bytes;
    case 'obj':
      return nodes(node.fields);
    case 'list':
      return node.items.map((item) => value(item.value));
    case 'map':
      return new Map(
        node.entries.map((entry) => {
          const key = value(entry.key);
          if (typeof key !== 'string' && typeof key !== 'bigint')
            throw new Error('空间响应包含无效键。');
          return [String(key), value(entry.value.value)];
        }),
      );
    default:
      throw new Error('空间响应包含不支持的 JCE 类型。');
  }
}
function nodes(items: raw.RvNode[]): Map<string, JceRead> {
  const result = new Map<string, JceRead>();
  for (const item of items) {
    const key = String(item.tag);
    if (result.has(key)) throw new Error('空间响应包含重复字段。');
    result.set(key, value(item.value));
  }
  return result;
}
export function decodeJce(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('空间响应大小无效。');
  return nodes(raw.decodeJce(bytes));
}
export const fieldsOf = (item: JceRead | undefined): Map<string, JceRead> =>
  item instanceof Map ? item : new Map();
export const textOf = (item: JceRead | undefined) => (typeof item === 'string' ? item : '');
export function integerOf(item: JceRead | undefined): number | null {
  return typeof item === 'bigint' &&
    item >= BigInt(Number.MIN_SAFE_INTEGER) &&
    item <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(item)
    : null;
}
function typed(item: JceRead | undefined): Uint8Array | null {
  if (item instanceof Uint8Array) return item;
  const entries = fieldsOf(item);
  if (entries.size !== 1) return null;
  const bytes = entries.values().next().value;
  return bytes instanceof Uint8Array ? bytes : null;
}
function attribute(data: Map<string, JceRead>, key: string): JceRead | undefined {
  const bytes = typed(data.get(key));
  return bytes ? decodeJce(bytes).get('0') : undefined;
}

export function qzoneLegacyRequest(
  selfUin: string,
  key: string,
  className: string,
  body: Record<number, JceValue>,
  seq: number,
) {
  if (!/^[1-9]\d{4,19}$/.test(selfUin)) throw new Error('空间账号无效。');
  const attrs = encodeJce({
    0: map([
      ['hostuin', map([['int64', encodeJce({ 0: BigInt(selfUin) })]])],
      [key, map([[className, encodeJce({ 0: structure(body) })]])],
    ]),
  });
  const control = encodeJce({
    0: map([
      [
        'busiCompCtl',
        map([
          [
            'QMF_PROTOCAL.QmfBusiControl',
            encodeJce({ 0: structure({ 0: 0, 1: attrs.length, 2: 1 }) }),
          ],
        ]),
      ],
    ]),
  });
  const bytes = encodeJce({
    0: seq,
    1: 1000027,
    2: BigInt(selfUin),
    3: 'V1_AND_SQ_9.3.85_16920_YYB_D',
    4: `QzoneNewService.${key}`,
    5: '',
    6: structure({ 0: 64, 1: new Uint8Array(), 2: map([[1, new Uint8Array([0])]]) }),
    7: structure({ 0: 0, 1: 0, 2: 0, 3: new Uint8Array(6) }),
    8: attrs,
    9: control,
    10: 0,
    11: 0,
  });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length + 4);
  return Buffer.concat([prefix, bytes]);
}

export function qzoneLegacyResponse(input: Uint8Array, key: string): Map<string, JceRead> {
  let bytes = Buffer.from(input);
  if (bytes.length >= 4 && bytes.readUInt32BE() === bytes.length) bytes = bytes.subarray(4);
  const envelope = decodeJce(bytes);
  const direct = fieldsOf(envelope.get('0'));
  if (direct.has('ret')) {
    const code = integerOf(attribute(direct, 'ret'));
    throw new Error(
      `空间服务返回 ${code ?? '未知状态'}：${textOf(attribute(direct, 'msg')) || '请求未确认'}`,
    );
  }
  const wns = integerOf(envelope.get('2')),
    business = integerOf(envelope.get('3'));
  if (wns !== 0 || business !== 0)
    throw new Error(`空间服务未接受请求（WNS ${wns ?? '?'}，业务 ${business ?? '?'}）。`);
  let body = envelope.get('5');
  const extra = envelope.get('6');
  if (extra instanceof Uint8Array && extra.length) {
    const controls = fieldsOf(decodeJce(extra).get('0'));
    if (integerOf(fieldsOf(attribute(controls, 'busiCompCtl')).get('0')) === 1) {
      if (!(body instanceof Uint8Array)) throw new Error('空间响应缺少压缩内容。');
      body = inflateSync(body, { maxOutputLength: MAX_BYTES });
    }
  }
  if (!(body instanceof Uint8Array)) throw new Error('空间响应缺少业务内容。');
  const attrs = fieldsOf(decodeJce(body).get('0'));
  const ret = integerOf(attribute(attrs, 'ret'));
  if (ret !== null && ret !== 0)
    throw new Error(`空间业务失败（${ret}）：${textOf(attribute(attrs, 'msg'))}`);
  const result = attribute(attrs, key);
  if (!(result instanceof Map)) throw new Error('空间响应缺少目标业务结果。');
  return result;
}
