import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import {
  useChatShellController,
  noopChatShellHistoryAdapter,
} from '../src/renderer/src/im-template/template/shellController';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';

const person: Contact = {
  id: 'u_known',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'u_known',
  displayName: '目录好友',
  avatarUrl: null,
  createdAt: new Date(0).toISOString(),
};
const group: GroupConversation = {
  id: '10002',
  type: 'group',
  updatedAt: new Date(0).toISOString(),
  lastMessage: null,
  otherUser: null,
  group: {
    id: '10002',
    name: '目录外群',
    identityLabel: '群号',
    identityValue: '10002',
    avatarUrl: null,
    announcement: null,
    memberCount: 5,
    role: 'member',
  },
  members: [],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const contacts = [person];
  const conversations: GroupConversation[] = [];
  const read = vi.fn();
  let current: ReturnType<typeof useChatShellController>;
  function Probe() {
    current = useChatShellController({
      contacts,
      conversations,
      conversationPrefs: {},
      initialActiveConversationId: null,
      initialView: 'messages',
      sidebarWidthStorageKey: 'test-contact-workspace',
      history: noopChatShellHistoryAdapter,
      onReadConversation: read,
    });
    return null;
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { state: () => current, contacts, conversations, read };
}

it('群友或陌生人的名片可展开，不写入好友目录或改变会话阅读状态', () => {
  const p = mount();
  const stranger = { ...person, id: 'u_stranger', identityValue: '10003', displayName: '合成群友' };
  act(() => {
    p.state().setQuery('旧搜索');
    p.state().openContactDetails(stranger, 'portrait');
  });
  expect(p.state().view).toBe('contacts');
  expect(p.state().contactTab).toBe('friends');
  expect(p.state().selectedContact).toEqual(stranger);
  expect(p.state().mainOpen).toBe(true);
  expect(p.state().contactWorkspaceTab).toBe('portrait');
  expect(p.state().query).toBe('');
  expect(p.contacts).toEqual([person]);
  expect(p.read).not.toHaveBeenCalled();
  act(() => p.state().backContact());
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().mainOpen).toBe(false);
});

it('目录外群名片可展开，连续切换不会残留前一个好友或群', () => {
  const p = mount();
  act(() => p.state().openContactDetails(person, 'marks'));
  act(() => p.state().openGroupDetails(group));
  expect(p.state().view).toBe('contacts');
  expect(p.state().contactTab).toBe('groups');
  expect(p.state().selectedGroupConversation).toEqual(group);
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.conversations).toHaveLength(0);
  act(() => p.state().openContactDetails(person));
  expect(p.state().selectedContact).toEqual(person);
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.state().contactWorkspaceTab).toBe('profile');
});

it('切换好友与群聊分别保留详情和好友分区，未选对象时显示群交集首页', () => {
  const p = mount();
  act(() => p.state().openContactDetails(person, 'marks'));
  act(() => p.state().changeContactTab('groups'));
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.state().contactOverviewOpen).toBe(true);
  act(() => p.state().openGroupDetails(group));
  act(() => p.state().changeContactTab('friends'));
  expect(p.state().selectedContact).toEqual(person);
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.state().contactWorkspaceTab).toBe('marks');
  act(() => p.state().changeContactTab('groups'));
  expect(p.state().selectedGroupConversation).toEqual(group);
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.read).not.toHaveBeenCalled();
});

it('直接进入联系人且尚未打开好友或群聊时，默认显示群交集', () => {
  const p = mount();
  act(() => p.state().switchView('contacts'));
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.state().contactOverviewOpen).toBe(true);
});

it('尚未选择对象时切换标签、离开后重进，都不显示联系人占位页', () => {
  const p = mount();
  act(() => p.state().changeContactTab('groups'));
  act(() => p.state().switchView('contacts'));
  expect(p.state().contactOverviewOpen).toBe(true);
  act(() => p.state().changeContactTab('friends'));
  expect(p.state().contactOverviewOpen).toBe(true);
  act(() => p.state().switchView('messages'));
  act(() => p.state().switchView('contacts'));
  expect(p.state().contactOverviewOpen).toBe(true);
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.read).not.toHaveBeenCalled();
});

it('离开联系人再返回保留当前详情，主动返回群交集后仍可切换标签', () => {
  const p = mount();
  act(() => p.state().openContactDetails(person, 'portrait'));
  act(() => p.state().switchView('qzone'));
  act(() => p.state().switchView('contacts'));
  expect(p.state().selectedContact).toEqual(person);
  expect(p.state().contactWorkspaceTab).toBe('portrait');
  expect(p.state().contactOverviewOpen).toBe(false);
  act(() => p.state().backContact());
  expect(p.state().contactOverviewOpen).toBe(true);
  expect(p.state().selectedContact).toBeUndefined();
  act(() => p.state().changeContactTab('groups'));
  expect(p.state().contactOverviewOpen).toBe(true);
});
