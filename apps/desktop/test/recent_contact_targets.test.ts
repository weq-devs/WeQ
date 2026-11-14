import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useRecentContactTargets } from '../src/renderer/src/hooks/useRecentContactTargets';
import {
  RECENT_DIRECTORY_SIZE,
  recentContactHeadOptions,
} from '../src/renderer/src/hooks/useRecentContactQueries';
import {
  patchRecentContactRows,
  mergeRecentContactPages,
} from '../src/renderer/src/lib/recentContacts';
import { trpc } from '../src/renderer/src/trpc/client';

const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/trpc/client', async () => {
  const { createTRPCReact } = await import('@trpc/react-query');
  return {
    trpc: createTRPCReact(),
    client: { account: { listRecentContactTargets: { query: api.read } } },
  };
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const row = (targetUid: string, sendTime = '1', msgSeq = '1', preview = '旧摘要') => ({
  targetUid,
  sendTime,
  msgSeq,
  preview,
});
const page = (items: ReturnType<typeof row>[]) => ({ items, total: 1200, nextCursor: 550 });
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  api.read.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.createElement('div'));
  let refresh!: ReturnType<typeof useRecentContactTargets>;
  const directoryKey = (configId = binding.expectedAccountConfigId) =>
    getQueryKey(
      trpc.account.listRecentContacts,
      { ...binding, expectedAccountConfigId: configId, limit: RECENT_DIRECTORY_SIZE },
      'infinite',
    );
  function Probe({ ids, configId }: { ids: string[]; configId: string }) {
    refresh = useRecentContactTargets({ ...binding, expectedAccountConfigId: configId }, true, ids);
    return null;
  }
  const render = (ids: string[] = [], configId = binding.expectedAccountConfigId) =>
    act(() =>
      root.render(
        h(QueryClientProvider, { client: cache }, h(StrictMode, null, h(Probe, { ids, configId }))),
      ),
    );
  stops.push(() => {
    act(() => root.unmount());
    cache.clear();
  });
  cache.setQueryData(recentContactHeadOptions(binding).queryKey, page([row('u_head')]));
  cache.setQueryData(directoryKey(), {
    pages: [page([row('u_head')]), page([row('u_1000'), row('u_1001')])],
    pageParams: [undefined, 50],
  });
  return {
    cache,
    render,
    refresh: (ids?: string[]) => refresh(ids),
    directoryKey,
    rows: () =>
      cache
        .getQueryData<InfiniteData<ReturnType<typeof page>>>(directoryKey())!
        .pages.flatMap((page) => page.items),
  };
}

it('首次滚到缓存的非首屏会话即批量更新，目录仍在后台读取也不阻塞', async () => {
  const f = fixture();
  api.read.mockResolvedValue([row('u_1000', '2', '2', '新摘要')]);
  const pending = f.cache.fetchQuery(['background-directory'], () => new Promise(() => {}));
  void pending;
  f.render(['u_1000']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(api.read).toHaveBeenCalledOnce();
  expect(api.read).toHaveBeenCalledWith({ ...binding, targetUids: ['u_1000'] });
  expect(f.rows()[1]?.preview).toBe('新摘要');
  expect(f.rows()[2]?.preview).toBe('旧摘要');
  expect(
    f.cache.getQueryData<InfiniteData<ReturnType<typeof page>>>(f.directoryKey())?.pageParams,
  ).toEqual([undefined, 50]);
});

it('实时变更读取屏外目标，同轮去重，重连默认校准当前可见会话', async () => {
  const f = fixture();
  api.read.mockResolvedValue([row('u_1001', '3', '3', '屏外新消息')]);
  f.render();
  f.refresh(['u_1001', 'u_1001']);
  f.refresh(['u_1001']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(api.read).toHaveBeenCalledOnce();
  expect(f.rows()[2]?.preview).toBe('屏外新消息');
  api.read.mockResolvedValue([row('u_1000', '4', '4')]);
  f.render(['u_1000']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  f.refresh();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(api.read).toHaveBeenCalledTimes(3);
  expect(api.read).toHaveBeenLastCalledWith({ ...binding, targetUids: ['u_1000'] });
});

it('连续滚动合并重叠目标，新出现的会话不排在旧目标冷却之后', async () => {
  const f = fixture();
  api.read.mockResolvedValue([]);
  f.render(['u_1000']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  f.render(['u_1000', 'u_1001']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(api.read.mock.calls.map(([input]) => input.targetUids)).toEqual([['u_1000'], ['u_1001']]);
  f.render(['u_1000', 'u_1001']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(499);
  });
  expect(api.read).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(api.read).toHaveBeenCalledTimes(3);
});

it('同水位灰条更新首屏与分页副本，旧结果不回灌更晚的消息', async () => {
  const f = fixture();
  const updated = row('u_head', '1', '1', '已撤回');
  api.read.mockResolvedValue([updated]);
  f.render(['u_head']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const head = f.cache.getQueryData<ReturnType<typeof page>>(
    recentContactHeadOptions(binding).queryKey,
  )!;
  expect(mergeRecentContactPages([head.items, f.rows()])[0]?.preview).toBe('已撤回');
  const newer = [row('u_head', '3', '3')];
  expect(patchRecentContactRows(newer, [updated])).toBe(newer);
});

it('刷新失败自动重试且保留旧行，同号换源不接收迟到结果', async () => {
  const f = fixture();
  api.read
    .mockRejectedValueOnce(new Error('synthetic offline'))
    .mockResolvedValueOnce([row('u_1000', '2', '2')]);
  f.render(['u_1000']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(f.rows()[1]?.sendTime).toBe('1');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(f.rows()[1]?.sendTime).toBe('2');
  let finish!: (rows: ReturnType<typeof row>[]) => void;
  api.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.refresh(['u_1000']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  f.render([], 'source-b');
  await act(async () => {
    finish([row('u_1000', '99', '99')]);
  });
  expect(f.rows()[1]?.sendTime).toBe('2');
});
