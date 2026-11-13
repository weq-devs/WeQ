import { decode, encode, message } from '../../protobuf';
import { sendPacket, type TrpcNative } from '../../transport';
import { responseObject } from '../write-validation';
import type { ProfilePage } from './extras';

export interface HistoricalAvatar {
  id: string;
  thumbnailUrl: string;
  url: string;
  faceFlag: number | null;
  fileSize: number | null;
  firstUsedAt: number | null;
  lastUsedAt: number | null;
}
export const SELF_AVATAR_HISTORY_COMMAND = 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0x5f1_6';
const request = message([
  { name: 'type', tag: 2, type: 'uint32', force: true },
  { name: 'data', tag: 3, type: 'string' },
]);
const response = message([
  { name: 'type', tag: 2, type: 'uint32' },
  { name: 'ret', tag: 3, type: 'uint32' },
  { name: 'data', tag: 4, type: 'string' },
]);
function uint(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error('历史头像数字字段无效');
  return value;
}
export function historicalAvatarUrl(base: string, flag: number | null, thumbnail = false): string {
  const sizes = thumbnail
    ? [
        [4, '100'],
        [8, '140'],
        [16, '640'],
        [2, '40'],
        [32, '0'],
      ]
    : [
        [32, '0'],
        [16, '640'],
        [8, '140'],
        [4, '100'],
        [2, '40'],
      ];
  const size = sizes.find(([bit]) => ((flag ?? 0) & Number(bit)) !== 0)?.[1] ?? '40';
  const url = new URL(base + size);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !/^q\d*\.qlogo\.cn$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('历史头像图片地址无效');
  url.protocol = 'https:';
  return url.href;
}

/** 历史列表隐含当前登录账号，不在 wire 上添加目标 UIN。 */
export async function getSelfAvatarHistory(
  nt: TrpcNative,
  pid: number,
  before?: number,
): Promise<Omit<ProfilePage<HistoricalAvatar, number>, 'targetUin'>> {
  if (before !== undefined && (uint(before) === null || before === 0))
    throw new Error('历史头像游标无效');
  const timestamp = before ?? Math.floor(Date.now() / 1000);
  const reply = await sendPacket(
    nt,
    pid,
    SELF_AVATAR_HISTORY_COMMAND,
    encode(request, {
      type: 0,
      data: JSON.stringify({
        uint32_timestamp: timestamp,
        uint32_num: before === undefined ? 24 : 30,
      }),
    }),
  );
  if (!reply.length || reply.length > 1024 * 1024) throw new Error('历史头像响应长度无效');
  const outer = decode(response, reply);
  if (outer.type !== 0 || outer.ret !== 0 || typeof outer.data !== 'string')
    throw new Error('历史头像服务暂不可用');
  const data = responseObject(JSON.parse(outer.data), '历史头像');
  if (data.ErrorCode !== 0) throw new Error('历史头像读取失败');
  if (data.uint32_is_end !== 0 && data.uint32_is_end !== 1)
    throw new Error('历史头像响应缺少结束标记');
  if (!Array.isArray(data.rpt_msg_his_heads)) throw new Error('历史头像响应缺少列表');
  const items = data.rpt_msg_his_heads.map((value): HistoricalAvatar => {
    const row = responseObject(value, '历史头像');
    if (
      typeof row.str_fileid !== 'string' ||
      !row.str_fileid ||
      row.str_fileid.length > 512 ||
      typeof row.str_headurl !== 'string' ||
      row.str_headurl.length > 8192
    )
      throw new Error('历史头像条目标识或图片地址无效');
    const flag = uint(row.uint32_face_flag);
    return {
      id: row.str_fileid,
      thumbnailUrl: historicalAvatarUrl(row.str_headurl, flag, true),
      url: historicalAvatarUrl(row.str_headurl, flag),
      faceFlag: flag,
      fileSize: uint(row.uint32_file_size),
      firstUsedAt: uint(row.uint32_upload_time) || null,
      lastUsedAt: uint(row.uint32_update_time) || null,
    };
  });
  const next = uint(data.uint32_last_timestamp);
  const more = data.uint32_is_end === 0 && next !== 0;
  const broken = more && (next === null || next >= timestamp);
  return {
    items: [...new Map(items.map((item) => [item.id, item])).values()],
    nextCursor: more && !broken ? next : null,
    hasMore: more && !broken,
    paginationError: broken ? '服务器未提供有效的下一页游标' : null,
  };
}
