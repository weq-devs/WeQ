import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import {
  DEFAULT_SEARCH_CATEGORIES,
  SEARCH_CATEGORY_ORDER,
  type SearchCategory,
} from '../src/renderer/src/components/search/types';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));
vi.mock('../src/renderer/src/components/QQExactLookup', () => ({ QQExactLookup: () => null }));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness({ keyword }: { keyword: string }) {
    const [categories, setCategories] = useState<SearchCategory[]>([...DEFAULT_SEARCH_CATEGORIES]);
    const [enabled, setEnabled] = useState(true);
    return h(TitleBarSearch, {
      query: keyword,
      onQueryChange: vi.fn(),
      results: h(SearchDropdown, {
        keyword,
        categories,
        onCategoriesChange: setCategories,
        appSearchEnabled: enabled,
        onAppSearchEnabledChange: setEnabled,
        onSelectAppEntry: vi.fn(),
        quick: {
          conversations: [],
          friends: [
            {
              category: 'friend',
              uid: 'u_fixture',
              uin: '',
              nick: '合成好友',
              remark: '',
              avatarUrl: null,
            },
          ],
          groupMembers: [],
        },
        slow: {
          chatRecords: [],
          files: [],
          collections: [],
          cloneMessages: [],
          assistantMessages: [],
          indexStatus: 'building',
        },
        quickLoading: true,
        slowLoading: false,
        quickError: true,
        onSelect: vi.fn(),
        onMore: vi.fn(),
      }),
    });
  }
  const render = (keyword: string) => act(() => root.render(h(Harness, { keyword })));
  render('');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
  return {
    render,
    scope: () => document.querySelector<HTMLElement>('[aria-label="搜索范围"]')!,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('搜索范围选择工具栏', () => {
  it('未输入或只有空格时可选范围，不显示结果、失败、加载或索引提示', () => {
    const f = mount();
    try {
      for (const keyword of ['', '   ', '\t\n']) {
        f.render(keyword);
        expect(f.scope()).not.toBeNull();
        expect(document.querySelector('[aria-label="搜索结果"]')).toBeNull();
        expect(document.querySelector('.weq-app-search')).toBeNull();
        expect(document.querySelector('.weq-search-section')).toBeNull();
        expect(document.querySelector('.weq-search-index-hint')).toBeNull();
        expect(document.querySelector('.weq-search-empty')).toBeNull();
      }
      f.render('合成');
      expect(document.querySelector('[aria-label="搜索结果"]')).not.toBeNull();
      f.render('');
      expect(document.querySelector('[aria-label="搜索结果"]')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('范围采用图标文字按钮，空输入时切换范围在开始搜索后保留', () => {
    const f = mount();
    try {
      const buttons = [...f.scope().querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons).toHaveLength(SEARCH_CATEGORY_ORDER.length);
      for (const button of buttons) {
        expect(button.textContent?.trim()).not.toBe('');
        expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        expect(button.hasAttribute('aria-pressed')).toBe(true);
      }
      const friend = buttons.find((button) => button.textContent === '好友')!;
      expect(friend.getAttribute('aria-pressed')).toBe('true');
      act(() => friend.click());
      expect(friend.getAttribute('aria-pressed')).toBe('false');
      f.render('合成');
      expect(friend.getAttribute('aria-pressed')).toBe('false');
      expect(document.querySelector('[data-search-hit-key="friend:u_fixture"]')).toBeNull();
      act(() => friend.click());
      expect(friend.getAttribute('aria-pressed')).toBe('true');
    } finally {
      f.close();
    }
  });

  it('全部按钮区分部分、全部和未选状态，清空后输入才显示未选择提示', () => {
    const f = mount();
    try {
      const all = f.scope().querySelector<HTMLButtonElement>('[aria-label="全部范围"]')!;
      expect(all.getAttribute('aria-pressed')).toBe('mixed');
      act(() => all.click());
      expect(all.getAttribute('aria-pressed')).toBe('true');
      act(() => all.click());
      expect(all.getAttribute('aria-pressed')).toBe('false');
      expect(document.querySelector('.weq-search-empty')).toBeNull();
      f.render('合成');
      expect(document.querySelector('.weq-search-empty')?.textContent).toBe('未选择搜索范围');
      expect(document.querySelector('.weq-app-search')).toBeNull();
    } finally {
      f.close();
    }
  });
});
