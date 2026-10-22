import { act, createElement as h, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import {
  SEARCH_CATEGORY_ORDER,
  type SearchCategory,
} from '../src/renderer/src/components/search/types';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));
vi.mock('../src/renderer/src/components/QQExactLookup', () => ({
  QQExactLookup: ({
    kind,
    initial,
    onClose,
  }: {
    kind: 'user' | 'group';
    initial?: string;
    onClose: () => void;
  }) =>
    createPortal(
      h(
        'section',
        { role: 'dialog', 'aria-label': '精确查询', 'data-kind': kind },
        h('input', { defaultValue: initial, 'aria-label': 'QQ 号码' }),
        h('button', { onClick: onClose }, '关闭查询'),
      ),
      document.body,
    ),
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('全局搜索增量接入不替换原功能', () => {
  it.each(['', '10002'])('仅悬停时不显示号码搜索操作，主动点击后分别显示两类入口：%s', (query) => {
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
        host.firstElementChild!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })),
      );
      expect(document.querySelector('[data-local-search]')).not.toBeNull();
      expect(document.querySelector('.weq-cloud-lookup-entry')).toBeNull();
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
      const entries = document.querySelectorAll<HTMLButtonElement>('.weq-cloud-lookup-entry');
      expect([...entries].map((node) => node.getAttribute('aria-label'))).toEqual([
        'QQ 号搜索',
        '群号搜索',
      ]);
      act(() => entries[1]!.click());
      expect(document.querySelector('[aria-label="精确查询"]')?.getAttribute('data-kind')).toBe(
        'group',
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('保留全部范围、命中、更多与选择，号码查询弹窗关闭后原词和范围不丢失', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host),
      select = vi.fn(),
      more = vi.fn();
    function Harness() {
      const [categories, setCategories] = useState<SearchCategory[]>([...SEARCH_CATEGORY_ORDER]);
      return h(TitleBarSearch, {
        query: '10002',
        onQueryChange: vi.fn(),
        results: h(SearchDropdown, {
          keyword: '10002',
          quick: {
            conversations: [],
            groupMembers: [],
            friends: [1, 2, 3].map((id) => ({
              category: 'friend' as const,
              uid: `u_synthetic${id}`,
              uin: '10002',
              nick: `合成好友${id}`,
              remark: '',
              avatarUrl: null,
            })),
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
          onSelect: select,
          onMore: more,
        }),
      });
    }
    try {
      act(() => root.render(h(Harness)));
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
      const panel = document.querySelector<HTMLElement>('.weq-titlebar-search-results')!;
      expect(panel.querySelector('[aria-label="搜索范围"]')).not.toBeNull();
      expect(panel.textContent).toContain('合成好友1');
      expect(panel.textContent).toContain('聊天记录');
      expect(panel.querySelector('.weq-cloud-lookup-entry')).not.toBeNull();
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
      const friendBox = [...panel.querySelectorAll<HTMLLabelElement>('.weq-search-scope label')]
        .find((label) => label.textContent === '好友')!
        .querySelector<HTMLInputElement>('input')!;
      act(() => friendBox.click());
      expect(friendBox.checked).toBe(false);
      act(() => panel.querySelector<HTMLButtonElement>('.weq-cloud-lookup-entry')!.click());
      const dialog = document.querySelector('[aria-label="精确查询"]')!;
      act(() => dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      expect(document.querySelector('.weq-titlebar-search-results')).not.toBeNull();
      act(() => dialog.querySelector<HTMLButtonElement>('button')!.click());
      expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('10002');
      expect(friendBox.checked).toBe(false);
      act(() => friendBox.click());
      act(() => panel.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
      expect(more).toHaveBeenCalledWith('friend');
      act(() => panel.querySelector<HTMLButtonElement>('.weq-search-row')!.click());
      expect(select).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('没有最近搜索或本地结果时，精确查询入口仍然可见', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(h(TitleBarSearch, { query: '', onQueryChange: vi.fn(), results: null })),
      );
      act(() =>
        host.firstElementChild!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })),
      );
      expect(document.querySelector('.weq-titlebar-search-results')).toBeNull();
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
      expect(document.querySelectorAll('.weq-cloud-lookup-entry')).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
