import { useEffect, useState } from 'react';
import { client } from '../trpc/client';

type CollectionPage = NonNullable<Awaited<ReturnType<typeof client.account.listCollections.query>>>;

/** 每次进入收藏导出重新读取；切走、卸载或切账号后丢弃在途响应。 */
export function useExportCollections(enabled: boolean, accountKey: string | null) {
  const [state, setState] = useState<{
    accountKey: string | null;
    items: CollectionPage['items'];
    loading: boolean;
    error: boolean;
  }>({ accountKey, items: [], loading: false, error: false });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled || !accountKey) return;
    let cancelled = false;
    setState({ accountKey, items: [], loading: true, error: false });
    const fetchAll = async (source: 'db' | 'network') => {
      const items: CollectionPage['items'] = [];
      for (let offset = 0; !cancelled; ) {
        const page = await client.account.listCollections.query({ limit: 100, offset, source });
        if (!page || cancelled) return null;
        items.push(...page.items);
        if (!page.hasMore || page.items.length === 0) return items;
        offset += page.items.length;
      }
      return null;
    };
    void (async () => {
      let localAvailable = false;
      try {
        const local = await fetchAll('db');
        if (cancelled) return;
        localAvailable = local !== null;
        setState({ accountKey, items: local ?? [], loading: local === null, error: false });
      } catch {
        // 继续尝试网络；只有两条路径都不可用才显示失败。
      }
      try {
        const fresh = await fetchAll('network');
        if (cancelled) return;
        setState((previous) => ({
          ...previous,
          items: fresh ?? previous.items,
          error: !localAvailable && fresh === null,
        }));
      } catch {
        if (!cancelled) setState((previous) => ({ ...previous, error: !localAvailable }));
      } finally {
        if (!cancelled) setState((previous) => ({ ...previous, loading: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, accountKey, revision]);

  return {
    ...(state.accountKey === accountKey ? state : { items: [], loading: enabled, error: false }),
    retry: () => setRevision((value) => value + 1),
  };
}
