import { useEffect, useRef } from 'react';
import { useToast } from '../components/Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';

/** 首次成功读取只建立基线；切号、已读回填和资料补全不重复通知。 */
export function useNewNoticeNotification(
  scope: string,
  ids: string[],
  ready: boolean,
  title: string,
  onOpen: () => void,
) {
  const seen = useRef<{ scope: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!scope || !ready) return;
    if (seen.current?.scope !== scope) {
      seen.current = { scope, ids: new Set(ids) };
      return;
    }
    const added = ids.filter((id) => !seen.current!.ids.has(id));
    for (const id of ids) seen.current.ids.add(id);
    while (seen.current.ids.size > 4096)
      seen.current.ids.delete(seen.current.ids.values().next().value!);
    if (added.length)
      useToast.getState().push({
        event: 'contact',
        title,
        detail: `${added.length} 条新通知`,
        source: notificationSource({ kind: 'local', open: onOpen }, '查看通知'),
      });
  }, [scope, ids, ready, title, onOpen]);
}
