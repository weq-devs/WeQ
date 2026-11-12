import { sendPacket, type TrpcNative } from '../../transport';
import { requireUin } from '../write-validation';

type Value = number | bigint | string | Buffer | Value[] | Map<Value, Value>;

export class FriendSummaryCardError extends Error {
  constructor(readonly result: number | null) {
    super(`我的好友备注资料读取失败（${result ?? '未知'}）`);
    this.name = 'FriendSummaryCardError';
  }
}

// SummaryCard 仍使用 JCE UniPacket；只在本模块适配，不混入 protobuf 传输。
function field(tag: number, value: Value): Buffer {
  let type: number;
  let body: Buffer;
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = BigInt(value);
    type =
      n === 0n
        ? 12
        : n >= -128n && n <= 127n
          ? 0
          : n >= -32768n && n <= 32767n
            ? 1
            : n >= -2147483648n && n <= 2147483647n
              ? 2
              : 3;
    body = Buffer.alloc(type === 12 ? 0 : 2 ** type);
    if (type !== 12) {
      if (type === 3) body.writeBigInt64BE(n);
      else body.writeIntBE(Number(n), 0, body.length);
    }
  } else if (typeof value === 'string') {
    const text = Buffer.from(value);
    type = text.length <= 255 ? 6 : 7;
    const length = Buffer.alloc(type === 6 ? 1 : 4);
    length.writeUIntBE(text.length, 0, length.length);
    body = Buffer.concat([length, text]);
  } else if (Buffer.isBuffer(value)) {
    type = 13;
    body = Buffer.concat([Buffer.from([0]), field(0, value.length), value]);
  } else if (Array.isArray(value)) {
    type = 9;
    body = Buffer.concat([field(0, value.length), ...value.map((item) => field(0, item))]);
  } else {
    type = 8;
    body = Buffer.concat([
      field(0, value.size),
      ...[...value].flatMap(([key, item]) => [field(0, key), field(1, item)]),
    ]);
  }
  return Buffer.concat([Buffer.from(tag < 15 ? [(tag << 4) | type] : [0xf0 | type, tag]), body]);
}

function fields(values: Record<number, Value>): Buffer {
  return Buffer.concat(Object.entries(values).map(([tag, value]) => field(Number(tag), value)));
}

function struct(values: Record<number, Value>): Buffer {
  return Buffer.concat([Buffer.from([10]), fields(values), Buffer.from([11])]);
}

class Reader {
  private offset = 0;
  private count = 0;
  constructor(private readonly bytes: Buffer) {}
  private take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length)
      throw new Error('好友备注资料响应截断');
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  private head() {
    if (++this.count > 50000) throw new Error('好友备注资料响应字段过多');
    const head = this.take(1)[0]!;
    return { type: head & 15, tag: head >> 4 === 15 ? this.take(1)[0]! : head >> 4 };
  }
  private length(depth: number) {
    const head = this.head();
    const size = this.value(head.type, depth);
    if (
      head.tag !== 0 ||
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > 1048576
    )
      throw new Error('好友备注资料响应长度无效');
    return size;
  }
  private value(type: number, depth: number): Value {
    if (depth > 24) throw new Error('好友备注资料响应嵌套过深');
    if (type === 12) return 0;
    if (type <= 2) return this.take(2 ** type).readIntBE(0, 2 ** type);
    if (type === 3) return this.take(8).readBigInt64BE();
    if (type === 4) return this.take(4).readFloatBE();
    if (type === 5) return this.take(8).readDoubleBE();
    if (type === 6 || type === 7) {
      const length = this.take(type === 6 ? 1 : 4).readUIntBE(0, type === 6 ? 1 : 4);
      return new TextDecoder('utf-8', { fatal: true }).decode(this.take(length));
    }
    if (type === 13) {
      const element = this.head();
      if (element.type !== 0 || element.tag !== 0) throw new Error('好友备注资料字节类型无效');
      return this.take(this.length(depth + 1));
    }
    if (type === 9) {
      const length = this.length(depth + 1);
      return Array.from({ length }, () => {
        const head = this.head();
        if (head.tag !== 0) throw new Error('好友备注资料列表无效');
        return this.value(head.type, depth + 1);
      });
    }
    if (type === 8) {
      const length = this.length(depth + 1);
      const map = new Map<Value, Value>();
      for (let i = 0; i < length; i++) {
        const keyHead = this.head();
        const key = this.value(keyHead.type, depth + 1);
        const valueHead = this.head();
        if (keyHead.tag !== 0 || valueHead.tag !== 1 || map.has(key))
          throw new Error('好友备注资料字典无效');
        map.set(key, this.value(valueHead.type, depth + 1));
      }
      return map;
    }
    if (type === 10) return this.read(depth + 1, true);
    throw new Error('好友备注资料 JCE 类型无效');
  }
  read(depth = 0, nested = false): Map<Value, Value> {
    const result = new Map<Value, Value>();
    while (this.offset < this.bytes.length) {
      const head = this.head();
      if (head.type === 11) {
        if (!nested || head.tag !== 0) throw new Error('好友备注资料结构结束无效');
        return result;
      }
      if (result.has(head.tag)) throw new Error('好友备注资料响应字段重复');
      result.set(head.tag, this.value(head.type, depth));
    }
    if (nested) throw new Error('好友备注资料结构未结束');
    return result;
  }
}

export function encodeFriendSummaryCard(targetUin: string): Uint8Array {
  const target = requireUin(targetUin);
  const request = struct({
    0: target,
    1: 1,
    2: 0,
    3: 1,
    4: 0,
    5: 0,
    6: Buffer.from([0]),
    7: '',
    8: 0x12e3d,
    9: 10004,
    10: Buffer.from([0]),
    14: [],
    15: 0,
    16: 0,
    18: 0,
    19: [],
    20: 1,
    21: 0,
    22: 0,
    24: 1,
    25: 0,
  });
  return fields({
    1: 3,
    2: 0,
    3: 0,
    4: 1,
    5: 'SummaryCardServantObj',
    6: 'ReqSummaryCard',
    7: fields({
      0: new Map<Value, Value>([
        ['ReqHead', struct({ 0: 2 })],
        ['ReqSummaryCard', request],
      ]),
    }),
    8: 0,
    9: new Map(),
    10: new Map(),
  });
}

export function decodeFriendSummaryCard(bytes: Uint8Array, targetUin: string): Uint8Array | null {
  if (!bytes.length || bytes.length > 1048576) throw new Error('好友备注资料响应为空或超限');
  const outer = new Reader(Buffer.from(bytes)).read();
  const version = outer.get(1);
  const payload = outer.get(7);
  if ((version !== 2 && version !== 3) || !Buffer.isBuffer(payload))
    throw new Error('好友备注资料响应封装无效');
  const map = new Reader(payload).read().get(0);
  if (!(map instanceof Map)) throw new Error('好友备注资料响应字典缺失');
  const read = (key: string) => {
    let value = map.get(key);
    if (version === 2 && value instanceof Map && value.size === 1) value = [...value.values()][0];
    if (!Buffer.isBuffer(value)) throw new Error('好友备注资料响应结构缺失');
    const decoded = new Reader(value).read();
    const row = decoded.get(0);
    if (decoded.size !== 1 || !(row instanceof Map)) throw new Error('好友备注资料响应结构无效');
    return row;
  };
  const head = read('RespHead');
  const result = head.get(1);
  if (result !== 0) throw new FriendSummaryCardError(typeof result === 'number' ? result : null);
  const row = read('RespSummaryCard');
  if (String(row.get(23)) !== targetUin) throw new Error('好友备注资料返回目标不匹配');
  const card = row.get(62);
  if (!Buffer.isBuffer(card)) throw new Error('好友备注资料内容缺失或类型无效，请刷新后再试');
  return card.length ? card : null;
}

export async function readFriendSummaryCard(nt: TrpcNative, pid: number, targetUin: string) {
  return decodeFriendSummaryCard(
    await sendPacket(nt, pid, 'SummaryCard.ReqSummaryCard', encodeFriendSummaryCard(targetUin)),
    targetUin,
  );
}
