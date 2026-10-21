import { act, createElement as h, type ReactNode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (Component: ComponentType<{ onClose: () => void }>) => Component,
  useQQAction: () => ({ binding: null, disabled: true }),
  ActionFeedback: () => null,
  ActionIcon: ({
    label,
    children,
    ...props
  }: {
    label: string;
    children: ReactNode;
    disabled?: boolean;
    onClick: () => void;
  }) => h('button', { ...props, type: 'button', 'aria-label': label }, children),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({ client: {} }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function mount(contactTab: 'friends' | 'groups') {
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
it('群聊目录提供直接可见的加入入口，打开真实加群表单并可关闭', () => {
  const host = mount('groups');
  const entry = host.querySelector<HTMLButtonElement>(
    '.contact-list-controls [aria-label="申请加入 QQ 群"]',
  );
  expect(entry).not.toBeNull();
  expect(entry?.textContent).toContain('加入群聊');
  const output = process.env.WEQ_JOIN_LAYOUT_DIR;
  if (output) {
    mkdirSync(output, { recursive: true });
    const links = ['index.css', 'contact-navigation.css']
      .map(
        (file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`,
      )
      .join('');
    writeFileSync(
      resolve(output, 'join-entry.html'),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${links}<style>body{margin:0;background:var(--background);font-family:system-ui}.sidebar{width:min(360px,100vw);height:100vh}*,*::before,*::after{box-sizing:border-box}</style><body><aside class="sidebar">${host.innerHTML}</aside></body></html>`,
    );
  }
  act(() => entry!.click());
  expect(document.querySelector('[aria-label="QQ 群分享链接"]')).not.toBeNull();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭加群窗口"]')!.click());
  expect(document.querySelector('[aria-label="QQ 群分享链接"]')).toBeNull();
});
it('好友页保留原添加菜单，加群操作挂到真实 portal 而非隐藏移动端容器', () => {
  const host = mount('friends');
  expect(host.querySelector('.contact-list-controls [aria-label="申请加入 QQ 群"]')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('.desktop-sidebar-add .sidebar-add')!.click());
  const join = [
    ...host.querySelectorAll<HTMLButtonElement>('.desktop-sidebar-add .sidebar-add-menu button'),
  ].find((node) => node.textContent === '申请加入 QQ 群')!;
  act(() => join.click());
  const input = document.querySelector('[aria-label="QQ 群分享链接"]')!;
  expect(input).not.toBeNull();
  expect(input.closest('.mobile-sidebar-top')).toBeNull();
  expect(host.querySelector('.sidebar-add-menu')).toBeNull();
});
