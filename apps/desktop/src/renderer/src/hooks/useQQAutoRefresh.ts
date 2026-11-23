import { useEffect, useRef, useState } from 'react';
import { useTabActive } from '../components/RetainedTabs.shared';
import { useRenderDocument } from '../lib/renderDocument';
import { useRemoteClient } from '../lib/remoteClient';
import { useWebConnection } from '../state/webConnection';

/** 手写异步页与查询缓存共用可读状态，不用定时器维持前台刷新。 */
export function useQQReadActivity(
  available: boolean,
  { onlineOnly = true, remoteCache = false }: { onlineOnly?: boolean; remoteCache?: boolean } = {},
) {
  const document = useRenderDocument();
  const owner = document.defaultView ?? window;
  const tabActive = useTabActive();
  const remote = useRemoteClient();
  const readsLocalCache = remoteCache && remote;
  const requiresNetwork = onlineOnly && !readsLocalCache;
  const recovery = useWebConnection((current) => (readsLocalCache ? current.recovery : 0));
  const [state, setState] = useState(() => ({
    active: document.visibilityState !== 'hidden' && (!requiresNetwork || owner.navigator.onLine),
    revision: 0,
  }));
  const lastResume = useRef(Date.now());
  useEffect(() => {
    if (!available || !tabActive) return;
    const update = (event?: Event) => {
      const active =
        document.visibilityState !== 'hidden' && (!requiresNetwork || owner.navigator.onLine);
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
    owner.addEventListener('online', update);
    owner.addEventListener('offline', update);
    owner.addEventListener('focus', update);
    update();
    return () => {
      document.removeEventListener('visibilitychange', update);
      owner.removeEventListener('online', update);
      owner.removeEventListener('offline', update);
      owner.removeEventListener('focus', update);
    };
  }, [available, tabActive, requiresNetwork, document, owner]);
  return {
    enabled:
      available &&
      tabActive &&
      state.active &&
      document.visibilityState !== 'hidden' &&
      (!requiresNetwork || owner.navigator.onLine),
    revision: state.revision + recovery,
  };
}

/** 只重试读取；隐藏或离线时停读，不添加后台轮询。 */
export function useQQAutoRefresh(available: boolean, options?: { onlineOnly?: boolean }) {
  const { enabled } = useQQReadActivity(available, options);
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
