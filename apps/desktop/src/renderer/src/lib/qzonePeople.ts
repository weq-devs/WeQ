import { createContext } from 'react';

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

export const QzonePeopleContext = createContext<{
  nickname: (uin: string, fallback?: string) => string;
  remark: (uin: string) => string;
  request: (uin: string) => void;
}>({ nickname: qzoneNickname, remark: () => '', request: () => {} });
