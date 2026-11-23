import { observable } from '@trpc/server/observable';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AppRouter } from '../src/shared/router';
import { remoteCacheLink } from '../src/renderer/src/trpc/remoteCacheLink';

const runtime = vi.hoisted(() => ({
  scope: '["12345","source-a"]',
  offline: false,
  rows: new Map<string, unknown>(),
}));
vi.mock('../src/renderer/src/lib/remoteClient', () => ({ isRemoteClient: () => true }));
vi.mock('../src/renderer/src/lib/remoteDataCache', () => ({
  remoteDataCacheAccount: () => runtime.scope,
  remoteDataCacheOffline: () => runtime.offline,
  remoteDataCacheStatus: async () => ({ limit: 256 * 1024 * 1024, generation: '0' }),
  getRemoteCacheRecord: async (key: string) => runtime.rows.get(key),
  putRemoteCacheRecord: async (key: string, value: unknown) => runtime.rows.set(key, value),
}));

type Handle = ReturnType<TRPCLink<AppRouter>>;
const link = remoteCacheLink({} as Parameters<TRPCLink<AppRouter>>[0]);
const binding = { expectedAccountUin: '12345', expectedAccountConfigId: 'source-a' };

beforeEach(() => {
  runtime.rows.clear();
  runtime.scope = '["12345","source-a"]';
  runtime.offline = false;
});

function read(
  path: string,
  input: Record<string, unknown>,
  next: Parameters<Handle>[0]['next'],
  type: 'query' | 'mutation' = 'query',
) {
  return new Promise<unknown>((resolve, reject) => {
    link({ op: { id: 1, type, path, input, context: {} }, next }).subscribe({
      next: (value) => resolve('data' in value.result ? value.result.data : undefined),
      error: reject,
    });
  });
}

function reply(data: unknown, status?: number) {
  return vi.fn<Parameters<Handle>[0]['next']>(() =>
    observable((observer) => {
      if (status) {
        observer.error(
          new TRPCClientError('failed', { meta: { response: new Response(null, { status }) } }),
        );
        return;
      }
      observer.next({ result: { data } });
      observer.complete();
    }),
  );
}

it('重启后按真实历史游标复用多页，忽略每次打开变化的读取标识', async () => {
  const page = (beforeSeq: string, generation: number) => ({
    ...binding,
    kind: 'group',
    conv: '123',
    beforeSeq,
    limit: 50,
    readWindow: { owner: 'new-document', generation },
    deferReplyMedia: true,
  });
  await read('account.listBefore', page('100', 1), reply([{ msgSeq: '70' }]));
  await read('account.listBefore', page('70', 1), reply([{ msgSeq: '30' }]));
  runtime.offline = true;
  const noComputer = reply(undefined, 503);
  expect(await read('account.listBefore', page('100', 2), noComputer)).toEqual([{ msgSeq: '70' }]);
  expect(await read('account.listBefore', page('70', 2), noComputer)).toEqual([{ msgSeq: '30' }]);
  expect(noComputer).not.toHaveBeenCalled();
  await expect(read('account.listBefore', page('30', 2), noComputer)).rejects.toThrow('failed');
});

it('保留搜索筛选，拒绝跨数据源及明确撤销后的缓存回退，写操作走原链路', async () => {
  const input = { ...binding, keyword: '历史', categories: ['records'] };
  await read('account.searchSlow', { ...input, searchWindow: { generation: 1 } }, reply(['keep']));
  const revoked = reply(undefined, 401);
  await expect(read('account.searchSlow', input, revoked)).rejects.toThrow('failed');

  runtime.offline = true;
  const offline = reply(undefined, 503);
  expect(
    await read('account.searchSlow', { ...input, searchWindow: { generation: 2 } }, offline),
  ).toEqual(['keep']);
  await expect(read('account.searchSlow', { ...input, keyword: '其他' }, offline)).rejects.toThrow(
    'failed',
  );
  await expect(read('account.searchSlow', input, offline, 'mutation')).rejects.toThrow('failed');

  runtime.scope = '["12345","source-b"]';
  await expect(
    read('account.searchSlow', { ...input, expectedAccountConfigId: 'source-b' }, offline),
  ).rejects.toThrow('failed');
});
