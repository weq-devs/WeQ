import { useEffect, useMemo, useRef, useState } from 'react';
import {
  mergeNoticeSeen,
  noticeTimestamp,
  NOTICE_SEEN_LIMIT,
  type GroupNoticeRead,
  type NoticeSeenState,
} from '../../../shared/notice_seen';
import { confirmedGroupNoticeReads } from '../lib/contactNotice';
import { type NewNoticeNotification, useNewNoticeNotification } from './useNewNoticeNotification';

export { NOTICE_SEEN_LIMIT };
const NOTICE_READ_EVENT = 'weq:notice-read';

type SeenState = NoticeSeenState;

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
  sync?: {
    state: SeenState | null | undefined;
    qqGroupRead?: GroupNoticeRead;
    publish: (state: SeenState) => void;
  },
  notification?: NewNoticeNotification,
) {
  const key = `weq:notice-seen:${accountKey}:${kind}`;
  const [revision, setRevision] = useState(0);
  const memory = useRef(
    new Map<string, { seen: Set<string>; readThrough: number; initialized: boolean }>(),
  );
  const snapshot = useMemo(() => {
    void revision;
    const cached = memory.current.get(key);
    if (cached && !sync?.state) return cached;
    const stored = readSeen(key);
    const local = cached
      ? mergeNoticeSeen(stored, { seen: [...cached.seen], readThrough: cached.readThrough })
      : stored;
    const merged = sync?.state ? mergeNoticeSeen(local, sync.state) : local;
    const result = {
      seen: new Set(merged?.seen ?? []),
      readThrough: merged?.readThrough ?? 0,
      initialized: merged !== null,
    };
    memory.current.set(key, result);
    return result;
  }, [key, revision, sync?.state]);
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
  const synchronized = !sync || sync.state !== undefined;
  const { normal, filtered } = sync?.qqGroupRead ?? {};
  const legacyIds = notification?.legacyIds;
  const readIds = useMemo(() => {
    void revision;
    if (!normal && !filtered && !legacyIds?.size) return seen;
    const read = new Set([...seen, ...confirmedGroupNoticeReads(ids, normal, filtered)]);
    for (const [id, legacy] of legacyIds ?? []) if (seen.has(legacy)) read.add(id);
    return read;
  }, [seen, revision, ids, normal, filtered, legacyIds]);
  const unread = useMemo(() => {
    void revision;
    if (!accountKey || !ready || !synchronized) return null;
    if (!initialized) return [];
    return [...new Set(ids)].filter((id) => {
      const time = noticeTimestamp(id);
      return !readIds.has(id) && (time === null || time >= readThrough);
    });
  }, [accountKey, ready, synchronized, initialized, ids, readIds, readThrough, revision]);
  useEffect(() => {
    if (!accountKey || !ready) return;
    // 首次成功读取只建立历史基线；空列表也要保存，后续新增才能正常提醒。
    const baseline = synchronized && !initialized;
    const viewed = baseline || open ? ids.filter((id) => !seen.has(id)) : [];
    // 把旧版已读提升到规范 ID，之后只有在线条目时也能认出同一条。
    for (const [id, legacy] of legacyIds ?? [])
      if (!seen.has(id) && seen.has(legacy)) viewed.push(id);
    if (!baseline && !viewed.length) return;
    const stored = readSeen(key);
    const state = mergeNoticeSeen(stored, {
      seen: [...seen, ...viewed],
      readThrough,
    });
    if (
      initialized &&
      state.readThrough === readThrough &&
      state.seen.length === seen.size &&
      state.seen.every((id) => seen.has(id))
    )
      return;
    seen.clear();
    for (const id of state.seen) seen.add(id);
    snapshot.initialized = true;
    snapshot.readThrough = state.readThrough;
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
      window.dispatchEvent(new CustomEvent(NOTICE_READ_EVENT, { detail: key }));
    } catch {
      // 存储不可用时仍在当前会话清除红点。
    }
    setRevision((value) => value + 1);
  }, [
    accountKey,
    ready,
    synchronized,
    open,
    key,
    ids,
    seen,
    readThrough,
    initialized,
    snapshot,
    legacyIds,
  ]);
  useEffect(() => {
    if (!sync || !synchronized || !ready || !accountKey || !snapshot.initialized) return;
    const state = mergeNoticeSeen(readSeen(key), {
      seen: [...snapshot.seen],
      readThrough: snapshot.readThrough,
    });
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
      window.dispatchEvent(new CustomEvent(NOTICE_READ_EVENT, { detail: key }));
    } catch {
      // 本地存储失败仍向账号端保存。
    }
    const remote = sync.state && mergeNoticeSeen(null, sync.state);
    if (JSON.stringify(state) !== JSON.stringify(remote)) sync.publish(state);
  }, [sync, synchronized, ready, accountKey, key, revision, snapshot]);
  const unreadForDisplay = open && unread ? [] : unread;
  useNewNoticeNotification(key, ids, unreadForDisplay, readIds, readThrough, notification);
  return unreadForDisplay;
}
