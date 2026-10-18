import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { countVisibleUnreadConversations } from '../src/renderer/src/im-template/template/shellController';
import { readFileSync } from 'node:fs';

it('主界面将实际未读汇总传入消息入口，不固定为零', () => {
  const source = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
  expect(source.includes('messageBadgeCount={shell.messageUnreadCount}')).toBe(true);
});

it('消息汇总按消息条数累加，免打扰可由本地偏好覆盖', () => {
  const [first, second] = createTemplateDemoData().conversations;
  const conversations = [
    { ...first, unreadCount: 3, preference: { pinned: false, muted: false, blocked: false } },
    { ...second, unreadCount: 7, preference: { pinned: false, muted: true, blocked: false } },
  ];
  expect(countVisibleUnreadConversations(conversations, {})).toBe(3);
  expect(countVisibleUnreadConversations(conversations, { [second.id]: { muted: false } })).toBe(
    10,
  );
  expect(countVisibleUnreadConversations(conversations, { [first.id]: { muted: true } })).toBe(0);
});

it('收藏与后部页面入口按实际页面高亮，返回消息后清除旧高亮', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host),
    noop = () => {};
  const props = {
    user: createTemplateDemoData().user,
    onViewChange: noop,
    onOpenSettings: noop,
    onOpenCollection: noop,
    onOpenMarketBrowser: noop,
    onOpenDressUp: noop,
    onOpenProfile: noop,
    onOpenAbout: noop,
    onOpenInvite: noop,
    onOpenWonderfulTools: noop,
    onOpenAntiRecall: noop,
    onOpenDbRepair: noop,
    onOpenQzoneAlbum: noop,
  };
  try {
    act(() => root.render(h(AppRail, { ...props, view: 'collections' })));
    expect(host.querySelector('.rail-tab-collection')?.classList.contains('active')).toBe(true);
    for (const activeRailItem of ['market', 'dressup', 'settings'] as const) {
      act(() => root.render(h(AppRail, { ...props, view: 'messages', activeRailItem })));
      expect(host.querySelectorAll('.rail-tab.active')).toHaveLength(1);
      expect(host.querySelector(`.rail-tab-${activeRailItem}`)?.getAttribute('aria-current')).toBe(
        'page',
      );
    }
    act(() => root.render(h(AppRail, { ...props, view: 'messages' })));
    expect(host.querySelector('.rail-tab-messages')?.classList.contains('active')).toBe(true);
    expect(host.querySelector('.rail-tab-settings')?.classList.contains('active')).toBe(false);
    for (const [count, label] of [
      [8, '8'],
      [120, '99+'],
      [0, null],
    ] as const) {
      act(() => root.render(h(AppRail, { ...props, view: 'messages', messageBadgeCount: count })));
      expect(host.querySelector('.rail-tab-messages .rail-badge')?.textContent ?? null).toBe(label);
    }
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
