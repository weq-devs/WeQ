import type { AccountSession } from '@weq/account';
import type { BuddyMsgFtsHit } from '@weq/db';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedSearchService, type SearchCategory } from '../src/account/unified_search';
import type { ContentSearchHit } from '../src/account/content_search';

function fixture() {
  const emptyPage = () => Promise.resolve({ items: [], total: 0 });
  const recent = vi.fn(emptyPage);
  const friends = vi.fn(emptyPage);
  const members = vi.fn(emptyPage);
  const buddyRecords = vi.fn(async () => []);
  const groupRecords = vi.fn(async (): Promise<Array<{ partition: bigint; count: number }>> => []);
  const buddyFiles = vi.fn(emptyPage);
  const groupFiles = vi.fn(
    async (): Promise<{ items: BuddyMsgFtsHit[]; total: number }> => ({ items: [], total: 0 }),
  );
  const session = {
    guildDirectNodes: { listSessions: async () => [] },
    recentContacts: { searchByName: recent },
    profileInfo: { searchFriends: friends },
    groupMembers: { searchMembers: members },
    groupDetail: { detailsByGroupCodes: async () => [] },
    buddyMsgFts: {
      topConversationsByKeyword: buddyRecords,
      searchFilesByKeyword: buddyFiles,
    },
    groupMsgFts: {
      topConversationsByKeyword: groupRecords,
      searchFilesByKeyword: groupFiles,
    },
  } as unknown as AccountSession;
  return {
    session,
    service: new UnifiedSearchService(session),
    recent,
    friends,
    members,
    buddyRecords,
    groupRecords,
    buddyFiles,
    groupFiles,
  };
}

describe('全局搜索范围', () => {
  it('频道联系人按频道节点独立保留，快速和更多采用相同筛选', async () => {
    const f = fixture();
    f.session.guildDirectNodes.listSessions = async () =>
      [7n, 8n].map((nodeId) => ({
        nodeId,
        directGid: '',
        lastTime: 1n,
        lastSeq: 1n,
        peerTinyId: 99n,
        guildId: nodeId,
        guildName: '合成频道',
        nickChannel: '合成联系人',
        nickGlobal: '',
        preview: null,
      }));
    f.session.guildCommonProfiles = {
      listByTinyIds: async () => [],
    } as unknown as AccountSession['guildCommonProfiles'];
    f.session.guildDirectMsgs = {
      countAllByNode: async () => [],
    } as unknown as AccountSession['guildDirectMsgs'];
    const quick = await f.service.quickSearch('合成', 3, ['contact', 'group'], 'guild');
    expect(quick.contacts?.map((hit) => hit.target)).toEqual([
      { kind: 'guild', nodeId: '7' },
      { kind: 'guild', nodeId: '8' },
    ]);
    expect(quick.groups).toEqual([]);
    expect((await f.service.moreSearch('contact', '合成', 0, 3, 'guild')).items).toEqual(
      quick.contacts,
    );
    expect(f.recent).not.toHaveBeenCalled();
  });
  it('仅频道范围将联系人与消息并入原分类，预览与更多不读取真实或克隆消息', async () => {
    const f = fixture();
    const guildHit: ContentSearchHit = {
      category: 'guildMessage',
      id: 'guild-hit',
      target: { kind: 'guildMessage', nodeId: '7', msgId: '8', msgSeq: '9' },
      title: '合成频道联系人',
      content: '合成消息',
      sourceName: '合成频道',
      time: 1,
      observedAt: 1,
    };
    const searchContent = vi.fn(() => ({
      items: [guildHit],
      total: 1,
      coverage: { scope: 'local-database' as const, records: 1, limited: false, updatedAt: null },
    }));
    const service = new UnifiedSearchService(f.session, { searchContent });
    const preview = await service.slowSearch('合成', 3, ['chatRecord'], 'guild');
    expect(preview.messageHits).toEqual([guildHit]);
    const page = await service.moreSearch('chatRecord', '合成', 0, 3, 'guild');
    expect(page.items).toEqual([guildHit]);
    expect(f.buddyRecords).not.toHaveBeenCalled();
    expect(f.groupRecords).not.toHaveBeenCalled();
    expect(searchContent).toHaveBeenCalledWith('guildMessage', '合成', 3, 0);
    expect(await service.moreSearch('group', '合成', 0, 3, 'guild')).toMatchObject({
      items: [],
      total: 0,
    });
  });
  it('文件范围同时检索消息附件和群文件缓存，按名称及时间统一分页', async () => {
    const f = fixture();
    f.groupFiles.mockResolvedValue({
      items: [
        {
          msgId: 1n,
          msgSeq: 1n,
          targetUid: '10001',
          senderUid: '',
          chatType: 2,
          fileName: '报告',
          content: '',
          sendTime: 20n,
        },
        {
          msgId: 2n,
          msgSeq: 2n,
          targetUid: '10001',
          senderUid: '',
          chatType: 2,
          fileName: '报告-消息',
          content: '',
          sendTime: 40n,
        },
      ],
      total: 2,
    });
    const cached: ContentSearchHit[] = [
      {
        category: 'groupFile',
        id: 'cached-exact',
        target: { kind: 'groupFile', groupCode: '10001', folderId: '/nested', fileId: 'exact' },
        title: '报告',
        content: '',
        sourceName: '合成群目录',
        time: 30,
        observedAt: 10,
      },
      {
        category: 'groupFile',
        id: 'cached-prefix',
        target: { kind: 'groupFile', groupCode: '10001', folderId: '/', fileId: 'prefix' },
        title: '报告-目录',
        content: '',
        sourceName: '合成群目录',
        time: 50,
        observedAt: 10,
      },
    ];
    const coverage = { scope: 'observed-cache' as const, records: 2, limited: true, updatedAt: 10 };
    const searchContent = vi.fn(
      (_category: string, _keyword: string, limit: number, offset: number) => ({
        items: cached.slice(offset, offset + limit),
        total: cached.length,
        coverage,
      }),
    );
    const service = new UnifiedSearchService(f.session, { searchContent });
    const preview = await service.slowSearch('报告', 3, ['file']);
    expect(preview.contentHits).toEqual(cached);
    expect(searchContent).toHaveBeenCalledWith('groupFile', '报告', 3, 0);
    const pages = await Promise.all([
      service.moreSearch('file', '报告', 0, 2),
      service.moreSearch('file', '报告', 2, 2),
    ]);
    expect(pages.map((page) => [page.total, page.hasMore, page.limited])).toEqual([
      [4, true, false],
      [4, false, false],
    ]);
    expect(
      pages.flatMap((page) =>
        page.items.map((hit) => ('id' in hit ? hit.id : 'msgId' in hit ? hit.msgId : '')),
      ),
    ).toEqual(['cached-exact', '1', 'cached-prefix', '2']);
    expect(pages[0]?.coverage).toEqual(coverage);
    expect(pages[0]?.items[0]).toEqual(cached[0]);
    searchContent.mockClear();
    await service.slowSearch('报告', 3, []);
    expect(searchContent).not.toHaveBeenCalled();
  });

  it('文件来源单独失败时保留另一来源结果，并标明失败来源', async () => {
    const f = fixture();
    f.groupFiles.mockResolvedValue({
      items: [
        {
          msgId: 1n,
          msgSeq: 1n,
          targetUid: '10001',
          senderUid: '',
          chatType: 2,
          fileName: '报告',
          content: '',
          sendTime: 20n,
        },
      ],
      total: 1,
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const service = new UnifiedSearchService(f.session, {
        searchContent: () => {
          throw new Error('合成目录失败');
        },
      });
      const result = await service.slowSearch('报告', 3, ['file']);
      expect(result.failedCategories).toEqual(['groupFile']);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.msgId).toBe('1');
      await expect(service.moreSearch('file', '报告', 0, 2)).rejects.toThrow('合成目录失败');
      f.groupFiles.mockRejectedValue(new Error('合成消息索引失败'));
      const cached: ContentSearchHit = {
        category: 'groupFile',
        id: 'cached-only',
        target: { kind: 'groupFile', groupCode: '10001', folderId: '/', fileId: 'target' },
        title: '报告',
        content: '',
        sourceName: '合成群目录',
        time: 30,
        observedAt: 10,
      };
      const directoryOnly = new UnifiedSearchService(f.session, {
        searchContent: () => ({
          items: [cached],
          total: 1,
          coverage: { scope: 'observed-cache', records: 1, limited: false, updatedAt: 10 },
        }),
      });
      const fallback = await directoryOnly.slowSearch('报告', 3, ['file']);
      expect(fallback.failedCategories).toEqual(['file']);
      expect(fallback.contentHits).toEqual([cached]);
    } finally {
      log.mockRestore();
    }
  });

  it('文件精确名称优先于较新的包含命中，同档仍按时间排序', async () => {
    const f = fixture();
    f.groupFiles.mockResolvedValue({
      items: [
        {
          msgId: 1n,
          msgSeq: 1n,
          targetUid: '10001',
          senderUid: '',
          chatType: 2,
          fileName: 'x报告',
          content: '',
          sendTime: 100n,
        },
        {
          msgId: 2n,
          msgSeq: 2n,
          targetUid: '10001',
          senderUid: '',
          chatType: 2,
          fileName: '报告',
          content: '',
          sendTime: 1n,
        },
      ],
      total: 2,
    });
    const result = await f.service.moreSearch('file', '报告', 0, 10);
    expect(result.items.map((hit) => ('msgId' in hit ? hit.msgId : ''))).toEqual(['2', '1']);
  });
  it('默认包含助手和随会话范围合并的克隆消息，不扫描公共商城', async () => {
    const searchContent = vi.fn(
      async (_category: string, _keyword: string, _limit: number, _offset: number) => ({
        items: [],
        total: 0,
        coverage: {
          scope: 'observed-cache' as const,
          records: 0,
          limited: false,
          updatedAt: null,
        },
      }),
    );
    const generatedSources = vi.fn();
    const f = fixture();
    const service = new UnifiedSearchService(f.session, {
      searchContent,
      generatedSources,
    });
    await service.slowSearch('needle');
    expect(searchContent.mock.calls.some(([category]) => category === 'marketEmoji')).toBe(false);
    expect(generatedSources).toHaveBeenCalled();
    generatedSources.mockClear();
    await service.slowSearch('needle', 3, ['marketEmoji', 'cloneMessage']);
    expect(searchContent).toHaveBeenLastCalledWith('marketEmoji', 'needle', 3, 0);
    expect(generatedSources).toHaveBeenCalledOnce();
  });
  it('同名文件保留不同会话和不同消息，重复索引行只出现一次并按时间排序', async () => {
    const f = fixture();
    const hit = (id: bigint, targetUid: string, sendTime: bigint): BuddyMsgFtsHit => ({
      msgId: id,
      msgSeq: id,
      targetUid,
      senderUid: 'u_fixture',
      chatType: 2,
      fileName: '同名报告.pdf',
      content: '',
      sendTime,
    });
    f.groupFiles.mockResolvedValue({
      items: [
        hit(1n, '10001', 10n),
        hit(2n, '10002', 30n),
        hit(3n, '10001', 20n),
        hit(2n, '10002', 30n),
      ],
      total: 4,
    });
    const result = await f.service.moreSearch('file', '报告', 0, 20);
    expect(result.total).toBe(3);
    expect(result.items.map((item) => ('msgSeq' in item ? item.msgSeq : ''))).toEqual([
      '2',
      '3',
      '1',
    ]);
  });
  it('文件候选池未覆盖全部命中时显式标记，不将有限候选数冒称完整总数', async () => {
    const f = fixture();
    f.groupFiles.mockResolvedValue({ items: [], total: 500 });
    expect(await f.service.moreSearch('file', '报告', 0, 20)).toMatchObject({ limited: true });
  });
  it('未传范围兼容默认全选，快速类别继续并行查询', async () => {
    const f = fixture();
    await f.service.quickSearch('合成内容', 5);
    for (const query of [f.recent, f.friends, f.members]) {
      expect(query).toHaveBeenCalledWith('合成内容', 5, 0);
    }
  });

  it('只查勾选的快速类别，空范围不等于全部', async () => {
    const f = fixture();
    const scope: SearchCategory[] = ['friend'];
    await f.service.quickSearch('合成内容', 3, scope);
    expect(f.friends).toHaveBeenCalledOnce();
    expect(f.recent).not.toHaveBeenCalled();
    expect(f.members).not.toHaveBeenCalled();
    f.friends.mockClear();
    expect(await f.service.quickSearch('合成内容', 3, [])).toEqual({
      conversations: [],
      friends: [],
      groupMembers: [],
    });
    expect(f.friends).not.toHaveBeenCalled();
  });

  it('慢查询只执行选定数据源，相同关键词切换范围不复用错误缓存', async () => {
    const f = fixture();
    await f.service.slowSearch('合成内容', 3, ['file']);
    expect(f.buddyFiles).toHaveBeenCalledOnce();
    expect(f.groupFiles).toHaveBeenCalledOnce();
    expect(f.buddyRecords).not.toHaveBeenCalled();
    expect(f.groupRecords).not.toHaveBeenCalled();
    await f.service.slowSearch('合成内容', 3, ['chatRecord']);
    expect(f.buddyRecords).toHaveBeenCalledOnce();
    expect(f.groupRecords).toHaveBeenCalledOnce();
    expect(f.buddyFiles).toHaveBeenCalledOnce();
    expect(f.groupFiles).toHaveBeenCalledOnce();
  });

  it('未选中慢类别不触发扫描或索引初始化', async () => {
    const f = fixture();
    const indexes = vi.spyOn(f.service, 'ensureIndexes');
    await f.service.slowSearch('合成内容', 3, ['friend']);
    await f.service.slowSearch('合成内容', 3, []);
    expect(indexes).not.toHaveBeenCalled();
    for (const query of [f.buddyRecords, f.groupRecords, f.buddyFiles, f.groupFiles]) {
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('慢查询遵守调用方 limit，不把之前三条预览缓存当成完整结果', async () => {
    const f = fixture();
    f.groupRecords.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ partition: BigInt(i + 1), count: 8 - i })),
    );
    const first = await f.service.slowSearch('合成内容', 1, ['chatRecord']);
    const next = await f.service.slowSearch('合成内容', 5, ['chatRecord']);
    expect(first.chatRecords).toHaveLength(1);
    expect(next.chatRecords).toHaveLength(5);
    expect(f.groupRecords).toHaveBeenCalledOnce();
  });
});
