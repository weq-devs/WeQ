import { useCallback, useEffect, useMemo, useRef } from 'react';
import { client } from '../trpc/client';

let activeReads = 0;
let activeBackgroundReads = 0;
const foregroundReads = new Set<() => void>();
const backgroundReads = new Set<() => void>();

function pumpReads() {
  while (activeReads < 2) {
    // 两个后台读取不能同时占用空间的两个名额。
    const queue = foregroundReads.size
      ? foregroundReads
      : activeBackgroundReads === 0
        ? backgroundReads
        : undefined;
    const start = queue?.values().next().value;
    if (!start) return;
    queue?.delete(start);
    start();
  }
}

function queueRead<T>(
  work: () => Promise<T>,
  background: boolean,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const queue = background ? backgroundReads : foregroundReads;
    const cancel = () => {
      queue.delete(start);
      reject(signal.reason);
    };
    const start = (): void => {
      activeReads++;
      if (background) activeBackgroundReads++;
      void Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return work();
        })
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener('abort', cancel);
          activeReads--;
          if (background) activeBackgroundReads--;
          pumpReads();
        });
    };
    signal.addEventListener('abort', cancel, { once: true });
    queue.add(start);
    pumpReads();
  });
}

/**
 * Bound queued reads to their mounted pane and propagate cancellation to main.
 *
 * `scope` 选主进程里哪个路由持有这些 requestId：旧空间 cgi 在 `qzone`，
 * 空友爱看（h5 gotrpc）在 `qzonePublic`，两边各有一张 pending 表，不能混着取消。
 */
export function useQzoneRequests(scope: 'qzone' | 'qzonePublic' = 'qzone') {
  const requests = useRef(new Map<string, { controller: AbortController; sent: boolean }>());
  const cancelRequest = useCallback(
    (requestId: string, reason = new DOMException('空间加载已取消。', 'AbortError')) => {
      const request = requests.current.get(requestId);
      if (!request) return;
      requests.current.delete(requestId);
      request.controller.abort(reason);
      if (!request.sent) return;
      const cancelRoute =
        scope === 'qzonePublic' ? client.account.qzonePublic.cancel : client.account.qzone.cancel;
      void cancelRoute.mutate({ requestId }).catch(() => {});
    },
    [scope],
  );
  const cancel = useCallback(() => {
    for (const requestId of requests.current.keys()) cancelRequest(requestId);
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
      const request = { controller: new AbortController(), sent: false };
      requests.current.set(requestId, request);
      const abort = () => cancelRequest(requestId, signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        return await queueRead(
          () => {
            request.sent = true;
            return work(requestId);
          },
          background,
          request.controller.signal,
        );
      } finally {
        signal?.removeEventListener('abort', abort);
        requests.current.delete(requestId);
      }
    },
    [cancelRequest],
  );
  // 返回值必须稳定：调用方会把整个对象放进 effect 依赖数组，每次渲染新对象
  // 会让 effect 反复重跑（进而无限发请求）。
  return useMemo(() => ({ run, cancel }), [run, cancel]);
}
