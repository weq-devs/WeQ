import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ContentSearchStore,
  contentSearchKey,
  type ContentSearchRecord,
} from '../src/account/content_search';
import { qzoneFeedSearchRecord } from '../src/account/content_search_projection';
import { GuildDirectService, type RenderGuildDirectMsg } from '../src/account/guild_direct';
import { UnifiedSearchService } from '../src/account/unified_search';
import type { AccountSession } from '@weq/account';

const roots: string[] = [];
const stores: ContentSearchStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(bytes?: number, count?: number) {
  const root = mkdtempSync(join(tmpdir(), 'weq-content-search-'));
  roots.push(root);
  const path = join(root, 'observed.json');
  const store = new ContentSearchStore(path, bytes, count);
  stores.push(store);
  return { root, path, store };
}
const post = (tid: string, content: string, uin = '10001'): ContentSearchRecord => ({
  target: { kind: 'qzonePost', uin, tid },
  title: '合成空间',
  sourceName: '空间',
  content,
  time: 1,
});
it('个人与他人空间按作者分开检索，标题匹配优先于较新的正文命中', () => {
  const f = fixture();
  f.store.remember([
    { ...post('body', 'needle'), time: 100 },
    { ...post('title', '正文'), title: 'needle', time: 1 },
    { ...post('other', 'needle', '10002'), time: 200 },
  ]);
  const result = f.store.search('qzonePost', 'needle', 10, 0, '10001');
  expect(result.items.map((item) => item.target)).toEqual([
    { kind: 'qzonePost', uin: '10001', tid: 'title' },
    { kind: 'qzonePost', uin: '10001', tid: 'body' },
  ]);
  expect(result.coverage.records).toBe(2);
  const other = f.store.search('otherQzonePost', 'needle', 10, 0, '10001');
  expect(other.items).toMatchObject([
    { category: 'otherQzonePost', target: { kind: 'qzonePost', uin: '10002', tid: 'other' } },
  ]);
  expect(other.coverage.records).toBe(1);
  f.store.remember(
    ['10001', '10002'].map((uin) => ({
      target: { kind: 'qzoneAlbum' as const, uin, albumId: 'album' },
      title: 'needle',
      content: '',
      sourceName: '空间',
      time: 1,
    })),
  );
  expect(f.store.search('qzoneAlbum', 'needle', 1, 0, '10001').items[0]?.target).toMatchObject({
    uin: '10001',
  });
  expect(f.store.search('otherQzoneAlbum', 'needle', 1, 0, '10001').items[0]).toMatchObject({
    category: 'otherQzoneAlbum',
    target: { kind: 'qzoneAlbum', uin: '10002' },
  });
});
it('未知版本原件不被覆盖，新观察内容仍可在内存检索', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-content-version-'));
  roots.push(root);
  const path = join(root, 'observed.json');
  const original = '{"version":99,"original":"preserve"}';
  writeFileSync(path, original);
  const store = new ContentSearchStore(path);
  stores.push(store);
  store.remember([post('a', 'needle')]);
  store.flush();
  expect(store.search('qzonePost', 'needle', 10)).toMatchObject({
    total: 1,
    coverage: { persistenceFailed: true },
  });
  expect(readFileSync(path, 'utf8')).toBe(original);
});
it('群文件保留目录上下文，不凭相同 fileId 合并不同位置的条目', () => {
  const f = fixture();
  f.store.remember([
    {
      target: { kind: 'groupFile', groupCode: '50001', folderId: 'old', fileId: 'same-id' },
      title: 'needle.txt',
      content: '',
      sourceName: '群',
      time: 1,
    },
  ]);
  f.store.remember([
    {
      target: { kind: 'groupFile', groupCode: '50001', folderId: 'new', fileId: 'same-id' },
      title: 'needle.txt',
      content: '',
      sourceName: '群',
      time: 1,
    },
  ]);
  const result = f.store.search('groupFile', 'needle', 10);
  expect(result.total).toBe(2);
  expect(result.items.map((item) => item.target)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ folderId: 'old' }),
      expect.objectContaining({ folderId: 'new' }),
    ]),
  );
});
it('缓存按真实身份隔离同名内容，持久化、分页和删除不需要网络', () => {
  const f = fixture();
  f.store.remember([post('a', 'needle a'), post('a', 'needle b', '10002'), post('b', 'needle c')]);
  expect(f.store.search('qzonePost', 'needle', 2).total).toBe(3);
  expect(f.store.search('qzonePost', 'needle', 2, 2).items).toHaveLength(1);
  f.store.flush();
  const reloaded = new ContentSearchStore(f.path);
  stores.push(reloaded);
  expect(reloaded.search('qzonePost', 'needle', 10).items.map((hit) => hit.id)).toContain(
    contentSearchKey({ kind: 'qzonePost', uin: '10002', tid: 'a' }),
  );
  reloaded.remove({ kind: 'qzonePost', uin: '10001', tid: 'a' });
  expect(reloaded.search('qzonePost', 'needle', 10).total).toBe(2);
  const other = fixture();
  expect(other.store.search('qzonePost', 'needle', 10).total).toBe(0);
});
it('列表摘要不能覆盖已读完整正文，外部数组不能改写缓存，关闭后拒绝晚到写入', () => {
  const f = fixture();
  const original = { ...post('a', '完整正文专有词 needle'), detail: true };
  f.store.remember([original]);
  original.content = 'changed';
  f.store.remember([post('a', '摘要')]);
  expect(f.store.search('qzonePost', 'needle', 10).total).toBe(1);
  expect(f.store.search('qzonePost', 'needle', 10).coverage.limited).toBe(false);
  f.store.close();
  f.store.remember([post('late', 'late')]);
  expect(f.store.search('qzonePost', 'late', 10).total).toBe(0);
});
it('缓存回收是明确覆盖信息，不把剩余缓存当完整来源', () => {
  const f = fixture(10000, 2);
  f.store.remember([post('a', 'needle'), post('b', 'needle'), post('c', 'needle')]);
  expect(f.store.search('qzonePost', 'needle', 10)).toMatchObject({
    total: 2,
    coverage: { scope: 'observed-cache', records: 2, limited: true },
  });
});
it('空间 feed 只使用已知稳定属性，不猜 key、不索引脚本或图片签名', () => {
  const base = { appid: 311, uin: 10001, nickname: '合成作者', time: 1, key: 'not-a-post-id' };
  expect(qzoneFeedSearchRecord({ ...base, html: '<div>没有身份</div>' })).toBeNull();
  const record = qzoneFeedSearchRecord({
    ...base,
    html: '<div data-fkey="real-tid"><p>needle 正文</p><script>secret</script><img src="https://example.invalid/?token=secret"></div>',
  })!;
  expect(record.target).toEqual({ kind: 'qzonePost', uin: '10001', tid: 'real-tid' });
  expect(record.content).toContain('needle');
  expect(record.content).not.toMatch(/secret|token|https/);
  const f = fixture();
  f.store.remember([record]);
  f.store.flush();
  expect(readFileSync(f.path, 'utf8')).not.toMatch(/secret|token|https/);
});
it('频道检索全量分页而不是只读最新页，64 位身份可精确分页', async () => {
  const session = {
    guildDirectNodes: {
      listSessions: async () => [
        {
          nodeId: 9007199254740993n,
          lastSeq: 2501n,
          lastTime: 1n,
          peerTinyId: 2n,
          nickChannel: '频道好友',
          nickGlobal: '',
          guildName: '合成频道',
        },
      ],
    },
  } as unknown as AccountSession;
  const guild = new GuildDirectService(session);
  const read = vi
    .spyOn(guild, 'getStablePage')
    .mockImplementation(async (_node, cursor, limit = 1000) => {
      const seq = cursor?.id ?? 0n;
      const items = Array.from(
        { length: Math.min(limit, Math.max(0, 2501 - Number(seq))) },
        (_, index) => ({
          msgId: seq + BigInt(index + 1),
          msgSeq: seq + BigInt(index + 1),
          sendTime: seq + BigInt(index + 1),
          elements: [{ type: 'text', data: { textContent: 'needle' } }],
        }),
      ) as RenderGuildDirectMsg[];
      const last = items.at(-1);
      return {
        items,
        cursor: last ? { seq: last.msgSeq, time: last.sendTime, id: last.msgId } : null,
      };
    });
  const first = await guild.search('needle', 3);
  expect(first.total).toBe(2501);
  expect(first.coverage.records).toBe(2501);
  expect(read).toHaveBeenCalledTimes(3);
  expect(first.items[0]?.target).toEqual({
    kind: 'guildMessage',
    nodeId: '9007199254740993',
    msgId: '2501',
    msgSeq: '2501',
  });
  expect((await guild.search('needle', 3, 2499)).items).toHaveLength(2);
  expect(read).toHaveBeenCalledTimes(3);
});
it('没有频道库明确声明来源不可用，不把缺库伪装成完整零条历史', async () => {
  const f = fixture();
  const list = vi.fn();
  const guild = new GuildDirectService({
    msgDbPath: join(f.root, 'msg.db'),
    guildDirectNodes: { listSessions: list },
  } as unknown as AccountSession);
  expect(await guild.search('needle', 3)).toMatchObject({
    total: 0,
    coverage: { scope: 'local-database', available: false },
  });
  expect(list).not.toHaveBeenCalled();
});
it('账号关闭后取消在途频道扫描，不继续翻页或缓存旧结果', async () => {
  const guild = new GuildDirectService({
    guildDirectNodes: {
      listSessions: async () => [
        {
          nodeId: 100n,
          lastSeq: 1n,
          lastTime: 1n,
          peerTinyId: 2n,
          nickChannel: '合成',
          nickGlobal: '',
          guildName: '频道',
        },
      ],
    },
  } as unknown as AccountSession);
  let finish!: (value: Awaited<ReturnType<GuildDirectService['getStablePage']>>) => void;
  const pending = new Promise<Awaited<ReturnType<GuildDirectService['getStablePage']>>>(
    (resolve) => {
      finish = resolve;
    },
  );
  const read = vi.spyOn(guild, 'getStablePage').mockReturnValueOnce(pending);
  const search = guild.search('needle', 10);
  const rejected = expect(search).rejects.toThrow('已取消');
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  guild.cancelSearch();
  finish({
    items: Array.from({ length: 1000 }, (_, i) => ({
      msgId: BigInt(i),
      msgSeq: 1n,
      sendTime: 1n,
      elements: [],
    })) as RenderGuildDirectMsg[],
    cursor: { seq: 1n, time: 1n, id: 999n },
  });
  await rejected;
  expect(read).toHaveBeenCalledOnce();
  read.mockResolvedValue({ items: [], cursor: null });
  expect((await guild.search('needle', 10)).total).toBe(0);
  expect(read).toHaveBeenCalledTimes(2);
});
it('同一物理节点的重复会话条目不重复扫描或生成重复消息命中', async () => {
  const node = {
    nodeId: 100n,
    directGid: 'route',
    lastSeq: 1n,
    lastTime: 1n,
    peerTinyId: 2n,
    nickChannel: '合成当前',
    nickGlobal: '',
    guildId: 3n,
    guildName: '频道',
  };
  const guild = new GuildDirectService({
    guildDirectNodes: { listSessions: async () => [node, { ...node, nickChannel: '旧别名' }] },
    guildCommonProfiles: { listByTinyIds: async () => [] },
    guildDirectMsgs: { countAllByNode: async () => [{ nodeId: 100n, count: 1 }] },
  } as unknown as AccountSession);
  const read = vi.spyOn(guild, 'getStablePage').mockResolvedValue({
    items: [{ msgId: 1n, msgSeq: 1n, sendTime: 1n, elements: [] }] as RenderGuildDirectMsg[],
    cursor: null,
  });
  expect((await guild.listSessions()).map((item) => item.peerNick)).toEqual(['合成当前']);
  expect((await guild.search('合成', 10)).total).toBe(1);
  expect(read).toHaveBeenCalledOnce();
});
it('缺失可选频道昵称资料库时仍能读本地会话与正文，不把消息库藏成空列表', async () => {
  const guild = new GuildDirectService({
    guildDirectNodes: {
      listSessions: async () => [
        {
          nodeId: 100n,
          directGid: 'route',
          lastSeq: 1n,
          lastTime: 1n,
          peerTinyId: 2n,
          nickChannel: '',
          nickGlobal: '',
          guildId: 3n,
          guildName: '频道',
        },
      ],
    },
    guildCommonProfiles: {
      listByTinyIds: async () => {
        throw new Error('可选缓存不存在');
      },
    },
    guildDirectMsgs: { countAllByNode: async () => [{ nodeId: 100n, count: 1 }] },
  } as unknown as AccountSession);
  vi.spyOn(guild, 'getStablePage').mockResolvedValue({
    items: [
      {
        msgId: 1n,
        msgSeq: 1n,
        sendTime: 1n,
        elements: [{ type: 'text', data: { textContent: 'needle' } }],
      },
    ] as RenderGuildDirectMsg[],
    cursor: null,
  });
  expect((await guild.listSessions())[0]?.peerNick).toBe('2');
  expect((await guild.search('needle', 1)).items[0]?.title).toBe('2');
});
it('频道搜索使用与查看器一致的资料昵称兜底，不仅匹配 tinyId', async () => {
  const guild = new GuildDirectService({
    guildDirectNodes: {
      listSessions: async () => [
        {
          nodeId: 100n,
          lastSeq: 1n,
          lastTime: 1n,
          peerTinyId: 2n,
          nickChannel: '',
          nickGlobal: '',
          guildName: '频道',
        },
      ],
    },
    guildCommonProfiles: { listByTinyIds: async () => [{ tinyId: 2n, nick: '资料缓存昵称' }] },
  } as unknown as AccountSession);
  vi.spyOn(guild, 'getStablePage').mockResolvedValue({
    items: [{ msgId: 1n, msgSeq: 1n, sendTime: 1n, elements: [] }] as RenderGuildDirectMsg[],
    cursor: null,
  });
  expect((await guild.search('资料缓存昵称', 3)).items[0]?.title).toBe('资料缓存昵称');
});
it('新增来源预览、更多与失败隔离走实际统一搜索服务', async () => {
  const f = fixture();
  f.store.remember([post('a', 'needle'), post('b', 'needle'), post('c', 'needle')]);
  const service = new UnifiedSearchService({} as AccountSession, {
    searchContent: (category, keyword, limit, offset) => {
      if (category === 'guildMessage') throw new Error('合成独立失败');
      return f.store.search(category, keyword, limit, offset);
    },
  });
  const result = await service.slowSearch('needle', 1, ['qzonePost', 'guildMessage']);
  expect(result.contentHits).toHaveLength(1);
  expect(result.failedCategories).toEqual(['guildMessage']);
  expect(result.contentCoverage?.qzonePost.records).toBe(3);
  expect(await service.moreSearch('qzonePost', 'needle', 1, 1)).toMatchObject({
    total: 3,
    hasMore: true,
    items: [expect.objectContaining({ category: 'qzonePost' })],
  });
});
