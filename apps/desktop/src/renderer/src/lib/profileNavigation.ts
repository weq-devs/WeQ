import { createContext } from 'react';
import type { User } from '../im-template/template/types';
import { avatarFromUin } from './avatarResolver';

export type ProfileGroup = { code: string; name: string };
export type ProfileTarget = {
  identity: string;
  uin?: string;
  name: string;
  avatarUrl?: string | null;
  group?: ProfileGroup;
};

/** 群公告等来源可能返回 UID 或 QQ 号，不能把数字身份伪造成 UID。 */
export function profileTargetUser(target: ProfileTarget): User | null {
  const uid = /^u_[A-Za-z0-9_-]+$/.test(target.identity) ? target.identity : '';
  const uin =
    [target.uin, target.identity].find((value) => value && /^[1-9]\d{4,19}$/.test(value)) ?? '';
  if (!uid && !uin) return null;
  return {
    id: uid,
    username: uid || uin,
    identityLabel: uin ? 'QQ' : 'UID',
    identityValue: uin || uid,
    displayName: target.name || uin || uid,
    avatarUrl: target.avatarUrl || avatarFromUin(uin),
  };
}

export const ProfileNavigationContext = createContext<
  ((user: User, anchor: { x: number; y: number }, group?: ProfileGroup) => void) | null
>(null);
