import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RECENT_DIRECTORY_SIZE,
  RECENT_HEAD_SIZE,
  recentContactHeadOptions,
  useRecentContactQueries,
} from '../src/renderer/src/hooks/useRecentContactQueries';
import { trpc } from '../src/renderer/src/trpc/client';

const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/trpc/client', async () => {
  const { createTRPCReact } = await import('@trpc/react-query');
  return {
    trpc: createTRPCReact(),
    client: { account: { listRecentContacts: { query: api.read } } },
  };
});

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  api.read.mockReset();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  let queries!: ReturnType<typeof useRecentContactQueries>;
  function Probe({ configId = binding.expectedAccountConfigId }: { configId?: string }) {
    queries = useRecentContactQueries({ ...binding, expectedAccountConfigId: configId }, true);
    return h(
      'span',
      null,
      JSON.stringify({ head: queries.head.data, directory: queries.contacts.data }),
    );
  }
  const render = async (configId?: string) => {
    await act(async () => {
      root.render(h(QueryClientProvider, { client: cache }, h(Probe, { configId })));
    });
    await settle();
  };
  cleanups.push(() => {
    act(() => root.unmount());
    cache.clear();
  });
  return { cache, host, render, queries: () => queries };
}
const page = (label: string, nextCursor?: number) => ({
  items: [{ targetUid: label }],
  total: 700,
  nextCursor,
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

it('无缓存最新页与目录首屏共用一次小页请求，后续从小页游标按大页补齐', async () => {
  const f = fixture();
  api.read.mockResolvedValueOnce(page('new', RECENT_HEAD_SIZE));
  await f.render();
  expect(f.queries().contacts.data?.pages).toHaveLength(1);
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(api.read).toHaveBeenCalledWith({ ...binding, limit: RECENT_HEAD_SIZE, cursor: 0 });
  api.read.mockResolvedValueOnce(page('older'));
  await act(async () => {
    await f.queries().contacts.fetchNextPage();
  });
  await settle();
  expect(api.read).toHaveBeenLastCalledWith({
    ...binding,
    limit: RECENT_DIRECTORY_SIZE,
    cursor: RECENT_HEAD_SIZE,
  });
  expect(
    f.queries().contacts.data?.pages.flatMap((p) => p.items.map((row) => row.targetUid)),
  ).toEqual(['new', 'older']);
});

it('缓存恢复期间已请求最新页，挂载后接用成功结果，不重复读取', async () => {
  const f = fixture();
  api.read.mockResolvedValue(page('prefetched', RECENT_HEAD_SIZE));
  await f.cache.prefetchQuery(recentContactHeadOptions(binding));
  expect(api.read).toHaveBeenCalledOnce();
  // 缓存恢复或界面挂载较慢，也不能因此再发一份相同首屏。
  f.cache.setQueryData(
    recentContactHeadOptions(binding).queryKey,
    page('prefetched', RECENT_HEAD_SIZE),
    {
      updatedAt: Date.now() - 5000,
    },
  );
  await f.render();
  expect(f.queries().contacts.data?.pages[0]?.items[0]?.targetUid).toBe('prefetched');
  expect(api.read).toHaveBeenCalledOnce();
});

it('旧最新页存在而刷新仍在途时，目录首屏等待同一新请求，不用旧游标起步', async () => {
  const f = fixture();
  const options = recentContactHeadOptions(binding);
  f.cache.setQueryData(options.queryKey, page('old-head', 500));
  let finish!: (value: ReturnType<typeof page>) => void;
  api.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.cache.prefetchQuery(options);
  await f.render();
  expect(f.queries().contacts.data).toBeUndefined();
  await act(async () => {
    finish(page('fresh-head', RECENT_HEAD_SIZE));
    await pending;
  });
  await settle();
  expect(f.queries().contacts.data?.pages[0]?.items[0]?.targetUid).toBe('fresh-head');
  expect(api.read).toHaveBeenCalledOnce();
});

it('有完整旧目录时立即刷新小页，不等待目录刷新，旧分页在新结果返回前后均保留', async () => {
  const f = fixture();
  f.cache.setQueryData(
    getQueryKey(
      trpc.account.listRecentContacts,
      { ...binding, limit: RECENT_DIRECTORY_SIZE },
      'infinite',
    ),
    { pages: [page('cached', 500), page('cached-older')], pageParams: [undefined, 500] },
  );
  let finish!: (value: ReturnType<typeof page>) => void;
  api.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.render();
  expect(api.read).toHaveBeenCalledOnce();
  expect(f.host.textContent).toContain('cached-older');
  await act(async () => {
    finish(page('latest', RECENT_HEAD_SIZE));
  });
  await settle();
  expect(f.queries().head.data?.items[0]?.targetUid).toBe('latest');
  expect(f.host.textContent).toContain('cached-older');
  expect(api.read).toHaveBeenCalledOnce();
});

it('刷新失败保留旧目录，同号换来源不接收上一来源的迟到结果', async () => {
  const f = fixture();
  let finish!: (value: ReturnType<typeof page>) => void;
  api.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.render();
  api.read.mockResolvedValueOnce(page('source-b'));
  await f.render('source-b');
  await act(async () => {
    finish(page('late-source-a'));
  });
  await settle();
  expect(f.queries().head.data?.items[0]?.targetUid).toBe('source-b');
  expect(f.host.textContent).not.toContain('late-source-a');
  api.read.mockRejectedValueOnce(new Error('synthetic unavailable'));
  await act(async () => {
    await f.queries().head.refetch();
  });
  await settle();
  expect(f.host.textContent).toContain('source-b');
});

it('超过千条会话按真实游标补齐，无跳页、重复或丢失', async () => {
  const f = fixture();
  const rows = Array.from({ length: 1203 }, (_, index) => ({ targetUid: `u_${index}` }));
  api.read.mockImplementation(async ({ cursor, limit }: { cursor: number; limit: number }) => {
    const items = rows.slice(cursor, cursor + limit);
    return {
      items,
      total: rows.length,
      nextCursor: cursor + items.length < rows.length ? cursor + items.length : undefined,
    };
  });
  await f.render();
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await f.queries().contacts.fetchNextPage();
    });
    await settle();
  }
  expect(f.queries().contacts.data?.pages.flatMap((p) => p.items)).toEqual(rows);
  expect(f.queries().contacts.hasNextPage).toBe(false);
  expect(api.read.mock.calls.map(([input]) => [input.cursor, input.limit])).toEqual([
    [0, RECENT_HEAD_SIZE],
    [50, RECENT_DIRECTORY_SIZE],
    [550, RECENT_DIRECTORY_SIZE],
    [1050, RECENT_DIRECTORY_SIZE],
  ]);
});
