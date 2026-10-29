import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  groupRelationship,
  personRelationship,
  RelationshipDirectoryContext,
  type RelationshipDirectory,
} from '../src/renderer/src/lib/contactRelationship';
import {
  ContactProfileDialog,
  GroupProfileDialog,
} from '../src/renderer/src/im-template/template/profilePanes';
import { PersonRelationshipStatus } from '../src/renderer/src/components/RelationshipStatus';
import { GroupList } from '../src/renderer/src/im-template/template/conversationLists';
import { GroupSettingsPanel } from '../src/renderer/src/im-template/template/groupSettingsPanel';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/components/ContactWorkspace', () => ({
  ContactWorkspace: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/qq-actions/CommonRelationships', () => ({
  CommonRelationships: () => null,
}));
vi.mock('../src/renderer/src/components/qq-actions/ProfileLikesRow', () => ({
  ProfileLikesRow: () => null,
}));

const directory: RelationshipDirectory = {
  selfUid: 'u_self',
  selfUin: '10000',
  friends: new Map([
    ['u_friend', { categoryName: '同学' }],
    ['10001', { categoryName: '同学' }],
  ]),
  friendsComplete: true,
  groups: new Map([
    ['20001', { listed: true, role: 'admin' }],
    ['20002', { listed: false, role: 'owner' }],
  ]),
};
const person: Contact = {
  id: 'u_friend',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'u_friend',
  displayName: '合成联系人',
  avatarUrl: null,
  createdAt: new Date(0).toISOString(),
};
const group: GroupConversation = {
  id: '20001',
  type: 'group',
  updatedAt: new Date(0).toISOString(),
  lastMessage: null,
  otherUser: null,
  members: [],
  group: {
    id: '20001',
    identityLabel: '群号',
    identityValue: '20001',
    name: '合成群',
    avatarUrl: null,
    announcement: null,
    memberCount: 20,
    role: 'owner',
    roleKnown: true,
  },
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function mount(node: ReactNode, value: RelationshipDirectory | null = directory) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: RelationshipDirectory | null) =>
    act(() => root.render(h(RelationshipDirectoryContext.Provider, { value: next }, node)));
  render(value);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, render };
}

it('好友名册优先于旧资料缓存，自身支持 UID、QQ 号和本地 self 身份', () => {
  expect(personRelationship({ id: 'u_friend', isFriend: false }, directory)).toBe('friend');
  expect(personRelationship({ id: 'u_stranger', isFriend: true }, directory)).toBe('nonfriend');
  for (const identity of [{ id: 'u_self' }, { identityValue: '10000' }, { id: 'self:10000' }])
    expect(personRelationship(identity, directory)).toBe('self');
  expect(personRelationship({ identityValue: '10001' }, directory)).toBe('friend');
  expect(personRelationship({ isFriend: false, friendshipKnown: false })).toBe('unknown');
  expect(personRelationship({})).toBe('unknown');
  expect(personRelationship({ id: 'u_other' }, { ...directory, friendsComplete: false })).toBe(
    'unknown',
  );
});

it('群关系不使用角色、群人数或缓存缺席推断，未知不能当成不在群', () => {
  expect(groupRelationship({ id: '20001', listed: false }, directory)).toBe('member');
  expect(groupRelationship({ id: '20002', role: 'owner' }, directory)).toBe('nonmember');
  expect(groupRelationship({ id: '20003', role: 'owner' }, directory)).toBe('unknown');
  expect(groupRelationship({ listed: false })).toBe('unknown');
  expect(groupRelationship({ listed: false, membershipKnown: true })).toBe('nonmember');
  expect(groupRelationship({ membershipKnown: true })).toBe('unknown');
});

it.each([false, true])(
  '完整联系人资料与浮层共用关系信息（内嵌 %s），不冒称非好友为好友',
  (embedded) => {
    const { host } = mount(
      h(ContactProfileDialog, { contact: person, embedded, onClose: vi.fn() }),
    );
    const scope = embedded ? host : document.body;
    expect(scope.querySelector('[data-relationship="friend"]')?.textContent).toContain('我的好友');
    expect(scope.querySelector('[data-relationship="friend"]')?.textContent).toContain('同学');
    expect(scope.querySelector('[aria-label="联系人资料"]')).not.toBeNull();
  },
);

it('名册刷新实时改变关系，非好友和未知都不显示好友分组', () => {
  const { host, render } = mount(h(PersonRelationshipStatus, { person }));
  expect(host.textContent).toContain('我的好友');
  render({ ...directory, friends: new Map() });
  expect(host.textContent).toBe('非好友');
  render(null);
  expect(host.textContent).toBe('关系待确认');
});

it.each(['20001', '20002', '20003'])('群名片 %s 显示关系，群外不显示旧管理身份', (code) => {
  const conversation = {
    ...group,
    id: code,
    group: { ...group.group, id: code, identityValue: code },
  };
  const { host } = mount(h(GroupProfileDialog, { conversation, embedded: true, onClose: vi.fn() }));
  const badge = host.querySelector('.weq-relationship-status')!;
  expect(badge.textContent).toBe(
    code === '20001' ? '我在群内· 管理员' : code === '20002' ? '我不在群内' : '入群状态待确认',
  );
  expect(host.textContent).not.toContain('群主');
});

it('克隆与我的设备不显示真实 QQ 关系', () => {
  const { host } = mount(
    h(
      'div',
      null,
      h(PersonRelationshipStatus, { person: { ...person, clone: true } }),
      h(PersonRelationshipStatus, { person: { ...person, identityLabel: '设备' } }),
    ),
  );
  expect(host.querySelector('.weq-relationship-status')).toBeNull();
});

it.each(['20001', '20002', '20003'])('群列表 %s 与名片状态一致，未知关系仍可查看', (code) => {
  const conversation = {
    ...group,
    id: code,
    group: { ...group.group, id: code, identityValue: code },
  };
  const { host } = mount(
    h(GroupList, { conversations: [conversation], activeConversationId: code, onSelect: vi.fn() }),
  );
  expect(
    host.querySelector('.contact-row [data-relationship]')?.getAttribute('data-relationship'),
  ).toBe(code === '20001' ? 'member' : code === '20002' ? 'nonmember' : 'unknown');
  expect(host.textContent).not.toContain('已解散');
  expect(host.textContent).not.toContain('已退出');
});

it.each(['20001', '20002', '20003'])(
  '群设置 %s 不因旧管理角色向群外或未知对象开放管理操作',
  (code) => {
    const conversation = {
      ...group,
      id: code,
      group: { ...group.group, id: code, identityValue: code },
    };
    const { host } = mount(
      h(GroupSettingsPanel, {
        conversation,
        panelRef: { current: null },
        onUpdateGroup: vi.fn(),
        detailActionGroups: [],
        detailActionContext: {},
      }),
    );
    expect(Boolean(host.querySelector('[title="编辑群资料"]'))).toBe(code === '20001');
  },
);
