import type { AccountSession } from '@weq/account';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedSearchService } from '../src/account/unified_search';
import {
  searchGeneratedMessages,
  type GeneratedSearchSources,
} from '../src/account/generated_search';
import {
  DEFAULT_SEARCH_CATEGORIES,
  DEFAULT_SEARCH_SOURCES,
  normalizeSearchPreferences,
  searchCategoriesForSources,
} from '../src/account/search_policy';

function generated(): GeneratedSearchSources {
  return {
    agentLab: {
      listPersonas: () => [{ id: 'p', name: '合成角色' }],
      listGroups: () => [{ id: 'g', name: '合成群' }],
      listPersonaSessions: () => [{ id: 'ps', title: '长期对话' }],
      getPersonaSessionConversation: () => [{ id: 'p1', text: '合成内容', ts: 10 }],
      getConversation: () => [],
      listGroupSessions: () => [{ id: 'gs', title: '长期群聊' }],
      getGroupSessionConversation: () => [{ id: 'g1', text: '合成内容', ts: 20 }],
      getGroupMessages: () => [],
    },
    assistant: {
      listSessions: () => [
        { id: 'title-only', title: '合成课题', updatedAt: 40 },
        { id: 'body-only', title: '独立任务', updatedAt: 30 },
      ],
      getConversation: (id) => (id === 'body-only' ? [{ id: 'a1', text: '合成答复', ts: 30 }] : []),
    },
  };
}

describe('全局搜索来源与类型', () => {
  it('本地资源分页保留原对象，区分来源未覆盖、零命中和候选上限', async () => {
    const coverage = {
      scope: 'observed-cache' as const,
      records: 0,
      updatedAt: null,
      limited: false,
    };
    const target = {
      kind: 'groupFile' as const,
      groupCode: '10000',
      folderId: 'docs',
      fileId: 'f1',
    };
    const groupFiles = vi.fn((_category, keyword) => ({
      items:
        keyword === '有记录'
          ? [
              {
                id: 'file',
                category: 'groupFile' as const,
                target,
                title: '有记录.txt',
                content: '',
                sourceName: '',
                time: 0,
                observedAt: 0,
              },
            ]
          : [],
      total: keyword === '有记录' ? 1 : 0,
      coverage: { ...coverage, records: keyword === '未覆盖' ? 0 : 1 },
    }));
    const service = new UnifiedSearchService(
      {
        buddyMsgFts: { searchFilesByKeyword: async () => ({ items: [], total: 0 }) },
        groupMsgFts: {
          searchFilesByKeyword: async () => ({
            total: 150,
            items: [
              {
                targetUid: '10000',
                msgId: 7n,
                msgSeq: 5n,
                sendTime: 50n,
                fileName: '有记录.txt',
              },
            ],
          }),
        },
        groupDetail: { detailsByGroupCodes: async () => [] },
      } as unknown as AccountSession,
      { searchContent: groupFiles },
    );
    const unavailable = await service.localResourceSearch('groupFile', '未覆盖', 0, 1);
    expect(unavailable).toMatchObject({ status: 'unavailable', items: [] });
    expect(unavailable).not.toHaveProperty('total');
    expect(await service.localResourceSearch('groupFile', '没匹配', 0, 1)).toMatchObject({
      status: 'ok',
      total: 0,
    });
    expect(await service.localResourceSearch('groupFile', '有记录', 0, 1)).toMatchObject({
      items: [{ target }],
      nextOffset: null,
    });
    expect(await service.localResourceSearch('chatAttachment', '有记录', 0, 1)).toMatchObject({
      items: [{ target: { kind: 'group', conv: '10000', msgId: '7', msgSeq: '5' } }],
      coverage: { limited: true, candidateLimitPerSource: 100 },
    });
    expect(await service.localResourceSearch('collection', '未配置', 0, 1)).toMatchObject({
      status: 'unavailable',
    });
  });

  it('全局组合筛选的预览、会话分页及详情共用同一候选和消息分类', async () => {
    const hit = (msgId: number, partition: number) => ({
      msgId: BigInt(msgId),
      msgSeq: BigInt(msgId),
      partition: BigInt(partition),
      senderUid: 'u_sender',
      targetUid: String(partition),
      chatType: 2,
      sendTime: 50n,
      content: '合成记录',
    });
    const candidate = vi.fn(async () => [hit(7, 100), hit(6, 100), hit(5, 200)]);
    const originals = [7, 6, 5].map((id) => ({
      msgId: BigInt(id),
      senderUin: 12345n,
      elements: [
        { kind: 'text', textContent: id === 6 ? '正文无网址' : '网址 https://example.com' },
      ],
    }));
    const service = new UnifiedSearchService({
      buddyMsgFts: { searchRecordCandidates: async () => [] },
      groupMsgFts: { searchRecordCandidates: candidate },
      groupMsgs: {
        listByMsgIds: async () => originals,
        listBySeqsInPartition: async (_partition: string, ids: bigint[]) =>
          originals.filter((message) => ids.includes(message.msgId)),
      },
      groupMembers: { getMembersByUids: async () => [] },
      groupDetail: { detailsByGroupCodes: async () => [] },
      uidMap: { uidByUin: () => 'u_sender' },
    } as unknown as AccountSession);
    const filter = { category: 'link' as const, sender: '12345', start: 40, end: 60 };
    const preview = await service.slowSearch('合成', 1, ['chatRecord'], 'all', ['qq'], filter);
    const first = await service.moreSearch('chatRecord', '合成', 0, 1, 'all', ['qq'], filter);
    const next = await service.moreSearch('chatRecord', '合成', 1, 1, 'all', ['qq'], filter);
    expect(candidate).toHaveBeenCalledOnce();
    expect(candidate).toHaveBeenCalledWith(
      '合成',
      { senderUid: 'u_sender', start: 40, end: 60 },
      501,
    );
    expect(preview.messageHits).toEqual(first.items);
    expect(first.hasMore).toBe(true);
    expect(next.hasMore).toBe(false);
    expect(first.total).toBe(2);
    const details = await service.conversationRecords('group', '100', '合成', 0, 20, filter);
    expect(details.total).toBe(1);
    expect(details.items.map(({ msgId }) => msgId)).toEqual(['7']);
    const cleared = await service.moreSearch('chatRecord', '合成', 0, 20, 'all', ['qq'], {});
    expect(cleared.items).toHaveLength(2);
    expect(candidate).toHaveBeenLastCalledWith(
      '合成',
      { senderUid: undefined, start: undefined, end: undefined },
      501,
    );
    const unfilteredDetails = await service.conversationRecords('group', '100', '合成', 0, 20, {});
    expect(unfilteredDetails.items.map(({ msgId }) => msgId)).toEqual(['7', '6']);
  });
  it('类型取来源适用集合的并集，功能来源没有类型', () => {
    expect(searchCategoriesForSources(['app'])).toEqual([]);
    expect(searchCategoriesForSources(['assistant', 'app'])).toEqual(['chatRecord']);
    expect(searchCategoriesForSources(['assistant', 'clone'])).toEqual([
      'contact',
      'group',
      'chatRecord',
    ]);
    expect(searchCategoriesForSources(['qq', 'app'])).toEqual(DEFAULT_SEARCH_CATEGORIES);
    expect(DEFAULT_SEARCH_CATEGORIES).toEqual([
      'contact',
      'group',
      'chatRecord',
      'file',
      'qzone',
      'collection',
      'mailMessage',
    ]);
  });

  it('新筛选首次重置全选，之后保留空选区、来源与类型的独立选择', () => {
    const reset = normalizeSearchPreferences({ categories: ['file'], appEnabled: false });
    expect(reset.sources).toEqual(DEFAULT_SEARCH_SOURCES);
    expect(reset.categories).toEqual(DEFAULT_SEARCH_CATEGORIES);
    expect(normalizeSearchPreferences({ version: 2, sources: [], categories: [] })).toMatchObject({
      sources: [],
      categories: [],
      appEnabled: false,
    });
    expect(
      normalizeSearchPreferences({ version: 2, sources: ['qq', 'app'], categories: ['file'] }),
    ).toMatchObject({ sources: ['qq', 'app'], categories: ['file'], appEnabled: true });
  });

  it('克隆与助手的聊天记录取并集，预览和分页一致且不读取 QQ', async () => {
    const service = new UnifiedSearchService({} as AccountSession, { generatedSources: generated });
    const preview = await service.slowSearch('合成', 3, ['chatRecord'], 'real', [
      'clone',
      'assistant',
    ]);
    const page = await service.moreSearch('chatRecord', '合成', 0, 20, 'guild', [
      'clone',
      'assistant',
    ]);
    expect(page.total).toBe(4);
    expect(preview.messageHits).toEqual(page.items.slice(0, 3));
    expect(new Set(page.items.map((hit) => hit.category))).toEqual(
      new Set(['cloneMessage', 'assistantMessage']),
    );
    const pages = await Promise.all(
      [0, 2].map((offset) =>
        service.moreSearch('chatRecord', '合成', offset, 2, 'real', ['clone', 'assistant']),
      ),
    );
    expect(pages.flatMap((result) => result.items)).toEqual(page.items);
    const assistant = await service.moreSearch('chatRecord', '合成', 0, 20, 'virtual', [
      'assistant',
    ]);
    expect(assistant.total).toBe(2);
    expect(assistant.items.every((hit) => hit.category === 'assistantMessage')).toBe(true);
  });

  it('助手标题和正文分别命中，空历史标题仍可定位独立会话', () => {
    const result = searchGeneratedMessages(generated(), 'assistantMessage', '合成');
    expect(result).toMatchObject([
      { sessionId: 'title-only', messageId: '', matchType: 'title', content: '合成课题' },
      { sessionId: 'body-only', messageId: 'a1', matchType: 'content', content: '合成答复' },
    ]);
  });

  it('不支持当前来源的类型不查询，也不以旧左栏范围限制显式来源', async () => {
    const searchContent = vi.fn(() => ({
      items: [],
      total: 0,
      coverage: { scope: 'observed-cache' as const, records: 0, limited: false, updatedAt: null },
    }));
    const session = {
      buddyMsgFts: { searchFilesByKeyword: async () => ({ items: [], total: 0 }) },
      groupMsgFts: { searchFilesByKeyword: async () => ({ items: [], total: 0 }) },
    } as unknown as AccountSession;
    const service = new UnifiedSearchService(session, { searchContent });
    await service.slowSearch('合成', 3, ['file', 'qzone'], 'all', ['assistant', 'app']);
    expect(searchContent).not.toHaveBeenCalled();
    expect(await service.moreSearch('file', '合成', 0, 20, 'all', ['clone'])).toMatchObject({
      items: [],
      total: 0,
    });
    await service.slowSearch('合成', 3, ['file'], 'virtual', ['qq', 'app']);
    expect(searchContent.mock.calls.map((call) => call[0])).toEqual(['groupFile', 'flashFile']);
    searchContent.mockClear();
    await service.slowSearch('合成', 3, DEFAULT_SEARCH_CATEGORIES, 'all', ['app']);
    expect(searchContent).not.toHaveBeenCalled();
    expect(await service.moreSearch('groupAlbum', '合成', 0, 20, 'all', ['qq'])).toMatchObject({
      items: [],
      total: 0,
    });
    expect(await service.moreSearch('marketEmoji', '合成', 0, 20, 'all', ['qq'])).toMatchObject({
      items: [],
      total: 0,
    });
  });
});
