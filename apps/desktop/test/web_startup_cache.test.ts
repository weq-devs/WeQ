import { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@weq/service';
import { hydrateWebStartupCache } from '../src/renderer/src/lib/webStartupCache';
import { trpc } from '../src/renderer/src/trpc/client';

it.each(['home', 'messages', 'last'] as const)(
  '快照复用当前 %s 启动设置，工作区挂载不重复读取配置',
  async (startupPage) => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: 30000 } } });
    try {
      hydrateWebStartupCache(cache, {
        native: null,
        current: { uin: '10001' },
        settings: { ...DEFAULT_APP_SETTINGS, startupPage },
        config: null,
        home: null,
      });
      const fetch = vi.fn(async () => ({ uin: 'wrong' }));
      const current = await cache.fetchQuery(
        getQueryKey(trpc.bootstrap.currentAccount, undefined, 'query'),
        fetch,
      );
      expect(current).toEqual({ uin: '10001' });
      const fetchSettings = vi.fn(async () => DEFAULT_APP_SETTINGS);
      const settings = await cache.fetchQuery(
        getQueryKey(trpc.bootstrap.getSettings, undefined, 'query'),
        fetchSettings,
      );
      expect(settings.startupPage).toBe(startupPage);
      expect(fetchSettings).not.toHaveBeenCalled();
      expect(
        cache.getQueryData(getQueryKey(trpc.account.getAccountConfig, undefined, 'query')),
      ).toBeNull();
    } finally {
      cache.clear();
    }
  },
);
