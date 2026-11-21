import { useCallback, useEffect, useMemo, useRef } from 'react';
import { client } from '../trpc/client';

let activeReads = 0;
const readQueue: (() => void)[] = [];
function queueRead<T>(work: () => Promise<T>, background: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      activeReads++;
      void Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          activeReads--;
          readQueue.shift()?.();
        });
    };
    if (activeReads < 2) start();
    else if (background) readQueue.push(start);
    else readQueue.unshift(start);
  });
}

/**
 * Bound queued reads to their mounted pane and propagate cancellation to main.
 *
 * `scope` 选主进程里哪个路由持有这些 requestId：旧空间 cgi 在 `qzone`，
 * 空友爱看（h5 gotrpc）在 `qzonePublic`，两边各有一张 pending 表，不能混着取消。
 */
export function useQzoneRequests(scope: 'qzone' | 'qzonePublic' = 'qzone') {
  const ids = useRef(new Set<string>());
  const cancelRequest = useCallback(
    (requestId: string) => {
      if (!ids.current.delete(requestId)) return;
      const cancelRoute =
        scope === 'qzonePublic' ? client.account.qzonePublic.cancel : client.account.qzone.cancel;
      void cancelRoute.mutate({ requestId }).catch(() => {});
    },
    [scope],
  );
  const cancel = useCallback(() => {
    for (const requestId of ids.current) cancelRequest(requestId);
  }, [cancelRequest]);
  useEffect(() => cancel, [cancel]);
  const run = useCallback(
    async <T>(
      work: (requestId: string) => Promise<T>,
      background = false,
      signal?: AbortSignal,
    ): Promise<T> => {
      signal?.throwIfAborted();
      const requestId = crypto.randomUUID();
      ids.current.add(requestId);
      const abort = () => cancelRequest(requestId);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        return await queueRead(() => {
          if (!ids.current.has(requestId)) throw new Error('空间加载已取消。');
          return work(requestId);
        }, background);
      } finally {
        signal?.removeEventListener('abort', abort);
        ids.current.delete(requestId);
      }
    },
    [cancelRequest],
  );
  // 返回值必须稳定：调用方会把整个对象放进 effect 依赖数组，每次渲染新对象
  // 会让 effect 反复重跑（进而无限发请求）。
  return useMemo(() => ({ run, cancel }), [run, cancel]);
}
