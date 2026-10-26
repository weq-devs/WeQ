import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { useSearchDismissal } from '../src/renderer/src/hooks/useSearchDismissal';
import {
  CATEGORY_META,
  SEARCH_CATEGORY_ORDER,
  type SearchCategory,
} from '../src/renderer/src/components/search/types';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));
vi.mock('../src/renderer/src/components/QQExactLookup', () => ({ QQExactLookup: () => null }));
afterEach(() => vi.unstubAllGlobals());

it('已聚焦输入框清空后保留搜索范围及选择，点击外部仍收起', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [query, setQuery] = useState('合成');
    const [focused, setFocused] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [categories, setCategories] = useState<SearchCategory[]>([SEARCH_CATEGORY_ORDER[0]!]);
    useSearchDismissal(query, focused, setDismissed, setFocused);
    return h(TitleBarSearch, {
      persistent: true,
      query,
      onQueryChange: setQuery,
      onSearchFocus: () => {
        setFocused(true);
        setDismissed(false);
      },
      results:
        (query.trim() || focused) && !dismissed
          ? h(SearchDropdown, {
              keyword: query,
              categories,
              onCategoriesChange: setCategories,
              quick: null,
              slow: null,
              quickLoading: false,
              slowLoading: false,
              onSelect: vi.fn(),
              onMore: vi.fn(),
            })
          : null,
    });
  }
  try {
    act(() => root.render(h(Harness)));
    const input = host.querySelector('input')!;
    act(() => input.focus());
    const scope = () => document.querySelector('[aria-label="搜索范围"]');
    expect(scope()).not.toBeNull();
    // 原生清除按钮的鼠标事件以 input 为目标，清空时不会再次触发 focus。
    act(() => input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('');
    expect(scope()).not.toBeNull();
    expect(scope()!.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(scope()!.querySelector('[aria-pressed="true"]')?.textContent).toBe(
      CATEGORY_META[SEARCH_CATEGORY_ORDER[0]!].label,
    );
    expect(document.querySelector('[aria-label="搜索结果"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    act(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(scope()).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
