import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock(
  '../src/renderer/src/hooks/useContactDirectoryOrder',
  () => import('./support/contact-order.stub'),
);

// 名片与资料页现在统一读 bootstrap.getSettings（内容开关）并带 tanstack 查询；
// 这里只搭一个空壳 trpc 树，不改变本文件断言的关系语义。
vi.mock('../src/renderer/src/trpc/client', () => {
  const emptyQuery = () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: false,
    error: null,
    refetch: async () => ({ data: undefined }),
  });
  const tree: any = () =>
    new Proxy(() => {}, {
      get: (_target, key: string) => {
        if (key === 'useQuery' || key === 'useInfiniteQuery') return emptyQuery;
        if (key === 'useMutation')
          return () => ({ isLoading: false, error: null, mutateAsync: async () => ({}) });
        if (key === 'query') return async () => null;
        if (key === 'useUtils') return () => tree();
        if (key === 'getData') return () => undefined;
        if (key === 'setData') return () => undefined;
        if (key === 'invalidate' || key === 'cancel') return async () => undefined;
        return tree();
      },
      apply: () => undefined,
    });
  const allVisible = {
    contactCard: {
      visible: Object.fromEntries(
        [
          'qqShow',
          'pendant',
          'signature',
          'signatureUpdated',
          'gender',
          'age',
          'birthday',
          'constellation',
          'zodiac',
          'bloodType',
          'region',
          'occupation',
          'school',
          'labels',
          'photos',
          'status',
          'common',
          'category',
          'intimacy',
          'relations',
          'marks',
          'privileges',
          'level',
          'likes',
          'energy',
          'qid',
          'uid',
          'description',
          'company',
          'email',
          'friendClue',
          'notes',
          'botDescription',
          'botFeatures',
          'groupLevel',
          'joinedAt',
          'lastSpeakAt',
        ].map((key) => [key, true]),
      ),
    },
  };
  const settingsTree: any = () =>
    new Proxy(() => {}, {
      get: (_target, key: string) => {
        if (key === 'useQuery') return () => ({ data: allVisible, isLoading: false, error: null });
        if (key === 'query') return async () => allVisible;
        if (key === 'useUtils') return () => tree();
        return settingsTree();
      },
      apply: () => undefined,
    });
  return {
    client: tree(),
    trpc: new Proxy(() => {}, {
      get: (_target, key: string) => {
        if (key === 'bootstrap') return settingsTree();
        if (key === 'useUtils') return () => tree();
        return tree();
      },
      apply: () => undefined,
    }),
    useQQWriteSession: () => ({
      binding: { expectedAccountUin: '10000', expectedAccountConfigId: 'stub' },
      available: true,
      busy: false,
      result: null,
      run: async () => true,
    }),
  };
});

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
import { ContactList, GroupList } from '../src/renderer/src/im-template/template/conversationLists';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/components/ContactWorkspace', () => ({
  ContactWorkspace: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/qq-actions/CommonRelationships', () => ({
  CommonRelationships: () => null,
}));
vi.mock('../src/renderer/src/components/qq-actions/FriendClue', () => ({
  FriendClue: ({ uid }: { uid: string }) => h('div', { 'data-friend-clue': uid }),
}));
vi.mock('../src/renderer/src/components/qq-actions/ProfileLikesRow', () => ({
  ProfileLikesRow: () => null,
}));
vi.mock('../src/renderer/src/components/ProfileExtras', () => ({ ProfileExtras: () => null }));
vi.mock('../src/renderer/src/components/GroupExtendedProfile', () => ({
  GroupExtendedProfile: () => null,
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

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function mount(node: ReactNode, value: RelationshipDirectory | null = directory) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: RelationshipDirectory | null) =>
    act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(RelationshipDirectoryContext.Provider, { value: next }, node),
        ),
      ),
    );
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
    // 好友分组编辑已并入名片头部的身份行，分组名直接显示在同一行。
    const relationship = scope.querySelector(
      '.weq-contact-identity .weq-relationship-with-category',
    );
    expect(relationship?.textContent).toContain('我的好友');
    expect(relationship?.textContent).toContain('同学');
    expect(
      [...scope.querySelectorAll('.weq-profile-data-label')].some(
        (node) => node.textContent === '好友分组',
      ),
    ).toBe(false);
    // 内嵌时由 ProfileWorkspace 提供「联系人资料」页头；浮层名片沿用统一名片外壳的 aria-label。
    expect(
      scope.querySelector(embedded ? '[aria-label="联系人资料"]' : '[aria-label="用户资料"]'),
    ).not.toBeNull();
    // 好友添加信息由名片内容开关控制（默认关闭）；这里只验证共用正文把它们渲染在同一套行模型里。
    if (!embedded)
      expect(scope.querySelector('[data-friend-clue]')?.getAttribute('data-friend-clue')).toBe(
        person.id,
      );
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

it('联系人列表不显示好友关系标识，保留姓名和签名', () => {
  const stranger = { ...person, id: 'u_stranger', displayName: '合成访客', signature: '访客签名' };
  const { host } = mount(
    h(ContactList, {
      contacts: [{ ...person, signature: '好友签名' }],
      trailingSections: [{ id: 'history:test', name: '历史联系人', items: [stranger] }],
      activeContactId: person.id,
      onSelect: vi.fn(),
    }),
  );
  act(() => {
    for (const header of host.querySelectorAll<HTMLButtonElement>('.contact-cat-header'))
      header.click();
  });
  expect(host.querySelectorAll('.contact-row')).toHaveLength(2);
  expect(host.querySelector('.contact-row [data-relationship]')).toBeNull();
  expect(host.textContent).not.toContain('非好友');
  for (const text of [person.displayName, stranger.displayName, '好友签名', '访客签名'])
    expect(host.textContent).toContain(text);
});

// 完整资料页与快速名片共用同一份身份正文：入群状态与人数都只在身份区出现一次。
it.each(['20001', '20002', '20003'])(
  '联系人页群资料 %s 与名片共用身份区，状态只出现一次',
  (code) => {
    const conversation = {
      ...group,
      id: code,
      group: { ...group.group, id: code, identityValue: code },
    };
    const { host } = mount(
      h(GroupProfileDialog, { conversation, embedded: true, onClose: vi.fn() }),
    );
    expect(host.querySelectorAll('.weq-relationship-status')).toHaveLength(1);
    expect(host.querySelector('.weq-relationship-status')?.textContent).toBe(
      code === '20001' ? '我在群内· 管理员' : code === '20002' ? '我不在群内' : '入群状态待确认',
    );
    expect(host.textContent).toContain(group.group.name);
    expect(host.textContent).toContain('20 人');
  },
);

it.each(['20001', '20002', '20003'])('独立群名片 %s 保留关系，群外不显示旧管理身份', (code) => {
  const conversation = {
    ...group,
    id: code,
    group: { ...group.group, id: code, identityValue: code },
  };
  mount(h(GroupProfileDialog, { conversation, onClose: vi.fn() }));
  const profile = document.body.querySelector('[aria-label="群资料"]')!;
  expect(profile.querySelector('.weq-relationship-status')?.textContent).toBe(
    code === '20001' ? '我在群内· 管理员' : code === '20002' ? '我不在群内' : '入群状态待确认',
  );
  expect(profile.textContent).not.toContain('群主');
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

it.each(['20001', '20002', '20003'])('群列表 %s 不显示入群提示，仍可查看所有群', (code) => {
  const conversation = {
    ...group,
    id: code,
    group: { ...group.group, id: code, identityValue: code },
  };
  const { host } = mount(
    h(GroupList, { conversations: [conversation], activeConversationId: code, onSelect: vi.fn() }),
  );
  expect(host.querySelector('.contact-row')).not.toBeNull();
  expect(host.querySelector('.contact-row [data-relationship]')).toBeNull();
  for (const text of ['我在群内', '我不在群内', '入群状态待确认', '已不在当前群列表'])
    expect(host.textContent).not.toContain(text);
  expect(host.textContent).toContain(group.group.name);
  expect(host.textContent).toContain('20 位成员');
  expect(host.textContent).not.toContain('已解散');
  expect(host.textContent).not.toContain('已退出');
});

it.each(['20001', '20002', '20003'])('现行群名片 %s 不暴露模板资料和头像编辑表单', (code) => {
  const conversation = {
    ...group,
    id: code,
    group: { ...group.group, id: code, identityValue: code },
  };
  const { host } = mount(h(GroupProfileDialog, { conversation, embedded: true, onClose: vi.fn() }));
  expect(host.querySelector('[title="编辑群资料"]')).toBeNull();
  expect(host.querySelector('[placeholder="输入 GitHub 用户名"]')).toBeNull();
  expect(host.textContent).toContain(conversation.group.name);
});
