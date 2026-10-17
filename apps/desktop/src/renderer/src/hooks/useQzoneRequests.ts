import { useCallback, useEffect, useRef } from 'react';
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

/** Bound queued reads to their mounted pane and propagate cancellation to main. */
export function useQzoneRequests() {
  const ids = useRef(new Set<string>());
  const cancel = useCallback(() => {
    for (const requestId of ids.current)
      void client.account.qzone.cancel.mutate({ requestId }).catch(() => {});
    ids.current.clear();
  }, []);
  useEffect(() => cancel, [cancel]);
  const run = useCallback(
    async <T>(work: (requestId: string) => Promise<T>, background = false): Promise<T> => {
      const requestId = crypto.randomUUID();
      ids.current.add(requestId);
      try {
        return await queueRead(() => {
          if (!ids.current.has(requestId)) throw new Error('空间加载已取消。');
          return work(requestId);
        }, background);
      } finally {
        ids.current.delete(requestId);
      }
    },
    [],
  );
  return { run, cancel };
}
