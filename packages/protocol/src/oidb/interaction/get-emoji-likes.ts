// OIDB 0x9083_1 —— 群消息上某个表情的「贴表情」详情：**谁**贴了这个表情（可分页）。
//
// 搬运自 SnowLuma `packages/protocol/src/oidb-services/reaction/get-emoji-likes.ts`
// （对齐 Windows QQ 的 `EncodeGetMsgEmojiLikesListReq` / `DecodeGetMsgEmojiLikesListRsp`），
// 与同目录的 `set-reaction.ts`（0x9082_1/2 贴 / 撤）配套：这条负责「看有谁贴了」。
//
// ⚠️ 0x9084_1 是**最近使用表情目录**（GetRecentUseEmojiList），不是某条消息的回应详情，
// 别拿它当查询用 —— SnowLuma 的 `fetch-reaction-summary.ts` 顶部也这么标注。
//
// inner body 字段号（注意与 0x9082 不同：这里 f4 是 emojiType、f5 是 emojiId，写反会被
// 服务端当成空表情 id 查）：
//   f2 groupId   (uint64) 群号
//   f3 sequence  (uint64) 被回应消息的 msgSeq
//   f4 emojiType (uint32) 1 = QQ 小黄脸短 id，2 = Unicode 码点
//   f5 emojiId   (string) 表情 id
//   f6 cookie    (string) 上一页返回的续传 cookie（首页空串是 proto3 默认值，不上 wire）
//   f8 count     (uint32) 每页条数
//
// 回包：
//   f1 users   (repeated) { f1 uin (uint64), f2 nick, f3 headUrl } —— nick / headUrl
//              服务端可能不填，`deserialize` 统一归一成字符串（空串 = 没给）
//   f2 cookie  (string)   下一页 cookie；空 = 已到末页
//   f3 isLast  (bool)
//   f4 isFirst (bool)
//
// 签名：**不签**（`needSign = false`）。Lagrange 的需要签名白名单里 0x908x 一族一个都没有
// （只有 0x9082_1/2 两个服务定义，白名单里没有），所以这一族按「白名单没有 = 不带
// SecToken/SecExtra/SecSign」处理；同族的 0x9082 贴 / 撤也一起改成了 false。

import { message } from '../../protobuf';
import { toInt } from '../shared';
import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';

/** 0x9083_1 的 inner body。 */
const EMOJI_LIKES_REQ = message([
  { name: 'groupId', tag: 2, type: 'uint64' },
  { name: 'sequence', tag: 3, type: 'uint64' },
  { name: 'emojiType', tag: 4, type: 'uint32' },
  { name: 'emojiId', tag: 5, type: 'string' },
  { name: 'cookie', tag: 6, type: 'string' },
  { name: 'count', tag: 8, type: 'uint32' },
]);

/** 回包里的单个回应者（nick / headUrl 服务端不一定填）。 */
const EMOJI_LIKES_USER = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { name: 'nick', tag: 2, type: 'string' },
  { name: 'headUrl', tag: 3, type: 'string' },
]);

const EMOJI_LIKES_RESP = message([
  { name: 'users', tag: 1, type: EMOJI_LIKES_USER, repeated: true },
  { name: 'cookie', tag: 2, type: 'string' },
  { name: 'isLast', tag: 3, type: 'bool' },
  { name: 'isFirst', tag: 4, type: 'bool' },
]);

export interface GetEmojiLikesParams {
  /** 群号。 */
  groupId: number;
  /** 被回应消息的 msgSeq。 */
  sequence: number;
  /** 表情 id：1–3 位是 QQ 小黄脸 id（如 76），更长的是 Unicode 码点（如 128516）。 */
  emojiId: string;
  /** 1 = QQ 小黄脸短 id（默认），2 = Unicode 码点。 */
  emojiType?: number;
  /** 每页条数，缺省 10。 */
  count?: number;
  /** 上一页返回的续传 cookie；首页不填。 */
  cookie?: string;
}

export interface EmojiLikeUser {
  /** 回应者 QQ 号。 */
  uin: number;
  /** 服务端给的昵称；可能为空串（这时由上层用本地资料补）。 */
  nick: string;
  /** 服务端给的头像直链；可能为空串（这时上层按 uin 拼 qlogo）。 */
  headUrl: string;
}

export interface GetEmojiLikesResult {
  users: EmojiLikeUser[];
  /** 下一页的续传 cookie；空字符串 = 已到末页。 */
  cookie: string;
  isLast: boolean;
}

export namespace GetEmojiLikes {
  export const command = 0x9083;
  export const subCommand = 1;
  /** 不签名：Lagrange 签名白名单里没有 0x908x（见文件头注释）。 */
  export const needSign = false;
  export const reqSchema = EMOJI_LIKES_REQ;
  export const respSchema = EMOJI_LIKES_RESP;

  export type Params = GetEmojiLikesParams;
  export type Result = GetEmojiLikesResult;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0) {
      throw new Error(`sequence 必须是正整数，收到 ${String(p.sequence)}`);
    }
    if (!p.emojiId) throw new Error('emojiId（表情 id）不能为空');
    const count = p.count ?? 10;
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`count 必须是正整数，收到 ${String(p.count)}`);
    }
    return {
      groupId: p.groupId,
      sequence: p.sequence,
      emojiType: p.emojiType ?? 1,
      emojiId: p.emojiId,
      // 首页的空 cookie 会被编码器按 proto3 默认值省略。
      cookie: p.cookie ?? '',
      count,
    };
  };

  export const deserialize = (body: Record<string, unknown>): Result => {
    const raw = (body.users as Record<string, unknown>[] | undefined) ?? [];
    const users = raw
      .map((u) => ({
        uin: toInt(u?.uin),
        nick: typeof u?.nick === 'string' ? u.nick : '',
        headUrl: typeof u?.headUrl === 'string' ? u.headUrl : '',
      }))
      // uin=0 是占位 / 零值，过滤掉。
      .filter((u) => u.uin > 0);
    const cookie = (body.cookie as string | undefined) ?? '';
    return { users, cookie, isLast: (body.isLast as boolean | undefined) ?? !cookie };
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<GetEmojiLikesResult> =>
    invokeOidb(nt, pid, GetEmojiLikes as OidbSpec<Params, GetEmojiLikesResult>, params);
}
