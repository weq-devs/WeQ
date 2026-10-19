import { act, createElement, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import {
  UnifiedSearchModal,
  type SearchMoreSnapshot,
} from '../src/renderer/src/components/search/UnifiedSearchModal';
import { WorkspaceContent, WorkspacePages } from '../src/renderer/src/components/WorkspacePages';
import { useSearchReturn } from '../src/renderer/src/hooks/useSearchReturn';
import { useGlobalSearch } from '../src/renderer/src/hooks/useGlobalSearch';
import type { SearchCategory, SearchHit } from '../src/renderer/src/components/search/types';

const rpc = vi.hoisted(() => ({ quick: vi.fn(), slow: vi.fn(), more: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      searchQuick: { query: rpc.quick },
      searchSlow: { query: rpc.slow },
      searchMore: { query: rpc.more },
    },
  },
}));

function hit(uid: string): SearchHit {
  return { category: 'friend', uid, uin: '', nick: uid, remark: '', avatarUrl: null };
}

function Harness({ account }: { account: string }) {
  const [query, setQuery] = useState('合成');
  const [categories, setCategories] = useState<SearchCategory[]>(['friend']);
  const [dismissed, setDismissed] = useState(false);
  const [view, setView] = useState('原页面');
  const [more, setMore] = useState<{
    category: SearchCategory;
    keyword: string;
    snapshot?: SearchMoreSnapshot;
  } | null>(null);
  const search = useGlobalSearch(query, categories, account);
  const back = useSearchReturn(account, query, categories);
  const select = (value: SearchHit) => {
    setDismissed(true);
    setView(value.category === 'friend' ? value.uid : '命中内容');
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
      onReturn: back.target
        ? () => {
            const target = back.target!;
            if (target.kind === 'more') {
              setMore({
                category: target.snapshot.category,
                keyword: target.snapshot.keyword,
                snapshot: target.snapshot,
              });
              return false;
            }
            setDismissed(false);
            return true;
          }
        : undefined,
      results: !dismissed
        ? createElement(SearchDropdown, {
            keyword: query,
            categories,
            onCategoriesChange: setCategories,
            quick: search.quick,
            slow: search.slow,
            quickLoading: search.quickLoading,
            slowLoading: search.slowLoading,
            onSelect: select,
            onNavigate: (position) => back.remember({ kind: 'dropdown', position }),
            initialPosition: back.target?.kind === 'dropdown' ? back.target.position : undefined,
            onMore: (category) => setMore({ category, keyword: query }),
          })
        : null,
    }),
    createElement(
      WorkspaceContent,
      { key: 'content' },
      createElement('div', { 'data-view': view }, view),
    ),
    more
      ? createElement(UnifiedSearchModal, {
          key: 'more',
          category: more.category,
          initialKeyword: more.keyword,
          initialSnapshot: more.snapshot,
          onNavigate: (snapshot) => back.remember({ kind: 'more', snapshot }),
          onSelect: select,
          onOpenChatRecords: select,
          onClose: () => setMore(null),
        })
      : null,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (account: string) =>
    act(() => root.render(createElement(StrictMode, null, createElement(Harness, { account }))));
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

it('下拉跳转保留查询与范围，返回恢复滚动和焦点，不重新执行查询；切号丢弃旧现场', async () => {
  vi.useFakeTimers();
  rpc.quick.mockResolvedValue({
    conversations: [],
    friends: [hit('a'), hit('b'), hit('c')],
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
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="返回搜索结果"]')!.click());
    const restored = document.querySelector<HTMLElement>('.weq-search-dropdown')!;
    expect(restored.scrollTop).toBe(91);
    expect(document.activeElement?.textContent).toContain('b');
    expect(rpc.quick).toHaveBeenCalledOnce();
    expect(restored.querySelectorAll('input:checked')).toHaveLength(1);
    f.render('10002');
    expect(f.host.querySelector('[aria-label="返回搜索结果"]')).toBeNull();
    f.render('10001');
    expect(f.host.querySelector('[aria-label="返回搜索结果"]')).toBeNull();
  } finally {
    f.close();
  }
});

it('真实工作区返回更多页保留分页与焦点，StrictMode 不重新读取第一页', async () => {
  vi.useFakeTimers();
  rpc.quick.mockResolvedValue({
    conversations: [],
    friends: [hit('a'), hit('b'), hit('c')],
    groupMembers: [],
  });
  rpc.more.mockResolvedValueOnce({
    category: 'friend',
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
    act(() => document.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const body = document.querySelector<HTMLElement>('.weq-search-more-body')!;
    body.scrollTop = 131;
    act(() => body.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
    expect(document.querySelector('.weq-search-more-body')).toBeNull();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="返回搜索结果"]')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(document.querySelector('.weq-search-more-body')?.scrollTop).toBe(131);
    expect(document.activeElement?.textContent).toContain('b');
    expect(rpc.more).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});
