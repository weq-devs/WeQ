import { createContext } from 'react';
import { z } from 'zod';
import type { Contact, GroupConversation, User } from '../im-template/template/types';
import { avatarFromUin } from './avatarResolver';
import type { SettingsNavigation } from '../hooks/useSettingsNavigation';

export const ProfileNavigationGuardContext = createContext<
  ((guard: SettingsNavigation) => () => void) | null
>(null);

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

export const contactWorkspaceTabSchema = z.enum([
  'profile',
  'details',
  'signatures',
  'labels',
  'questions',
  'marks',
  'group',
  'personality',
  'portrait',
  'history',
  'edit',
]);
export type ContactWorkspaceTab = z.infer<typeof contactWorkspaceTabSchema>;
export type GroupWorkspaceTab =
  | 'profile'
  | 'details'
  | 'members'
  | 'announcements'
  | 'albums'
  | 'files'
  | 'essence'
  | 'sign'
  | 'management'
  | 'history';
export type ContactWorkspaceTarget =
  | {
      kind: 'person';
      contact: Contact;
      tab?: ContactWorkspaceTab;
      group?: ProfileGroup;
      labelId?: string;
    }
  | {
      kind: 'group';
      conversation: GroupConversation;
      section?: GroupWorkspaceTab;
      albumId?: string;
      folderId?: string;
      fileId?: string;
    };

/** 小名片展开到联系人详情，不向好友或群目录写入临时对象。 */
export const ContactWorkspaceNavigationContext = createContext<
  ((target: ContactWorkspaceTarget) => void) | null
>(null);
