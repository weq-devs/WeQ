import { useEffect, useRef, useState } from 'react';
import { useTabActive } from '../components/RetainedTabs';

/** 手写异步页与查询缓存共用可读状态，不用定时器维持前台刷新。 */
export function useQQReadActivity(
  available: boolean,
  { onlineOnly = true }: { onlineOnly?: boolean } = {},
) {
  const tabActive = useTabActive();
  const [state, setState] = useState(() => ({
    active: document.visibilityState !== 'hidden' && (!onlineOnly || navigator.onLine),
    revision: 0,
  }));
  const lastResume = useRef(Date.now());
  useEffect(() => {
    const update = (event?: Event) => {
      const active = document.visibilityState !== 'hidden' && (!onlineOnly || navigator.onLine);
      const now = Date.now();
      const focusRefresh = active && event?.type === 'focus' && now - lastResume.current > 250;
      if (active) lastResume.current = now;
      setState((current) => {
        const resumed = active && (!current.active || focusRefresh);
        return current.active === active && !resumed
          ? current
          : {
              active,
              revision: current.revision + (resumed ? 1 : 0),
            };
      });
    };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener('focus', update);
    update();
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('focus', update);
    };
  }, [onlineOnly]);
  return { enabled: available && tabActive && state.active, revision: state.revision };
}

/** 只重试读取；隐藏或离线时停读，不添加后台轮询。 */
export function useQQAutoRefresh(available: boolean) {
  const { enabled } = useQQReadActivity(available);
  return {
    enabled,
    retry: 2,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 4000),
    staleTime: 0,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: 'always' as const,
    refetchOnReconnect: 'always' as const,
  };
}
