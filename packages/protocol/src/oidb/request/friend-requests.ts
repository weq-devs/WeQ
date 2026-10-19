// 好友申请处理 — 0xB5D_44（同意/拒绝）与可疑好友申请 0xD69_0 / 0xD72_0。
//
// 搬运自 SnowLuma：
//   `oidb-services/friend/handle-friend-request.ts`
//   `oidb-services/friend/{get,approve,reject}-doubt-buddy-req.ts`
//
// 签名：这几条都不在 LagrangeV2 白名单里 → 不签（自动推导）。
// `uinForm`：`0xD69_0` 列表走 UIN 形态；拒绝共用同一命令、同样 UIN 形态；
// 同意 `0xD72_0` 与 `0xB5D_44` 走 UID 形态。

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

// ───────────────────────── 好友申请 — 0xB5D_44 ─────────────────────────

const FRIEND_REQUEST_REQ = message([
  /** 3 = 同意，5 = 拒绝。 */
  { name: 'accept', tag: 1, type: 'uint32' },
  { name: 'targetUid', tag: 2, type: 'string' },
]);
const EMPTY_RESP = message([]);

export interface HandleFriendRequestParams {
  /** 申请方 uid（调用方已从本地库/资料解析好）。 */
  targetUid: string;
  /** true = 同意，false = 拒绝。 */
  approve: boolean;
}

export namespace HandleFriendRequest {
  export const command = 0xb5d;
  export const subCommand = 44;
  export const reqSchema = FRIEND_REQUEST_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = HandleFriendRequestParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const uid = String(p.targetUid ?? '').trim();
    if (!uid) throw new Error('targetUid 不能为空');
    return { accept: p.approve ? 3 : 5, targetUid: uid };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, HandleFriendRequest as OidbSpec<Params, void>, params);
}

// ───────────────────────── 可疑好友申请列表 — 0xD69_0 ─────────────────────────

const DOUBT_LIST_INNER = message([
  { name: 'num', tag: 1, type: 'uint32' },
  { name: 'cookie', tag: 2, type: 'string' },
]);
const DOUBT_LIST_REQ = message([
  /** 1 = 拉取列表（拒绝时同一命令用 3 区分）。 */
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'inner', tag: 2, type: DOUBT_LIST_INNER },
]);

const DOUBT_ITEM = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'nick', tag: 2, type: 'string' },
  { name: 'age', tag: 3, type: 'uint32' },
  { name: 'sex', tag: 4, type: 'uint32' },
  { name: 'msg', tag: 5, type: 'string' },
  { name: 'source', tag: 6, type: 'string' },
  { name: 'reason', tag: 7, type: 'string' },
  { name: 'reqTime', tag: 8, type: 'uint64' },
  { name: 'groupCode', tag: 9, type: 'uint64' },
  { name: 'commFriendNum', tag: 10, type: 'uint32' },
]);
const DOUBT_LIST_RESP = message([
  { name: 'status', tag: 1, type: 'uint32' },
  {
    name: 'body',
    tag: 2,
    type: message([
      { name: 'list', tag: 1, type: DOUBT_ITEM, repeated: true },
      { name: 'reason', tag: 2, type: 'string' },
    ]),
  },
]);

export interface DoubtFriendRequest {
  uid: string;
  nick: string;
  age: number;
  sex: number;
  message: string;
  source: string;
  reason: string;
  /** 申请时间（unix 秒）。 */
  requestTime: number;
  /** 来源群号（0 = 非群来源）。 */
  groupCode: number;
  commonFriendCount: number;
}

export interface FetchDoubtFriendRequestsParams {
  /** 一次拉多少条（官方默认 20 左右）。 */
  count?: number;
  /** 分页 cookie；首页传空串。 */
  cookie?: string;
}

export namespace FetchDoubtFriendRequests {
  export const command = 0xd69;
  export const subCommand = 0;
  export const uinForm = true;
  export const reqSchema = DOUBT_LIST_REQ;
  export const respSchema = DOUBT_LIST_RESP;

  export type Params = FetchDoubtFriendRequestsParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    field1: 1,
    inner: { num: p.count ?? 20, cookie: p.cookie ?? '' },
  });

  export const deserialize = (body: Record<string, unknown>): DoubtFriendRequest[] => {
    const inner = (body.body ?? {}) as Record<string, unknown>;
    return ((inner.list as Record<string, unknown>[] | undefined) ?? []).map((item) => ({
      uid: typeof item.uid === 'string' ? item.uid : '',
      nick: typeof item.nick === 'string' ? item.nick : '',
      age: toInt(item.age),
      sex: toInt(item.sex),
      message: typeof item.msg === 'string' ? item.msg : '',
      source: typeof item.source === 'string' ? item.source : '',
      reason: typeof item.reason === 'string' ? item.reason : '',
      requestTime: toInt(item.reqTime),
      groupCode: toInt(item.groupCode),
      commonFriendCount: toInt(item.commFriendNum),
    }));
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<DoubtFriendRequest[]> =>
    invokeOidb(nt, pid, FetchDoubtFriendRequests as OidbSpec<Params, DoubtFriendRequest[]>, params);
}

// ───────────────────────── 拒绝可疑好友申请 — 0xD69_0 ─────────────────────────

const DOUBT_REJECT_INNER = message([{ name: 'uid', tag: 1, type: 'string' }]);
const DOUBT_REJECT_REQ = message([
  /** 3 = 删除/拒绝（列表是 1）。 */
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'inner', tag: 3, type: DOUBT_REJECT_INNER },
]);

export interface RejectDoubtFriendRequestParams {
  uid: string;
}

export namespace RejectDoubtFriendRequest {
  export const command = 0xd69;
  export const subCommand = 0;
  export const uinForm = true;
  export const reqSchema = DOUBT_REJECT_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = RejectDoubtFriendRequestParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const uid = String(p.uid ?? '').trim();
    if (!uid) throw new Error('uid 不能为空');
    return { field1: 3, inner: { uid } };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, RejectDoubtFriendRequest as OidbSpec<Params, void>, params);
}

// ───────────────────────── 同意可疑好友申请 — 0xD72_0 ─────────────────────────

const DOUBT_APPROVE_REQ = message([
  { name: 'selfUid', tag: 1, type: 'string' },
  { name: 'targetUid', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'string' },
]);

export interface ApproveDoubtFriendRequestParams {
  /** 自己的 uid。 */
  selfUid: string;
  /** 申请方 uid。 */
  targetUid: string;
}

export namespace ApproveDoubtFriendRequest {
  export const command = 0xd72;
  export const subCommand = 0;
  export const reqSchema = DOUBT_APPROVE_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = ApproveDoubtFriendRequestParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const selfUid = String(p.selfUid ?? '').trim();
    const targetUid = String(p.targetUid ?? '').trim();
    if (!selfUid) throw new Error('selfUid 不能为空（uid map 可能未覆盖本账号）');
    if (!targetUid) throw new Error('targetUid 不能为空');
    return { selfUid, targetUid, field3: 0, field4: '' };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, ApproveDoubtFriendRequest as OidbSpec<Params, void>, params);
}
