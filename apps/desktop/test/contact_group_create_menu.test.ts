import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { FriendDirectoryContext } from '../src/renderer/src/components/FriendDirectoryControls';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('联系人分组添加入口位置', () => {
  it.each([true, false])(
    'showSearch=%s 时始终与会话列表一样放在顶部工具栏，不放好友／群聊切换行',
    (showSearch) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host),
        create = vi.fn(),
        noop = vi.fn();
      try {
        act(() =>
          root.render(
            h(
              ContentSelectionProvider,
              null,
              h(
                FriendDirectoryContext.Provider,
                {
                  value: {
                    categories: [],
                    assignments: new Map(),
                    busy: false,
                    available: true,
                    create,
                    edit: noop,
                    move: noop,
                    sort: noop,
                  },
                },
                h(SidebarHeader, {
                  user: createTemplateDemoData().user,
                  view: 'contacts',
                  query: '',
                  showSearch,
                  onQueryChange: noop,
                  onQuickInvite: noop,
                  onCreateGroup: noop,
                  onOpenProfile: noop,
                  onOpenFriendNotices: noop,
                  onOpenGroupNotices: noop,
                  contactTab: 'friends',
                  onContactTabChange: noop,
                  activeNotice: null,
                }),
              ),
            ),
          ),
        );
        const entry = host.querySelector<HTMLButtonElement>(
          '.weq-directory-toolbar [aria-label="添加联系人或分组"]',
        );
        expect(entry).not.toBeNull();
        expect(entry?.closest('.weq-directory-scope')).not.toBeNull();
        expect(entry?.querySelector('svg')?.getAttribute('width')).toBe('16');
        expect(host.querySelector('.contact-list-controls .sidebar-add-wrap')).toBeNull();
        act(() => entry!.click());
        const menu = host.querySelector('.weq-directory-toolbar .weq-directory-scope-menu');
        expect(menu?.getAttribute('role')).toBe('menu');
        const items = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        expect(items.map((item) => item.textContent)).toEqual([
          'QQ 号搜索',
          '群号搜索',
          '新建分组',
          '创建群聊',
          '添加好友/群聊',
        ]);
        const item = items.find((item) => item.textContent === '新建分组');
        expect(item?.textContent).toBe('新建分组');
        act(() => item!.click());
        expect(create).toHaveBeenCalledOnce();
        expect(host.querySelector('.weq-directory-toolbar [role="menu"]')).toBeNull();
        act(() =>
          entry!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
        );
        expect(host.querySelector('.weq-directory-toolbar [role="menu"]')).not.toBeNull();
        act(() =>
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          ),
        );
        expect(host.querySelector('.weq-directory-toolbar [role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(entry);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );
});
