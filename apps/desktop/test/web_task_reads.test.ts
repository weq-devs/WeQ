import { createTRPCUntypedClient } from '@trpc/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@trpc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@trpc/client')>();
  return {
    ...actual,
    createWSClient: vi.fn(() => ({})),
    wsLink: vi.fn(() => () => () => {
      throw new Error('此用例不应使用订阅');
    }),
  };
});

afterEach(() => vi.unstubAllGlobals());

it('真实 HTTP link 在慢业务批次未结束时仍返回任务和日志', async () => {
  const requests: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slowFinished = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), location.origin);
      requests.push(url.pathname);
      const batched = url.searchParams.has('batch');
      if (url.pathname.includes('account.listBuddies')) await blocked;
      const result = { result: { data: url.pathname } };
      return new Response(JSON.stringify(batched ? [result] : result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCUntypedClient({ links: createLinks() });
  const slow = client.query('account.listBuddies').then(() => {
    slowFinished = true;
  });
  try {
    const values = await Promise.all([
      client.query('backgroundTasks.list'),
      client.query('backgroundTasks.logs'),
      client.query('account.listExportTasks'),
    ]);
    expect(values).toEqual([
      '/trpc/backgroundTasks.list',
      '/trpc/backgroundTasks.logs',
      '/trpc/account.listExportTasks',
    ]);
    expect(slowFinished).toBe(false);
    expect(requests.every((path) => !path.includes(','))).toBe(true);
  } finally {
    release();
    await slow;
  }
});
