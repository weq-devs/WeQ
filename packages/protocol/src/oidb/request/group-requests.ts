// 加群请求 — 0x10C0_1/2（拉取主/过滤收件箱）与 0x10C8_1/2（同意/拒绝）。
//
// 搬运自 SnowLuma：
//   `oidb-services/contacts/fetch-group-requests.ts`
//   `oidb-services/group-admin/set-add-request.ts`
//
// 签名：LagrangeV2 白名单里有 `OidbSvcTrpcTcp.0x10c0_1/2` 与 `0x10c8_1/2`
// → 自动推导为签。
//
// ⚠️ `setAddRequest` 的 `message`（拒绝理由）**空值必须写 `" "`**，不能省略 ——
// 官方客户端就是这么发的；省略会被服务端拒。

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

// ───────────────────────── 通知类型 → 操作类型 ─────────────────────────

/**
 * 0x10C0 里的 `notifyType` 与 0x10C8 需要的 `eventType` 不是同一个值。
 * 映射表来自 SnowLuma（RE 自客户端）。
 */
export const GROUP_REQUEST_OPERATION_TYPE: ReadonlyMap<number, number> = new Map([
  [0, 0],
  [1, 2],
  [2, 10],
  [3, 11],
  [4, 12],
  [5, 22],
  [6, 35],
  [7, 1],
  [8, 3],
  [9, 6],
  [10, 7],
  [11, 13],
  [12, 15],
  [13, 16],
  [14, 17],
  [15, 19],
  [16, 8],
  [17, 100],
]);

const OPERATION_TYPE_VALUES = new Set(GROUP_REQUEST_OPERATION_TYPE.values());

/**
 * `notifyType` → `eventType`。已经是映射输出值（如 22）时原样返回；未知返回 null。
 */
export function groupRequestOperationType(notifyType: number): number | null {
  const mapped = GROUP_REQUEST_OPERATION_TYPE.get(notifyType);
  if (mapped !== undefined) return mapped;
  if (OPERATION_TYPE_VALUES.has(notifyType)) return notifyType;
  return null;
}

// ───────────────────────── 拉取请求 — 0x10C0_1/2 ─────────────────────────

const GROUP_REQUEST_LIST_REQ = message([
  { name: 'count', tag: 1, type: 'uint32' },
  { name: 'cookie', tag: 2, type: 'uint64' },
]);

/** UIN 形态下同一个位置是 uint32（wire type 不同，必须单独 schema）。 */
const REQUEST_USER_UIN = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'name', tag: 2, type: 'string' },
]);

const REQUEST_GROUP = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'groupName', tag: 2, type: 'string' },
]);

function groupRequestEntry(userSchema: ReturnType<typeof message>) {
  return message([
    { name: 'sequence', tag: 1, type: 'uint64' },
    { name: 'eventType', tag: 2, type: 'uint32' },
    { name: 'state', tag: 3, type: 'uint32' },
    { name: 'group', tag: 4, type: REQUEST_GROUP },
    { name: 'target', tag: 5, type: userSchema },
    { name: 'invitor', tag: 6, type: userSchema },
    { name: 'operatorUser', tag: 7, type: userSchema },
    { name: 'field9', tag: 9, type: 'string' },
    { name: 'comment', tag: 10, type: 'string' },
    { name: 'operateTransInfo', tag: 14, type: 'bytes' },
  ]);
}

/** UIN 形态（`uinForm = true`）的回包：用户字段 tag 1 是 uin。 */
const GROUP_REQUEST_RESP_BY_UIN = message([
  { name: 'requests', tag: 1, type: groupRequestEntry(REQUEST_USER_UIN), repeated: true },
  { name: 'cookie', tag: 2, type: 'uint64' },
  { name: 'newLatestSeq', tag: 3, type: 'uint64' },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'field5', tag: 5, type: 'uint64' },
  { name: 'field6', tag: 6, type: 'uint32' },
]);

export interface GroupRequestUser {
  uid: string;
  uin: number;
  name: string;
}

export interface GroupRequest {
  /** 处理该请求的定位序号。 */
  sequence: number;
  /** 处理时回传的 eventType。 */
  eventType: number;
  /** 0 = 待处理（通常）。 */
  state: number;
  groupId: number;
  groupName: string;
  /** 申请人（加群）或受邀人（邀请）。 */
  target: GroupRequestUser;
  invitor: GroupRequestUser;
  operator: GroupRequestUser;
  comment: string;
  /** 处理时需要原样回传的透传字段。 */
  operateTransInfo?: Uint8Array;
  /** 是否来自「过滤」收件箱。 */
  filtered: boolean;
}

export interface GroupRequestPage {
  requests: GroupRequest[];
  /** 下一页游标；0 表示没有下一页。 */
  cookie: number;
}

export interface FetchGroupRequestsParams {
  /** 一次拉多少条，默认 50。 */
  count?: number;
  /** 分页 cookie；首页传 0。 */
  cookie?: number | bigint;
  /** true = 过滤收件箱（0x10C0_2）。 */
  filtered?: boolean;
}

function parseUser(raw: unknown): GroupRequestUser {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    uid: typeof item.uid === 'string' ? item.uid : '',
    uin: toInt(item.uin),
    name: typeof item.name === 'string' ? item.name : '',
  };
}

function parseRequests(body: Record<string, unknown>, filtered: boolean): GroupRequest[] {
  return ((body.requests as Record<string, unknown>[] | undefined) ?? []).map((raw) => {
    const group = (raw.group ?? {}) as Record<string, unknown>;
    const transInfo = raw.operateTransInfo;
    return {
      sequence: toInt(raw.sequence),
      eventType: toInt(raw.eventType),
      state: toInt(raw.state),
      groupId: toInt(group.groupUin),
      groupName: typeof group.groupName === 'string' ? group.groupName : '',
      target: parseUser(raw.target),
      invitor: parseUser(raw.invitor),
      operator: parseUser(raw.operatorUser),
      comment: typeof raw.comment === 'string' ? raw.comment : '',
      ...(transInfo instanceof Uint8Array && transInfo.length > 0
        ? { operateTransInfo: transInfo }
        : {}),
      filtered,
    };
  });
}

export namespace FetchGroupRequests {
  export const command = 0x10c0;
  /** 主 / 过滤两个子命令都在白名单里；动态子命令无法在分发时推导，显式标注。 */
  export const needSign = true;
  export const uinForm = true;
  export const reqSchema = GROUP_REQUEST_LIST_REQ;
  // uinForm=true 时用户字段 tag 1 是 uint32，必须用 UIN 形态的 schema。
  export const respSchema = GROUP_REQUEST_RESP_BY_UIN;

  export type Params = FetchGroupRequestsParams;

  export const resolveSubCommand = (p: Params): number => (p.filtered ? 2 : 1);

  export const serialize = (p: Params): Record<string, unknown> => ({
    count: p.count ?? 50,
    cookie: p.cookie ?? 0,
  });

  export const deserialize = (body: Record<string, unknown>): GroupRequestPage => ({
    requests: parseRequests(body, false),
    cookie: toInt(body.cookie),
  });

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<GroupRequestPage> =>
    invokeOidb(nt, pid, FetchGroupRequests as OidbSpec<Params, GroupRequestPage>, params);
}

/**
 * 过滤收件箱（0x10C0_2）。与 {@link FetchGroupRequests} 共用请求形状，只改 subCommand。
 */
export namespace FetchFilteredGroupRequests {
  export const command = 0x10c0;
  export const subCommand = 2;
  /** 同 {@link FetchGroupRequests}。 */
  export const needSign = true;
  export const uinForm = true;
  export const reqSchema = GROUP_REQUEST_LIST_REQ;
  export const respSchema = GROUP_REQUEST_RESP_BY_UIN;

  export type Params = Omit<FetchGroupRequestsParams, 'filtered'>;

  export const serialize = FetchGroupRequests.serialize;
  export const deserialize = (body: Record<string, unknown>): GroupRequestPage => ({
    requests: parseRequests(body, true),
    cookie: toInt(body.cookie),
  });

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<GroupRequestPage> =>
    invokeOidb(nt, pid, FetchFilteredGroupRequests as OidbSpec<Params, GroupRequestPage>, params);
}

// ───────────────────────── 同意 / 拒绝 — 0x10C8_1/2 ─────────────────────────

const GROUP_REQUEST_ACTION_BODY = message([
  { name: 'sequence', tag: 1, type: 'uint64' },
  { name: 'eventType', tag: 2, type: 'uint32' },
  { name: 'groupUin', tag: 3, type: 'uint32' },
  /** ⚠️ 空理由必须写成 `" "`，不能省略。 */
  { name: 'message', tag: 4, type: 'string', force: true },
  { name: 'operateTransInfo', tag: 7, type: 'bytes' },
]);
const GROUP_REQUEST_ACTION_REQ = message([
  /** 1 = 同意，2 = 拒绝。 */
  { name: 'accept', tag: 1, type: 'uint32' },
  { name: 'body', tag: 2, type: GROUP_REQUEST_ACTION_BODY },
]);

export interface SetGroupRequestParams {
  groupId: number;
  /** 来自 0x10C0 的请求序号。 */
  sequence: number;
  /** 来自 0x10C0 的 eventType。 */
  eventType: number;
  approve: boolean;
  /** 拒绝理由；空串会上 wire 成 `" "`。 */
  reason?: string;
  /** true = 过滤收件箱（0x10C8_2）。 */
  filtered?: boolean;
  /** 来自 0x10C0 的透传字段（有就带上）。 */
  operateTransInfo?: Uint8Array;
}

export namespace SetGroupRequest {
  export const command = 0x10c8;
  /** 主 / 过滤两个子命令都在白名单里；动态子命令无法在分发时推导，显式标注。 */
  export const needSign = true;
  export const uinForm = true;
  export const reqSchema = GROUP_REQUEST_ACTION_REQ;
  export const respSchema = message([]);

  export type Params = SetGroupRequestParams;

  export const resolveSubCommand = (p: Params): number => (p.filtered ? 2 : 1);

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0) {
      throw new Error(`sequence 必须是正整数，收到 ${String(p.sequence)}`);
    }
    const reason = p.reason ?? '';
    return {
      accept: p.approve ? 1 : 2,
      body: {
        sequence: p.sequence,
        eventType: p.eventType,
        groupUin: p.groupId,
        // 原生行为：空理由写一个空格，省略会被拒。
        message: reason.length > 0 ? reason : ' ',
        ...(p.operateTransInfo && p.operateTransInfo.length > 0
          ? { operateTransInfo: p.operateTransInfo }
          : {}),
      },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupRequest as OidbSpec<Params, void>, params);
}
