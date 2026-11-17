import { decode, encode, message } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { GetQzoneFeedMediaDetail } from './feed-media-detail';

export type QzoneArchiveAction = 'contribute' | 'uncontribute' | 'unarchive';
let sequence = 0n;
/** Android QQ 9.3.85 的 SetFeedStatus；不是直接写 archiveStatus 枚举。 */
export namespace SetQzoneFeedStatus {
  export const cmd = 'QzoneV4Service.trpc.qqappai.qzone_archive.FeedStatusService.SetFeedStatus';
  export const bodySchema = message([
    { name: 'feedId', tag: 1, type: 'string' },
    {
      name: 'statuses',
      tag: 2,
      repeated: true,
      type: message([
        { name: 'kind', tag: 1, type: 'int32' },
        { name: 'value', tag: 2, type: 'uint32' },
      ]),
    },
    { name: 'uin', tag: 3, type: 'string' },
    { name: 'operator', tag: 4, type: 'string' },
  ]);
  const responseSchema = message([
    { name: 'code', tag: 1, type: 'int32' },
    { name: 'message', tag: 2, type: 'string' },
    { name: 'flag', tag: 3, type: 'bool' },
  ]);
  export function serialize(params: {
    feedId: string;
    selfUin: string;
    action: QzoneArchiveAction;
  }) {
    if (
      !params.feedId ||
      params.feedId.length > 1024 ||
      !/^[1-9]\d{4,19}$/.test(params.selfUin) ||
      !['contribute', 'uncontribute', 'unarchive'].includes(params.action)
    )
      throw new Error('空间状态操作的目标无效。');
    return {
      seq: ++sequence,
      traceId: `${params.selfUin}_${Date.now()}`,
      ext: [{ key: 'fc-appid', value: '101' }],
      body: encode(bodySchema, {
        feedId: params.feedId,
        uin: params.selfUin,
        operator: params.selfUin,
        statuses: [
          {
            kind: params.action === 'unarchive' ? 6 : 19,
            value: params.action === 'contribute' ? 1 : 2,
          },
        ],
      }),
    };
  }
  export function parse(bytes: Uint8Array) {
    if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('空间状态操作响应无效。');
    const envelope = decode(GetQzoneFeedMediaDetail.respSchema, bytes, { strict: true });
    if ((envelope.retCode ?? 0n) !== 0n || !(envelope.body instanceof Uint8Array))
      throw new Error('空间状态操作未取得成功回执。');
    const response = decode(responseSchema, envelope.body, { strict: true });
    if ((response.code ?? 0) !== 0)
      throw new Error(
        typeof response.message === 'string' && response.message
          ? response.message
          : `空间状态操作失败（${String(response.code)}）。`,
      );
    return { accepted: true as const };
  }
  export async function invoke(
    nt: TrpcNative,
    pid: number,
    params: Parameters<typeof serialize>[0],
  ) {
    return parse(
      await sendPacket(nt, pid, cmd, encode(GetQzoneFeedMediaDetail.reqSchema, serialize(params))),
    );
  }
}
