import { createTRPCProxyClient } from '@trpc/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppRouter } from '../src/shared/router';

vi.mock('@trpc/client', async (original) => ({
  ...(await original<typeof import('@trpc/client')>()),
  createWSClient: vi.fn(() => ({ close: vi.fn(), request: vi.fn() })),
}));
afterEach(() => vi.unstubAllGlobals());

it('Web 搜索独立 HTTP 返回，慢分类不阻塞快分类；普通查询仍批处理', async () => {
  let finish!: (response: Response) => void;
  const slowResponse = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const response = (data: unknown) =>
    new Response(JSON.stringify({ result: { data } }), {
      headers: { 'content-type': 'application/json' },
    });
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('account.searchSlow')) {
      expect(url).not.toContain('batch=1');
      return slowResponse;
    }
    if (url.includes('account.searchQuick')) {
      expect(url).not.toContain('batch=1');
      return Promise.resolve(
        response({ contacts: [], conversations: [], friends: [], groupMembers: [] }),
      );
    }
    expect(url).toContain('batch=1');
    return Promise.resolve(
      new Response(JSON.stringify([{ result: { data: [] } }]), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCProxyClient<AppRouter>({ links: createLinks() });
  let slowFinished = false;
  const slow = client.account.searchSlow
    .query({ keyword: '合成', categories: ['file'] })
    .then(() => {
      slowFinished = true;
    });
  const quick = client.account.searchQuick.query({ keyword: '合成', categories: ['contact'] });
  try {
    expect((await quick).contacts).toEqual([]);
    expect(slowFinished).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    finish(
      response({
        chatRecords: [],
        files: [],
        collections: [],
        cloneMessages: [],
        assistantMessages: [],
        indexStatus: 'disabled',
      }),
    );
    await slow;
  }
  expect(await client.account.searchHistory.query({ limit: 1 })).toEqual([]);
});

it('消息首屏和双向定位独立返回，不与慢辅助目录合并为同一 HTTP 批次', async () => {
  let release!: () => void;
  const slow = new Promise<Response>((resolve) => {
    release = () => resolve(new Response(JSON.stringify([{ result: { data: [] } }])));
  });
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('account.listProfiles')) return slow;
    expect(url).not.toContain('batch=1');
    return Promise.resolve(new Response(JSON.stringify({ result: { data: [] } })));
  });
  vi.stubGlobal('fetch', fetch);
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCProxyClient<AppRouter>({ links: createLinks() });
  const directory = client.account.listProfiles.query({ limit: 2000 });
  try {
    expect(
      await Promise.all([
        client.account.listLatest.query({ kind: 'group', conv: '777' }),
        client.account.listBefore.query({ kind: 'group', conv: '777', beforeSeq: '20' }),
        client.account.listAfter.query({ kind: 'group', conv: '777', afterSeq: '20' }),
        client.account.listFrom.query({ kind: 'group', conv: '777', sinceSeq: '20' }),
      ]),
    ).toEqual([[], [], [], []]);
  } finally {
    release();
    await directory;
  }
});
