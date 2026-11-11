import { decode, encode, message } from '../../protobuf';
import { sendPacket, type TrpcNative } from '../../transport';
import { invokeLegacyOidb } from '../legacy';
import { requireUin, responseObject } from '../write-validation';
import type { ProfilePage } from './extras';

export interface ProfileLikeUser {
  id: string;
  uin: string;
  name: string | null;
  time: number | null;
}
export interface ProfileComment {
  id: string;
  text: string;
  fromUin: string;
  fromName: string | null;
  toUin: string | null;
  toName: string | null;
  replyId: string | null;
  time: number | null;
}
export interface SignatureTarget {
  id: string;
  createdAt: number;
}
const u64 = (name: string, tag: number) => ({ name, tag, type: 'uint64' as const });
const u32 = (name: string, tag: number) => ({ name, tag, type: 'uint32' as const, force: true });
const str = (name: string, tag: number) => ({ name, tag, type: 'string' as const });
const bytes = (name: string, tag: number) => ({ name, tag, type: 'bytes' as const });
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function profileInteger(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('互动数字精度不足');
  const text = String(value);
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > 0xffffffffffffffffn)
    throw new Error('互动数字无效');
  return text;
}
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 65536) throw new Error('互动文本无效');
  return value;
}
function identifier(value: unknown): string {
  const result = text(value);
  if (!result || result.length > 512) throw new Error('互动标识无效');
  return result;
}
function time(value: unknown): number | null {
  const result = profileInteger(value);
  if (result === null || result === '0') return null;
  const number = Number(result);
  if (!Number.isSafeInteger(number) || number > 8640000000000) throw new Error('互动时间无效');
  return number;
}
function rows(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('互动列表无效');
  return value.map((row) => responseObject(row, '互动'));
}
function nonzero(value: unknown) {
  const result = profileInteger(value);
  return result === '0' ? null : result;
}
function user(row: Record<string, unknown>, json = false): ProfileLikeUser {
  const uin = profileInteger(json ? row.uint64_from_uin : row.uin);
  if (!uin || uin === '0') throw new Error('点赞人缺失');
  return {
    id: uin,
    uin,
    name: text(json ? row.str_from_nick : row.name),
    time: time(json ? row.uint64_time : row.time),
  };
}
export const signatureCommentSchema = message([
  u64('id', 1),
  str('text', 2),
  u64('replyId', 3),
  u64('toUin', 4),
  u64('fromUin', 5),
  u64('time', 6),
]);
export const signatureLikeSchema = message([u64('uin', 1), u64('time', 2)]);
export const labelLikeSchema = message([u64('uin', 1), str('name', 2)]);
export function parseProfileLikes(value: unknown, json = false): ProfileLikeUser[] {
  return [
    ...new Map(
      rows(value).map((row) => {
        const item = user(row, json);
        return [item.id, item] as const;
      }),
    ).values(),
  ];
}
export function parseProfileComments(value: unknown, json = false): ProfileComment[] {
  return [
    ...new Map(
      rows(value).map((row) => {
        const fromUin = profileInteger(json ? row.uint64_from_uin : row.fromUin);
        if (!fromUin || fromUin === '0') throw new Error('评论人缺失');
        const item: ProfileComment = {
          id: json ? identifier(row.str_id) : (profileInteger(row.id) ?? ''),
          text: text(json ? row.str_comment : row.text) ?? '',
          fromUin,
          fromName: json ? text(row.str_from_nick) : null,
          toUin: nonzero(json ? row.uint64_to_uin : row.toUin),
          toName: json ? text(row.str_to_nick) : null,
          replyId: json ? text(row.str_reply_id) || null : nonzero(row.replyId),
          time: time(json ? row.uint64_time : row.time),
        };
        if (!item.id || item.id === '0') throw new Error('评论标识缺失');
        return [item.id, item] as const;
      }),
    ).values(),
  ];
}
export function signatureFeedBytes(id: string): Uint8Array {
  if (!/^(?:[\da-f]{2}){1,512}$/i.test(id)) throw new Error('签名标识无效');
  return Buffer.from(id, 'hex');
}
function signatureParams(uin: string, signature: SignatureTarget) {
  requireUin(uin);
  if (
    !Number.isInteger(signature.createdAt) ||
    signature.createdAt < 0 ||
    signature.createdAt > 0xffffffff
  )
    throw new Error('签名时间无效');
  return { feed: signatureFeedBytes(signature.id), time: signature.createdAt, uin, type: 255 };
}
const likeRequest = message([
  bytes('feed', 1),
  u64('time', 2),
  u64('uin', 3),
  u32('type', 4),
  u32('action', 5),
]);
export async function setSignatureLike(
  nt: TrpcNative,
  pid: number,
  uin: string,
  signature: SignatureTarget,
  liked: boolean,
) {
  const body = await invokeLegacyOidb(
    nt,
    pid,
    0x795,
    0,
    'OidbSvc.0x795_0',
    encode(likeRequest, { ...signatureParams(uin, signature), action: liked ? 1 : 0 }),
    { allowEmptyBody: true },
  );
  if (body.length) {
    const result = decode(message([u32('result', 1)]), body).result;
    if (result !== 0) throw new Error(`签名点赞失败：${String(result ?? '未返回结果')}`);
  }
}
const likePageRequest = message([
  bytes('feed', 1),
  u64('time', 2),
  u64('uin', 3),
  u32('type', 4),
  { name: 'last', tag: 5, type: signatureLikeSchema },
  u32('seq', 6),
]);
const likePageResponse = message([
  u32('result', 1),
  { name: 'users', tag: 3, type: signatureLikeSchema, repeated: true },
  { name: 'last', tag: 4, type: signatureLikeSchema },
  u32('flag', 5),
]);
export async function getSignatureLikes(
  nt: TrpcNative,
  pid: number,
  uin: string,
  signature: SignatureTarget,
  after?: string,
): Promise<ProfilePage<ProfileLikeUser>> {
  let last = { uin: '0', time: '0' };
  if (after) {
    const match = /^(\d{1,20}):(\d{1,20})$/.exec(after);
    if (!match) throw new Error('点赞游标无效');
    last = { uin: profileInteger(match[1])!, time: profileInteger(match[2])! };
  }
  const result = decode(
    likePageResponse,
    await invokeLegacyOidb(
      nt,
      pid,
      0x796,
      0,
      'OidbSvc.0x796_0',
      encode(likePageRequest, { ...signatureParams(uin, signature), last, seq: 0 }),
    ),
  );
  if (result.result !== 0 || result.flag === undefined)
    throw new Error(`签名点赞列表读取失败：${String(result.result ?? '未返回结果')}`);
  const point = result.last === undefined ? null : responseObject(result.last, '点赞游标');
  const next =
    point && profileInteger(point.uin) && profileInteger(point.time)
      ? `${String(point.uin)}:${String(point.time)}`
      : null;
  return interactionPage(uin, parseProfileLikes(result.users), result.flag !== 0, next, after);
}
export async function addSignatureComment(
  nt: TrpcNative,
  pid: number,
  uin: string,
  selfUin: string,
  feedId: string,
  content: string,
  replyId = '0',
) {
  requireUin(uin);
  requireUin(selfUin);
  if (!content.trim() || content.length > 4096) throw new Error('请输入 4096 字以内的评论');
  if (profileInteger(replyId) === null) throw new Error('回复标识无效');
  const schema = message([
    u64('uin', 1),
    str('feed', 2),
    { ...u64('reply', 3), force: true },
    u64('from', 4),
    str('text', 5),
  ]);
  const result = decode(
    message([u64('id', 1)]),
    await invokeLegacyOidb(
      nt,
      pid,
      0xde5,
      1,
      'OidbSvc.0xde5_1',
      encode(schema, {
        uin,
        feed: utf8.decode(signatureFeedBytes(feedId)),
        reply: replyId,
        from: selfUin,
        text: content,
      }),
    ),
  );
  const id = nonzero(result.id);
  if (!id) throw new Error('评论响应未返回标识');
  return id;
}
export async function deleteSignatureComment(
  nt: TrpcNative,
  pid: number,
  uin: string,
  selfUin: string,
  feedId: string,
  commentId: string,
) {
  requireUin(uin);
  requireUin(selfUin);
  requireUin(commentId);
  const schema = message([u64('uin', 1), str('feed', 2), u64('from', 3), u64('comment', 4)]);
  await invokeLegacyOidb(
    nt,
    pid,
    0xde7,
    1,
    'OidbSvc.0xde7_1',
    encode(schema, {
      uin,
      feed: utf8.decode(signatureFeedBytes(feedId)),
      from: selfUin,
      comment: commentId,
    }),
    { allowEmptyBody: true },
  );
}
function interactionPage<T>(
  targetUin: string,
  items: T[],
  hasMore: boolean,
  next: string | null,
  after?: string,
): ProfilePage<T> {
  const broken = hasMore && (!next || next === after);
  return {
    targetUin,
    items,
    hasMore: hasMore && !broken,
    nextCursor: hasMore && !broken ? next : null,
    paginationError: broken ? '服务器未提供下一页游标' : null,
  };
}
const webRequest = message([u32('type', 2), str('data', 3)]);
const webResponse = message([u32('type', 2), u32('ret', 3), bytes('data', 4)]);
async function anonymousRequest(
  nt: TrpcNative,
  pid: number,
  command: string,
  value: Record<string, unknown>,
) {
  const reply = await sendPacket(
    nt,
    pid,
    `MQUpdateSvc_com_qq_ti.web.OidbSvc.${command}`,
    encode(webRequest, { type: 0, data: JSON.stringify(value) }),
  );
  if (!reply.length || reply.length > 1024 * 1024) throw new Error('问答响应长度无效');
  const outer = decode(webResponse, reply);
  if ((outer.type ?? 0) !== 0 || (outer.ret ?? 0) !== 0 || !(outer.data instanceof Uint8Array))
    throw new Error('问答读取失败');
  const result = responseObject(JSON.parse(utf8.decode(outer.data)), '问答');
  if (result.ErrorCode !== 0 || (result.uint32_ret !== undefined && result.uint32_ret !== 0))
    throw new Error(`问答读取失败：${String(result.ErrorCode)}`);
  return result;
}
function anonymousTarget(uin: string, questionId: string) {
  const value = requireUin(uin);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('问答目标超出支持范围');
  return {
    uint64_uin: Number(value),
    str_quest_id: identifier(questionId),
    uint64_comment_num: 30,
  };
}
export async function getAnonymousQuestionDetail(
  nt: TrpcNative,
  pid: number,
  uin: string,
  questionId: string,
  askedAt: number,
) {
  if (!Number.isSafeInteger(askedAt) || askedAt < 0) throw new Error('问题时间无效');
  const result = await anonymousRequest(nt, pid, '0xecf_1', {
    ...anonymousTarget(uin, questionId),
    uint64_quest_time: askedAt,
  });
  const quest = responseObject(result.msg_quest, '问题');
  if (quest.str_id !== questionId || result.int32_comment_fetch_over === undefined)
    throw new Error('问答详情不匹配');
  return {
    ...interactionPage(
      uin,
      parseProfileComments(quest.rpt_comment, true),
      result.int32_comment_fetch_over !== 1,
      text(result.strCommentCookie) || null,
    ),
    questionId,
    question: text(quest.str_quest),
    answer: text(quest.str_ans),
    likes: profileInteger(quest.uint64_praise_num),
    comments: profileInteger(quest.uint64_comment_num),
    likeUsers: parseProfileLikes(quest.rpt_praise, true),
  };
}
export async function getAnonymousComments(
  nt: TrpcNative,
  pid: number,
  uin: string,
  questionId: string,
  after?: string,
): Promise<ProfilePage<ProfileComment>> {
  if (after !== undefined && after.length > 32768) throw new Error('评论游标过长');
  const result = await anonymousRequest(nt, pid, '0xec5_1', {
    ...anonymousTarget(uin, questionId),
    str_cookie: after ?? '',
  });
  if (result.int32_is_fetch_over === undefined) throw new Error('问答评论缺少结束标记');
  return interactionPage(
    uin,
    parseProfileComments(result.rpt_comment, true),
    result.int32_is_fetch_over !== 1,
    text(result.str_cookie) || null,
    after,
  );
}
