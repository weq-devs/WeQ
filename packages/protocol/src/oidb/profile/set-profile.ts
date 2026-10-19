// 修改个人资料 — 0x112A_2 与 0x112A_1。
//
//   `SetProfile`       — 批量写字符串 / 数字资料字段（昵称 20002、签名 102、性别 20009）
//   `SetSelfLongNick`  — 只改长昵称（签名），走单独的 `profile{tag,value}` 形状
//
// 搬运自 SnowLuma `oidb-services/profile/{set-profile,set-self-long-nick}.ts`。
//
// 签名：LagrangeV2 白名单里有 `OidbSvcTrpcTcp.0x112a_1` / `_2` → 签（自动推导）。

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

/** 资料字段 id（QQ 的 profile field）。 */
export const PROFILE_FIELD = {
  /** 个性签名 / 长昵称。 */
  longNick: 102,
  /** 昵称。 */
  nick: 20002,
  /** 性别。 */
  sex: 20009,
} as const;

const PROFILE_STRING_ITEM = message([
  { name: 'fieldId', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'string' },
]);
const PROFILE_INT_ITEM = message([
  { name: 'fieldId', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'uint64' },
]);

const SET_PROFILE_REQ = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { name: 'stringProfiles', tag: 2, type: PROFILE_STRING_ITEM, repeated: true },
  { name: 'intProfiles', tag: 3, type: PROFILE_INT_ITEM, repeated: true },
]);
const SET_PROFILE_RESP = message([]);

export interface SetProfileParams {
  /** 当前账号 uin。 */
  selfUin: number | string;
  nickname?: string;
  /** 个性签名（长短昵称）。 */
  personalNote?: string;
  /** 性别：0 未知 / 1 男 / 2 女。 */
  sex?: number;
}

export namespace SetProfile {
  export const command = 0x112a;
  export const subCommand = 2;
  export const reqSchema = SET_PROFILE_REQ;
  export const respSchema = SET_PROFILE_RESP;

  export type Params = SetProfileParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const uin = toInt(p.selfUin);
    if (uin <= 0) throw new Error('selfUin 必须是正整数');
    const stringProfiles: Record<string, unknown>[] = [];
    const intProfiles: Record<string, unknown>[] = [];
    if (p.nickname !== undefined) {
      stringProfiles.push({ fieldId: PROFILE_FIELD.nick, value: p.nickname });
    }
    if (p.personalNote !== undefined) {
      stringProfiles.push({ fieldId: PROFILE_FIELD.longNick, value: p.personalNote });
    }
    if (p.sex !== undefined) {
      intProfiles.push({ fieldId: PROFILE_FIELD.sex, value: p.sex });
    }
    return {
      uin,
      ...(stringProfiles.length > 0 ? { stringProfiles } : {}),
      ...(intProfiles.length > 0 ? { intProfiles } : {}),
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> => {
    // 没有任何要写的字段 → 直接返回，避免一次白跑的服务端往返。
    if (
      params.nickname === undefined &&
      params.personalNote === undefined &&
      params.sex === undefined
    ) {
      return Promise.resolve();
    }
    return invokeOidb(nt, pid, SetProfile as OidbSpec<Params, void>, params);
  };
}

// ───────────────────────── 长昵称 — 0x112A_1 ─────────────────────────

const SELF_LONG_NICK_PROFILE = message([
  { name: 'tag', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'string' },
]);
const SELF_LONG_NICK_REQ = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { name: 'profile', tag: 2, type: SELF_LONG_NICK_PROFILE },
]);

export interface SetSelfLongNickParams {
  selfUin: number | string;
  longNick: string;
}

/**
 * 改长昵称的 wire 形状与 `SetProfile` 不同（单个 `profile{tag,value}`，不是
 * repeated stringProfiles），所以单独一个 spec。subCommand 仍为 2（与 SnowLuma
 * 抓包一致；白名单里 0x112a_1/2 都存在，但服务端按 body 形状分派）。
 */
export namespace SetSelfLongNick {
  export const command = 0x112a;
  export const subCommand = 2;
  export const reqSchema = SELF_LONG_NICK_REQ;
  export const respSchema = SET_PROFILE_RESP;

  export type Params = SetSelfLongNickParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const uin = toInt(p.selfUin);
    if (uin <= 0) throw new Error('selfUin 必须是正整数');
    return {
      uin,
      profile: { tag: PROFILE_FIELD.longNick, value: String(p.longNick ?? '') },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetSelfLongNick as OidbSpec<Params, void>, params);
}
