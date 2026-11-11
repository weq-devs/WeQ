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
const mock = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock('../src/renderer/src/hooks/useGroupProfile', () => ({ useGroupProfile: mock.profile }));
vi.mock('../src/renderer/src/components/groupProfile/GroupWorkspace', () => ({
  GroupWorkspace: () => h('div', null, '完整资料页'),
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
  expect(host.querySelector('.weq-profile-name')?.textContent).toBe('我的备注');
  expect(host.querySelector('.weq-group-original-name')?.textContent).toBe('原群名');
  // 好友数走共用数据行（label 96px + 值列），真实零值保留。
  const friendRow = [...host.querySelectorAll('.weq-profile-data-row')].find(
    (row) => row.querySelector('.weq-profile-data-label')?.textContent === '群内好友',
  )!;
  expect(friendRow.querySelector('.weq-profile-data-value')?.textContent).toBe('0 人');
  expect(host.textContent).not.toContain('不应出现');
  expect(host.textContent).not.toContain('扩展资料');
  const text = host.querySelector('.weq-group-description p')!;
  expect(text.classList.contains('is-clamped')).toBe(true);
  act(() => (host.querySelector('.weq-group-text-action') as HTMLButtonElement).click());
  expect(text.classList.contains('is-clamped')).toBe(false);
  act(() => (host.querySelector('.weq-group-preview-avatars button') as HTMLButtonElement).click());
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  expect(host.textContent).toContain('u_1:12345');
  act(() => (host.querySelector('[aria-label="成员名片"] button') as HTMLButtonElement).click());
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
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
  expect(groupCreationDate('2024-01-01T20:00:00Z')).toBe('2024/01/02');
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
