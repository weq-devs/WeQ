import type { AppSettings } from '@weq/service';
import { createContext } from 'react';

export type QzoneNamePriority = AppSettings['qzoneNamePriority'];

export type QzoneLocalProfile = {
  uin: string;
  nick?: string | null;
  remark?: string | null;
  isFriend?: boolean;
};

export function qzoneNickname(uin: string, value?: string | null): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name !== uin ? name : '';
}

export function qzoneDisplayName(
  uin: string,
  nick: string,
  remark: string,
  priority: QzoneNamePriority,
): string {
  const nickname = qzoneNickname(uin, nick);
  return (priority === 'nickname' ? nickname || remark : remark || nickname) || uin;
}

export const QzonePeopleContext = createContext<{
  namePriority: QzoneNamePriority;
  nickname: (uin: string, fallback?: string) => string;
  remark: (uin: string) => string;
  request: (uin: string) => void;
}>({ namePriority: 'remark', nickname: qzoneNickname, remark: () => '', request: () => {} });
