import { decode, encode, message } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';

let sequence = 0n;

const entry = message([
  { name: 'key', tag: 1, type: 'string' },
  { name: 'value', tag: 2, type: 'string' },
]);
const extId = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'numeric', tag: 2, type: 'int64' },
  { name: 'str', tag: 3, type: 'string' },
  { name: 'unsignedNumeric', tag: 4, type: 'uint64' },
]);
const unionId = message([
  { name: 'ufKey', tag: 1, type: 'string' },
  { name: 'extIds', tag: 4, type: extId, repeated: true },
]);
const businessRequest = message([{ name: 'unionId', tag: 2, type: unionId }]);
const media = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'video', tag: 3, type: message([{ name: 'id', tag: 1, type: 'string' }]) },
  { name: 'isLivePhoto', tag: 18, type: 'bool' },
]);
const feed = message([
  {
    name: 'comm',
    tag: 1,
    type: message([{ name: 'unionId', tag: 15, type: unionId }]),
  },
  {
    name: 'media',
    tag: 5,
    type: message([{ name: 'items', tag: 1, type: media, repeated: true }]),
  },
]);
const businessResponse = message([
  { name: 'body', tag: 2, type: message([{ name: 'feed', tag: 1, type: feed }]) },
]);

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface QzoneMediaType {
  videoId: string;
  /** 缺失保持未知，不能按时长、type 或 Web 数组位置补造。 */
  isLivePhoto?: boolean;
}

/** Android QQ 9.3.85 V4 详情；已用 macOS QQ 会话实测。 */
export namespace GetQzoneFeedMediaDetail {
  export const cmd = 'QzoneV4Service.trpc.qzone.feeds_reader.FeedsReader.GetFeedDetail';
  export const reqSchema = message([
    { name: 'seq', tag: 1, type: 'uint64' },
    { name: 'body', tag: 4, type: 'bytes' },
    { name: 'traceId', tag: 5, type: 'string' },
    { name: 'ext', tag: 10, type: entry, repeated: true },
  ]);
  export const respSchema = message([
    { name: 'retCode', tag: 2, type: 'uint64' },
    { name: 'body', tag: 4, type: 'bytes' },
  ]);
  export interface Params {
    ownerUin: string;
    tid: string;
    time: number;
  }
  export function serialize(params: Params): Record<string, unknown> {
    if (
      !/^[1-9]\d{4,19}$/.test(params.ownerUin) ||
      BigInt(params.ownerUin) > 0xffffffffffffffffn ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(params.tid) ||
      params.tid === '0' ||
      !Number.isSafeInteger(params.time) ||
      params.time <= 0
    )
      throw new Error('空间媒体定位信息不完整。');
    const now = Date.now();
    return {
      seq: ++sequence,
      traceId: `${params.ownerUin}_${now}`,
      ext: [{ key: 'fc-appid', value: '101' }],
      body: encode(businessRequest, {
        unionId: {
          ufKey: `${params.ownerUin}_${Math.floor(now / 1000)}`,
          extIds: [
            { type: 8, unsignedNumeric: BigInt(params.ownerUin) },
            { type: 4, numeric: 311n },
            { type: 9, numeric: BigInt(params.time) },
            { type: 5, str: params.tid },
          ],
        },
      }),
    };
  }
  export function parse(bytes: Uint8Array, params: Params): QzoneMediaType[] {
    if (!bytes.length || bytes.length > 4 * 1024 * 1024)
      throw new Error('空间媒体详情响应大小无效。');
    const envelope = decode(respSchema, bytes, { strict: true });
    // StQWebRsp.retCode 是 protobuf 零默认值；同时要求业务体及真实对象身份。
    if ((envelope.retCode ?? 0n) !== 0n || !(envelope.body instanceof Uint8Array))
      throw new Error('暂时无法读取空间媒体类型。');
    const body = decode(businessResponse, envelope.body, { strict: true });
    const detail = object(object(body.body).feed);
    const ids = array(object(object(detail.comm).unionId).extIds).map(object);
    const owners = ids.filter((id) => id.type === 8);
    const posts = ids.filter((id) => id.type === 5);
    const appIds = ids.filter((id) => id.type === 4);
    if (
      appIds.length !== 1 ||
      appIds[0]!.numeric !== 311n ||
      owners.length !== 1 ||
      String(owners[0]!.unsignedNumeric) !== params.ownerUin ||
      posts.length !== 1 ||
      posts[0]!.str !== params.tid
    )
      throw new Error('空间媒体详情与当前说说不匹配。');
    const items = array(object(detail.media).items);
    if (items.length > 256) throw new Error('空间媒体详情条目过多。');
    const values = new Map<string, boolean | undefined>();
    for (const raw of items) {
      const item = object(raw);
      const id = object(item.video).id;
      if (typeof id !== 'string' || !id || id.length > 1024) continue;
      const flag = typeof item.isLivePhoto === 'boolean' ? item.isLivePhoto : undefined;
      values.set(id, values.has(id) && values.get(id) !== flag ? undefined : flag);
    }
    return [...values].map(([videoId, isLivePhoto]) => ({ videoId, isLivePhoto }));
  }
  export async function invoke(
    nt: TrpcNative,
    pid: number,
    params: Params,
  ): Promise<QzoneMediaType[]> {
    return parse(await sendPacket(nt, pid, cmd, encode(reqSchema, serialize(params))), params);
  }
}
