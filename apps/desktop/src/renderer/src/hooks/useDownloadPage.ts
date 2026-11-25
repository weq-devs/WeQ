import { useCallback, useEffect, useRef } from 'react';
import { client } from '../trpc/client';

export function useDownloadPage(active: boolean) {
  const page = useRef<(() => Promise<string | undefined>) | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    let pageId: string | undefined;
    const ready = Promise.withResolvers<void>();
    // 页面订阅失联时，下载仍可通过普通请求发起。
    const timeout = window.setTimeout(ready.resolve, 1000);
    const settle = () => {
      window.clearTimeout(timeout);
      ready.resolve();
    };
    page.current = async () => {
      await ready.promise;
      return pageId;
    };
    const subscription = client.backgroundTasks.onDownloadPage.subscribe(undefined, {
      onData: (id) => {
        pageId = id;
        settle();
      },
      onError: () => {
        pageId = undefined;
        settle();
      },
    });
    return () => {
      page.current = undefined;
      pageId = undefined;
      settle();
      subscription.unsubscribe();
    };
  }, [active]);
  return useCallback(() => page.current?.(), []);
}
