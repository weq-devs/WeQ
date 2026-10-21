import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUin } from './write-validation';
import type { OidbNative } from '../transport';

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

// 兼容旧直接导入路径；状态写入统一由 profile/status 实现。
export { SetOnlineStatus } from './profile/status';
export type { SetOnlineStatusParams } from './profile/status';
