import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { pageSnapshots, pageValue } from '../src/renderer/src/lib/pageSnapshots';
import {
  useChatShellController,
  noopChatShellHistoryAdapter,
} from '../src/renderer/src/im-template/template/shellController';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';
import { mobileBack, resetMobileRoot } from '../src/renderer/src/hooks/useMobileNavigation';

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
  resetMobileRoot();
  useToast.setState({ toasts: [] });
  vi.unstubAllGlobals();
});

it('竖屏重复选择当前会话保留会话和筛选，不重复登记导航或增加返回层级', () => {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), { matches: media.includes('max-width'), media }),
  );
  const p = mount();
  act(() => p.state().selectConversation('fixture-conversation'));
  act(() => p.state().setQuery('保留筛选'));
  const navigate = vi.fn();
  window.addEventListener('weq-mobile-navigate', navigate);
  try {
    act(() => p.state().selectConversation('fixture-conversation'));
    expect(p.state().activeConversationId).toBe('fixture-conversation');
    expect(p.state().view).toBe('messages');
    expect(p.state().query).toBe('保留筛选');
    expect(navigate).not.toHaveBeenCalled();
    act(() => expect(mobileBack()).toBe(true));
    expect(p.state().activeConversationId).toBeNull();
    expect(mobileBack()).toBe(false);
  } finally {
    window.removeEventListener('weq-mobile-navigate', navigate);
  }
});

it('手机从通知进入资料并连续查看其他资料，逐级返回原来源而非跳到联系人首页', () => {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), { matches: media.includes('max-width'), media }),
  );
  const shell = mount();
  act(() => shell.state().switchView('contacts'));
  act(() => shell.state().openContactNotice('friend'));
  act(() => shell.state().openContactDetails(person));
  act(() => shell.state().openGroupDetails(group));
  act(() => shell.state().backGroup());
  expect(shell.state().selectedContactId).toBe(person.id);
  expect(shell.state().selectedGroupConversationId).toBeNull();
  expect(shell.state().contactNotice).toBeNull();
  act(() => shell.state().backContact());
  expect(shell.state().contactNotice).toBe('friend');
  expect(shell.state().selectedContactId).toBeNull();
  act(() => shell.state().backContactNotice());
  expect(shell.state().view).toBe('contacts');
  expect(shell.state().contactNotice).toBeNull();
});

function mount(
  storage = new Storage(),
  scope: string | null = null,
  startupView: 'home' | 'messages' | null = null,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', storage);
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
      startupView,
      sidebarWidthStorageKey: 'test-contact-workspace',
      history: noopChatShellHistoryAdapter,
      onReadConversation: read,
    });
    return null;
  }
  act(() => root.render(h(PageSnapshots, { scope, resetOnMount: startupView !== null }, h(Probe))));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { state: () => current, contacts, conversations, read };
}

it('重建界面恢复栏目和联系人详情，另一数据源不继承旧导航', () => {
  const storage = new Storage();
  const first = mount(storage, 'account:source-a');
  act(() => first.state().openContactDetails(person, 'portrait'));
  const restored = mount(storage, 'account:source-a');
  expect(restored.state().view).toBe('contacts');
  expect(restored.state().selectedContactId).toBe(person.id);
  expect(restored.state().contactWorkspaceTab).toBe('portrait');
  const other = mount(storage, 'account:source-b');
  expect(other.state().view).toBe('messages');
  expect(other.state().selectedContactId).toBeNull();
});

it('旧标签相册章节快照恢复为概览，不重新打开已移除的聚合页', () => {
  const storage = new Storage();
  const scope = 'removed-label-albums';
  const first = mount(storage, scope);
  act(() => first.state().openContactDetails(person, 'marks'));
  pageSnapshots.write(JSON.stringify([scope, 'shell:contact-detail']), 'labels');
  const restored = mount(storage, scope);
  expect(restored.state().selectedContactId).toBe(person.id);
  expect(restored.state().contactWorkspaceTab).toBe('profile');
});

it.each([
  'profile',
  'details',
  'signatures',
  'questions',
  'marks',
  'group',
  'personality',
  'portrait',
  'history',
  'edit',
] as const)('联系人 %s 分区可保存并从磁盘恢复，不误报存储失败', (tab) => {
  const storage = new Storage();
  const scope = 'contact-sections';
  const first = mount(storage, scope);
  act(() => first.state().openContactDetails(person, tab === 'profile' ? 'marks' : 'profile'));
  act(() => first.state().setContactWorkspaceTab(tab));
  expect(first.state().contactWorkspaceTab).toBe(tab);
  expect(useToast.getState().toasts).toEqual([]);
  // 直接读磁盘，不能让同一工作区的内存兜底掩盖保存失败。
  expect(
    pageSnapshots.read(JSON.stringify([scope, 'shell:contact-detail']), pageValue.string),
  ).toBe(tab);
  const restored = mount(storage, scope);
  expect(restored.state().contactWorkspaceTab).toBe(tab);
});

it.each(['home', 'messages'] as const)('正常启动进入 %s，后续崩溃重建恢复新现场', (page) => {
  const storage = new Storage();
  const first = mount(storage, 'startup-source');
  act(() => first.state().openContactDetails(person, 'portrait'));
  const normal = mount(storage, 'startup-source', page);
  expect(normal.state().view).toBe(page);
  expect(normal.state().selectedContactId).toBeNull();
  expect(normal.state().contactWorkspaceTab).toBe('profile');
  // 启动选项只应用一次，导航后不会被拉回。
  act(() => normal.state().switchView('qzone'));
  expect(normal.state().view).toBe('qzone');
  const recovered = mount(storage, 'startup-source');
  expect(recovered.state().view).toBe('qzone');
  expect(recovered.state().selectedContactId).toBeNull();
});

it('启动到指定栏目后立即崩溃，也从该栏目恢复', () => {
  const storage = new Storage();
  const first = mount(storage, 'immediate-crash');
  act(() => first.state().switchView('qzone'));
  mount(storage, 'immediate-crash', 'home');
  expect(mount(storage, 'immediate-crash').state().view).toBe('home');
});

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

it('切换左侧好友与群聊不替换或关闭右侧详情，点击对象才切换详情', () => {
  const p = mount();
  act(() => p.state().openContactDetails(person, 'marks'));
  act(() => p.state().changeContactTab('groups'));
  expect(p.state().contactTab).toBe('groups');
  expect(p.state().selectedContact).toEqual(person);
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.state().contactWorkspaceTab).toBe('marks');
  expect(p.state().contactOverviewOpen).toBe(false);
  expect(p.state().mainOpen).toBe(true);
  act(() => p.state().openGroupDetails(group));
  act(() => p.state().changeContactTab('friends'));
  expect(p.state().contactTab).toBe('friends');
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().selectedGroupConversation).toEqual(group);
  expect(p.state().contactOverviewOpen).toBe(false);
  expect(p.state().mainOpen).toBe(true);
  act(() => p.state().changeContactTab('groups'));
  expect(p.state().selectedGroupConversation).toEqual(group);
  expect(p.state().selectedContact).toBeUndefined();
  act(() => p.state().selectContact(person));
  expect(p.state().selectedContact).toEqual(person);
  expect(p.state().selectedGroupConversation).toBeUndefined();
  act(() => p.state().selectGroup(group.id));
  expect(p.state().selectedGroupConversation).toEqual(group);
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.read).not.toHaveBeenCalled();
});

it('重建界面时分别恢复左侧分类和右侧已打开详情', () => {
  const storage = new Storage();
  const scope = 'independent-contact-detail';
  const first = mount(storage, scope);
  act(() => first.state().openContactDetails(person, 'marks'));
  act(() => first.state().changeContactTab('groups'));
  const restored = mount(storage, scope);
  expect(restored.state().contactTab).toBe('groups');
  expect(restored.state().selectedContact).toEqual(person);
  expect(restored.state().contactWorkspaceTab).toBe('marks');
  expect(restored.state().contactOverviewOpen).toBe(false);
});

it('旧现场没有独立详情分类时，首次切换目录仍保留原详情', () => {
  const storage = new Storage();
  const scope = 'legacy-contact-detail';
  mount(storage, scope);
  pageSnapshots.write(JSON.stringify([scope, 'shell:view']), 'contacts');
  pageSnapshots.write(JSON.stringify([scope, 'shell:contact-tab']), 'friends');
  pageSnapshots.write(JSON.stringify([scope, 'shell:contact']), person.id);
  const restored = mount(storage, scope);
  expect(restored.state().selectedContact).toEqual(person);
  act(() => restored.state().changeContactTab('groups'));
  expect(restored.state().selectedContact).toEqual(person);
  expect(mount(storage, scope).state().selectedContact).toEqual(person);
});

it('直接进入联系人且尚未打开好友或群聊时，默认显示群交集', () => {
  const p = mount();
  act(() => p.state().switchView('contacts'));
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.state().contactOverviewOpen).toBe(true);
});

it('横屏可从任意资料切换到群交集，不改变目录分类和查询', () => {
  const p = mount();
  act(() => p.state().openGroupDetails(group));
  act(() => p.state().setQuery('保留筛选'));
  act(() => p.state().openContactOverview());
  expect(p.state().view).toBe('contacts');
  expect(p.state().contactTab).toBe('groups');
  expect(p.state().query).toBe('保留筛选');
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().selectedGroupConversation).toBeUndefined();
  expect(p.state().contactNotice).toBeNull();
  expect(p.state().contactOverviewOpen).toBe(true);
});

it('竖屏群交集独立进入，资料返回图谱，再返回原目录且不残留旧返回层', () => {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), { matches: media.includes('max-width'), media }),
  );
  const p = mount();
  act(() => p.state().switchView('contacts'));
  act(() => p.state().changeContactTab('groups'));
  act(() => p.state().setQuery('保留筛选'));
  expect(p.state().mainOpen).toBe(false);
  act(() => p.state().openContactOverview());
  expect(p.state().mainOpen).toBe(true);
  act(() => p.state().openContactDetails(person));
  act(() => p.state().backContact());
  expect(p.state().mainOpen).toBe(true);
  expect(p.state().contactOverviewOpen).toBe(true);
  expect(p.state().selectedContact).toBeUndefined();
  expect(p.state().contactTab).toBe('groups');
  act(() => p.state().backContactOverview());
  expect(p.state().mainOpen).toBe(false);
  expect(p.state().contactTab).toBe('groups');
  expect(p.state().query).toBe('保留筛选');
  expect(mobileBack()).toBe(false);
  act(() => p.state().openContactOverview());
  act(() => p.state().switchView('messages'));
  act(() => p.state().switchView('contacts'));
  expect(p.state().mainOpen).toBe(false);
  expect(mobileBack()).toBe(false);
});

it.each(['home', 'messages', 'qzone', 'export', 'agentlab'] as const)(
  '从 %s 打开资料，连续查看联系人和群后关闭仍返回来源页',
  (view) => {
    const p = mount();
    act(() => p.state().switchView(view));
    act(() => p.state().setQuery('来源查询'));
    act(() => p.state().openContactDetails(person));
    act(() => p.state().openGroupDetails(group));
    act(() => p.state().backGroup());
    expect(p.state().view).toBe(view);
    expect(p.state().query).toBe('来源查询');
    expect(p.state().selectedContact).toBeUndefined();
    expect(p.state().selectedGroupConversation).toBeUndefined();
  },
);

it('从联系人目录打开资料，关闭清空两类选择并回到群交集', () => {
  const p = mount();
  act(() => p.state().switchView('contacts'));
  act(() => p.state().openContactDetails(person));
  act(() => p.state().openGroupDetails(group));
  act(() => p.state().backGroup());
  expect(p.state().view).toBe('contacts');
  expect(p.state().contactOverviewOpen).toBe(true);
  act(() => p.state().changeContactTab('friends'));
  expect(p.state().selectedContact).toBeUndefined();
});

it('主动离开资料页后，重新从联系人目录打开不沿用旧来源', () => {
  const p = mount();
  act(() => p.state().switchView('qzone'));
  act(() => p.state().openContactDetails(person));
  act(() => p.state().switchView('contacts'));
  act(() => p.state().selectContact(person));
  act(() => p.state().backContact());
  expect(p.state().view).toBe('contacts');
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
