import { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@weq/service';
import { hydrateWebStartupCache } from '../src/renderer/src/lib/webStartupCache';
import { trpc } from '../src/renderer/src/trpc/client';

it('快照填入原查询键，工作区挂载后不重复读取相同配置', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: 30000 } } });
  try {
    hydrateWebStartupCache(cache, {
      native: null,
      current: { uin: '10001' },
      settings: DEFAULT_APP_SETTINGS,
      config: null,
      home: null,
    });
    const fetch = vi.fn(async () => ({ uin: 'wrong' }));
    const current = await cache.fetchQuery(
      getQueryKey(trpc.bootstrap.currentAccount, undefined, 'query'),
      fetch,
    );
    expect(current).toEqual({ uin: '10001' });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      cache.getQueryData(getQueryKey(trpc.account.getAccountConfig, undefined, 'query')),
    ).toBeNull();
  } finally {
    cache.clear();
  }
});
