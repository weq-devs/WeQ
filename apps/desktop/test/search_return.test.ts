import { act, createElement, StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';
import { SearchResultsPanel } from '../src/renderer/src/components/search/SearchResultsPanel';
import { contactSearchHit } from './support/search-fixtures';
import { WorkspaceContent, WorkspacePages } from '../src/renderer/src/components/WorkspacePages';
import { useSearchReturn } from '../src/renderer/src/hooks/useSearchReturn';
import { useGlobalSearch } from '../src/renderer/src/hooks/useGlobalSearch';
import type { SearchCategory, SearchHit } from '../src/renderer/src/components/search/types';
import type { SearchSource } from '@weq/service/search-policy';

const rpc = vi.hoisted(() => ({ quick: vi.fn(), slow: vi.fn(), more: vi.fn(), records: vi.fn() }));
vi.mock('../src/renderer/src/components/ChatMediaGallery', () => ({
  ChatMediaGallery: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      searchQuick: { query: rpc.quick },
      searchSlow: { query: rpc.slow },
      searchMore: { query: rpc.more },
      searchConversationRecords: { query: rpc.records },
    },
  },
}));

function hit(uid: string): SearchHit {
  return contactSearchHit({ uid, nick: uid });
}

function Harness({
  account,
  sources,
  initialCategories = ['contact'],
}: {
  account: string;
  sources?: readonly SearchSource[];
  initialCategories?: SearchCategory[];
}) {
  const [query, setQuery] = useState('合成');
  const [categories, setCategories] = useState<SearchCategory[]>(initialCategories);
  const [dismissed, setDismissed] = useState(false);
  const [view, setView] = useState('原页面');
  const search = useGlobalSearch(query, categories, account, sources);
  const back = useSearchReturn(account, query, categories, sources);
  const select = (value: SearchHit) => {
    setDismissed(true);
    setView(
      value.category === 'contact'
        ? value.uid
        : value.category === 'group'
          ? value.groupCode
          : '命中内容',
    );
  };
  return createElement(
    WorkspacePages,
    { navigationKey: view },
    createElement(TitleBarSearch, {
      key: 'search',
      query,
      onQueryChange: (value) => {
        back.clear();
        setQuery(value);
      },
      onSearchFocus: () => setDismissed(false),
      results: !dismissed
        ? createElement(SearchResultsPanel, {
            key: account,
            navigation: back,
            onJumpMessage: vi.fn(),
            renderDetail: (hit) =>
              createElement('div', { 'data-detail': hit.category }, '内容明细'),
            sources,
            keyword: query,
            categories,
            onCategoriesChange: setCategories,
            quick: search.quick,
            slow: search.slow,
            quickLoading: search.quickLoading,
            slowLoading: search.slowLoading,
            onSelect: select,
          })
        : null,
    }),
    createElement(
      WorkspaceContent,
      { key: 'content' },
      createElement('div', { 'data-view': view }, view),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function mount(initialCategories?: SearchCategory[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (account: string, sources?: readonly SearchSource[]) =>
    act(() =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Harness, { account, sources, initialCategories }),
        ),
      ),
    );
  render('10001');
  return {
    host,
    render,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('下拉跳转保留查询与范围，重新打开恢复滚动，不显示返回按钮', async () => {
  vi.useFakeTimers();
  rpc.quick.mockResolvedValue({
    conversations: [],
    friends: [],
    contacts: [hit('a'), hit('b'), hit('c')],
    groupMembers: [],
  });
  const f = mount();
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const dropdown = document.querySelector<HTMLElement>('.weq-search-dropdown')!;
    dropdown.scrollTop = 91;
    act(() => dropdown.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
    expect(f.host.querySelector('input')!.value).toBe('合成');
    expect(f.host.querySelector('[aria-label="返回搜索结果"]')).toBeNull();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    const restored = document.querySelector<HTMLElement>('.weq-search-dropdown')!;
    expect(restored.scrollTop).toBe(91);
    expect(document.activeElement).toBe(f.host.querySelector('input'));
    expect(rpc.quick).toHaveBeenCalledOnce();
    expect(
      restored.querySelectorAll('[aria-label="搜索类型"] button[aria-pressed="true"]'),
    ).toHaveLength(1);
    f.render('10002');
    expect(f.host.querySelector('[aria-label="返回搜索结果"]')).toBeNull();
    f.render('10001');
    expect(f.host.querySelector('[aria-label="返回搜索结果"]')).toBeNull();
  } finally {
    f.close();
  }
});

it('更多页换词保留分类，返回新总览顶部；清空和切号退出分类', async () => {
  vi.useFakeTimers();
  rpc.quick.mockResolvedValue({ contacts: [hit('a'), hit('b'), hit('c')] });
  rpc.more.mockImplementation(async ({ keyword }) => ({
    category: 'contact',
    items: [hit(keyword)],
    total: 1,
    hasMore: false,
  }));
  const f = mount();
  const change = (value: string) =>
    act(() => {
      const input = f.host.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const openMore = async () => {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    document.querySelector<HTMLElement>('.weq-search-dropdown')!.scrollTop = 90;
    act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
  };
  try {
    await openMore();
    change('新词');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(document.querySelector('.weq-search-more-body')!.textContent).toContain('新词');
    expect(rpc.more).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'contact', keyword: '新词', offset: 0 }),
    );
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="返回搜索总览"]')!.click());
    expect(document.querySelector('.weq-search-dropdown')!.scrollTop).toBe(0);
    act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
    change('');
    expect(document.querySelector('.weq-search-more-body')).toBeNull();
    change('再次');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
    f.render('10002');
    expect(document.querySelector('.weq-search-more-body')).toBeNull();
    f.render('10001');
    expect(document.querySelector('.weq-search-more-body')).toBeNull();
  } finally {
    f.close();
  }
});

it('来源变化重取当前分类，不适用的分类返回总览', async () => {
  vi.useFakeTimers();
  rpc.quick.mockResolvedValue({ contacts: [hit('a'), hit('b'), hit('c')] });
  rpc.more.mockResolvedValue({ category: 'contact', items: [hit('a')], total: 1, hasMore: false });
  const f = mount();
  try {
    f.render('10001', ['qq']);
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    f.render('10001', ['qq', 'clone']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(rpc.more).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: ['qq', 'clone'], offset: 0 }),
    );
    f.render('10001', ['assistant']);
    expect(document.querySelector('.weq-search-more-body')).toBeNull();
    expect(document.querySelector('[aria-label="搜索来源"]')).not.toBeNull();
  } finally {
    f.close();
  }
});

it('更多在原结果框展开，跳转后重新打开恢复分页现场，返回恢复总览位置', async () => {
  vi.useFakeTimers();
  rpc.quick.mockResolvedValue({
    conversations: [],
    friends: [],
    contacts: [hit('a'), hit('b'), hit('c')],
    groupMembers: [],
  });
  rpc.more.mockResolvedValue({
    category: 'contact',
    items: [hit('a'), hit('b')],
    total: 2,
    hasMore: false,
  });
  const f = mount();
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    document.querySelector<HTMLElement>('.weq-search-dropdown')!.scrollTop = 73;
    act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const body = document.querySelector<HTMLElement>('.weq-search-more-body')!;
    expect(body.closest('.weq-titlebar-search-results')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(1);
    body.scrollTop = 131;
    act(() => body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    act(() => body.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
    expect(document.querySelector('.weq-search-more-body')).toBeNull();
    expect(f.host.querySelector('[aria-label="返回搜索结果"]')).toBeNull();
    act(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(document.querySelector('.weq-search-more-body')).not.toBeNull();
    expect(document.querySelector('.weq-search-more-body')!.scrollTop).toBe(131);
    expect(rpc.more).toHaveBeenCalledOnce();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="返回搜索总览"]')!.click());
    expect(document.querySelector('.weq-search-more-body')).toBeNull();
    expect(document.querySelector('.weq-search-dropdown')!.scrollTop).toBe(73);
    expect(document.activeElement).toBe(document.querySelector('.weq-search-more'));
  } finally {
    f.close();
  }
});

it.each([false, true])(
  '聊天记录从总览或更多进入会话明细仍留在同一结果框（更多=%s）',
  async (more) => {
    vi.useFakeTimers();
    const record = {
      category: 'chatRecord',
      source: 'group',
      partition: '123',
      targetUid: '123',
      targetUin: '',
      name: '合成群',
      count: 2,
    };
    rpc.slow.mockResolvedValue({
      chatRecords: [
        record,
        { ...record, partition: '456', targetUid: '456' },
        { ...record, partition: '789', targetUid: '789' },
      ],
      files: [],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
    });
    rpc.more.mockResolvedValue({
      category: 'chatRecord',
      items: [record],
      total: 1,
      hasMore: false,
    });
    rpc.records.mockImplementation(async ({ keyword }) => ({
      items: [
        {
          msgId: 'message',
          msgSeq: '1',
          senderUid: '',
          senderUin: '',
          senderName: '成员',
          sendTime: '1',
          content: `${keyword}正文`,
        },
      ],
      total: 1,
    }));
    const f = mount(['chatRecord']);
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      if (more) {
        act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        document.querySelector<HTMLElement>('.weq-search-more-body')!.scrollTop = 90;
      }
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-search-category="chatRecord"]')!.click(),
      );
      expect(
        document.querySelector('.weq-titlebar-search-results .weq-chatrecords-msg')!.textContent,
      ).toContain('合成正文');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('.weq-chatrecords-convs')).toBeNull();
      expect(document.querySelectorAll('input')).toHaveLength(1);
      expect(rpc.more).toHaveBeenCalledTimes(more ? 1 : 0);
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="返回搜索结果"]')!.click());
      if (more) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20);
        });
        expect(document.querySelector('.weq-search-more-body')!.scrollTop).toBe(90);
        expect(rpc.more).toHaveBeenCalledOnce();
      }
      expect(document.querySelector('[data-search-category="chatRecord"]')).not.toBeNull();
    } finally {
      f.close();
    }
  },
);

it.each(['groupEssence', 'flashFile', 'qzonePublicComment', 'groupAlbum', 'groupFile'] as const)(
  '其它搜索明细 %s 也使用同一个容器并可返回',
  async (category) => {
    vi.useFakeTimers();
    const record = {
      category: 'chatRecord',
      source: 'group',
      partition: '123',
      targetUid: '123',
      targetUin: '',
      name: '合成群',
      count: 2,
    };
    rpc.slow.mockImplementation(async ({ categories }) => ({
      chatRecords: categories.includes('chatRecord')
        ? [
            record,
            { ...record, partition: '456', targetUid: '456' },
            { ...record, partition: '789', targetUid: '789' },
          ]
        : [],
      files: [],
      contentHits: [],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
    }));
    rpc.more.mockResolvedValue({
      category: 'chatRecord',
      items: [
        {
          category,
          id: 'target',
          target: { kind: category },
          title: '合成明细',
          content: '合成',
          sourceName: '',
          time: 1,
        },
      ],
      total: 1,
      hasMore: false,
    });
    rpc.quick.mockResolvedValue({ contacts: [] });
    const f = mount(['chatRecord', 'file', 'qzone']);
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      act(() =>
        document.querySelector<HTMLButtonElement>(`[data-search-category="${category}"]`)!.click(),
      );
      expect(
        document.querySelector(`.weq-titlebar-search-results [data-detail="${category}"]`),
      ).not.toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="返回搜索结果"]')!.click());
      expect(document.querySelector(`[data-search-category="${category}"]`)).not.toBeNull();
      expect(rpc.more).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  },
);

it.each([
  { more: false, count: 0 },
  { more: true, count: 2 },
])('公告会话从搜索结果直接打开群聊，不进入消息搜索明细（更多=$more）', async ({ more, count }) => {
  vi.useFakeTimers();
  const record = {
    category: 'chatRecord',
    source: 'group',
    partition: '123',
    targetUid: '123',
    targetUin: '',
    name: '合成群',
    count,
    matchedBulletins: 3,
  };
  rpc.slow.mockResolvedValue({
    chatRecords: [
      record,
      { ...record, partition: '456', targetUid: '456' },
      { ...record, partition: '789', targetUid: '789' },
    ],
    files: [],
    collections: [],
    cloneMessages: [],
    assistantMessages: [],
    messageCoverage: { scope: 'observed-cache', records: 375, limited: false, updatedAt: 1 },
  });
  rpc.more.mockResolvedValue({
    category: 'chatRecord',
    items: [record],
    total: 1,
    hasMore: false,
    coverage: { scope: 'observed-cache', records: 375, limited: false, updatedAt: 1 },
  });
  const f = mount(['chatRecord']);
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    if (more) {
      act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
    }
    const row = document.querySelector<HTMLButtonElement>('[data-search-category="chatRecord"]')!;
    expect(row.textContent).toContain('匹配3条群公告');
    if (!count) expect(row.textContent).not.toContain('0条');
    expect(document.querySelector('.weq-titlebar-search-results')!.textContent).not.toContain(
      '已缓存内容',
    );
    act(() => row.click());
    expect(f.host.querySelector('[data-view="123"]')).not.toBeNull();
    expect(document.querySelector('.weq-chatrecords')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(rpc.records).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
