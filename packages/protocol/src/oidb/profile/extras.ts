import { decode, encode, message } from '../../protobuf';
import { sendPacket, type TrpcNative } from '../../transport';
import { invokeLegacyOidb } from '../legacy';
import { requireUin, responseObject } from '../write-validation';

export interface ProfilePage<T, C = string> {
  targetUin: string;
  items: T[];
  nextCursor: C | null;
  hasMore: boolean;
  paginationError: string | null;
}
export interface HistoricalSignature {
  id: string;
  text: string;
  action: string | null;
  data: string | null;
  location: string | null;
  createdAt: number;
}
export interface ProfileEnergy {
  targetUin: string;
  score: number | null;
  level: number | null;
  trend: number | null;
  display: number | null;
}
export interface PersonalityPhoto {
  id: string;
  url: string;
  uploadedAt: number | null;
  likes: string | null;
}
export interface PersonalityLabel {
  id: string;
  text: string;
  cover: string | null;
  photoCount: number | null;
  photos: PersonalityPhoto[];
  photoCursor: string | null;
}
export interface AnonymousQuestion {
  id: string;
  question: string;
  answer: string | null;
  askedAt: number | null;
  answeredAt: number | null;
  likes: string | null;
  comments: string | null;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const numberField = (name: string, tag: number) => ({ name, tag, type: 'uint32' as const });
const bytesField = (name: string, tag: number) => ({ name, tag, type: 'bytes' as const });
const u64 = (name: string, tag: number) => ({ name, tag, type: 'uint64' as const });
function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('个人资料数字字段无效');
  return parsed;
}
function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 65536) throw new Error('个人资料文本无效');
  return value;
}
function decimal(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('个人资料整数精度不足');
  const text = String(value);
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > 0xffffffffffffffffn)
    throw new Error('个人资料整数无效');
  return text;
}
function timestamp(value: unknown): number | null {
  const parsed = optionalNumber(value);
  if (parsed !== null && parsed > 8640000000000) throw new Error('个人资料时间超出范围');
  return parsed === 0 ? null : parsed;
}
function signedNumber(value: unknown): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < -0x80000000 ||
    value > 0x7fffffff
  )
    throw new Error('个人资料有符号字段无效');
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('个人资料列表无效');
  return value.map((row) => responseObject(row, '个人资料'));
}
function id(value: unknown): string {
  const parsed = typeof value === 'bigint' ? decimal(value) : optionalText(value);
  if (!parsed || parsed.length > 512) throw new Error('个人资料条目标识缺失');
  return parsed;
}
function unique<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
function target(value: string) {
  requireUin(value);
  return value;
}
export function decodeProfileCursor(cursor: string): Uint8Array {
  if (
    !cursor ||
    cursor.length > 32768 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cursor)
  )
    throw new Error('标签照片游标无效');
  const bytes = Buffer.from(cursor, 'base64');
  if (bytes.toString('base64') !== cursor) throw new Error('标签照片游标无效');
  return bytes;
}
function cursor(value: unknown): string | null {
  if (!(value instanceof Uint8Array) || !value.length) return null;
  return Buffer.from(value).toString('base64');
}
function page<T, C>(
  targetUin: string,
  items: T[],
  hasMore: boolean,
  next: C | null,
  previous?: C,
): ProfilePage<T, C> {
  const broken = hasMore && (next === null || next === previous);
  return {
    targetUin,
    items,
    nextCursor: broken ? null : next,
    hasMore: hasMore && !broken,
    paginationError: broken ? '服务器未提供有效的下一页游标' : null,
  };
}

/** RichStatus 的 type/length 都是无符号单字节；非文本属性不能当成正文。 */
export function parseRichStatus(bytes: Uint8Array) {
  let action: string | null = null;
  let data: string | null = null;
  let location: string | null = null;
  const text: string[] = [];
  for (let at = 0; at < bytes.length; ) {
    if (at + 2 > bytes.length) throw new Error('签名属性头被截断');
    const type = bytes[at++]!;
    const length = bytes[at++]!;
    if (at + length > bytes.length) throw new Error('签名属性被截断');
    const payload = bytes.subarray(at, at + length);
    at += length;
    if (type <= 0 || type >= 128) continue;
    const value = textDecoder.decode(payload);
    if (type === 1) action = value;
    else if (type === 2) data = value;
    else if (type === 4) location = value;
    else text.push(value);
  }
  return { text: text.join(''), action, data, location };
}
const signatureRequest = message([
  u64('uin', 1),
  numberField('friendType', 2),
  { ...numberField('startTime', 4), force: true },
  numberField('endTime', 5),
  { ...numberField('type', 6), force: true },
  { ...numberField('start', 7), force: true },
  numberField('limit', 8),
  numberField('comments', 10),
]);
const signatureResponse = message([
  {
    name: 'items',
    tag: 1,
    repeated: true,
    type: message([bytesField('id', 1), bytesField('status', 2), numberField('createdAt', 4)]),
  },
  numberField('over', 2),
]);
export async function getSignatureHistory(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
  before?: number,
): Promise<ProfilePage<HistoricalSignature, number>> {
  target(targetUin);
  if (before !== undefined && (!Number.isInteger(before) || before < 0 || before > 0x7fffffff))
    throw new Error('签名时间游标无效');
  const body = await invokeLegacyOidb(
    nt,
    pid,
    0xde8,
    1,
    'OidbSvc.0xde8_1',
    encode(signatureRequest, {
      uin: targetUin,
      friendType: 2,
      startTime: 0,
      endTime: before ?? 0x7fffffff,
      type: 0,
      start: 0,
      limit: 6,
      comments: 60,
    }),
  );
  const response = decode(signatureResponse, body);
  if (response.over === undefined) throw new Error('签名响应缺少结束标记');
  const items = unique(
    rows(response.items).map((row): HistoricalSignature => {
      if (!(row.id instanceof Uint8Array) || !row.id.length || !(row.status instanceof Uint8Array))
        throw new Error('历史签名缺少内容或标识');
      const createdAt = optionalNumber(row.createdAt);
      if (createdAt === null || (before !== undefined && createdAt > before))
        throw new Error('签名时间无效');
      return { id: Buffer.from(row.id).toString('hex'), createdAt, ...parseRichStatus(row.status) };
    }),
  );
  const earliest = items.length ? Math.min(...items.map((item) => item.createdAt)) : null;
  return page(
    targetUin,
    items,
    response.over === 0,
    earliest !== null && earliest > 0 ? earliest - 1 : null,
    before,
  );
}

const energyRequest = message([{ name: 'uin', tag: 1, type: 'int64' }]);
const energyResponse = message([
  {
    name: 'value',
    tag: 1,
    type: message([
      { name: 'score', tag: 1, type: 'int32' },
      { name: 'level', tag: 2, type: 'int32' },
      { name: 'trend', tag: 3, type: 'int32' },
      { name: 'display', tag: 6, type: 'int32' },
      { name: 'uin', tag: 8, type: 'int64' },
    ]),
  },
]);
export async function getProfileEnergy(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
): Promise<ProfileEnergy> {
  target(targetUin);
  const reply = await sendPacket(
    nt,
    pid,
    'qqvalue.GetQQValue',
    encode(energyRequest, { uin: targetUin }),
  );
  const response = decode(energyResponse, reply);
  const value = responseObject(response.value, 'QQ 能量值');
  if (String(value.uin) !== targetUin) throw new Error('QQ 能量值返回目标不匹配');
  return {
    targetUin,
    score: optionalNumber(value.score),
    level: optionalNumber(value.level),
    trend: signedNumber(value.trend),
    display: optionalNumber(value.display),
  };
}

const photo = message([
  u64('id', 1),
  { name: 'url', tag: 2, type: 'string' },
  numberField('uploadedAt', 3),
  u64('likes', 4),
]);
const label = message([
  u64('id', 2),
  { name: 'text', tag: 4, type: 'string' },
  { name: 'cover', tag: 7, type: 'string' },
  numberField('photoCount', 9),
  { name: 'photos', tag: 10, type: photo, repeated: true },
  bytesField('cookie', 11),
]);
function photoItems(value: unknown): PersonalityPhoto[] {
  return unique(
    rows(value).map((row) => ({
      id: id(row.id),
      url: optionalText(row.url) ?? '',
      uploadedAt: optionalNumber(row.uploadedAt),
      likes: decimal(row.likes),
    })),
  );
}
function labelItem(row: Record<string, unknown>): PersonalityLabel {
  return {
    id: id(row.id),
    text: optionalText(row.text) ?? '',
    cover: optionalText(row.cover),
    photoCount: optionalNumber(row.photoCount),
    photos: photoItems(row.photos),
    photoCursor: cursor(row.cookie),
  };
}
const labelsRequest = message([u64('uin', 1), numberField('digest', 2)]);
const labelsResponse = message([
  { name: 'labels', tag: 1, type: label, repeated: true },
  numberField('totalPhotos', 4),
  numberField('closed', 8),
]);
export async function getPersonalityLabels(nt: TrpcNative, pid: number, targetUin: string) {
  target(targetUin);
  const response = decode(
    labelsResponse,
    await invokeLegacyOidb(
      nt,
      pid,
      0x8f0,
      0,
      'OidbSvc.0x8f0',
      encode(labelsRequest, { uin: targetUin, digest: 1 }),
    ),
  );
  return {
    targetUin,
    labels: unique(rows(response.labels).map(labelItem)),
    totalPhotos: optionalNumber(response.totalPhotos),
    closed: response.closed === undefined ? null : response.closed !== 0,
  };
}
const photosRequest = message([
  numberField('limit', 1),
  bytesField('cookie', 2),
  u64('uin', 3),
  u64('labelId', 4),
]);
const photosResponse = message([
  { name: 'label', tag: 1, type: label },
  numberField('complete', 2),
  bytesField('cookie', 3),
]);
export async function getPersonalityPhotos(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
  labelId: string,
  after?: string,
): Promise<ProfilePage<PersonalityPhoto>> {
  target(targetUin);
  requireUin(labelId);
  const response = decode(
    photosResponse,
    await invokeLegacyOidb(
      nt,
      pid,
      0x8f1,
      0,
      'OidbSvc.0x8f1',
      encode(photosRequest, {
        uin: targetUin,
        labelId,
        limit: 20,
        cookie: after ? decodeProfileCursor(after) : undefined,
      }),
    ),
  );
  if (response.complete === undefined) throw new Error('标签相册响应缺少结束标记');
  const value = response.label === undefined ? null : responseObject(response.label, '标签相册');
  if (value?.id !== undefined && String(value.id) !== labelId)
    throw new Error('标签相册返回目标不匹配');
  return page(
    targetUin,
    photoItems(value?.photos),
    response.complete === 0,
    cursor(response.cookie),
    after,
  );
}

export const ANONYMOUS_QUESTIONS_COMMAND = 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xec4_1';
const webRequest = message([
  { name: 'type', tag: 2, type: 'uint32', force: true },
  { name: 'data', tag: 3, type: 'string' },
]);
const webResponse = message([numberField('type', 2), numberField('ret', 3), bytesField('data', 4)]);
export async function getAnonymousQuestions(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
  filter: 'all' | 'answered',
  after?: string,
): Promise<ProfilePage<AnonymousQuestion>> {
  const uin = requireUin(targetUin);
  if (uin > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('问答目标超出支持范围');
  if (after !== undefined && after.length > 32768) throw new Error('问答游标过长');
  const reply = await sendPacket(
    nt,
    pid,
    ANONYMOUS_QUESTIONS_COMMAND,
    encode(webRequest, {
      type: 0,
      data: JSON.stringify({
        uint64_uin: Number(uin),
        uint64_quest_num: 10,
        uint64_comment_num: 10,
        bytes_cookie: after ?? '',
        uint32_fetch_type: filter === 'all' ? 0 : 1,
      }),
    }),
  );
  if (!reply.length || reply.length > 1024 * 1024) throw new Error('问答响应长度无效');
  const outer = decode(webResponse, reply);
  if ((outer.type ?? 0) !== 0 || (outer.ret ?? 0) !== 0) throw new Error('问答服务暂不可用');
  if (!(outer.data instanceof Uint8Array)) throw new Error('问答响应缺少数据');
  const value = responseObject(JSON.parse(textDecoder.decode(outer.data)), '匿问我答');
  if (value.ErrorCode !== 0 || (value.uint32_ret !== undefined && value.uint32_ret !== 0))
    throw new Error('问答读取失败');
  if (typeof value.bool_is_fetch_over !== 'boolean') throw new Error('问答响应缺少结束标记');
  const items = unique(
    rows(value.msg_quest).map(
      (row): AnonymousQuestion => ({
        id: id(row.str_id),
        question: optionalText(row.str_quest) ?? '',
        answer: optionalText(row.str_ans),
        askedAt: timestamp(row.uint64_time),
        answeredAt: timestamp(row.uint64_ans_time),
        likes: decimal(row.uint64_praise_num),
        comments: decimal(row.uint64_comment_num),
      }),
    ),
  );
  return page(
    targetUin,
    items,
    !value.bool_is_fetch_over,
    optionalText(value.bytes_cookie) || null,
    after,
  );
}
