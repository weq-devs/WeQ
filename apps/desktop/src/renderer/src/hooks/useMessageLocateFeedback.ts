import { useCallback, useLayoutEffect, useRef } from 'react';
import { useToastApi } from '../components/Toast.shared';
import type { NotificationSource } from '../lib/notificationNavigation';

/** 定位任务独占一条进度提示；换会话或后续定位会使旧任务失效。 */
export function useMessageLocateFeedback(scope: string) {
  const notificationToast = useToastApi();
  const active = useRef<{ id: number; scope: string } | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const clear = useCallback(() => {
    if (active.current) notificationToast.remove(active.current.id);
    active.current = null;
  }, [notificationToast]);
  useLayoutEffect(() => clear, [scope, clear]);

  const run = useCallback(
    async <T>(
      work: (isCurrent: () => boolean) => Promise<T>,
      source?: NotificationSource,
    ): Promise<T> => {
      clear();
      const task = {
        scope: currentScope.current,
        id: notificationToast.push({
          title: '正在加载目标消息…',
          detail: '正在读取目标消息及附近记录',
          loading: true,
          dismissible: false,
          source,
        }),
      };
      active.current = task;
      const isCurrent = () => active.current === task && currentScope.current === task.scope;
      try {
        return await work(isCurrent);
      } finally {
        if (active.current === task) clear();
      }
    },
    [clear, notificationToast],
  );
  return { run, cancel: clear };
}
