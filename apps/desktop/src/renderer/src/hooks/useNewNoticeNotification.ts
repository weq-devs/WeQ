import { useEffect, useRef } from 'react';
import { noticeTimestamp, NOTICE_SEEN_LIMIT } from '../../../shared/notice_seen';
import { useToast } from '../components/Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { preferenceValue } from '../lib/clientPreferences';
import { useAppLock } from '../state/lock';

export type NewNoticeNotification = {
  title: string;
  onOpen: () => void;
  handledIds?: ReadonlySet<string>;
  describe?: (id: string) => { title: string; summary: string } | undefined;
};

/** 首次读取建立基线，刷新时不把早于已见记录的历史回填当成新通知。 */
export function useNewNoticeNotification(
  scope: string,
  ids: string[],
  unreadIds: string[] | null,
  readIds: ReadonlySet<string>,
  readThrough: number,
  notification?: NewNoticeNotification,
) {
  const seen = useRef<{ scope: string; time: number; ids: Set<string> } | null>(null);
  const banners = useRef(
    new Map<number, { scope: string; items: Array<{ id: string; handled: boolean }> }>(),
  );
  const title = notification?.title;
  const onOpen = notification?.onOpen;
  const handledIds = notification?.handledIds;
  const describe = notification?.describe;
  useEffect(() => {
    if (!unreadIds || !title || !onOpen) return;
    const previous = seen.current?.scope === scope ? seen.current : null;
    const toast = useToast.getState();
    if (banners.current.size) {
      const active = new Set(toast.toasts.map(({ id }) => id));
      for (const [bannerId, owner] of banners.current) {
        if (!active.has(bannerId)) banners.current.delete(bannerId);
        else if (
          owner.scope === scope &&
          owner.items.every(
            ({ id, handled }) =>
              readIds.has(id) ||
              (noticeTimestamp(id) ?? Infinity) < readThrough ||
              (!handled && handledIds?.has(id)),
          )
        ) {
          toast.dismiss(bannerId);
          banners.current.delete(bannerId);
        }
      }
    }
    const additions: string[] = [];
    if (previous) {
      for (const id of unreadIds) {
        const time = noticeTimestamp(id);
        if (time !== null && time >= previous.time && !previous.ids.has(id)) additions.push(id);
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
    if (additions.length) {
      const newest = additions.reduce((current, id) =>
        (noticeTimestamp(id) ?? 0) > (noticeTimestamp(current) ?? 0) ? id : current,
      );
      const hide = useAppLock.getState().locked || preferenceValue('privacyMode');
      const copy = hide ? undefined : describe?.(newest);
      const batch = additions.length > 1;
      const bannerId = toast.push({
        event: 'contact',
        title: copy && !batch ? copy.title : `${title} · ${additions.length} 条新通知`,
        summary: copy
          ? [batch ? copy.title : '', copy.summary].filter(Boolean).join(' · ')
          : undefined,
        source: notificationSource({ kind: 'local', open: onOpen }, '查看通知'),
      });
      banners.current.set(bannerId, {
        scope,
        items: additions.map((id) => ({ id, handled: handledIds?.has(id) ?? false })),
      });
    }
  }, [scope, ids, unreadIds, readIds, readThrough, title, onOpen, handledIds, describe]);
}
