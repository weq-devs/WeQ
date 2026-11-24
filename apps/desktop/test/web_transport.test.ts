// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTRPCUntypedClient } from '@trpc/client';
import { createServer } from 'node:http';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { HTTP_BATCH_MAX_URL_LENGTH } from '../src/renderer/src/lib/queryInputBatches';
import { useWebConnection } from '../src/renderer/src/state/webConnection';
import { createTrpcHandler } from '../src/main/web/trpc_adapter';

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
beforeEach(() => {
  vi.stubGlobal('location', Object.assign(new URL('http://localhost'), { reload: vi.fn() }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('真实 HTTP 查询同批返回，快结果先交付，慢项保留自己的业务错误', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = initTRPC.create();
  const router = t.router({
    slow: t.procedure.query(async () => {
      await held;
      throw new TRPCError({ code: 'NOT_FOUND', message: '该合成业务项不存在' });
    }),
    fast: t.procedure.query(() => '快结果'),
  });
  const handle = createTrpcHandler(router);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('缺少测试监听地址');
  const origin = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(input instanceof Request ? input.url : input, origin), init),
  );
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  let delivered: unknown;
  const slow = client.query('slow').catch((error: unknown) => error);
  const fast = client.query('fast', 'a'.repeat(HTTP_BATCH_MAX_URL_LENGTH - 150)).then(
    (value) => {
      delivered = value;
    },
    (error: unknown) => {
      delivered = error;
    },
  );
  try {
    await vi.waitFor(() => expect(delivered).toBe('快结果'));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.length).toBeGreaterThan(2048);
    release();
    expect(await slow).toMatchObject({ data: { code: 'NOT_FOUND' } });
  } finally {
    release();
    await Promise.allSettled([slow, fast]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('逐字节拆分的中英文、表情和正文 BOM 在两个并发批次里完整解码', async () => {
  const encoder = new TextEncoder();
  const expected = ['中文😀\uFEFF名字', '第二个🚀\uFEFF结果'];
  let called = 0;
  vi.stubGlobal('fetch', async () => {
    const data = expected[called++];
    const encoded = encoder.encode(`{"0":${JSON.stringify({ result: { data } })}\n}`);
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(stream) {
          if (offset >= encoded.length) stream.close();
          else stream.enqueue(encoded.subarray(offset, ++offset));
        },
      }),
      { headers: { Vary: 'Accept-Encoding, TRPC-Batch-Mode' } },
    );
  });
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const payloadLength = Math.floor(HTTP_BATCH_MAX_URL_LENGTH / 2);
  const results = await Promise.all([
    client.query('synthetic', 'a'.repeat(payloadLength)),
    client.query('synthetic', 'b'.repeat(payloadLength)),
  ]);
  expect(results).toEqual(expected);
  expect(called).toBe(2);
});

it.each([false, true])('批次鉴权失效保留错误并触发登录重载，流式=%s', async (streaming) => {
  const denied = {
    error: { message: '会话失效', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
  };
  const encoded = JSON.stringify(denied);
  const fetcher = vi.fn(async () =>
    streaming
      ? new Response(`{"0":${encoded}\n,"1":${encoded}\n}`, {
          headers: { Vary: 'trpc-batch-mode' },
        })
      : new Response(encoded, { status: 401 }),
  );
  vi.stubGlobal('fetch', fetcher);
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const result = await Promise.allSettled([client.query('one'), client.query('two')]);
  expect(result).toEqual(
    Array.from({ length: 2 }, () => ({
      status: 'rejected',
      reason: expect.objectContaining({ data: { code: 'UNAUTHORIZED', httpStatus: 401 } }),
    })),
  );
  expect(location.reload).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('取消同批中的单项时保留其他读取，最后一个未完成查询取消后释放正文', async () => {
  const cancel = vi.fn();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
          cancel,
        }),
        { headers: { Vary: 'trpc-batch-mode' } },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const first = new AbortController();
  const last = new AbortController();
  const dropped = client
    .query('first', undefined, { signal: first.signal })
    .catch((error) => error);
  const fast = client.query('fast');
  const pending = client.query('last', undefined, { signal: last.signal }).catch((error) => error);
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    first.abort();
    expect(await dropped).toBeInstanceOf(Error);
    expect(cancel).not.toHaveBeenCalled();
    body.enqueue(new TextEncoder().encode('{"1":{"result":{"data":"已收到"}}\n'));
    await expect(fast).resolves.toBe('已收到');
    last.abort();
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  } finally {
    first.abort();
    last.abort();
    if (!cancel.mock.calls.length) body?.close();
    await Promise.allSettled([dropped, fast, pending]);
  }
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
  const payload = 'x'.repeat(Math.floor(HTTP_BATCH_MAX_URL_LENGTH / 2));
  expect(await Promise.all(paths.map((path) => client.query(path, payload)))).toEqual(paths);
  expect(fetcher.mock.calls).toHaveLength(2);
  for (const [url] of fetcher.mock.calls) {
    expect(new URL(String(url), location.origin).searchParams.get('batch')).toBe('1');
    expect(String(url).length).toBeLessThanOrEqual(HTTP_BATCH_MAX_URL_LENGTH);
  }
  await expect(
    new Promise((resolve, reject) =>
      client.subscription('synthetic', {}, { onData: resolve, onError: reject }),
    ),
  ).resolves.toBe('WebSocket');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('Remote 完整群目录和聚合批次挂起时，摘要、未读和小查询先完成', async () => {
  const slow = ['account.listAllGroups', 'account.listHiddenSessions'];
  const fast = [
    'account.getUnreadInfos',
    'account.listRecentContacts',
    'account.listAssistantSessions',
    'account.getProfilesByUids',
    'backgroundTasks.list',
  ];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Set<string>();
  const completed = new Set<string>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    const paths = url.pathname.slice('/trpc/'.length).split(',');
    for (const path of paths) started.add(path);
    if (paths.some((path) => slow.includes(path))) await held;
    const data = paths.map((path) => ({ result: { data: path } }));
    return new Response(JSON.stringify(url.searchParams.has('batch') ? data : data[0]));
  });
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const requests = [...slow, ...fast].map(async (path) => {
    const result = await client.query(path);
    completed.add(result as string);
  });
  try {
    await vi.waitFor(() => {
      expect(slow.every((path) => started.has(path))).toBe(true);
      expect(completed).toEqual(new Set(fast));
    });
  } finally {
    release();
    await Promise.all(requests);
  }
  expect(completed).toEqual(new Set([...slow, ...fast]));
});
