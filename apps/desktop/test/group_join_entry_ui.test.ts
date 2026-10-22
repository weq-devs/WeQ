import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function mount(contactTab: 'friends' | 'groups', showSearch: boolean) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = vi.fn();
  act(() =>
    root.render(
      h(
        ContentSelectionProvider,
        null,
        h(SidebarHeader, {
          user: { ...createTemplateDemoData().user, avatarUrl: '' },
          view: 'contacts',
          showSearch,
          query: '',
          onQueryChange: noop,
          onQuickInvite: noop,
          onCreateGroup: noop,
          onOpenProfile: noop,
          onOpenFriendNotices: noop,
          onOpenGroupNotices: noop,
          contactTab,
          onContactTabChange: noop,
          activeNotice: null,
        }),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
it.each([
  ['friends', true],
  ['groups', true],
  ['friends', false],
  ['groups', false],
] as const)(
  '%s showSearch=%s 的所有添加入口移除通用加群，其余菜单继续保留',
  (contactTab, showSearch) => {
    const host = mount(contactTab, showSearch);
    expect(host.querySelector('.weq-contact-join-entry')).toBeNull();
    act(() =>
      host.querySelector<HTMLButtonElement>('.mobile-sidebar-actions .sidebar-add')!.click(),
    );
    expect(host.textContent).not.toContain('申请加入 QQ 群');
    expect(host.textContent).toContain('QQ 号搜索');
    expect(host.textContent).toContain('群号搜索');
    act(() =>
      host
        .querySelector<HTMLButtonElement>('.weq-directory-toolbar [aria-label="添加联系人或分组"]')!
        .click(),
    );
    const menu = host.querySelector('.weq-directory-toolbar [role="menu"]')!;
    expect(menu.textContent).not.toContain('申请加入 QQ 群');
    expect(menu.textContent).toContain('QQ 号搜索');
    expect(menu.textContent).toContain('群号搜索');
    expect(menu.textContent).toContain('创建群聊');
    expect(menu.textContent).toContain('添加好友/群聊');
    expect(menu.textContent?.includes('新建分组')).toBe(contactTab === 'friends');
    expect(document.querySelector('[aria-label="QQ 群分享链接"]')).toBeNull();
  },
);
