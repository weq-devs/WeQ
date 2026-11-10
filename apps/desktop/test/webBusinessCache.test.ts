import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  restoreBusinessCache,
  watchBusinessCache,
  type BusinessCacheStore,
  type BusinessSnapshot,
} from '../src/renderer/src/lib/webBusinessCache';

const key = (name: string) => [['account', name], { type: 'query' }];
function memoryStore(): BusinessCacheStore {
  const snapshots = new Map<string, BusinessSnapshot>();
  return {
    get: async (scope) => snapshots.get(scope),
    put: async (snapshot) => {
      snapshots.set(snapshot.scope, structuredClone(snapshot));
    },
  };
}

describe('Web 业务持久缓存', () => {
  it('重进恢复摘要及昵称，隔离电脑、账号和配置，不持久化正文或凭据', async () => {
    const storage = memoryStore();
    const first = new QueryClient();
    const stop = watchBusinessCache(first, 'computer-a/account-a/config-a', storage);
    first.setQueryData(key('listRecentContacts'), { items: [{ preview: '摘要' }] });
    first.setQueryData(key('listProfiles'), [{ uid: 'synthetic', remark: '本地备注' }]);
    first.setQueryData(key('listLatest'), [{ text: '不应保存正文' }]);
    first.setQueryData(key('getAccountConfig'), { secret: '不应保存凭据' });
    await stop();
    const next = new QueryClient();
    await restoreBusinessCache(next, 'computer-a/account-a/config-a', storage);
    expect(next.getQueryData(key('listProfiles'))).toEqual([
      { uid: 'synthetic', remark: '本地备注' },
    ]);
    expect(next.getQueryData(key('listRecentContacts'))).toEqual({ items: [{ preview: '摘要' }] });
    expect(next.getQueryData(key('listLatest'))).toBeUndefined();
    expect(next.getQueryData(key('getAccountConfig'))).toBeUndefined();
    for (const scope of [
      'computer-b/account-a/config-a',
      'computer-a/account-b/config-a',
      'computer-a/account-a/config-b',
    ]) {
      const other = new QueryClient();
      await restoreBusinessCache(other, scope, storage);
      expect(other.getQueryData(key('listProfiles'))).toBeUndefined();
      other.clear();
    }
    first.clear();
    next.clear();
  });

  it('刷新失败、清理内存和损坏存储不抹掉上次成功数据', async () => {
    const storage = memoryStore();
    const first = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stop = watchBusinessCache(first, 'scope', storage);
    first.setQueryData(key('listBuddies'), ['cached']);
    await expect(
      first.fetchQuery({
        queryKey: key('listBuddies'),
        queryFn: () => Promise.reject(new Error('offline')),
      }),
    ).rejects.toThrow();
    first.removeQueries();
    await stop();
    const next = new QueryClient();
    await restoreBusinessCache(next, 'scope', storage);
    expect(next.getQueryData(key('listBuddies'))).toEqual(['cached']);
    await expect(
      restoreBusinessCache(next, 'broken', {
        ...storage,
        get: async () => {
          throw new Error('损坏');
        },
      }),
    ).resolves.toBeUndefined();
    next.clear();
  });

  it('迟到的旧账号缓存不进入新账号，旧快照不覆盖较新的在线数据', async () => {
    const storage = memoryStore();
    const first = new QueryClient();
    const stop = watchBusinessCache(first, 'scope', storage);
    first.setQueryData(key('listProfiles'), ['old'], { updatedAt: 1 });
    await stop();
    const next = new QueryClient();
    await restoreBusinessCache(next, 'scope', storage, () => false);
    expect(next.getQueryData(key('listProfiles'))).toBeUndefined();
    next.setQueryData(key('listProfiles'), ['new']);
    await restoreBusinessCache(next, 'scope', storage);
    expect(next.getQueryData(key('listProfiles'))).toEqual(['new']);
    first.clear();
    next.clear();
  });
  it('目录缓存有界，截断分页后保留游标并与 pageParams 对齐', async () => {
    const storage = memoryStore();
    const client = new QueryClient();
    const stop = watchBusinessCache(client, 'scope', storage);
    const infiniteKey = [['account', 'listRecentContacts'], { type: 'infinite' }];
    client.setQueryData(infiniteKey, {
      pages: Array.from({ length: 30 }, (_, page) => ({
        items: Array.from({ length: 500 }, (_, row) => ({ targetUid: `${page}-${row}` })),
        nextCursor: (page + 1) * 500,
      })),
      pageParams: Array.from({ length: 30 }, (_, page) => page * 500),
    });
    await stop();
    const next = new QueryClient();
    await restoreBusinessCache(next, 'scope', storage);
    const data = next.getQueryData<{ pages: { nextCursor: number }[]; pageParams: number[] }>(
      infiniteKey,
    )!;
    expect(data.pages).toHaveLength(20);
    expect(data.pageParams).toHaveLength(data.pages.length);
    expect(data.pages.at(-1)?.nextCursor).toBe(10_000);
    client.clear();
    next.clear();
  });
});
