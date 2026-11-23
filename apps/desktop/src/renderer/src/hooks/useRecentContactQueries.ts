import { getQueryKey } from '@trpc/react-query';
import { useEffect } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { client, trpc } from '../trpc/client';
import type { QQWriteBinding } from './useQQWriteSession';
import { IS_WEB } from '../lib/target.shared';
import { readDirectory } from '../lib/conditionalCache';
import { subscribeWorkspaceRecovery } from '../lib/connectionRecovery';
import { createUnreadRefresh } from '../lib/unreadRefresh';

type RecentContactPage = Awaited<ReturnType<typeof client.account.listRecentContacts.query>>;

export const RECENT_HEAD_SIZE = 50;
export const RECENT_DIRECTORY_SIZE = 500;

export function recentContactHeadOptions(binding: QQWriteBinding, cache?: QueryClient) {
  const input = { ...binding, limit: RECENT_HEAD_SIZE, cursor: 0 };
  const queryKey = getQueryKey(trpc.account.listRecentContacts, input, 'query');
  return {
    queryKey,
    queryFn: () =>
      readDirectory(
        'listRecentContacts',
        binding,
        cache?.getQueryData<RecentContactPage>(queryKey),
        () => client.account.listRecentContacts.query(input),
        input,
      ),
    staleTime: 0,
  };
}

/** 最新页与缓存恢复并行；冷启动的目录首屏接用同一请求，后续仍按大页读取。 */
export function useRecentContactQueries(binding: QQWriteBinding | null, active: boolean) {
  const cache = useQueryClient();
  const scope = binding ?? { expectedAccountUin: '', expectedAccountConfigId: '' };
  const headOptions = recentContactHeadOptions(scope, cache);
  const head = useQuery<RecentContactPage, Error>({
    ...headOptions,
    enabled: Boolean(binding) && active,
    refetchOnMount: !IS_WEB,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    keepPreviousData: false,
  });
  const input = { ...scope, limit: RECENT_DIRECTORY_SIZE };
  const directoryKey = getQueryKey(trpc.account.listRecentContacts, input, 'infinite');
  const contacts = useInfiniteQuery<RecentContactPage, Error>({
    queryKey: directoryKey,
    queryFn: ({ pageParam = 0 }) =>
      pageParam === 0
        ? cache.fetchQuery({
            ...headOptions,
            // 初次接用已预取的首屏，不按挂载快慢重新请求；全目录校准仍读取最新页。
            staleTime:
              cache.getQueryData(directoryKey) ||
              cache.getQueryState(headOptions.queryKey)?.fetchStatus === 'fetching'
                ? 0
                : Infinity,
          })
        : (() => {
            const cursor = pageParam as number;
            const saved = cache.getQueryData<InfiniteData<RecentContactPage>>(directoryKey);
            const index = saved?.pageParams.indexOf(cursor) ?? -1;
            const page = { ...input, cursor, ...(!IS_WEB ? { summaryOnly: true } : {}) };
            return readDirectory(
              'listRecentContacts',
              binding,
              index < 0 ? undefined : saved?.pages[index],
              () => client.account.listRecentContacts.query(page),
              page,
            );
          })(),
    enabled: Boolean(binding),
    getNextPageParam: (lastPage) => (lastPage.items.length ? lastPage.nextCursor : undefined),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { refetch } = contacts;
  const { expectedAccountUin, expectedAccountConfigId } = scope;
  useEffect(() => {
    if (!IS_WEB || !expectedAccountUin || !expectedAccountConfigId) return;
    const key = getQueryKey(
      trpc.account.listRecentContacts,
      { expectedAccountUin, expectedAccountConfigId, limit: RECENT_DIRECTORY_SIZE },
      'infinite',
    );
    let disposed = false;
    const refresh = createUnreadRefresh(async () => {
      // 翻页在途时先等它完成；一次续页成功并不等于已校准旧页。
      if (cache.getQueryState(key)?.fetchStatus !== 'idle') await refetch({ cancelRefetch: false });
      if (disposed) return true;
      // 从首批起按新游标续读。旧目录在校准完成前继续显示。
      return !(await refetch({ cancelRefetch: false })).isError;
    });
    const unsubscribe = subscribeWorkspaceRecovery(refresh.request);
    return () => {
      disposed = true;
      unsubscribe();
      refresh.dispose();
    };
  }, [cache, expectedAccountUin, expectedAccountConfigId, refetch]);
  return { contacts, head };
}
