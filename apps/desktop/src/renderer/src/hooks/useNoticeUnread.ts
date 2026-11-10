import { useEffect, useMemo, useRef, useState } from 'react';

export const NOTICE_SEEN_LIMIT = 4096;
const NOTICE_READ_EVENT = 'weq:notice-read';

type SeenState = { seen: string[]; readThrough: number };

/** 通知 ID 的末段来自原始记录时间，不受昵称、资料补齐或申请状态影响。 */
function noticeTimestamp(id: string): number | null {
  const match = /^(?:buddy-request:[^:]+|group-notify:[^:]+:[^:]*):(\d+)$/.exec(id);
  if (!match) return null;
  const time = Number(match[1]);
  return Number.isSafeInteger(time) && time > 0 ? time : null;
}

function latestTimestamp(ids: string[], initial = 0): number {
  return ids.reduce((latest, id) => Math.max(latest, noticeTimestamp(id) ?? 0), initial);
}

function readSeen(key: string): SeenState | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    // 兼容旧版 ID 数组；用已读记录推导水位，不把本次读到的真正新通知吞掉。
    const record = value && typeof value === 'object' && 'seen' in value ? value : null;
    const entries = Array.isArray(value) ? value : record?.seen;
    if (!Array.isArray(entries)) return null;
    const seen = entries.filter((id): id is string => typeof id === 'string');
    const storedTime = record && 'readThrough' in record ? record.readThrough : 0;
    const readThrough =
      typeof storedTime === 'number' && Number.isSafeInteger(storedTime) && storedTime >= 0
        ? storedTime
        : 0;
    return {
      seen: seen.slice(-NOTICE_SEEN_LIMIT),
      readThrough: latestTimestamp(seen, readThrough),
    };
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
  const memory = useRef(
    new Map<string, { seen: Set<string>; readThrough: number; initialized: boolean }>(),
  );
  const snapshot = useMemo(() => {
    void revision;
    const cached = memory.current.get(key);
    if (cached) return cached;
    const stored = readSeen(key);
    const result = {
      seen: new Set(stored?.seen ?? []),
      readThrough: stored?.readThrough ?? 0,
      initialized: stored !== null,
    };
    memory.current.set(key, result);
    return result;
  }, [key, revision]);
  useEffect(() => {
    const refresh = () => {
      const stored = readSeen(key);
      if (!stored) return;
      const changed =
        !snapshot.initialized ||
        stored.readThrough > snapshot.readThrough ||
        stored.seen.some((id) => !snapshot.seen.has(id));
      if (!changed) return;
      snapshot.seen = new Set(
        [...new Set([...snapshot.seen, ...stored.seen])]
          .sort((a, b) => (noticeTimestamp(a) ?? 0) - (noticeTimestamp(b) ?? 0))
          .slice(-NOTICE_SEEN_LIMIT),
      );
      snapshot.readThrough = Math.max(snapshot.readThrough, stored.readThrough);
      snapshot.initialized = true;
      setRevision((value) => value + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) refresh();
    };
    const onRead = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refresh);
    window.addEventListener(NOTICE_READ_EVENT, onRead);
    // 覆盖首次渲染到订阅生效之间其他入口的已读写入。
    refresh();
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(NOTICE_READ_EVENT, onRead);
    };
  }, [key, snapshot]);
  const { seen, readThrough, initialized } = snapshot;
  const unread =
    accountKey && ready && initialized
      ? [...new Set(ids)].filter((id) => {
          const time = noticeTimestamp(id);
          return !seen.has(id) && (time === null || time >= readThrough);
        }).length
      : 0;
  useEffect(() => {
    if (!accountKey || !ready || (initialized && (!open || !unread))) return;
    // 首次成功读取只建立历史基线；空列表也要保存，后续新增才能正常提醒。
    // 合并其他窗口的已读；优先保留较新的标识，时间水位覆盖被淘汰的较早历史。
    const stored = readSeen(key);
    const merged = new Set([...(stored?.seen ?? []), ...seen]);
    for (const id of ids) {
      merged.delete(id);
      merged.add(id);
    }
    const retained = [...merged]
      .sort((a, b) => (noticeTimestamp(a) ?? 0) - (noticeTimestamp(b) ?? 0))
      .slice(-NOTICE_SEEN_LIMIT);
    seen.clear();
    for (const id of retained) seen.add(id);
    snapshot.initialized = true;
    snapshot.readThrough = latestTimestamp(ids, Math.max(readThrough, stored?.readThrough ?? 0));
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify({ seen: retained, readThrough: snapshot.readThrough }),
      );
      window.dispatchEvent(new CustomEvent(NOTICE_READ_EVENT, { detail: key }));
    } catch {
      // 存储不可用时仍在当前会话清除红点。
    }
    setRevision((value) => value + 1);
  }, [accountKey, ready, open, unread, key, ids, seen, readThrough, initialized, snapshot]);
  return open ? 0 : unread;
}
