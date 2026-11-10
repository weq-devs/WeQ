import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { restoreBusinessCache, watchBusinessCache } from '../lib/webBusinessCache';

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
    let alive = true;
    let stop: (() => Promise<void>) | undefined;
    const finish = () => {
      stop = watchBusinessCache(client, scope);
      setReady(true);
    };
    // 存储被占用不能阻塞首屏；迟到结果也不得覆盖已开始的在线读取。
    const timeout = window.setTimeout(() => {
      alive = false;
      finish();
    }, 250);
    void restoreBusinessCache(client, scope, undefined, () => alive).then(() => {
      if (!alive) return;
      window.clearTimeout(timeout);
      finish();
    });
    return () => {
      alive = false;
      window.clearTimeout(timeout);
      void stop?.();
    };
  }, [client, scope]);
  return ready ? children : fallback;
}
