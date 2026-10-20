import { useSyncExternalStore } from 'react';
import { cachedAvatarUrl, refreshAvatarUrl } from '../lib/avatarCache';
import { avatarFetchUrl } from '../lib/resourceUrl';

const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
let serial = Date.now();

function groupKey(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, 'https://weq.invalid');
    if (url.searchParams.get('scope') === 'group') return url.searchParams.get('uid');
    const upstream = url.searchParams.get('src') ?? url.searchParams.get('fb');
    return (upstream ?? src).match(/^https?:\/\/[^/]*qlogo\.cn\/gh\/(\d+)\//i)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function refreshGroupAvatar(groupCode: string): void {
  revisions.delete(groupCode);
  revisions.set(groupCode, ++serial);
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
export function useAvatarUrl(src: string | null | undefined, wrap = true): string | null {
  const key = groupKey(src);
  const revision = useSyncExternalStore(subscribe, () => (key ? (revisions.get(key) ?? 0) : 0));
  let resolved = wrap || key ? cachedAvatarUrl(src) : (src ?? null);
  if (!revision || !resolved) return resolved;
  // CDN 直连偏好下，显式修改后的这一次刷新仍经本地桥强制回源。
  if (/^https?:/i.test(resolved)) resolved = avatarFetchUrl(resolved);
  const url = new URL(refreshAvatarUrl(resolved, revision)!, 'https://weq.invalid');
  url.searchParams.set('_weq_avatar_remote', '1');
  return resolved.startsWith('/') ? `${url.pathname}${url.search}` : url.href;
}
