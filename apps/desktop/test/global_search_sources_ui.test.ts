import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { SearchResultCard } from '../src/renderer/src/components/search/SearchResultCard';
import { useGlobalSearch } from '../src/renderer/src/hooks/useGlobalSearch';
import {
  DEFAULT_SEARCH_CATEGORIES,
  DEFAULT_SEARCH_SOURCES,
  type SearchSource,
} from '@weq/service/search-policy';
import type { SearchCategory } from '../src/renderer/src/components/search/types';

const rpc = vi.hoisted(() => ({ quick: vi.fn(), slow: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { searchQuick: { query: rpc.quick }, searchSlow: { query: rpc.slow } } },
  trpc: {},
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('全局搜索两层筛选', () => {
  it('来源在前，类型随适用并集变化；纯功能不显示类型，文件筛选不限制功能结果', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    function Harness() {
      const [sources, setSources] = useState<SearchSource[]>([...DEFAULT_SEARCH_SOURCES]);
      const [categories, setCategories] = useState<SearchCategory[]>([
        ...DEFAULT_SEARCH_CATEGORIES,
      ]);
      return h(SearchDropdown, {
        keyword: '导出',
        sources,
        onSourcesChange: setSources,
        categories,
        onCategoriesChange: setCategories,
        quick: null,
        quickLoading: false,
        slow: null,
        slowLoading: false,
        onSelect: vi.fn(),
        onMore: vi.fn(),
        onSelectAppEntry: vi.fn(),
      });
    }
    const source = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('[aria-label="搜索来源"] button')].find(
        (button) => button.textContent === label,
      )!;
    const types = () =>
      [...host.querySelectorAll('[aria-label="搜索类型"] button')].map((node) => node.textContent);
    try {
      act(() => root.render(h(Harness)));
      expect(host.querySelectorAll('[role="group"]')[1]?.getAttribute('aria-label')).toBe(
        '搜索来源',
      );
      expect(types()).toEqual([
        '清空',
        '联系人',
        '群聊',
        '聊天记录',
        '文件',
        '空间',
        '收藏',
        '邮件',
      ]);
      act(() => source('QQ').click());
      expect(types()).toEqual(['清空', '联系人', '群聊', '聊天记录']);
      act(() => source('克隆').click());
      expect(types()).toEqual(['清空', '聊天记录']);
      act(() => source('WeQ 助手').click());
      expect(host.querySelector('[aria-label="搜索类型"]')).toBeNull();
      expect(host.querySelector('.weq-app-search')).not.toBeNull();
      act(() => source('QQ').click());
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="全部类型"]')!.click());
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('[aria-label="搜索类型"] button')]
          .find((button) => button.textContent === '文件')!
          .click(),
      );
      expect(
        [...host.querySelectorAll('.weq-search-section-name')].map((node) => node.textContent),
      ).toEqual(['功能与设置', '文件']);
      expect(host.querySelector('.weq-app-search')).not.toBeNull();
      expect(types()).not.toContain('群相册');
    } finally {
      act(() => root.unmount());
    }
  });

  it('助手标题和正文卡片有不同标识，标题命中保留会话定位', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const select = vi.fn();
    const title = {
      category: 'assistantMessage' as const,
      kind: 'assistant' as const,
      ownerId: 'assistant',
      sessionId: 's1',
      messageId: '',
      title: 'WeQ 助手',
      sessionTitle: '合成任务',
      content: '合成任务',
      ts: 1,
      matchType: 'title' as const,
    };
    try {
      act(() =>
        root.render(
          h(
            'div',
            null,
            h(SearchResultCard, { hit: title, keyword: '合成', onSelect: select }),
            h(SearchResultCard, {
              hit: { ...title, messageId: 'm1', content: '合成正文', matchType: 'content' },
              keyword: '合成',
            }),
          ),
        ),
      );
      expect(host.textContent).toContain('标题命中');
      expect(host.textContent).toContain('正文命中');
      act(() => host.querySelector<HTMLButtonElement>('button')!.click());
      expect(select).toHaveBeenCalledWith(title);
    } finally {
      act(() => root.unmount());
    }
  });

  it('助手来源只请求聊天记录，切换来源后执行适用类型', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const root = createRoot(host);
    rpc.slow.mockResolvedValue({
      chatRecords: [],
      files: [],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
      indexStatus: 'disabled',
    });
    rpc.quick.mockResolvedValue({
      contacts: [],
      groups: [],
      conversations: [],
      friends: [],
      groupMembers: [],
    });
    const categories: SearchCategory[] = ['contact', 'file', 'chatRecord'];
    const assistant: SearchSource[] = ['assistant'];
    const clone: SearchSource[] = ['clone'];
    function Harness({ sources }: { sources: SearchSource[] }) {
      const result = useGlobalSearch('合成', categories, 'account', sources);
      return h('span', null, String(result.slowLoading));
    }
    try {
      await act(async () => {
        root.render(h(Harness, { sources: assistant }));
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(rpc.quick).not.toHaveBeenCalled();
      expect(rpc.slow).toHaveBeenCalledOnce();
      expect(rpc.slow).toHaveBeenCalledWith({
        keyword: '合成',
        limit: 3,
        categories: ['chatRecord'],
        conversationScope: 'all',
        sources: ['assistant'],
      });
      await act(async () => {
        root.render(h(Harness, { sources: clone }));
        vi.advanceTimersByTime(200);
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(rpc.quick).toHaveBeenCalledWith({
        keyword: '合成',
        limit: 3,
        categories: ['contact'],
        conversationScope: 'all',
        sources: ['clone'],
      });
      expect(rpc.slow.mock.calls.some((call) => call[0].categories.includes('file'))).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
