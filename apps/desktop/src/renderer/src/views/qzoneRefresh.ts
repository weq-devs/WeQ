import { createContext, useContext, useLayoutEffect, useState, type RefObject } from 'react';
import { useStableCallback } from '../hooks/useStableCallback';
import type { ScrollToPosition } from '../lib/scrollToNewest';

type Refresh = (signal: AbortSignal) => Promise<boolean>;

export const QzoneRefreshContext = createContext<((refresh: Refresh) => () => void) | null>(null);
export const QzoneRefreshScrollContext = createContext<RefObject<ScrollToPosition | null> | null>(
  null,
);

/** 当前栏目注册自己的读取入口，返回是否有新内容可定位。 */
export function useQzoneRefresh(refresh: Refresh, enabled: boolean, scope?: string): void {
  const register = useContext(QzoneRefreshContext);
  const run = useStableCallback(refresh);
  useLayoutEffect(() => {
    if (enabled) return register?.(run);
  }, [enabled, register, run, scope]);
}

type RefreshRequest = {
  signal: AbortSignal;
  readonly pending: boolean;
  resolve: (hasNew: boolean) => void;
  reject: (error: unknown) => void;
};

/** 同一个读取 effect 处理翻页、自动刷新和工具栏刷新。 */
export function useQzoneRefreshRequest(enabled: boolean, scope?: string): RefreshRequest | null {
  const [request, setRequest] = useState<RefreshRequest | null>(null);
  useQzoneRefresh(
    (signal) =>
      new Promise((resolve, reject) => {
        let pending = true;
        const finish = () => {
          pending = false;
          signal.removeEventListener('abort', abort);
        };
        const abort = () => {
          finish();
          resolve(false);
        };
        signal.addEventListener('abort', abort, { once: true });
        setRequest({
          signal,
          get pending() {
            return pending;
          },
          resolve(hasNew) {
            finish();
            resolve(hasNew);
          },
          reject(error) {
            finish();
            reject(error);
          },
        });
      }),
    enabled,
    scope,
  );
  return request;
}

/** 首次重叠之前的新条目才会改变最新位置，旧条目补到页尾时维持原位。 */
export function hasNewQzoneItems<T>(
  previous: readonly T[],
  incoming: readonly T[],
  key: (entry: T) => string,
): boolean {
  if (!incoming.length) return false;
  const firstKey = key(incoming[0]!);
  return !previous.some((item) => key(item) === firstKey);
}
