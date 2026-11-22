import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { QzoneShareCategory } from '@weqbot/protocol/web';
import { useContext, useEffect, useMemo, useRef } from 'react';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { client, trpc } from '../trpc/client';
import { QzonePageContext } from './qzoneShared.shared';

export type Space = {
  selfUin: string;
  hostUin: string;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
};
type Request = Pick<Space, 'selfUin' | 'hostUin'> & {
  requestId: string;
  expectedAccountConfigId: string;
};
type Page = { items: { id: string }[]; next: number | null };
type ReadScope = { active?: boolean; refresh?: number };

function useSpaceRequest(
  { selfUin, hostUin }: Pick<Space, 'selfUin' | 'hostUin'>,
  scope?: ReadScope,
) {
  const page = useContext(QzonePageContext);
  const active = scope?.active ?? page.active;
  const refresh = scope?.refresh ?? page.refresh;
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const configId = (config.data?.uin === selfUin ? config.data.configId : undefined) ?? '';
  const target = useMemo(
    () => ({ selfUin, hostUin, expectedAccountConfigId: configId }),
    [selfUin, hostUin, configId],
  );
  return {
    active,
    refresh,
    error: config.error,
    retryConfig: config.refetch,
    configId,
    target,
  };
}

export function useMorePages<P extends Page>(
  space: Pick<Space, 'selfUin' | 'hostUin'>,
  key: string,
  start: number,
  load: (input: Request, offset: number) => Promise<P>,
  scope?: ReadScope,
) {
  const { active, refresh, configId, target, error, retryConfig } = useSpaceRequest(space, scope);
  const { run } = useQzoneRequests();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['qzone-more', target, key, start] as const, [target, key, start]);
  const enabled = active && Boolean(configId);
  const query = useInfiniteQuery({
    queryKey,
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    refetchOnMount: true,
    queryFn: ({ pageParam = start, signal }) =>
      run((requestId) => load({ ...target, requestId }, pageParam), false, signal),
    getNextPageParam: (last: P, pages: P[]) => {
      if (!last.items.length || last.next === null || last.next === start) return undefined;
      if (pages.length > 1) {
        if (pages.slice(0, -1).some((page) => page.next === last.next)) return undefined;
        const preceding = new Set(
          pages.slice(0, -1).flatMap((page) => page.items.map(({ id }) => id)),
        );
        if (last.items.every(({ id }) => preceding.has(id))) return undefined;
      }
      return last.next;
    },
  });
  const { refetch } = query;
  const previousRefresh = useRef(refresh);
  useEffect(() => {
    if (!enabled) {
      void queryClient.cancelQueries({
        queryKey,
        exact: true,
        predicate: (query) => !query.isActive(),
      });
      return;
    }
    if (previousRefresh.current === refresh) return;
    previousRefresh.current = refresh;
    void refetch({ cancelRefetch: false });
  }, [enabled, queryClient, queryKey, refresh, refetch]);
  const pages = query.data?.pages;
  const items = useMemo(() => {
    const distinct = new Map<string, P['items'][number]>();
    for (const page of pages ?? []) {
      for (const item of page.items as P['items'])
        if (!distinct.has(item.id)) distinct.set(item.id, item);
    }
    return [...distinct.values()] as P['items'];
  }, [pages]);
  const failure = error ?? query.error;
  return {
    first: pages?.[0],
    pageCount: pages?.length ?? 0,
    configId,
    refresh,
    items,
    error: failure instanceof Error ? failure.message : failure ? '读取失败，请重试。' : '',
    loading: query.isFetching || (active && !configId && !error),
    initialLoading: !pages && (query.isFetching || (active && !configId && !error)),
    paging: query.isFetchingNextPage,
    onNext:
      active && query.hasNextPage
        ? () => void query.fetchNextPage({ cancelRefetch: false })
        : undefined,
    onRetry: () => void (error ? retryConfig() : refetch()),
  };
}

export function useQzoneShareIndex(
  space: Pick<Space, 'selfUin' | 'hostUin'>,
  category: QzoneShareCategory = 0,
  scope?: ReadScope,
) {
  return useMorePages(
    space,
    `shares:${category}`,
    1,
    (input, page) => client.account.qzone.shares.query({ ...input, category, page }),
    scope,
  );
}

export type QzoneShareIndex = ReturnType<typeof useQzoneShareIndex>;
