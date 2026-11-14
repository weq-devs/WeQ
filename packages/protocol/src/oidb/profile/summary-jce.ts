/** SummaryCard 的 JCE UniPacket 适配；复用已归档原型，不恢复好友扩展备注业务。 */
export type JceValue = number | bigint | string | Buffer | JceValue[] | Map<JceValue, JceValue>;

export function jceField(tag: number, value: JceValue): Buffer {
  let type: number;
  let body: Buffer;
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = BigInt(value);
    if (n < -0x8000000000000000n || n > 0x7fffffffffffffffn) throw new Error('资料卡整数超限');
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
    if (type === 3) body.writeBigInt64BE(n);
    else if (type !== 12) body.writeIntBE(Number(n), 0, body.length);
  } else if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    type = bytes.length <= 255 ? 6 : 7;
    const length = Buffer.alloc(type === 6 ? 1 : 4);
    length.writeUIntBE(bytes.length, 0, length.length);
    body = Buffer.concat([length, bytes]);
  } else if (Buffer.isBuffer(value)) {
    type = 13;
    body = Buffer.concat([Buffer.of(0), jceField(0, value.length), value]);
  } else if (Array.isArray(value)) {
    type = 9;
    body = Buffer.concat([jceField(0, value.length), ...value.map((item) => jceField(0, item))]);
  } else {
    type = 8;
    body = Buffer.concat([
      jceField(0, value.size),
      ...[...value].flatMap(([key, item]) => [jceField(0, key), jceField(1, item)]),
    ]);
  }
  return Buffer.concat([Buffer.from(tag < 15 ? [(tag << 4) | type] : [0xf0 | type, tag]), body]);
}
export function jceFields(values: Record<number, JceValue>): Buffer {
  return Buffer.concat(Object.entries(values).map(([tag, value]) => jceField(Number(tag), value)));
}
export function jceStruct(values: Record<number, JceValue>): Buffer {
  return Buffer.concat([Buffer.of(10), jceFields(values), Buffer.of(11)]);
}

class Reader {
  private offset = 0;
  private count = 0;
  constructor(private readonly bytes: Buffer) {}
  private take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length)
      throw new Error('资料卡 JCE 截断');
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  private head() {
    if (++this.count > 50000) throw new Error('资料卡 JCE 字段过多');
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
      size > 65536
    )
      throw new Error('资料卡 JCE 长度无效');
    return size;
  }
  private value(type: number, depth: number): JceValue {
    if (depth > 24) throw new Error('资料卡 JCE 嵌套过深');
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
      const head = this.head();
      if (head.type !== 0 || head.tag !== 0) throw new Error('资料卡 JCE 字节类型无效');
      return this.take(this.length(depth + 1));
    }
    if (type === 9)
      return Array.from({ length: this.length(depth + 1) }, () => {
        const head = this.head();
        if (head.tag !== 0) throw new Error('资料卡 JCE 列表无效');
        return this.value(head.type, depth + 1);
      });
    if (type === 8) {
      const size = this.length(depth + 1);
      const result = new Map<JceValue, JceValue>();
      for (let i = 0; i < size; i++) {
        const keyHead = this.head(),
          key = this.value(keyHead.type, depth + 1);
        const valueHead = this.head();
        if (keyHead.tag !== 0 || valueHead.tag !== 1 || result.has(key))
          throw new Error('资料卡 JCE 字典无效');
        result.set(key, this.value(valueHead.type, depth + 1));
      }
      return result;
    }
    if (type === 10) return this.read(depth + 1, true);
    throw new Error('资料卡 JCE 类型无效');
  }
  read(depth = 0, nested = false): Map<JceValue, JceValue> {
    const result = new Map<JceValue, JceValue>();
    while (this.offset < this.bytes.length) {
      const head = this.head();
      if (head.type === 11) {
        if (!nested || head.tag !== 0) throw new Error('资料卡 JCE 结构结束无效');
        return result;
      }
      if (result.has(head.tag)) throw new Error('资料卡 JCE 字段重复');
      result.set(head.tag, this.value(head.type, depth));
    }
    if (nested) throw new Error('资料卡 JCE 结构未结束');
    return result;
  }
}
export function readJce(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 1048576) throw new Error('资料卡 JCE 响应为空或超限');
  return new Reader(Buffer.from(bytes)).read();
}
