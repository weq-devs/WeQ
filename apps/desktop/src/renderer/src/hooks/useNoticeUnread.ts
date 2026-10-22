import { useEffect, useMemo, useRef, useState } from 'react';

export const NOTICE_SEEN_LIMIT = 4096;

function readSeen(key: string): string[] | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string').slice(-NOTICE_SEEN_LIMIT)
      : null;
  } catch {
    return null;
  }
}

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
  const memory = useRef(new Map<string, { seen: Set<string>; initialized: boolean }>());
  const snapshot = useMemo(() => {
    void revision;
    const cached = memory.current.get(key);
    if (cached) return cached;
    const stored = readSeen(key);
    const result = { seen: new Set(stored ?? []), initialized: stored !== null };
    memory.current.set(key, result);
    return result;
  }, [key, revision]);
  const { seen, initialized } = snapshot;
  const unread = accountKey && ready && initialized ? ids.filter((id) => !seen.has(id)).length : 0;
  useEffect(() => {
    if (!accountKey || !ready || (initialized && (!open || !unread))) return;
    // 首次成功读取只建立历史基线；空列表也要保存，后续新增才能正常提醒。
    // 合并历史与其他窗口写下的已读；当前批次放最后，不能覆盖掉之前看过的通知。
    const merged = new Set([...(readSeen(key) ?? []), ...seen]);
    for (const id of ids) {
      merged.delete(id);
      merged.add(id);
    }
    const retained = [...merged].slice(-Math.max(NOTICE_SEEN_LIMIT, new Set(ids).size));
    seen.clear();
    for (const id of retained) seen.add(id);
    snapshot.initialized = true;
    try {
      window.localStorage.setItem(key, JSON.stringify(retained));
    } catch {
      // 存储不可用时仍在当前会话清除红点。
    }
    setRevision((value) => value + 1);
  }, [accountKey, ready, open, unread, key, ids, seen, initialized, snapshot]);
  return open ? 0 : unread;
}
