import { useEffect, useState } from 'react';

/** 只重试读取；隐藏或离线时停读，不添加后台轮询。 */
export function useQQAutoRefresh(available: boolean) {
  const [active, setActive] = useState(
    () => document.visibilityState !== 'hidden' && navigator.onLine,
  );
  useEffect(() => {
    const update = () => setActive(document.visibilityState !== 'hidden' && navigator.onLine);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return {
    enabled: available && active,
    retry: 2,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 4000),
    staleTime: 0,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: 'always' as const,
    refetchOnReconnect: 'always' as const,
  };
}
