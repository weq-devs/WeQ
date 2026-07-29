// 0x7ED_12 — fetch QQ "thumbs up" (赞) summary for a user.
//
// Keyed by uid, not uin — callers resolve the uid first (the login probe
// carries it for the logged-in account).

import { message } from '../protobuf';
import { toInt } from './shared';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const LIKE_REQ = message([
  { name: 'targetUid', tag: 1, type: 'string' },
  { name: 'basic', tag: 2, type: 'uint32' },
  { name: 'vote', tag: 3, type: 'uint32' },
  { name: 'favorite', tag: 4, type: 'uint32' },
  { name: 'start', tag: 12, type: 'uint32' },
  { name: 'limit', tag: 103, type: 'uint32' },
]);

const INTERACTION = message([
  { name: 'totalCount', tag: 1, type: 'uint32' },
  { name: 'newCount', tag: 2, type: 'uint32' },
  { name: 'todayCount', tag: 3, type: 'uint32' },
  { name: 'lastTime', tag: 4, type: 'uint64' },
]);

const USER_LIKE_INFO = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'time', tag: 2, type: 'uint64' },
  { name: 'favoriteInfo', tag: 3, type: INTERACTION },
  { name: 'voteInfo', tag: 4, type: INTERACTION },
]);

const LIKE_RESP = message([
  { name: 'userLikeInfos', tag: 1, type: USER_LIKE_INFO, repeated: true },
]);

export interface InteractionCounts {
  totalCount: number;
  newCount: number;
  todayCount: number;
  lastTime: number;
}

export interface LikeInfo {
  uid: string;
  time: number;
  /** 收藏 */
  favoriteInfo: InteractionCounts;
  /** 点赞 */
  voteInfo: InteractionCounts;
}

function readInteraction(v: unknown): InteractionCounts {
  const o = (v as Record<string, unknown> | undefined) ?? {};
  return {
    totalCount: toInt(o.totalCount),
    newCount: toInt(o.newCount),
    todayCount: toInt(o.todayCount),
    lastTime: toInt(o.lastTime),
  };
}

export namespace GetProfileLike {
  export const command = 0x7ed;
  export const subCommand = 12;
  export const reqSchema = LIKE_REQ;
  export const respSchema = LIKE_RESP;

  export interface Params {
    targetUid: string;
    start?: number;
    limit?: number;
  }

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.targetUid) throw new Error('target uid not found');
    return {
      targetUid: p.targetUid,
      basic: 1,
      vote: 1,
      favorite: 1,
      start: p.start ?? 0,
      limit: p.limit ?? 10,
    };
  };

  export const deserialize = (body: Record<string, unknown>): LikeInfo => {
    const data = (body.userLikeInfos as Record<string, unknown>[] | undefined)?.[0];
    if (!data) throw new Error('get profile like info empty');
    return {
      uid: (data.uid as string) ?? '',
      time: toInt(data.time),
      favoriteInfo: readInteraction(data.favoriteInfo),
      voteInfo: readInteraction(data.voteInfo),
    };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<LikeInfo> =>
    invokeOidb(nt, pid, GetProfileLike as OidbSpec<Params, LikeInfo>, params);
}
