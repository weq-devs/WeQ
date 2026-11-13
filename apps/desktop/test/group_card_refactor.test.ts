import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupProfileSurface } from '../src/renderer/src/components/groupProfile/GroupProfileSurface';
import {
  GroupFacts,
  GroupFreezeNotice,
  groupCreationDate,
} from '../src/renderer/src/components/groupProfile/GroupContent';
import { ProfileWorkspace } from '../src/renderer/src/components/ProfileWorkspace';
import { useTabActive } from '../src/renderer/src/components/RetainedTabs';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';
import { useDraftProtection } from '../src/renderer/src/lib/draftClose';
import { ContactWorkspaceNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { RelationshipDirectoryContext } from '../src/renderer/src/lib/contactRelationship';
import { GroupMessagePreviewContext } from '../src/renderer/src/lib/chatNavigation';
const mock = vi.hoisted(() => ({ profile: vi.fn(), media: vi.fn() }));
vi.mock('../src/renderer/src/components/mediaPreviewStore', () => ({
  openMediaPreview: mock.media,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({ available: false, binding: null, busy: false, result: null }),
}));
vi.mock('../src/renderer/src/hooks/useGroupProfile', () => ({ useGroupProfile: mock.profile }));
vi.mock('../src/renderer/src/components/groupProfile/GroupWorkspace', () => ({
  GroupWorkspace: () => h('div', null, '完整资料页'),
}));
vi.mock('../src/renderer/src/components/groupProfile/GroupCardMemberList', () => ({
  GroupCardMemberList: ({ kind, conversation, onClose, onOpenMember }) =>
    h(
      'div',
      { role: 'dialog', 'aria-label': kind === 'members' ? '群成员' : '群内好友' },
      h(
        'button',
        { onClick: () => onOpenMember(conversation.members[0], { x: 10, y: 10 }) },
        '查看成员甲',
      ),
      h('button', { onClick: onClose }, '关闭名单'),
    ),
}));
vi.mock('../src/renderer/src/components/MemberProfileCard', () => ({
  MemberProfileCard: ({ member, groupCode, onClose }) =>
    h(
      'div',
      { role: 'dialog', 'aria-label': '成员名片' },
      `${member.id}:${groupCode}`,
      h('button', { onClick: onClose }, '返回群名片'),
    ),
}));
vi.mock('../src/renderer/src/components/GroupLabelSources', () => ({
  GroupLabelSources: () => null,
}));
vi.mock('../src/renderer/src/im-template/template/primitives', () => ({
  Avatar: ({ name }) => h('span', null, name),
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }) => children,
}));
vi.mock('../src/renderer/src/components/VirtualConversationAvatar', () => ({
  VirtualConversationBadge: () => null,
}));
const group: GroupConversation = {
  id: '12345',
  type: 'group',
  updatedAt: '',
  otherUser: null,
  group: {
    id: '12345',
    name: '原群名',
    remark: '我的备注',
    identityLabel: '群号',
    identityValue: '12345',
    avatarUrl: null,
    announcement: '不应出现在名片的公告',
    description: '简介\n'.repeat(10),
    entranceQ: '不应出现的入群问题',
    memberCount: 100,
    maxMemberCount: 200,
    role: 'member',
  },
  members: [
    {
      id: 'u_1',
      username: 'u_1',
      displayName: '成员甲',
      identityLabel: 'QQ',
      identityValue: '10001',
      avatarUrl: null,
      role: 'member',
      joinedAt: '',
    },
  ],
  preference: { pinned: false, muted: false, archived: false },
  unreadCount: 0,
  lastMessage: null,
};
const cleanup: Array<() => void> = [];
function mount(node) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, root };
}
afterEach(() => {
  cleanup.splice(0).forEach((fn) => {
    fn();
  });
  vi.unstubAllGlobals();
});
it('名片首屏保留本地身份，公告／入群问题／扩展指标不进入正文；成员返回保留父卡', () => {
  mock.profile.mockReturnValue({
    conversation: group,
    members: group.members,
    scope: 'a',
    previewLoading: false,
    previewError: null,
    retryPreview: vi.fn(),
    metrics: { friendCount: { value: 0, updatedAt: 1 } },
  });
  const { host } = mount(h(GroupProfileSurface, { conversation: group, onClose: vi.fn() }));
  // 群名是标题，备注作为身份区的独立属性行，不顶替标题。
  expect(host.querySelector('.weq-profile-name')?.textContent).toBe('原群名');
  expect(
    host.querySelector('.weq-profile-identity-remark .weq-profile-data-value')?.textContent,
  ).toBe('我的备注');
  // 好友数走共用数据行（label 96px + 值列），真实零值保留。
  const friendRow = [...host.querySelectorAll('.weq-profile-data-row')].find(
    (row) => row.querySelector('.weq-profile-data-label')?.textContent === '群内好友数',
  )!;
  expect(friendRow.querySelector('.weq-profile-data-value')?.textContent).toBe('0 人');
  expect(host.textContent).not.toContain('不应出现');
  expect(host.textContent).not.toContain('扩展资料');
  const text = host.querySelector('.weq-group-description p')!;
  expect(text.classList.contains('is-clamped')).toBe(true);
  expect(
    [...host.querySelectorAll('.weq-profile-subtitle')].map((node) => node.textContent),
    // 快速名片与完整资料页共用同一个小节标题。
  ).toEqual(['基本资料', '成员']);
  expect(host.textContent).not.toContain('与我的关系');
  expect(host.querySelector('.weq-group-preview-avatars')).toBeNull();
  const labels = [...host.querySelectorAll('.weq-profile-data-label')].map(
    (node) => node.textContent,
  );
  expect(labels.slice(-3)).toEqual(['群容量', '群成员数', '群内好友数']);
  act(() => (host.querySelector('[aria-label="查看群成员列表"]') as HTMLButtonElement).click());
  act(() => (host.querySelector('[aria-label="群成员"] button') as HTMLButtonElement).click());
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(3);
  expect(host.textContent).toContain('u_1:12345');
  act(() => (host.querySelector('[aria-label="成员名片"] button') as HTMLButtonElement).click());
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(2);
});
it('短简介不显示展开，成员和好友数量打开旁侧名单而不关闭名片或跳资料页', () => {
  const conversation = { ...group, group: { ...group.group, description: '短简介' } };
  mock.profile.mockReturnValue({
    conversation,
    members: group.members,
    scope: 'a',
    retryPreview: vi.fn(),
    metrics: {},
  });
  const navigate = vi.fn();
  const close = vi.fn();
  const { host } = mount(
    h(
      ContactWorkspaceNavigationContext.Provider,
      { value: navigate },
      h(GroupProfileSurface, { conversation, onClose: close, onOpenChat: vi.fn() }),
    ),
  );
  expect(host.querySelector('.weq-group-description p')?.textContent).toBe('短简介');
  expect(host.querySelector('.weq-group-description button')).toBeNull();
  expect(host.querySelector('.weq-profile-card-actions')?.textContent).not.toContain('完整群资料');
  act(() => (host.querySelector('[aria-label="打开完整群资料"]') as HTMLButtonElement).click());
  expect(navigate).toHaveBeenLastCalledWith({ kind: 'group', conversation });
  act(() => (host.querySelector('[aria-label="查看群成员列表"]') as HTMLButtonElement).click());
  expect(host.querySelector('[aria-label="群成员"]')).not.toBeNull();
  act(() =>
    (host.querySelector('[aria-label="群成员"] button:last-child') as HTMLButtonElement).click(),
  );
  act(() => (host.querySelector('[aria-label="查看群内好友列表"]') as HTMLButtonElement).click());
  expect(host.querySelector('[aria-label="群内好友"]')).not.toBeNull();
  expect(navigate).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it('完整群资料页只在页头渲染一条操作行，不再吸底重复', () => {
  mock.profile.mockReturnValue({
    conversation: group,
    members: group.members,
    scope: 'a',
    previewLoading: false,
    previewError: null,
    retryPreview: vi.fn(),
    metrics: {},
  });
  const { host } = mount(
    h(GroupProfileSurface, {
      conversation: group,
      onClose: vi.fn(),
      embedded: true,
      onOpenChat: vi.fn(),
    }),
  );
  // 完整资料页只在页头操作区渲染一条操作行，正文底部不再有第二套吸底操作。
  const bars = host.querySelectorAll('.weq-profile-card-actions');
  expect(bars).toHaveLength(1);
  expect(bars[0].querySelector('button')).not.toBeNull();
  expect(host.querySelector('.weq-group-quick-card')).toBeNull();
  // 完整资料页与快速名片共用同一份身份正文。
  expect(host.querySelector('.weq-contact-identity-body')).not.toBeNull();
  expect(host.querySelector('[aria-label="打开完整群资料"]')).toBeNull();
  expect(host.textContent).toContain('12345');
});
it('快速名片底部只显示消息操作，预览不关闭名片，打开消息关闭名片', () => {
  mock.profile.mockReturnValue({
    conversation: group,
    members: [],
    scope: 'a',
    retryPreview: vi.fn(),
    metrics: undefined,
  });
  const close = vi.fn();
  const chat = vi.fn();
  const preview = vi.fn();
  const { host } = mount(
    h(
      GroupMessagePreviewContext.Provider,
      {
        value: {
          open: preview,
          close: vi.fn(),
          conversationId: null,
          content: null,
        },
      },
      h(GroupProfileSurface, { conversation: group, onClose: close, onOpenChat: chat }),
    ),
  );
  const bar = host.querySelector('.weq-profile-card-actions')!;
  expect(bar.classList.contains('weq-group-card-actions')).toBe(false);
  const actions = bar.querySelectorAll('button');
  expect([...actions].map((button) => button.textContent)).toEqual(['查看消息', '预览消息']);
  // 主操作（查看消息）是填充按钮，其余次操作是描边按钮。
  expect(actions[0].classList.contains('weq-contact-primary')).toBe(true);
  expect(actions[0].classList.contains('weq-set-btn')).toBe(true);
  expect(
    [...actions].slice(1).every((button) => button.className === 'weq-contact-secondary'),
  ).toBe(true);
  act(() => (actions[1] as HTMLButtonElement).click());
  expect(preview).toHaveBeenCalledWith(group);
  expect(close).not.toHaveBeenCalled();
  act(() => (actions[0] as HTMLButtonElement).click());
  expect(chat).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it('未加入的群保留资料但不提供编辑；头像沿用共用媒体预览，冻结状态位于身份区', () => {
  const conversation = {
    ...group,
    group: {
      ...group.group,
      avatarUrl: '/group.png',
      role: 'admin' as const,
      roleKnown: true,
      membershipKnown: true,
      listed: false,
    },
  };
  mock.profile.mockReturnValue({
    conversation,
    members: [],
    scope: 'a',
    retryPreview: vi.fn(),
    metrics: {
      friendCount: { value: 5, attemptedAt: 1, state: 'failed' },
      freezeState: { value: 1, updatedAt: 1, state: 'ready' },
    },
  });
  const { host } = mount(
    h(
      RelationshipDirectoryContext.Provider,
      {
        value: { friends: new Map(), friendsComplete: true, groups: new Map() },
      },
      h(GroupProfileSurface, { conversation, onClose: vi.fn() }),
    ),
  );
  expect(host.querySelector('[aria-label="编辑群名称"]')).toBeNull();
  expect(host.querySelector('[aria-label="编辑备注"]')).toBeNull();
  expect(host.querySelector('.weq-group-quick-identity')?.textContent).toContain('该群已冻结');
  expect(host.querySelector('.weq-group-quick-sections')?.textContent).not.toContain('与我的关系');
  act(() => (host.querySelector('[aria-label="查看群头像"]') as HTMLButtonElement).click());
  expect(mock.media).toHaveBeenLastCalledWith({
    items: [{ key: '/group.png', kind: 'image', src: '/group.png', title: '原群名' }],
  });
});
it('本地合成群不出现 QQ 关系、在线编辑或完整资料跳转', () => {
  const conversation = {
    ...group,
    generated: { ownerId: 'virtual-owner' } as GroupConversation['generated'],
  };
  mock.profile.mockReturnValue({
    conversation,
    members: [],
    scope: 'a',
    retryPreview: vi.fn(),
    metrics: undefined,
  });
  const { host } = mount(
    h(
      ContactWorkspaceNavigationContext.Provider,
      { value: vi.fn() },
      h(GroupProfileSurface, { conversation, onClose: vi.fn() }),
    ),
  );
  expect(host.querySelector('.weq-profile-expand')).toBeNull();
  expect(host.querySelector('.weq-relationship-status')).toBeNull();
  expect(host.querySelector('[aria-label="编辑备注"]')).toBeNull();
  expect(host.querySelector('.weq-contact-identity-body')?.textContent).toContain(
    'IDvirtual-owner',
  );
});
it('没有成功值的缓存不显示好友数，正常／未知不占位', () => {
  const metrics = {
    friendCount: { value: 5, attemptedAt: 1, state: 'failed' },
    freezeState: { value: 0, updatedAt: 1, attemptedAt: 1, state: 'ready' },
  };
  const { host } = mount(
    h(
      'div',
      null,
      h(GroupFacts, { conversation: group, metrics }),
      h(GroupFreezeNotice, { metrics }),
    ),
  );
  // 失败值、缺失值、正常状态都不出行，也不写「未知」。
  expect(host.textContent).not.toContain('群内好友');
  expect(host.textContent).not.toContain('正常');
  expect(host.textContent).not.toContain('未知');
});
it('创建日期以北京时间显示，缺失、无效或 epoch 不冒充有效日期', () => {
  expect(groupCreationDate('2024-01-01T20:00:00Z')).toBe('2024-01-02 04:00:00');
  expect(groupCreationDate('not-a-date')).toBe('');
  expect(groupCreationDate('1970-01-01T00:00:00Z')).toBe('');
  expect(groupCreationDate()).toBe('');
});
it('共用目录容器仅挂载访问过的章节，已离开章节保留状态但变为 inactive', async () => {
  const mounted = vi.fn();
  function Content({ id }: { id: string }) {
    const active = useTabActive();
    mounted(id, active);
    return h('span', null, `${id}:${active}`);
  }
  function App() {
    const [selected, set] = useState('a');
    return h(ProfileWorkspace, {
      label: '资料分区',
      sections: [
        ['a', '概览'],
        ['b', '文件'],
      ],
      selected,
      onSelect: set,
      render: (key) => h(Content, { id: key }),
    });
  }
  const { host } = mount(h(App));
  expect(mounted).not.toHaveBeenCalledWith('b', true);
  await act(async () => (host.querySelectorAll('nav button')[1] as HTMLButtonElement).click());
  expect(host.textContent).toContain('a:false');
  expect(host.textContent).toContain('b:true');
});
it('章节中操作未结束时不允许离开，不提前挂载目标章节', async () => {
  let busy = true;
  function Draft() {
    useDraftProtection(null, busy);
    return h('span', null, '编辑中');
  }
  function App() {
    const [selected, set] = useState('a');
    return h(ProfileWorkspace, {
      label: '资料分区',
      sections: [
        ['a', '概览'],
        ['b', '文件'],
      ],
      selected,
      onSelect: set,
      render: (key) => (key === 'a' ? h(Draft) : h('span', null, '文件内容')),
    });
  }
  const { host, root } = mount(h(App));
  await act(async () => (host.querySelectorAll('nav button')[1] as HTMLButtonElement).click());
  expect(host.textContent).not.toContain('文件内容');
  busy = false;
  act(() => root.render(h(App)));
  await act(async () => (host.querySelectorAll('nav button')[1] as HTMLButtonElement).click());
  expect(host.textContent).toContain('文件内容');
});
