import { afterEach, expect, it, vi } from 'vitest';
import { createTRPCUntypedClient } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useWebConnection } from '../src/renderer/src/state/webConnection';

const socket = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('@trpc/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trpc/client')>()),
  createWSClient: socket,
  wsLink: () => () => () =>
    observable((observer) => {
      observer.next({ result: { data: 'WebSocket' } });
      observer.complete();
    }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('成功读取和主动取消都清理期限及正文，不残留后台请求', async () => {
  vi.useFakeTimers();
  const { fetchRpcWithDeadline } = await import('../src/renderer/src/trpc/httpDeadline');
  const cancel = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('{"ok":true}'))
    .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
  vi.stubGlobal('fetch', fetcher);
  expect(await (await fetchRpcWithDeadline('/trpc/synthetic')).json()).toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
  const response = await fetchRpcWithDeadline('/trpc/synthetic');
  await response.body!.cancel();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('写请求超时只报告结果待确认，不重复发送', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const outcome = client.mutation('synthetic', {}).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(120_001);
  expect((await outcome).message).toContain('结果暂未确认');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['headers', 'body'] as const)(
  'Web 读取的 %s 挂起时到期限退出，并释放定时器',
  async (part) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        part === 'headers'
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response(new ReadableStream())),
      ),
    );
    const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
    const client = createTRPCUntypedClient({ links: createLinks() });
    const outcome = client.query('synthetic').catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await outcome).message).toContain('请求超时');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('传输层通过实际连接回调报告恢复，并限制 HTTP 批次 URL 长度', async () => {
  useWebConnection.setState({ status: 'connecting', connectedBefore: false, recovery: 0 });
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const options = (socket as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  expect(options.url).toMatch(/\/trpc-ws$/);
  options.onOpen();
  expect(useWebConnection.getState().status).toBe('connected');
  options.onClose({ code: 1006 });
  expect(useWebConnection.getState().status).toBe('reconnecting');
  options.onOpen();
  expect(useWebConnection.getState().recovery).toBe(1);
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    const results = url.pathname
      .slice('/trpc/'.length)
      .split(',')
      .map((path) => ({ result: { data: path } }));
    return new Response(JSON.stringify(url.searchParams.has('batch') ? results : results[0]));
  });
  vi.stubGlobal('fetch', fetcher);
  const client = createTRPCUntypedClient({ links: createLinks() });
  const independent = [
    'account.listRecentContacts',
    'account.getProfilesByUids',
    'account.getGroupMembersByUids',
    'account.getGroupDetail',
    'backgroundTasks.list',
    'backgroundTasks.details',
    'backgroundTasks.logs',
    'account.calendarOverview.task',
    'account.listExportTasks',
    'account.roamingBackfill.list',
    'account.flashListDownloadTasks',
    'account.dressup.resolveMsgDecoration',
  ];
  expect(await Promise.all(independent.map((path) => client.query(path)))).toEqual(independent);
  const direct = fetcher.mock.calls.map(([url]) => new URL(String(url), location.origin));
  expect(direct).toHaveLength(independent.length);
  expect(direct.every((url) => !url.searchParams.has('batch'))).toBe(true);

  fetcher.mockClear();
  const paths = ['account.listBuddies', 'synthetic'];
  expect(await Promise.all(paths.map((path) => client.query(path, 'x'.repeat(1200))))).toEqual(
    paths,
  );
  expect(fetcher.mock.calls).toHaveLength(2);
  for (const [url] of fetcher.mock.calls) {
    expect(new URL(String(url), location.origin).searchParams.get('batch')).toBe('1');
    expect(String(url).length).toBeLessThanOrEqual(2048);
  }
  await expect(
    new Promise((resolve, reject) =>
      client.subscription('synthetic', {}, { onData: resolve, onError: reject }),
    ),
  ).resolves.toBe('WebSocket');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
