import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { groupAssistantPreferences } from '../src/renderer/src/lib/groupAssistant';
import { groupDirectoryPreference } from '../src/renderer/src/lib/groupNotifications';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { createTemplateDemoData } from './support/templateDemoData';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));
afterEach(() => vi.unstubAllGlobals());
const seed = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
const mutedGroup = {
  ...seed,
  unreadCount: 7,
  preference: { pinned: false, muted: true, blocked: true },
};

it('未保存本地偏好时，群助手内置顶不能用默认 false 覆盖 QQ 的免打扰状态', () => {
  expect(
    groupAssistantPreferences([mutedGroup], {}, { [mutedGroup.id]: true })[mutedGroup.id],
  ).toEqual({ pinned: true, muted: true, blocked: true });
  expect(
    groupAssistantPreferences([mutedGroup], {}, { [mutedGroup.id]: false })[mutedGroup.id],
  ).toEqual({ pinned: false, muted: true, blocked: true });
});

it('保留明确的本地免打扰覆盖和其他会话偏好，分类置顶单独协调', () => {
  const preferences = {
    [mutedGroup.id]: { pinned: false, muted: false, blocked: false },
    other: { pinned: true, muted: true, blocked: false },
  };
  expect(groupAssistantPreferences([mutedGroup], preferences, { [mutedGroup.id]: true })).toEqual({
    ...preferences,
    [mutedGroup.id]: { pinned: true, muted: false, blocked: false },
  });
});

it('只有群目录、notifyLevel=2 时即显示免打扰；未读数据到达前后保持一致', () => {
  const directoryOnly = {
    ...seed,
    notifyLevel: 2,
    preference: groupDirectoryPreference(2, undefined, true),
  };
  expect(groupAssistantPreferences([directoryOnly], {}, {})[directoryOnly.id]).toEqual({
    pinned: true,
    muted: true,
    blocked: false,
  });
  const withRecent = {
    ...directoryOnly,
    preference: groupDirectoryPreference(2, mutedGroup.preference, true),
  };
  expect(groupAssistantPreferences([withRecent], {}, {})[withRecent.id]).toEqual({
    pinned: true,
    muted: true,
    blocked: true,
  });
  expect(groupDirectoryPreference(undefined, mutedGroup.preference).muted).toBe(true);
  expect(groupDirectoryPreference(1, mutedGroup.preference).muted).toBe(false);
});

it.each([null, mutedGroup.id])(
  '普通和选中状态下，置顶前后都保留免打扰角标：%s',
  (activeConversationId) => {
    vi.stubGlobal('localStorage', new Storage());
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    function Fixture() {
      const [pinned, setPinned] = useState(false);
      const preferences = groupAssistantPreferences([mutedGroup], {}, { [mutedGroup.id]: pinned });
      return h(
        ConversationDirectoryContext.Provider,
        {
          value: {
            view: 'groupAssistant',
            rows: [mutedGroup],
            virtual: [],
            onVirtual: () => {},
            onCreate: () => {},
          },
        },
        h('button', { 'data-toggle-pin': '', onClick: () => setPinned((value) => !value) }, '置顶'),
        h(ConversationList, {
          conversations: [mutedGroup],
          activeConversationId,
          preferences,
          drafts: {},
          onSelect: () => {},
        }),
      );
    }
    try {
      act(() => root.render(h(Fixture)));
      const unread = () => host.querySelector('.row-unread');
      expect(unread()?.classList.contains('muted')).toBe(true);
      expect(unread()?.textContent).toBe('7');
      act(() => host.querySelector<HTMLButtonElement>('[data-toggle-pin]')!.click());
      expect(unread()?.classList.contains('muted')).toBe(true);
      expect(unread()?.textContent).toBe('7');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
