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
