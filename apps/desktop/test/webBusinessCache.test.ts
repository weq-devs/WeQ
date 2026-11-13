import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  restoreBusinessCache,
  configureBusinessCache,
  watchBusinessCache,
  type BusinessCacheStore,
  type BusinessSnapshot,
} from '../src/renderer/src/lib/webBusinessCache';

const key = (name: string) => [['account', name], { type: 'query' }];
const nestedKey = (path: string, input?: unknown) => [
  ['account', ...path.split('.')],
  { type: 'query', ...(input === undefined ? {} : { input }) },
];
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
  it('重进恢复各来源表情、已浏览表情包及通知目录，不保存发送操作或实时权限', async () => {
    const storage = memoryStore();
    const first = new QueryClient();
    const stop = watchBusinessCache(first, 'scope', storage);
    const entries = [
      ['emojiPanel.overview', undefined, { faces: [], recent: [], favorites: ['fav'], tags: [] }],
      ['emojiPanel.marketPackages', undefined, ['pack']],
      ['emojiPanel.marketPackDetail', { packId: 'pack' }, { items: ['face'] }],
      ['emojiPanel.relatedGifs', { keyword: '开心' }, ['gif']],
      ['emojiPanel.showEmojiCatalog', undefined, ['show']],
      ['emojiPanel.customEmojiRecent', undefined, ['custom']],
      ['emojiPanel.recentReactions', { expectedAccountUin: 'synthetic' }, ['reaction']],
      ['qqActions.favorites', { expectedAccountUin: 'synthetic' }, ['favorite']],
      ['getSystemFaces', undefined, ['face']],
      ['listBuddyRequests', { limit: 2000 }, ['request']],
      ['listGroupNotifies', { limit: 2000 }, ['notice']],
    ] as const;
    for (const [path, input, data] of entries) first.setQueryData(nestedKey(path, input), data);
    first.setQueryData(nestedKey('emojiPanel.sendCustomEmoji'), { ok: true });
    first.setQueryData(nestedKey('qqActions.groupPermissions'), { allowed: true });
    await stop();
    const next = new QueryClient();
    await restoreBusinessCache(next, 'scope', storage);
    for (const [path, input, data] of entries)
      expect(next.getQueryData(nestedKey(path, input)), path).toEqual(data);
    expect(next.getQueryData(nestedKey('emojiPanel.sendCustomEmoji'))).toBeUndefined();
    expect(next.getQueryData(nestedKey('qqActions.groupPermissions'))).toBeUndefined();
    expect(
      next.getQueryData(nestedKey('emojiPanel.marketPackDetail', { packId: 'other' })),
    ).toBeUndefined();
    first.clear();
    next.clear();
  });

  it('内存回收表情查询后，其他目录刷新不会丢掉已保存表情', async () => {
    const storage = memoryStore();
    const first = new QueryClient();
    const stop = watchBusinessCache(first, 'scope', storage);
    const emojiKey = nestedKey('emojiPanel.overview');
    first.setQueryData(emojiKey, { faces: ['face'] });
    await stop();
    const active = new QueryClient();
    await restoreBusinessCache(active, 'scope', storage);
    const stopActive = watchBusinessCache(active, 'scope', storage);
    active.removeQueries({ queryKey: emojiKey });
    active.setQueryData(key('listProfiles'), ['profile']);
    await stopActive();
    const next = new QueryClient();
    await restoreBusinessCache(next, 'scope', storage);
    expect(next.getQueryData(emojiKey)).toEqual({ faces: ['face'] });
    expect(next.getQueryData(key('listProfiles'))).toEqual(['profile']);
    first.clear();
    active.clear();
    next.clear();
  });

  it('Web 表情先交付旧缓存，过期才后台刷新，未打开面板不预取', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    });
    configureBusinessCache(client);
    const emojiKey = nestedKey('emojiPanel.overview');
    client.setQueryData(emojiKey, ['cached'], { updatedAt: 1 });
    let finish!: (data: string[]) => void;
    let requests = 0;
    const observer = new QueryObserver(client, {
      queryKey: emojiKey,
      queryFn: () => {
        requests++;
        return new Promise<string[]>((resolve) => {
          finish = resolve;
        });
      },
    });
    expect(requests).toBe(0);
    const unsubscribe = observer.subscribe(() => {});
    expect(observer.getCurrentResult().data).toEqual(['cached']);
    expect(observer.getCurrentResult().isFetching).toBe(true);
    expect(requests).toBe(1);
    finish(['fresh']);
    await client.getQueryCache().find(emojiKey)!.promise;
    expect(observer.getCurrentResult().data).toEqual(['fresh']);
    unsubscribe();
    const next = new QueryObserver(client, {
      queryKey: emojiKey,
      queryFn: async () => {
        requests++;
        return ['unexpected'];
      },
    });
    const stop = next.subscribe(() => {});
    expect(requests).toBe(1);
    expect(next.getCurrentResult().data).toEqual(['fresh']);
    stop();
    expect(client.getQueryDefaults(key('getAccountConfig'))?.refetchOnMount).toBeUndefined();
    client.clear();
  });

  it('表情包与 GIF 参数查询有数量上限，并保留最近成功访问的数据', async () => {
    const storage = memoryStore();
    const client = new QueryClient();
    const stop = watchBusinessCache(client, 'scope', storage);
    client.setQueryData(key('listProfiles'), ['profile']);
    client.setQueryData(nestedKey('emojiPanel.overview'), { faces: ['face'] });
    for (let i = 0; i < 250; i++)
      client.setQueryData(nestedKey('emojiPanel.marketPackDetail', { packId: `${i}` }), ['face']);
    await stop();
    const snapshot = await storage.get('scope');
    expect(snapshot!.state.queries.length).toBeLessThanOrEqual(160);
    const next = new QueryClient();
    await restoreBusinessCache(next, 'scope', storage);
    expect(next.getQueryData(key('listProfiles'))).toEqual(['profile']);
    expect(next.getQueryData(nestedKey('emojiPanel.overview'))).toEqual({ faces: ['face'] });
    expect(next.getQueryData(nestedKey('emojiPanel.marketPackDetail', { packId: '249' }))).toEqual([
      'face',
    ]);
    expect(
      next.getQueryData(nestedKey('emojiPanel.marketPackDetail', { packId: '0' })),
    ).toBeUndefined();
    client.clear();
    next.clear();
  });

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
