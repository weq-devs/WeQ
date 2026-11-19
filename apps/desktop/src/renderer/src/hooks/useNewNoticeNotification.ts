import { useEffect, useRef } from 'react';
import { noticeTimestamp, NOTICE_SEEN_LIMIT } from '../../../shared/notice_seen';
import { useToast } from '../components/Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';

export type NewNoticeNotification = { title: string; onOpen: () => void };

/** 首次读取建立基线，刷新时不把早于已见记录的历史回填当成新通知。 */
export function useNewNoticeNotification(
  scope: string,
  ids: string[],
  unreadIds: string[] | null,
  notification?: NewNoticeNotification,
) {
  const seen = useRef<{ scope: string; time: number; ids: Set<string> } | null>(null);
  const title = notification?.title;
  const onOpen = notification?.onOpen;
  useEffect(() => {
    if (!unreadIds || !title || !onOpen) return;
    const previous = seen.current?.scope === scope ? seen.current : null;
    let count = 0;
    if (previous) {
      for (const id of unreadIds) {
        const time = noticeTimestamp(id);
        if (time !== null && time >= previous.time && !previous.ids.has(id)) count++;
      }
    }
    const next = previous ?? { scope, time: 0, ids: new Set<string>() };
    for (const id of ids) {
      const time = noticeTimestamp(id);
      if (time === null || time < next.time) continue;
      if (time > next.time) {
        next.time = time;
        next.ids.clear();
      }
      next.ids.add(id);
    }
    while (next.ids.size > NOTICE_SEEN_LIMIT) next.ids.delete(next.ids.values().next().value!);
    seen.current = next;
    if (count)
      useToast.getState().push({
        event: 'contact',
        title,
        detail: `${count} 条新通知`,
        source: notificationSource({ kind: 'local', open: onOpen }, '查看通知'),
      });
  }, [scope, ids, unreadIds, title, onOpen]);
}
