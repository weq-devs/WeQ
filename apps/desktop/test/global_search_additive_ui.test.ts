import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { contactSearchHit } from './support/search-fixtures';
import {
  SEARCH_CATEGORY_ORDER,
  type SearchCategory,
} from '../src/renderer/src/components/search/types';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({ binding: null, available: false }),
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('全局搜索号码范围', () => {
  it.each(['', '10002'])('悬停及点击都不再追加独立号码搜索按钮：%s', (query) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(TitleBarSearch, {
            query,
            onQueryChange: vi.fn(),
            results: h('div', { 'data-local-search': true }, '原有本地搜索'),
          }),
        ),
      );
      act(() =>
        host.firstElementChild!.dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
        ),
      );
      expect(document.querySelector('[data-local-search]')).not.toBeNull();
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
      expect(document.querySelector('.weq-cloud-lookup-entry')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('QQ 来源控制号码查询，保留原词、本地命中、更多与选择', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host),
      select = vi.fn(),
      more = vi.fn();
    function Harness() {
      const [categories, setCategories] = useState<SearchCategory[]>([...SEARCH_CATEGORY_ORDER]);
      const [appEnabled, setAppEnabled] = useState(true);
      const [numberEnabled, setNumberEnabled] = useState(true);
      return h(TitleBarSearch, {
        query: '10002',
        onQueryChange: vi.fn(),
        results: h(SearchDropdown, {
          keyword: '10002',
          quick: {
            conversations: [],
            groupMembers: [],
            friends: [],
            contacts: [1, 2, 3].map((id) =>
              contactSearchHit({
                uid: `u_synthetic${id}`,
                uin: `10002${id}`,
                nick: `合成好友${id}`,
                remark: '',
                avatarUrl: null,
              }),
            ),
          },
          quickLoading: false,
          slow: {
            chatRecords: [],
            files: [],
            collections: [],
            cloneMessages: [],
            assistantMessages: [],
            indexStatus: 'ready',
          },
          slowLoading: false,
          categories,
          onCategoriesChange: setCategories,
          appSearchEnabled: appEnabled,
          onAppSearchEnabledChange: setAppEnabled,
          onSelectAppEntry: vi.fn(),
          numberLookupEnabled: numberEnabled,
          onNumberLookupEnabledChange: setNumberEnabled,
          onSelect: select,
          onMore: more,
        }),
      });
    }
    try {
      act(() => root.render(h(Harness)));
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
      const panel = document.querySelector<HTMLElement>('.weq-titlebar-search-results')!;
      const scope = (label: string) =>
        [...panel.querySelectorAll<HTMLButtonElement>('.weq-search-scope button')].find(
          (button) => button.textContent === label,
        )!;
      expect(
        [...panel.querySelectorAll('.weq-search-scope button')]
          .map((button) => button.textContent)
          .slice(0, 4),
      ).toEqual(['清空', 'QQ', '克隆', 'WeQ 助手']);
      expect(panel.textContent).toContain('合成好友1');
      expect(panel.textContent).toContain('QQ 在线能力未就绪');
      expect(scope('QQ').getAttribute('aria-pressed')).toBe('true');
      const output = process.env.WEQ_ENTRY_LAYOUT_DIR;
      if (output) {
        mkdirSync(output, { recursive: true });
        const styles = [
          'workspace-tools.css',
          'index.css',
          'search-scope.css',
          'friend-directory.css',
        ]
          .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
          .join('\n');
        writeFileSync(
          resolve(output, 'global-search.html'),
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><style>body{margin:0;font-family:system-ui;background:var(--background);color:var(--foreground)}.weq-titlebar-search-results{left:8px!important;top:48px!important;width:min(720px,calc(100vw - 16px))!important;max-height:calc(100dvh - 64px)!important}</style><body>${document.body.innerHTML}</body></html>`,
        );
      }
      act(() => scope('QQ').click());
      expect(panel.querySelector('[aria-label="QQ号/群号"]')).toBeNull();
      expect(scope('全部').getAttribute('aria-pressed')).toBe('mixed');
      act(() => scope('全部').click());
      expect(scope('QQ').getAttribute('aria-pressed')).toBe('true');
      act(() => scope('清空').click());
      expect(scope('QQ').getAttribute('aria-pressed')).toBe('false');
      expect(panel.textContent).toContain('未选择搜索范围');
      act(() => scope('全部').click());
      act(() => scope('联系人').click());
      expect(scope('联系人').getAttribute('aria-pressed')).toBe('false');
      expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('10002');
      act(() => scope('联系人').click());
      act(() => panel.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
      expect(more).toHaveBeenCalledWith('contact');
      act(() => panel.querySelector<HTMLButtonElement>('.weq-search-row')!.click());
      expect(select).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
