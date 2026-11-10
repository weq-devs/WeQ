import { createContext } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { trpc } from '../trpc/client';

export const WebStartupCache = createContext<QueryClient | null>(null);
export const WEB_STARTUP_CACHE_KEY = ['weq-web-startup-snapshot'] as const;
type Snapshot = NonNullable<inferRouterOutputs<AppRouter>['startup']['snapshot']['snapshot']>;

export function hydrateWebStartupCache(cache: QueryClient, data: Snapshot): void {
  cache.setQueryData(WEB_STARTUP_CACHE_KEY, true);
  cache.setQueryData(getQueryKey(trpc.bootstrap.nativeStatus, undefined, 'query'), data.native);
  cache.setQueryData(getQueryKey(trpc.bootstrap.currentAccount, undefined, 'query'), data.current);
  cache.setQueryData(getQueryKey(trpc.bootstrap.getSettings, undefined, 'query'), data.settings);
  if (data.config !== undefined)
    cache.setQueryData(getQueryKey(trpc.account.getAccountConfig, undefined, 'query'), data.config);
  if (data.home) {
    const [install, configs, auto] = data.home;
    if (install !== undefined)
      cache.setQueryData(getQueryKey(trpc.bootstrap.describeInstall, undefined, 'query'), install);
    if (configs !== undefined)
      cache.setQueryData(
        getQueryKey(trpc.bootstrap.listAccountConfigs, undefined, 'query'),
        configs,
      );
    if (auto !== undefined)
      cache.setQueryData(
        getQueryKey(trpc.bootstrap.getAutoEnter, { startup: false }, 'query'),
        auto,
      );
  }
}
