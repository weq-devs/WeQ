// 群待办 — 0xF90（设置 / 完成 / 取消）与 0x9474_0（列表）。
//
// 搬运自 SnowLuma `oidb-services/extras/group-todo.ts` /
// `get-group-todo-list.ts`。
//
// 0xF90 的三个动作共用同一请求形状 `{ groupUin, msgSeq }`，靠 subCommand 区分，
// 所以用一个 `resolveSubCommand`。
//
// 签名：LagrangeV2 白名单里没有 0xf90 / 0x9474，交给 `invokeOidb` 推导为不签。

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

// ───────────────────────── 设置 / 完成 / 取消 — 0xF90 ─────────────────────────

const TODO_ACTION_SUBCMD = { set: 1, complete: 2, cancel: 3 } as const;

export type GroupTodoAction = keyof typeof TODO_ACTION_SUBCMD;

const TODO_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'msgSeq', tag: 2, type: 'uint64' },
]);
const TODO_RESP = message([]);

export interface GroupTodoParams {
  groupId: number;
  /** 被设为待办的消息 msgSeq。 */
  msgSeq: number | bigint;
  action: GroupTodoAction;
}

export namespace GroupTodo {
  export const command = 0xf90;
  export const reqSchema = TODO_REQ;
  export const respSchema = TODO_RESP;

  export type Params = GroupTodoParams;

  export const resolveSubCommand = (p: Params): number => {
    const sub = TODO_ACTION_SUBCMD[p.action];
    if (sub === undefined) throw new Error(`未知的群待办动作：${String(p.action)}`);
    return sub;
  };

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0 || p.groupId > 0xffffffff) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    if (typeof p.msgSeq === 'number' && !Number.isSafeInteger(p.msgSeq))
      throw new Error('msgSeq 数字精度不足，请使用 bigint');
    const msgSeq = typeof p.msgSeq === 'bigint' ? p.msgSeq : BigInt(p.msgSeq);
    if (msgSeq <= 0n || msgSeq > 0xffffffffffffffffn)
      throw new Error('msgSeq 必须在 uint64 正整数范围内');
    return { groupUin: p.groupId, msgSeq };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, GroupTodo as OidbSpec<Params, void>, params);
}

// ───────────────────────── 待办列表 — 0x9474_0 ─────────────────────────

const TODO_LIST_REQ = message([
  { name: 'groupId', tag: 1, type: 'uint64' },
  { name: 'bannerFlag', tag: 2, type: 'uint32' },
]);

const TODO_LIST_UI = message([
  { name: 'iconUrl', tag: 1, type: 'string' },
  { name: 'preText', tag: 2, type: 'string' },
  { name: 'text', tag: 3, type: 'string' },
  { name: 'highText', tag: 4, type: 'string' },
  { name: 'accessoryType', tag: 5, type: 'uint32' },
  { name: 'iconColor', tag: 6, type: 'uint32' },
  { name: 'needTranslation', tag: 7, type: 'bool' },
]);
const TODO_LIST_JUMP_INFO = message([
  { name: 'jumpType', tag: 1, type: 'uint32' },
  { name: 'jumpUrl', tag: 2, type: 'string' },
  { name: 'jumpParam', tag: 3, type: 'bytes' },
]);
const TODO_LIST_COMMON = message([
  { name: 'ui', tag: 1, type: TODO_LIST_UI },
  { name: 'jumpInfo', tag: 2, type: TODO_LIST_JUMP_INFO },
  { name: 'createTime', tag: 3, type: 'uint64' },
  { name: 'updateTime', tag: 4, type: 'uint64' },
]);
const TODO_LIST_LEGACY = message([
  { name: 'redText', tag: 1, type: 'string' },
  { name: 'text', tag: 2, type: 'string' },
  { name: 'url', tag: 3, type: 'string' },
  { name: 'isExposure', tag: 4, type: 'bool' },
  { name: 'isComplete', tag: 5, type: 'bool' },
]);
const TODO_LIST_BANNER = message([
  { name: 'bizType', tag: 1, type: 'uint32' },
  { name: 'bannerType', tag: 2, type: 'uint32' },
  { name: 'msgId', tag: 3, type: 'bytes' },
  { name: 'isDisappear', tag: 4, type: 'bool' },
  { name: 'expireTime', tag: 8, type: 'uint64' },
  { name: 'todoBanner', tag: 12, type: TODO_LIST_LEGACY },
  { name: 'commonBanner', tag: 20, type: TODO_LIST_COMMON },
]);
const TODO_LIST_RESP = message([
  { name: 'banners', tag: 1, type: TODO_LIST_BANNER, repeated: true },
  { name: 'newSeq', tag: 3, type: 'uint64' },
]);

/** 0x9474 的 bannerFlag：1 = 群待办。 */
const TODO_BANNER_FLAG = 1;
/** `msgId` 是 UTF-8 的 `"{sequence}_{random}"`。 */
const SOURCE_ID_PATTERN = /^([1-9]\d*)_(-?\d+)$/;

export interface GroupTodoListItem {
  /** `"{sequence}_{random}"`，同时也出现在 jumpParam JSON 里。 */
  sourceId: string;
  sequence: string;
  random: number;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export interface GetGroupTodoListParams {
  groupId: number;
}

/** 只在真正解析失败时抛错；格式不符的 banner 属于数据异常。 */
function decodeUtf8(bytes: unknown, what: string): string {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error(`群待办消息标识缺失（${what}）`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`群待办消息标识不是合法 UTF-8（${what}）`);
  }
}

function parseTimestamp(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : toInt(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export namespace GetGroupTodoList {
  export const command = 0x9474;
  export const subCommand = 0;
  export const reqSchema = TODO_LIST_REQ;
  export const respSchema = TODO_LIST_RESP;

  export type Params = GetGroupTodoListParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    return { groupId: p.groupId, bannerFlag: TODO_BANNER_FLAG };
  };

  export const deserialize = (body: Record<string, unknown>): GroupTodoListItem[] => {
    const banners = (body.banners as Record<string, unknown>[] | undefined) ?? [];
    const items: GroupTodoListItem[] = [];
    for (const banner of banners) {
      if (banner.isDisappear === true) continue;
      const sourceId = decodeUtf8(banner.msgId, 'msgId');
      const match = SOURCE_ID_PATTERN.exec(sourceId);
      if (!match) throw new Error(`群待办消息标识格式非法：${sourceId}`);
      if (match[1]!.length > 20 || BigInt(match[1]!) > 0xffffffffffffffffn)
        throw new Error('群待办消息序号超出 uint64 范围');
      const common = (banner.commonBanner ?? {}) as Record<string, unknown>;
      const ui = (common.ui ?? {}) as Record<string, unknown>;
      const legacy = (banner.todoBanner ?? {}) as Record<string, unknown>;
      items.push({
        sourceId,
        sequence: match[1]!,
        random: Number(match[2]),
        text:
          (typeof ui.text === 'string' && ui.text) ||
          (typeof legacy.text === 'string' ? legacy.text : ''),
        createdAt: parseTimestamp(common.createTime),
        updatedAt: parseTimestamp(common.updateTime),
      });
    }
    return items;
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<GroupTodoListItem[]> =>
    invokeOidb(nt, pid, GetGroupTodoList as OidbSpec<Params, GroupTodoListItem[]>, params);
}
