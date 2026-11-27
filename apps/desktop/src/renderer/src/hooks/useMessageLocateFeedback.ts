import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** 同一会话只展示最近一次定位的进度。 */
export function useMessageLocateFeedback(scope: string) {
  const active = useRef<object | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const cancel = useCallback(() => {
    active.current = null;
    setPendingScope(null);
  }, []);
  useLayoutEffect(() => {
    cancel();
    return () => {
      active.current = null;
    };
  }, [scope, cancel]);

  const run = useCallback(
    async <T>(work: (isCurrent: () => boolean) => Promise<T>): Promise<T> => {
      const started = currentScope.current;
      const task = {};
      active.current = task;
      setPendingScope(started);
      const isCurrent = () => active.current === task && currentScope.current === started;
      try {
        return await work(isCurrent);
      } finally {
        if (active.current === task) cancel();
      }
    },
    [cancel],
  );

  return { run, cancel, locating: pendingScope === scope };
}
