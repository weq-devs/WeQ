import { useSyncExternalStore } from 'react';
import {
  cachedAvatarUrl,
  qqAvatarIdentity,
  qqAvatarIdentityForUin,
  refreshAvatarUrl,
} from '../lib/avatarCache';
import { avatarFetchUrl } from '../lib/resourceUrl';
import { useDataSaver } from '../lib/dataSaver';

const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
let serial = Date.now();

export function refreshGroupAvatar(groupCode: string): void {
  refreshAvatar(`group:${groupCode}`);
}

export function refreshUserAvatar(uin: string): void {
  refreshAvatar(`user:${uin}`);
}

function refreshAvatar(key: string): void {
  revisions.delete(key);
  revisions.set(key, ++serial);
  if (revisions.size > 128) revisions.delete(revisions.keys().next().value!);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 只让被修改的头像重取；版本只加在本地桥，不污染上游 URL 和磁盘缓存键。 */
export function useAvatarUrl(
  src: string | null | undefined,
  wrap = true,
  variant: 'big' | 'small' = 'big',
  uin?: string | null,
): string | null {
  const limited = useDataSaver((state) => state.enabled);
  useDataSaver((state) => state.behavior.dataSaverAvatars);
  const key = qqAvatarIdentity(src) ?? qqAvatarIdentityForUin(uin);
  const getSnapshot = () => (key ? (revisions.get(key) ?? 0) : 0);
  const revision = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  let resolved = wrap || key ? cachedAvatarUrl(src, limited ? 'small' : variant) : (src ?? null);
  if (!revision || !resolved) return resolved;
  // CDN 直连偏好下，显式修改后的这一次刷新仍经本地桥强制回源。
  if (/^https?:/i.test(resolved)) resolved = avatarFetchUrl(resolved);
  const url = new URL(refreshAvatarUrl(resolved, revision)!, 'https://weq.invalid');
  url.searchParams.set('_weq_avatar_remote', '1');
  return resolved.startsWith('/') ? `${url.pathname}${url.search}` : url.href;
}
