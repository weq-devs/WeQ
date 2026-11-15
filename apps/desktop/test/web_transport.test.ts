import { afterEach, expect, it, vi } from 'vitest';
import { useWebConnection } from '../src/renderer/src/state/webConnection';

const mocks = vi.hoisted(() => ({
  socket: vi.fn(),
  batch: vi.fn(),
  split: vi.fn(),
  single: vi.fn(),
}));
vi.mock('@trpc/client', () => ({
  createWSClient: mocks.socket,
  httpBatchLink: mocks.batch,
  httpLink: mocks.single,
  splitLink: mocks.split,
  wsLink: vi.fn(),
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
  createLinks();
  const options = mocks.single.mock.calls.at(-2)![0];
  const outcome = options
    .fetch('/trpc/synthetic', { method: 'POST' })
    .catch((error: Error) => error);
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
    createLinks();
    const options = mocks.batch.mock.calls.at(-1)![0];
    const work = options.fetch('/trpc/synthetic', {}).then((res: Response) => res.json());
    const outcome = work.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await outcome).message).toContain('请求超时');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('传输层通过实际连接回调报告恢复，并限制 HTTP 批次 URL 长度', async () => {
  useWebConnection.setState({ status: 'connecting', connectedBefore: false, recovery: 0 });
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const options = mocks.socket.mock.calls[0]![0];
  expect(options.url).toMatch(/\/trpc-ws$/);
  options.onOpen();
  expect(useWebConnection.getState().status).toBe('connected');
  options.onClose({ code: 1006 });
  expect(useWebConnection.getState().status).toBe('reconnecting');
  options.onOpen();
  expect(useWebConnection.getState().recovery).toBe(1);
  createLinks();
  const independent = mocks.split.mock.calls[0]![0].condition;
  expect(independent({ path: 'account.listRecentContacts' })).toBe(true);
  expect(independent({ path: 'account.listBuddies' })).toBe(false);
  for (const path of [
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
  ])
    expect(independent({ path })).toBe(true);
  expect(mocks.batch.mock.calls[0]![0]).toMatchObject({ url: '/trpc', maxURLLength: 2048 });
  const { condition } = mocks.split.mock.calls.at(-1)![0];
  expect(condition({ type: 'subscription' })).toBe(true);
  expect(condition({ type: 'mutation' })).toBe(false);
  expect(condition({ type: 'query' })).toBe(false);
});
