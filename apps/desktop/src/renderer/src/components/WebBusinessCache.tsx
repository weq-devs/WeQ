import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { restoreBusinessCache, watchBusinessCache } from '../lib/webBusinessCache';
import { WebAvatarScope } from '../hooks/useAvatarImage';
import { IS_WEB } from '../lib/target.shared';
import { bindRemoteDataCache, currentRemoteDataCacheStatus } from '../lib/remoteDataCache';

/** 在业务 hooks 挂载前恢复，账号切换沿用已有的 purgeAccountQueries。 */
export function WebBusinessCache({
  scope,
  children,
  fallback,
}: {
  scope: string;
  children: ReactNode;
  fallback: ReactNode;
}): ReactNode {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const unbind = bindRemoteDataCache(scope);
    let alive = true;
    let stop: (() => Promise<void>) | undefined;
    let mounted = false;
    const watch = () => {
      if (!stop && alive) stop = watchBusinessCache(client, scope);
    };
    const start = () => {
      if (!alive || mounted) return;
      mounted = true;
      setReady(true);
    };
    // 目录慢读可以晚到，hydrate 只填补比在线结果旧的显示状态。
    const timeout = window.setTimeout(() => {
      start();
      if (!currentRemoteDataCacheStatus()) watch();
    }, 250);
    void restoreBusinessCache(
      client,
      scope,
      undefined,
      () => alive && (!mounted || Boolean(currentRemoteDataCacheStatus())),
    ).finally(() => {
      window.clearTimeout(timeout);
      watch();
      start();
    });
    return () => {
      alive = false;
      unbind();
      window.clearTimeout(timeout);
      void stop?.();
    };
  }, [client, scope]);
  if (!ready) return fallback;
  return IS_WEB ? <WebAvatarScope value={scope}>{children}</WebAvatarScope> : children;
}
