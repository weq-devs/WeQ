import { getQueryKey } from '@trpc/react-query';
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
            const page = { ...input, cursor };
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
  return { contacts, head };
}
