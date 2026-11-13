import { useCallback, useEffect, useRef } from 'react';
import { createUnreadRefresh } from '../lib/unreadRefresh';

type RefetchHead = (options: { cancelRefetch: boolean }) => Promise<{ isError: boolean }>;

export function useRecentContactHeadRefresh(refetch: RefetchHead, scope: string) {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const active = useRef<{
    scope: string;
    refresh: ReturnType<typeof createUnreadRefresh>;
  } | null>(null);
  useEffect(() => {
    // 创建与销毁属于同一次 effect，StrictMode／热更新重放不能复用已销毁的队列。
    const refresh = createUnreadRefresh(async () => {
      const result = await refetchRef.current({ cancelRefetch: false });
      return !result.isError;
    }, 100);
    active.current = { scope, refresh };
    return () => {
      refresh.dispose();
      if (active.current?.refresh === refresh) active.current = null;
    };
  }, [scope]);
  return useCallback(() => {
    if (active.current?.scope === scope) active.current.refresh.request();
  }, [scope]);
}
