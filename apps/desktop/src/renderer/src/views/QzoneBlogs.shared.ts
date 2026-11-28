import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { timeDate } from '@weq/time';
import { useEffect, useMemo, useRef } from 'react';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { client, trpc } from '../trpc/client';

export type QzoneBlog = Awaited<
  ReturnType<typeof client.account.qzone.blogs.query>
>['items'][number];
type Page<T> = { items: T[]; nextOffset: number | null };

/** QQ 的十位日志编号编码了发表时间；其他编号仍用列表提供的时间。 */
export function qzoneBlogTime(blog: Pick<QzoneBlog, 'id' | 'publishedAt'>): number | string {
  const time = Number(blog.id);
  return /^[1-9]\d{9}$/.test(blog.id) && time <= Date.now() / 1000 ? time : blog.publishedAt.trim();
}

export function qzoneBlogSortTime(blog: QzoneBlog): number {
  const value = qzoneBlogTime(blog);
  return typeof value === 'number' ? value : (timeDate(value)?.getTime() ?? 0) / 1000;
}

export function repeatedPage<T extends { id: string }>(last: Page<T>, pages: Page<T>[]) {
  if (pages.length < 2 || !last.items.length) return false;
  const previous = new Set(pages.slice(0, -1).flatMap((page) => page.items.map(({ id }) => id)));
  return last.items.every(({ id }) => previous.has(id));
}

export function blogItems<T extends { id: string }>(pages: Page<T>[]) {
  const items = new Map<string, T>();
  for (const page of pages)
    for (const item of page.items) if (!items.has(item.id)) items.set(item.id, item);
  return [...items.values()];
}

export function nextPage<T extends { id: string }>(last: Page<T>, pages: Page<T>[]) {
  return repeatedPage(last, pages) ? undefined : (last.nextOffset ?? undefined);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? '读取 QQ 空间日志失败，请重试。' : '';
}

export function useQzoneBlogIndex({
  selfUin,
  hostUin,
  active,
  refresh,
}: {
  selfUin: string;
  hostUin: string;
  active: boolean;
  refresh: number;
}) {
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const configId = config.data?.uin === selfUin ? config.data.configId : undefined;
  const input = useMemo(
    () => ({ selfUin, hostUin, expectedAccountConfigId: configId ?? '' }),
    [selfUin, hostUin, configId],
  );
  const { run } = useQzoneRequests();
  const queryClient = useQueryClient();
  const { refetch, fetchNextPage, ...query } = useInfiniteQuery({
    queryKey: ['qzone-blogs', input],
    queryFn: ({ pageParam = 0, signal }) =>
      run(
        (requestId) => client.account.qzone.blogs.query({ ...input, requestId, offset: pageParam }),
        false,
        signal,
      ),
    enabled: active && Boolean(configId),
    getNextPageParam: nextPage,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const previousRefresh = useRef(refresh);
  useEffect(() => {
    if (!active) {
      void queryClient.cancelQueries({ queryKey: ['qzone-blogs', input], exact: true });
      return;
    }
    if (!configId || previousRefresh.current === refresh) return;
    previousRefresh.current = refresh;
    void refetch();
  }, [active, configId, refresh, input, queryClient, refetch]);
  const pages = query.data?.pages ?? [];
  const items = useMemo(() => blogItems(query.data?.pages ?? []), [query.data?.pages]);
  const last = pages.at(-1);
  const repeated = last && repeatedPage(last, pages);
  const error =
    errorText(config.error) ||
    errorText(query.error) ||
    (repeated
      ? '日志分页未推进，请刷新核对。'
      : active && config.isSuccess && !configId
        ? '当前账号尚未就绪，请重新打开日志。'
        : '');
  const loading = config.isFetching || query.isFetching;
  return {
    input,
    configId,
    items,
    total: pages[0]?.total,
    pages: pages.length,
    atEnd: last?.nextOffset === null,
    error,
    loading,
    success: query.isSuccess,
    hasNextPage: query.hasNextPage,
    next: () => void fetchNextPage({ cancelRefetch: false }),
    async reload() {
      const { data } = await refetch({ throwOnError: true });
      return blogItems(data?.pages ?? []);
    },
    retry: () => {
      if (!configId) void config.refetch();
      else if (query.error && query.hasNextPage) void fetchNextPage();
      else void refetch();
    },
  };
}

export type QzoneBlogIndex = ReturnType<typeof useQzoneBlogIndex>;
