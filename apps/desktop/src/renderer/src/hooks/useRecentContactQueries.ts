import { getQueryKey } from '@trpc/react-query';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, trpc } from '../trpc/client';
import type { QQWriteBinding } from './useQQWriteSession';
import { IS_WEB } from '../lib/target';

type RecentContactPage = Awaited<ReturnType<typeof client.account.listRecentContacts.query>>;

export const RECENT_HEAD_SIZE = 50;
export const RECENT_DIRECTORY_SIZE = 500;

export function recentContactHeadOptions(binding: QQWriteBinding) {
  const input = { ...binding, limit: RECENT_HEAD_SIZE, cursor: 0 };
  return {
    queryKey: getQueryKey(trpc.account.listRecentContacts, input, 'query'),
    queryFn: () => client.account.listRecentContacts.query(input),
    staleTime: 0,
  };
}

/** 最新页与缓存恢复并行；冷启动的目录首屏接用同一请求，后续仍按大页读取。 */
export function useRecentContactQueries(binding: QQWriteBinding | null, active: boolean) {
  const cache = useQueryClient();
  const scope = binding ?? { expectedAccountUin: '', expectedAccountConfigId: '' };
  const headOptions = recentContactHeadOptions(scope);
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
        : client.account.listRecentContacts.query({ ...input, cursor: pageParam as number }),
    enabled: Boolean(binding),
    getNextPageParam: (lastPage) => (lastPage.items.length ? lastPage.nextCursor : undefined),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return { contacts, head };
}
