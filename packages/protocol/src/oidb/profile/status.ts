// 在线状态 / 自定义状态 / 输入状态 / 在线状态查询。
//
//   trpc.qq_new_tech.status_svc.StatusService.SetStatus — 设置在线 / 自定义状态
//   0xCD4_1 — 设置私聊「正在输入」等输入状态
//   0xFE1_2 key 27372 — 查询某个 uin 的在线 / 扩展状态
//
// 搬运自 SnowLuma `core/src/bridge/apis/profile.ts`、
// `oidb-services/profile/set-input-status.ts`、`oidb-services/extras/get-stranger-status.ts`。
//
// 签名：
//   - `SetStatus` **不在** LagrangeV2 白名单 → 不签。若真机被拒，回退
//     `StatSvc.SetStatusFromClient`（在名单里）—— 目前保留 SetStatus，等真机验证。
//   - 0xCD4 不在名单 → 不签。
//   - 0xFE1_2 在名单 → 签（由 `invokeOidb` 推导）。

import { message } from '../../protobuf';
import { invokeOidb, invokeTrpc, type OidbSpec, type TrpcSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative, TrpcNative } from '../../transport';

// ───────────────────────── 设置在线 / 自定义状态 ─────────────────────────

const SET_STATUS_CMD = 'trpc.qq_new_tech.status_svc.StatusService.SetStatus';

const STATUS_CUSTOM_EXT = message([
  { name: 'faceId', tag: 1, type: 'uint32' },
  { name: 'text', tag: 2, type: 'string' },
  { name: 'faceType', tag: 3, type: 'uint32' },
]);
const SET_STATUS_REQ = message([
  { name: 'status', tag: 1, type: 'int32' },
  { name: 'extStatus', tag: 2, type: 'int32' },
  { name: 'batteryStatus', tag: 3, type: 'int32' },
  { name: 'customExt', tag: 4, type: STATUS_CUSTOM_EXT },
]);
const SET_STATUS_RESP = message([
  { name: 'errCode', tag: 1, type: 'int32' },
  { name: 'errMsg', tag: 2, type: 'string' },
]);

export interface SetOnlineStatusParams {
  /** 10 在线 / 30 离开 / 50 忙碌 / 60 Q我吧 / 70 勿扰 / 40 隐身。 */
  status: number;
  /** 扩展状态（如 1028 听歌中）；0 = 无。 */
  extStatus?: number;
  batteryStatus?: number;
}

export interface SetDiyOnlineStatusParams {
  /** 状态图标 id。 */
  faceId: number;
  /** 自定义状态文案。 */
  text: string;
  /** 图标类型。 */
  faceType: number;
}

export namespace SetOnlineStatus {
  export const cmd = SET_STATUS_CMD;
  export const reqSchema = SET_STATUS_REQ;
  export const respSchema = SET_STATUS_RESP;

  export type Params = SetOnlineStatusParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    status: p.status,
    extStatus: p.extStatus ?? 0,
    batteryStatus: p.batteryStatus ?? 100,
  });

  export const deserialize = (body: Record<string, unknown>): void => {
    const errMsg = typeof body.errMsg === 'string' ? body.errMsg : '';
    // 服务端成功时可能回 "set status success"；其他非空文案都按失败处理。
    if (errMsg && errMsg !== 'set status success') {
      throw new Error(`设置在线状态失败：code=${toInt(body.errCode)} ${errMsg}`);
    }
  };

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<void> =>
    invokeTrpc(nt, pid, SetOnlineStatus as TrpcSpec<Params, void>, params);
}

export namespace SetDiyOnlineStatus {
  export const cmd = SET_STATUS_CMD;
  export const reqSchema = SET_STATUS_REQ;
  export const respSchema = SET_STATUS_RESP;

  export type Params = SetDiyOnlineStatusParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const text = String(p.text ?? '');
    if (!text.trim()) throw new Error('自定义状态文案不能为空');
    return {
      // 官方客户端固定 status=10 / extStatus=2000 表示「自定义状态」。
      status: 10,
      extStatus: 2000,
      batteryStatus: 0,
      customExt: { faceId: p.faceId, text, faceType: p.faceType },
    };
  };

  export const deserialize = SetOnlineStatus.deserialize;

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<void> =>
    invokeTrpc(nt, pid, SetDiyOnlineStatus as TrpcSpec<Params, void>, params);
}

// ───────────────────────── 输入状态 — 0xCD4_1 ─────────────────────────

const INPUT_STATUS_BODY = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'chatType', tag: 2, type: 'uint32' },
  { name: 'eventType', tag: 3, type: 'uint32' },
]);
const INPUT_STATUS_REQ = message([{ name: 'reqBody', tag: 1, type: INPUT_STATUS_BODY }]);
const INPUT_STATUS_RESP = message([]);

export interface SetInputStatusParams {
  /** 目标对方 uid。 */
  targetUid: string;
  /** 事件类型（如 1 = 正在输入）。 */
  eventType: number;
}

export namespace SetInputStatus {
  export const command = 0xcd4;
  export const subCommand = 1;
  export const reqSchema = INPUT_STATUS_REQ;
  export const respSchema = INPUT_STATUS_RESP;

  export type Params = SetInputStatusParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const uid = String(p.targetUid ?? '').trim();
    if (!uid) throw new Error('targetUid 不能为空');
    return {
      reqBody: {
        uid,
        // 0 = 好友会话（当前只支持这一种）。
        chatType: 0,
        eventType: p.eventType,
      },
    };
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetInputStatus as OidbSpec<Params, void>, params);
}

// ───────────────────────── 在线状态查询 — 0xFE1_2 key 27372 ─────────────────────────

/** 在线状态属性键。 */
const STATUS_PROPERTY_KEY = 27372;

const STATUS_KEY = message([{ name: 'key', tag: 1, type: 'uint32' }]);
const STATUS_REQ = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'keys', tag: 3, type: STATUS_KEY, repeated: true },
]);
const STATUS_RESP = message([
  {
    name: 'data',
    tag: 1,
    type: message([
      {
        name: 'properties',
        tag: 2,
        type: message([
          {
            name: 'entries',
            tag: 1,
            type: message([
              { name: 'key', tag: 1, type: 'uint32' },
              { name: 'value', tag: 2, type: 'uint32' },
            ]),
            repeated: true,
          },
        ]),
      },
    ]),
  },
]);

export interface UserOnlineStatus {
  /** 主状态：10 在线 / 30 离开 / 50 忙碌 / 60 Q我吧 / 70 勿扰 / 40 隐身 / 0 离线。 */
  status: number;
  /** 扩展状态（听歌中 1028 等）。 */
  extStatus: number;
}

/**
 * 状态字是 QQ 的打包值：≤10 表示纯状态 ×10；否则低字节进状态、高位是扩展状态。
 * 与 SnowLuma `unpackStatusWord` 一致。
 */
export function unpackStatusWord(raw: number | bigint): UserOnlineStatus {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  if (value <= 10n) {
    return { status: Number(value) * 10, extStatus: 0 };
  }
  const packed = Number(value);
  const status = (packed & 0xff00) + ((packed >>> 16) & 0xff);
  return { status: 10, extStatus: status };
}

export interface GetUserOnlineStatusParams {
  uin: number;
}

export namespace GetUserOnlineStatus {
  export const command = 0xfe1;
  export const subCommand = 2;
  export const uinForm = true;
  export const reqSchema = STATUS_REQ;
  export const respSchema = STATUS_RESP;

  export type Params = GetUserOnlineStatusParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.uin) || p.uin <= 0) {
      throw new Error(`uin 必须是正整数，收到 ${String(p.uin)}`);
    }
    return { uin: p.uin, keys: [{ key: STATUS_PROPERTY_KEY }] };
  };

  /** 没有该属性时返回 null（对方可能未暴露在线状态）。 */
  export const deserialize = (body: Record<string, unknown>): UserOnlineStatus | null => {
    const data = (body.data ?? {}) as Record<string, unknown>;
    const properties = (data.properties ?? {}) as Record<string, unknown>;
    const entries = (properties.entries as Record<string, unknown>[] | undefined) ?? [];
    const hit = entries.find((entry) => toInt(entry.key) === STATUS_PROPERTY_KEY);
    if (!hit || hit.value === undefined || hit.value === null) return null;
    return unpackStatusWord(toInt(hit.value));
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<UserOnlineStatus | null> =>
    invokeOidb(nt, pid, GetUserOnlineStatus as OidbSpec<Params, UserOnlineStatus | null>, params);
}
