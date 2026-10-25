import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import {
  findSettingElement,
  revealSetting,
} from '../src/renderer/src/components/settings/searchTarget';
import { Row, Toggle } from '../src/renderer/src/components/settings/controls';
import type { SearchCategory } from '../src/renderer/src/components/search/types';
import type { SearchPosition } from '../src/renderer/src/components/search/searchPosition';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('功能与设置搜索界面', () => {
  it('展开更多后跳到内容，返回时保留功能列表的展开状态', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const navigate = vi.fn();
    const props = {
      keyword: '设置',
      quick: {
        conversations: [],
        groupMembers: [],
        friends: [
          {
            category: 'friend' as const,
            uid: 'u_fixture',
            uin: '10001',
            nick: '合成设置',
            remark: '',
            avatarUrl: null,
          },
        ],
      },
      quickLoading: false,
      slow: null,
      slowLoading: false,
      categories: ['friend'] as SearchCategory[],
      onCategoriesChange: vi.fn(),
      onSelect: vi.fn(),
      onMore: vi.fn(),
      appSearchEnabled: true,
      onSelectAppEntry: vi.fn(),
      onNavigate: navigate,
    };
    try {
      act(() => root.render(h(SearchDropdown, props)));
      expect(host.querySelectorAll('.weq-app-search [role="option"]')).toHaveLength(6);
      act(() => host.querySelector<HTMLButtonElement>('.weq-app-search-expand')!.click());
      const count = host.querySelectorAll('.weq-app-search [role="option"]').length;
      expect(count).toBeGreaterThan(6);
      act(() =>
        host.querySelector<HTMLButtonElement>('[data-search-hit-key="friend:u_fixture"]')!.click(),
      );
      const position = navigate.mock.calls[0]![0] as SearchPosition;
      expect(position.appResultsExpanded).toBe(true);
      act(() => root.render(null));
      act(() => root.render(h(SearchDropdown, { ...props, initialPosition: position })));
      expect(host.querySelectorAll('.weq-app-search [role="option"]')).toHaveLength(count);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('内容请求尚未返回时已可打开设置，独立范围与全选、全取消一致', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const select = vi.fn();
    function Harness() {
      const [categories, setCategories] = useState<SearchCategory[]>([]);
      const [enabled, setEnabled] = useState(true);
      return h(SearchDropdown, {
        keyword: '深色模式',
        quick: null,
        quickLoading: false,
        slow: null,
        slowLoading: false,
        categories,
        onCategoriesChange: setCategories,
        onSelect: vi.fn(),
        onMore: vi.fn(),
        appSearchEnabled: enabled,
        onAppSearchEnabledChange: setEnabled,
        onSelectAppEntry: select,
      });
    }
    try {
      act(() => root.render(h(Harness)));
      expect(host.textContent).not.toContain('未选择搜索范围');
      const output = process.env.WEQ_FEATURE_SEARCH_LAYOUT_DIR;
      if (output) {
        mkdirSync(output, { recursive: true });
        const styles = ['index.css', 'workspace-tools.css', 'search-scope.css', 'app-search.css']
          .map((name) => readFileSync(resolve('src/renderer/src/styles', name), 'utf8'))
          .join('\n');
        writeFileSync(
          resolve(output, 'search.html'),
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><style>body{margin:0;background:var(--background);color:var(--foreground);font-family:system-ui}.weq-titlebar-search-results{left:8px;top:48px;width:min(720px,calc(100vw - 16px));max-height:calc(100dvh - 64px)}</style><body><div class="weq-titlebar-search-results">${host.innerHTML}</div></body></html>`,
        );
      }
      act(() =>
        host
          .querySelector<HTMLButtonElement>(
            '[data-search-hit-key="app:setting:appearance:基础模式"]',
          )!
          .click(),
      );
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: 'setting', section: 'appearance', item: '基础模式' },
        }),
      );
      const all = host.querySelector<HTMLInputElement>('[aria-label="全部范围"]')!;
      expect(all.indeterminate).toBe(true);
      act(() => all.click());
      expect(all.checked).toBe(true);
      act(() => all.click());
      expect(host.textContent).toContain('未选择搜索范围');
      expect(host.querySelector('.weq-app-search')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('定位真实设置行并聚焦、高亮，不点击开关；撤销后恢复属性', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const change = vi.fn();
    act(() =>
      root.render(
        h(Row, {
          label: '显示消息序号（seq）',
          control: h(Toggle, { checked: false, label: '显示消息序号（seq）', onChange: change }),
        }),
      ),
    );
    const row = host.querySelector<HTMLElement>('.weq-set-row')!;
    try {
      expect(findSettingElement(host, '显示消息序号（seq）')).toBe(row);
      expect(findSettingElement(host, '显示消息序号')).toBeNull();
      const dispose = revealSetting(host, '显示消息序号（seq）');
      expect(row.dataset.searchHighlight).toBe('true');
      expect(document.activeElement).toBe(row);
      expect(change).not.toHaveBeenCalled();
      dispose();
      expect(row.hasAttribute('tabindex')).toBe(false);
      expect(row.hasAttribute('data-search-highlight')).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('异步加载后可定位，离开后不再定位迟到的控件', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = revealSetting(host, '缓存目录');
    const title = document.createElement('div');
    title.className = 'weq-set-card-title';
    title.textContent = '缓存目录';
    host.append(title);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(title.dataset.searchHighlight).toBe('true');
    dispose();
    title.remove();
    const cancel = revealSetting(host, '缓存目录');
    cancel();
    host.append(title);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(title.hasAttribute('data-search-highlight')).toBe(false);
    host.remove();
  });
});
