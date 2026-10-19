import { useEffect, useMemo, useRef, useState } from 'react';

/** 查看状态与待处理状态独立；只保存有限的通知标识，不保存正文或联系人资料。 */
export function useNoticeUnread(
  accountKey: string,
  kind: 'friend' | 'group',
  ids: string[],
  open: boolean,
  ready: boolean,
) {
  const key = `weq:notice-seen:${accountKey}:${kind}`;
  const [revision, setRevision] = useState(0);
  const memory = useRef(new Map<string, Set<string>>());
  const seen = useMemo(() => {
    void revision;
    const cached = memory.current.get(key);
    if (cached) return cached;
    let result = new Set<string>();
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
      result = new Set(
        Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
      );
    } catch {
      /* 损坏的查看记录按未读处理。 */
    }
    memory.current.set(key, result);
    return result;
  }, [key, revision]);
  const unread = accountKey && ready ? ids.filter((id) => !seen.has(id)).length : 0;
  useEffect(() => {
    if (!accountKey || !ready || !open || !unread) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(ids));
    } catch {
      // 存储不可用时仍在当前会话清除红点。
    }
    for (const id of ids) seen.add(id);
    setRevision((value) => value + 1);
  }, [accountKey, ready, open, unread, key, ids, seen]);
  return open ? 0 : unread;
}
