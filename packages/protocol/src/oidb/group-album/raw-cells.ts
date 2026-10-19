// 从整段 protobuf 响应里按字段路径切出**原始子消息字节**。
//
// 群相册评论必须把 `GetQunFeedDetail` 响应里的 `cellCommon` / `cellUserInfo` /
// `cellMedia` 子报文原样塞进 `DoQunComment`——重新按本仓库 schema 编码会丢掉
// QZone 依赖、但 WeQ 尚未建模的字段（字段顺序/省略规则也不保证一致）。
//
// 搬运自 SnowLuma `core/src/bridge/apis/group-album.ts` 的
// `protobufSubmessage` / `firstLengthDelimitedField`。

function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = offset;
  while (next < buf.length && shift <= 28) {
    const byte = buf[next++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next };
    shift += 7;
  }
  throw new Error('protobuf varint 不完整');
}

function skipVarint(buf: Uint8Array, offset: number): number {
  for (let index = 0; index < 10 && offset < buf.length; index++) {
    const byte = buf[offset++]!;
    if (index === 9 && byte > 1) throw new Error('protobuf varint 超过 64 位');
    if ((byte & 0x80) === 0) return offset;
  }
  throw new Error('protobuf varint 不完整');
}

/** 取第一个 tag 为 `fieldNo` 的 length-delimited 字段内容（不含 tag/长度头）。 */
function firstLengthDelimitedField(buf: Uint8Array, fieldNo: number): Uint8Array | undefined {
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;

    if (wire === 0) {
      offset = skipVarint(buf, offset);
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.next;
      const end = offset + len.value;
      if (end > buf.length) return undefined;
      if (field === fieldNo) return buf.slice(offset, end);
      offset = end;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** 沿 `path` 逐层取 length-delimited 子消息内容。 */
export function protobufSubmessage(
  buf: Uint8Array,
  path: readonly number[],
): Uint8Array | undefined {
  let current: Uint8Array | undefined = buf;
  for (const fieldNo of path) {
    if (!current) return undefined;
    current = firstLengthDelimitedField(current, fieldNo);
  }
  return current;
}

/** 空字节按「缺失」处理（服务端会用空串表示没有这一段）。 */
export function nonemptyBytes(value: Uint8Array | undefined): Uint8Array | undefined {
  return value && value.byteLength > 0 ? value : undefined;
}
