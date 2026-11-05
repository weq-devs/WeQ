import { decode, encode, message } from '../../protobuf';
import { walkProto } from '../../msg/dump';
import { sendPacket, type TrpcNative } from '../../transport';
import { requireUin, responseObject } from '../write-validation';

export const FRIEND_CLUE_COMMAND = 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xeb1_1';
const request = message([
  { name: 'type', tag: 2, type: 'uint32', force: true },
  { name: 'data', tag: 3, type: 'string' },
]);
const response = message([
  { name: 'type', tag: 2, type: 'uint32' },
  { name: 'ret', tag: 3, type: 'uint32' },
  { name: 'data', tag: 4, type: 'bytes' },
]);

export interface FriendClue {
  targetUin: string;
  /** Unix 秒；界面统一称为添加时间。 */
  addedAt: number | null;
  direction: 'incoming' | 'outgoing' | null;
  rawDirection: number | null;
  source: string | null;
  sourceGroupCode: string | null;
  canOpenSourceGroup: boolean | null;
  verificationMessage: string | null;
}

function integer(value: unknown, name: string, maximum: number): number | null {
  if (value === undefined || value === null) return null;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > maximum)
    throw new Error(`好友线索${name}无效`);
  return number;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 65536) throw new Error('好友线索文本无效');
  return value;
}

export async function getFriendClue(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
): Promise<FriendClue> {
  const target = requireUin(targetUin);
  if (target > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('好友 QQ 号超出支持范围');
  const bytes = await sendPacket(
    nt,
    pid,
    FRIEND_CLUE_COMMAND,
    encode(request, { type: 0, data: JSON.stringify({ uint64_friend_uin: Number(target) }) }),
    false,
  );
  if (!bytes.length || bytes.length > 262144) throw new Error('好友线索响应长度无效');
  // 共用严格的原始 wire 遍历，先拒绝截断、错类型及重复单值，再按 schema 解码。
  const fields = walkProto(bytes).filter((field) => !field.path.includes('.'));
  for (const tag of [1, 2, 3, 4, 5]) {
    const matches = fields.filter((field) => field.tag === tag);
    if (
      matches.length > 1 ||
      matches.some((field) => field.wire !== (tag >= 4 ? 2 : 0)) ||
      (tag <= 3 && matches.some((field) => BigInt(field.value) > 0xffffffffn))
    )
      throw new Error('好友线索响应结构无效');
  }
  const body = decode(response, bytes);
  if ((body.type ?? 0) !== 0 || (body.ret ?? 0) !== 0) throw new Error('好友线索服务暂不可用');
  if (!(body.data instanceof Uint8Array)) throw new Error('好友线索响应缺少数据');
  const data = responseObject(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.data)),
    '好友线索',
  );
  if (data.ErrorCode !== 0) throw new Error('好友线索查询失败');
  if (data.uint64_friend_uin !== undefined && String(data.uint64_friend_uin) !== targetUin)
    throw new Error('好友线索返回目标不匹配');
  const addedAt = integer(data.uint64_add_frd_time, '添加时间', 8640000000000);
  const rawDirection = integer(data.uint32_add_frd_type, '添加方向', 0xffffffff);
  const group = data.uint64_group_id;
  let sourceGroupCode: string | null = null;
  if (group !== undefined && group !== null && group !== 0 && group !== '0') {
    if (typeof group !== 'string' && (typeof group !== 'number' || !Number.isSafeInteger(group)))
      throw new Error('好友线索来源群号无效');
    sourceGroupCode = requireUin(String(group)).toString();
  }
  const canOpenSourceGroup = data.bool_group_jump;
  if (canOpenSourceGroup !== undefined && typeof canOpenSourceGroup !== 'boolean')
    throw new Error('好友线索来源群状态无效');
  return {
    targetUin,
    addedAt: addedAt || null,
    direction: rawDirection === 1 ? 'incoming' : rawDirection === 2 ? 'outgoing' : null,
    rawDirection,
    source: text(data.str_add_frd_source_wording),
    sourceGroupCode,
    canOpenSourceGroup: canOpenSourceGroup ?? null,
    verificationMessage: text(data.str_add_frd_message),
  };
}
