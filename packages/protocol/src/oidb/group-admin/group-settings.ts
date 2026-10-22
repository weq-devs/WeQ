// 群设置类命令：退群 (0x1097_1)、加群选项 (0x89A_0)、@全体剩余次数 (0x8A7_0)、
// 群分类标签 (0x967C/D/E_0)、在线群成员列表 (0xFE7_3)。
//
// 搬运自 SnowLuma：
//   `oidb-services/group-admin/{leave-group,set-add-option,get-at-all-remain,
//    get-group-category-tags,add-group-category-tag,delete-group-category-tag}.ts`
//   `oidb-services/contacts/fetch-group-member-list-page.ts`
//
// 签名（LangrangeV2 白名单）：
//   - 0x89a_0 → **true**（名单有 `OidbSvcTrpcTcp.0x89a_0`）
//   - 0x1097 / 0x8a7 / 0x967c / 0x967d / 0x967e → 全部 false
//   - 0xfe7_3 → **true**（名单有 `OidbSvcTrpcTcp.0xfe7_3`）
// 除 0x89a_0 / 0xfe7_3 外都不显式标注，交给 `invokeOidb` 按白名单推导。

import { decode, message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

function requireGroupId(groupId: number): number {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`groupId 必须是正整数，收到 ${String(groupId)}`);
  }
  return groupId;
}

// ───────────────────────── 退群 — 0x1097_1 ─────────────────────────

const LEAVE_GROUP_REQ = message([{ name: 'groupUin', tag: 1, type: 'uint32' }]);
const LEAVE_GROUP_RESP = message([]);

export interface LeaveGroupParams {
  groupId: number;
}

export namespace LeaveGroup {
  export const command = 0x1097;
  export const subCommand = 1;
  export const reqSchema = LEAVE_GROUP_REQ;
  export const respSchema = LEAVE_GROUP_RESP;

  export type Params = LeaveGroupParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    groupUin: requireGroupId(p.groupId),
  });

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, LeaveGroup as OidbSpec<Params, void>, params);
}

// ───────────────────────── 加群选项 — 0x89A_0 ─────────────────────────

/** 带问题的加群方式：4 = 需要回答问题并审核，5/55 = 仅回答问题。 */
export function isQuestionAddType(addType: number): boolean {
  return addType === 4 || addType === 5 || addType === 55;
}

/** 55 是 5 的别名；线上只接受 5。 */
export function wireAddType(addType: number): number {
  return addType === 55 ? 5 : addType;
}

const ADD_OPTION_SETTINGS = message([
  { name: 'addType', tag: 16, type: 'uint32' },
  // 空串是「清空另一种模式」的真实写入，必须显式上线。
  { name: 'groupQuestion', tag: 30, type: 'string', force: true },
  { name: 'groupAnswer', tag: 31, type: 'string', force: true },
]);

const ADD_OPTION_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint64' },
  { name: 'settings', tag: 2, type: ADD_OPTION_SETTINGS },
  { name: 'field12', tag: 12, type: 'uint32' },
]);

const ADD_OPTION_RESP = message([]);

export interface SetGroupAddOptionParams {
  groupId: number;
  /** 加群方式：4 = 问题 + 审核，5/55 = 仅问题，其余见官方枚举。 */
  addType: number;
  /** `addType` 为问题类时必填的问题文本。 */
  groupQuestion?: string;
  /** 仅 `addType = 4` 会保留答案；5/55 会被清空。 */
  groupAnswer?: string;
}

export namespace SetGroupAddOption {
  export const command = 0x89a;
  export const subCommand = 0;
  export const needSign = true;
  export const reqSchema = ADD_OPTION_REQ;
  export const respSchema = ADD_OPTION_RESP;

  export type Params = SetGroupAddOptionParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    requireGroupId(p.groupId);
    const addType = wireAddType(p.addType);
    const settings: Record<string, unknown> = { addType };
    if (isQuestionAddType(p.addType)) {
      settings.groupQuestion = p.groupQuestion ?? '';
      // 只有 type 4 保留答案；5/55 是仅问题，必须显式清空。
      settings.groupAnswer = addType === 4 ? (p.groupAnswer ?? '') : '';
    }
    return { groupUin: p.groupId, settings, field12: 0 };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupAddOption as OidbSpec<Params, void>, params);
}

// ───────────────────────── @全体成员剩余次数 — 0x8A7_0 ─────────────────────────

const AT_ALL_REQ = message([
  { name: 'basic1', tag: 1, type: 'uint32' },
  { name: 'basic2', tag: 2, type: 'uint32' },
  { name: 'basic3', tag: 3, type: 'uint32' },
  { name: 'uin', tag: 4, type: 'uint64' },
  { name: 'groupId', tag: 5, type: 'uint64' },
  { name: 'type', tag: 12, type: 'uint32' },
]);

const AT_ALL_RESP = message([
  { name: 'uinRemain', tag: 2, type: 'uint32' },
  { name: 'groupRemain', tag: 3, type: 'uint32' },
  { name: 'msg', tag: 4, type: 'string' },
  { name: 'canAtAll', tag: 6, type: 'bool' },
]);

export interface AtAllRemain {
  canAtAll: boolean;
  /** 该群共享的剩余次数。 */
  remainCountForGroup: number;
  /** 当前账号在该群的剩余次数。 */
  remainCountForUin: number;
}

export interface GetGroupAtAllRemainParams {
  groupId: number;
  /** 当前账号 uin（写入请求 f4）。 */
  selfUin: number | string;
}

export namespace GetGroupAtAllRemain {
  export const command = 0x8a7;
  export const subCommand = 0;
  export const reqSchema = AT_ALL_REQ;
  export const respSchema = AT_ALL_RESP;

  export type Params = GetGroupAtAllRemainParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const uin = toInt(p.selfUin);
    if (uin <= 0) throw new Error('selfUin 必须是正整数');
    return {
      // basic 三元组 (1,2,1) 是 NTQQ 的校验 cookie，服务端值不对直接拒。
      basic1: 1,
      basic2: 2,
      basic3: 1,
      uin,
      groupId: requireGroupId(p.groupId),
      type: 0,
    };
  };

  export const deserialize = (body: Record<string, unknown>): AtAllRemain => ({
    canAtAll: body.canAtAll === true,
    remainCountForGroup: toInt(body.groupRemain),
    remainCountForUin: toInt(body.uinRemain),
  });

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<AtAllRemain> =>
    invokeOidb(nt, pid, GetGroupAtAllRemain as OidbSpec<Params, AtAllRemain>, params);
}

// ───────────────────────── 群分类标签 — 0x967C/D/E_0 ─────────────────────────

const CATEGORY_TAG = message([
  { name: 'id', tag: 1, type: 'uint32' },
  { name: 'name', tag: 2, type: 'string' },
  { name: 'type', tag: 3, type: 'uint32' },
]);
// groupClass=0 是合法值，必须显式上线。
const GET_CATEGORY_TAGS_REQ = message([
  { name: 'groupClass', tag: 1, type: 'uint32', force: true },
]);
const GET_CATEGORY_TAGS_RESP = message([
  { name: 'tags', tag: 1, type: CATEGORY_TAG, repeated: true },
]);
const CHANGE_CATEGORY_TAG_REQ = message([
  { name: 'groupClass', tag: 1, type: 'uint32', force: true },
  { name: 'name', tag: 2, type: 'string' },
]);
const EMPTY_RESP = message([]);

export interface GroupCategoryTag {
  id: number | null;
  name: string;
  type: number | null;
}

/** 只校验目录及目录项帧，不把标签名称等任意 bytes 当作嵌套消息。 */
function validateCategoryDirectory(bytes: Uint8Array, root = true): void {
  let offset = 0;
  const seen = new Set<number>();
  const varint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('分类目录回应截断');
      const byte = bytes[offset++]!;
      if (i === 9 && byte > 1) throw new Error('分类目录整数越界');
      value |= BigInt(byte & 0x7f) << BigInt(7 * i);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('分类目录整数越界');
  };
  while (offset < bytes.length) {
    const key = varint();
    const tag = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (tag < 1 || tag > 0x1fffffff) throw new Error('分类目录字段无效');
    const known = root ? tag === 1 : tag >= 1 && tag <= 3;
    if (known) {
      if (wire !== (root || tag === 2 ? 2 : 0)) throw new Error('分类目录字段类型无效');
      if (!root && seen.has(tag)) throw new Error('分类目录项字段重复');
      seen.add(tag);
    }
    if (wire === 0) {
      const value = varint();
      if (known && value > 0xffffffffn) throw new Error('分类目录标识超出 uint32');
    } else if (wire === 2) {
      const length = varint();
      if (length > BigInt(bytes.length - offset)) throw new Error('分类目录回应截断');
      const end = offset + Number(length);
      if (root && tag === 1) validateCategoryDirectory(bytes.subarray(offset, end), false);
      if (!root && tag === 2) {
        const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end));
        if (!name.trim()) throw new Error('分类目录项缺少名称');
      }
      offset = end;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('分类目录回应截断');
    } else throw new Error('分类目录 wire 类型不支持');
  }
  if (!root && !seen.has(2)) throw new Error('分类目录项缺少名称');
}

export interface GroupCategoryParams {
  /** 群分类 id；0 是合法值，必须显式发。 */
  groupClass: number;
}

export namespace GetGroupCategoryTags {
  export const command = 0x967c;
  export const subCommand = 0;
  export const reqSchema = GET_CATEGORY_TAGS_REQ;
  export const respSchema = GET_CATEGORY_TAGS_RESP;
  export function decodeResponseBody(bytes: Uint8Array): Record<string, unknown> {
    validateCategoryDirectory(bytes);
    return decode(respSchema, bytes);
  }

  export type Params = GroupCategoryParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isInteger(p.groupClass) || p.groupClass < 0 || p.groupClass > 0xffffffff) {
      throw new Error(`groupClass 超出范围：${p.groupClass}`);
    }
    return { groupClass: p.groupClass };
  };

  export const deserialize = (body: Record<string, unknown>): GroupCategoryTag[] =>
    ((body.tags as Record<string, unknown>[] | undefined) ?? []).map((tag) => ({
      id: typeof tag.id === 'number' ? tag.id : null,
      name: typeof tag.name === 'string' ? tag.name : '',
      type: typeof tag.type === 'number' ? tag.type : null,
    }));

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<GroupCategoryTag[]> =>
    invokeOidb(nt, pid, GetGroupCategoryTags as OidbSpec<Params, GroupCategoryTag[]>, params);
}

export interface ChangeGroupCategoryTagParams extends GroupCategoryParams {
  /** 标签名；空串会被服务端接受但不产生效果，这里直接拒绝。 */
  name: string;
}

function serializeCategoryTagChange(p: ChangeGroupCategoryTagParams): Record<string, unknown> {
  if (!Number.isInteger(p.groupClass) || p.groupClass < 0 || p.groupClass > 0xffffffff) {
    throw new Error(`groupClass 超出范围：${p.groupClass}`);
  }
  const name = String(p.name ?? '').trim();
  if (!name) throw new Error('标签名不能为空');
  return { groupClass: p.groupClass, name };
}

export namespace AddGroupCategoryTag {
  export const command = 0x967d;
  export const subCommand = 0;
  export const reqSchema = CHANGE_CATEGORY_TAG_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = ChangeGroupCategoryTagParams;

  export const serialize = serializeCategoryTagChange;
  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, AddGroupCategoryTag as OidbSpec<Params, void>, params);
}

export namespace DeleteGroupCategoryTag {
  export const command = 0x967e;
  export const subCommand = 0;
  export const reqSchema = CHANGE_CATEGORY_TAG_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = ChangeGroupCategoryTagParams;

  export const serialize = serializeCategoryTagChange;
  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, DeleteGroupCategoryTag as OidbSpec<Params, void>, params);
}

// ───────────────────────── 在线群成员列表 — 0xFE7_3 ─────────────────────────

const MEMBER_LIST_UIN = message([
  { name: 'uid', tag: 2, type: 'string' },
  { name: 'uin', tag: 4, type: 'uint32' },
]);
const MEMBER_LIST_CARD = message([{ name: 'memberCard', tag: 2, type: 'string' }]);
const MEMBER_LIST_LEVEL = message([
  { name: 'infos', tag: 1, type: 'uint32', repeated: true },
  { name: 'level', tag: 2, type: 'uint32' },
]);
const MEMBER_LIST_MEMBER = message([
  { name: 'uin', tag: 1, type: MEMBER_LIST_UIN },
  { name: 'memberName', tag: 10, type: 'string' },
  { name: 'memberCard', tag: 11, type: MEMBER_LIST_CARD },
  { name: 'level', tag: 12, type: MEMBER_LIST_LEVEL },
  { name: 'specialTitle', tag: 17, type: 'string' },
  { name: 'joinTimestamp', tag: 100, type: 'uint32' },
  { name: 'lastMsgTimestamp', tag: 101, type: 'uint32' },
  { name: 'shutUpTimestamp', tag: 102, type: 'uint32' },
  { name: 'permission', tag: 107, type: 'uint32' },
]);
const MEMBER_LIST_RESP = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'members', tag: 2, type: MEMBER_LIST_MEMBER, repeated: true },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'memberChangeSeq', tag: 5, type: 'uint32' },
  { name: 'memberCardChangeSeq', tag: 6, type: 'uint32' },
  { name: 'token', tag: 15, type: 'string' },
]);

const MEMBER_LIST_BODY = message([
  { name: 'memberName', tag: 10, type: 'bool' },
  { name: 'memberCard', tag: 11, type: 'bool' },
  { name: 'level', tag: 12, type: 'bool' },
  { name: 'field13', tag: 13, type: 'bool' },
  { name: 'field16', tag: 16, type: 'bool' },
  { name: 'specialTitle', tag: 17, type: 'bool' },
  { name: 'field18', tag: 18, type: 'bool' },
  { name: 'field20', tag: 20, type: 'bool' },
  { name: 'field21', tag: 21, type: 'bool' },
  { name: 'joinTimestamp', tag: 100, type: 'bool' },
  { name: 'lastMsgTimestamp', tag: 101, type: 'bool' },
  { name: 'shutUpTimestamp', tag: 102, type: 'bool' },
  { name: 'field103', tag: 103, type: 'bool' },
  { name: 'field104', tag: 104, type: 'bool' },
  { name: 'field105', tag: 105, type: 'bool' },
  { name: 'field106', tag: 106, type: 'bool' },
  { name: 'permission', tag: 107, type: 'bool' },
  { name: 'field200', tag: 200, type: 'bool' },
  { name: 'field201', tag: 201, type: 'bool' },
]);

const MEMBER_LIST_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'body', tag: 4, type: MEMBER_LIST_BODY },
  { name: 'token', tag: 15, type: 'string' },
]);

export interface GroupMemberListItem {
  uin: number;
  uid: string;
  nickname: string;
  card: string;
  /** 0 = 成员，1 = 群主，2 = 管理员。 */
  permission: number;
  level: number;
  specialTitle: string;
  joinTime: number;
  lastSentTime: number;
  /** 禁言到期时间戳（秒）；0 = 未禁言。 */
  shutUpTime: number;
}

export interface GroupMemberListPage {
  members: GroupMemberListItem[];
  /** 空串表示已到最后一页。 */
  token: string;
}

export interface FetchGroupMemberListParams {
  groupId: number;
  /** 首页传空串；后续页传上一页响应里的 `token`。 */
  token?: string;
}

/**
 * 拉一页群成员（0xFE7_3）。
 *
 * ⚠️ 高频调用会触发风控，调用方（service）应做 TTL 缓存 + inflight 合并。
 * 这个 spec 只负责单页，翻页循环留给上层。
 */
export namespace FetchGroupMemberListPage {
  export const command = 0xfe7;
  export const subCommand = 3;
  export const reqSchema = MEMBER_LIST_REQ;
  export const respSchema = MEMBER_LIST_RESP;

  export type Params = FetchGroupMemberListParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      groupUin: requireGroupId(p.groupId),
      field2: 5,
      field3: 2,
      body: {
        memberName: true,
        memberCard: true,
        level: true,
        field13: true,
        field16: true,
        specialTitle: true,
        field18: true,
        field20: true,
        field21: true,
        joinTimestamp: true,
        lastMsgTimestamp: true,
        shutUpTimestamp: true,
        field103: true,
        field104: true,
        field105: true,
        field106: true,
        permission: true,
        field200: true,
        field201: true,
      },
    };
    if (p.token) body.token = p.token;
    return body;
  };

  export const deserialize = (body: Record<string, unknown>): GroupMemberListPage => ({
    members: ((body.members as Record<string, unknown>[] | undefined) ?? []).map((raw) => {
      const uin = (raw.uin ?? {}) as Record<string, unknown>;
      const card = (raw.memberCard ?? {}) as Record<string, unknown>;
      const level = (raw.level ?? {}) as Record<string, unknown>;
      return {
        uin: toInt(uin.uin),
        uid: typeof uin.uid === 'string' ? uin.uid : '',
        nickname: typeof raw.memberName === 'string' ? raw.memberName : '',
        card: typeof card.memberCard === 'string' ? card.memberCard : '',
        permission: toInt(raw.permission),
        level: toInt(level.level),
        specialTitle: typeof raw.specialTitle === 'string' ? raw.specialTitle : '',
        joinTime: toInt(raw.joinTimestamp),
        lastSentTime: toInt(raw.lastMsgTimestamp),
        shutUpTime: toInt(raw.shutUpTimestamp),
      };
    }),
    token: typeof body.token === 'string' ? body.token : '',
  });

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<GroupMemberListPage> =>
    invokeOidb(nt, pid, FetchGroupMemberListPage as OidbSpec<Params, GroupMemberListPage>, params);
}
