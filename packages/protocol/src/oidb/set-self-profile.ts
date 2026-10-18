import { message } from '../protobuf';
import { invokeOidb, invokeTrpc } from './invoke';
import { requireUin, requireUint32 } from './write-validation';
import type { OidbNative, TrpcNative } from '../transport';

export const PROFILE_NICKNAME = 20002;
export const PROFILE_SIGNATURE = 102;
export const PROFILE_GENDER = 20009;
export interface SelfProfilePatch {
  nickname?: string;
  signature?: string;
  gender?: 0 | 1 | 2;
}
export interface SetSelfProfileParams extends SelfProfilePatch {
  uin: string;
}

export namespace SetSelfProfile {
  export const command = 0x112a;
  export const subCommand = 2;
  export const needSign = true;
  export const reqSchema = message([
    { name: 'uin', tag: 1, type: 'uint64' },
    {
      name: 'strings',
      tag: 2,
      repeated: true,
      type: message([
        { name: 'key', tag: 1, type: 'uint32' },
        { name: 'value', tag: 2, type: 'string', force: true },
      ]),
    },
    {
      name: 'numbers',
      tag: 3,
      repeated: true,
      type: message([
        { name: 'key', tag: 1, type: 'uint32' },
        { name: 'value', tag: 2, type: 'uint32', force: true },
      ]),
    },
  ]);
  export const respSchema = message([]);
  export function serialize(p: SetSelfProfileParams): Record<string, unknown> {
    const strings: Array<{ key: number; value: string }> = [];
    const numbers: Array<{ key: number; value: number }> = [];
    if (p.nickname !== undefined) {
      if (!p.nickname.trim()) throw new Error('昵称不能为空');
      strings.push({ key: PROFILE_NICKNAME, value: p.nickname });
    }
    if (p.signature !== undefined) strings.push({ key: PROFILE_SIGNATURE, value: p.signature });
    if (p.gender !== undefined) {
      if (![0, 1, 2].includes(p.gender)) throw new Error('性别枚举无效');
      numbers.push({ key: PROFILE_GENDER, value: p.gender });
    }
    return { uin: requireUin(p.uin), strings, numbers };
  }
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export async function invoke(
    nt: OidbNative,
    pid: number,
    p: SetSelfProfileParams,
  ): Promise<void> {
    if (p.nickname === undefined && p.signature === undefined && p.gender === undefined) return;
    await invokeOidb(nt, pid, SetSelfProfile, p);
  }
}

export interface SetOnlineStatusParams {
  status: number;
  extStatus?: number;
  batteryStatus?: number;
  custom?: { faceId: number; wording: string; faceType: number };
}

export namespace SetOnlineStatus {
  export const cmd = 'trpc.qq_new_tech.status_svc.StatusService.SetStatus';
  export const needSign = true;
  export const reqSchema = message([
    { name: 'status', tag: 1, type: 'uint32' },
    { name: 'extStatus', tag: 2, type: 'uint32', force: true },
    { name: 'batteryStatus', tag: 3, type: 'uint32', force: true },
    {
      name: 'custom',
      tag: 4,
      type: message([
        { name: 'faceId', tag: 1, type: 'uint64', force: true },
        { name: 'wording', tag: 2, type: 'string', force: true },
        { name: 'faceType', tag: 3, type: 'uint64', force: true },
      ]),
    },
  ]);
  export const respSchema = message([
    { name: 'code', tag: 1, type: 'int32' },
    { name: 'message', tag: 2, type: 'string' },
  ]);
  export function serialize(p: SetOnlineStatusParams): Record<string, unknown> {
    if (p.custom && (p.status !== 10 || p.extStatus !== 2000))
      throw new Error('自定义状态必须使用 status=10、extStatus=2000');
    return {
      status: requireUint32(p.status, 'status'),
      extStatus: requireUint32(p.extStatus ?? 0, 'extStatus', true),
      batteryStatus: requireUint32(p.batteryStatus ?? 0, 'batteryStatus', true),
      ...(p.custom
        ? {
            custom: {
              faceId: BigInt(requireUint32(p.custom.faceId, 'faceId', true)),
              wording: p.custom.wording,
              faceType: BigInt(requireUint32(p.custom.faceType, 'faceType', true)),
            },
          }
        : {}),
    };
  }
  export function deserialize(body: Record<string, unknown>): void {
    if (body.code !== undefined && body.code !== 0)
      throw new Error(`在线状态设置失败：${String(body.code)} ${String(body.message ?? '')}`);
  }
  export const invoke = (nt: TrpcNative, pid: number, p: SetOnlineStatusParams): Promise<void> =>
    invokeTrpc(nt, pid, SetOnlineStatus, p);
}
