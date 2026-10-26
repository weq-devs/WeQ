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
