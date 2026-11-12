import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupMemberPreview } from '../src/renderer/src/components/groupProfile/GroupContent';
import type { GroupMember } from '../src/renderer/src/im-template/template/types';
import { mergeGroupPreviewMembers } from '../src/renderer/src/lib/groupPreviewMembers';

vi.mock('../src/renderer/src/im-template/template/primitives', () => ({
  Avatar: ({ name }: { name: string }) => h('span', null, name),
}));

const self: GroupMember = {
  id: 'self:10001',
  username: 'uin-10001',
  displayName: '本人昵称',
  identityLabel: 'UIN',
  identityValue: '10001',
  avatarUrl: null,
  role: 'member',
  joinedAt: '',
};
const member: GroupMember = {
  ...self,
  id: 'u_self',
  username: 'u_self',
  uin: '10001',
  displayName: '本人群名片',
  role: 'admin',
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});

it.each([
  [self, member],
  [member, self],
])('预览将不同 ID 的本人合并为一个头像，点击打开真实成员资料：%j', (...members) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const onOpen = vi.fn();
  cleanup.push(() => act(() => root.unmount()));
  act(() => root.render(h(GroupMemberPreview, { members, onOpen, onRetry: vi.fn() })));
  const buttons = host.querySelectorAll('.weq-group-preview-avatars button');
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.getAttribute('title')).toBe('本人群名片');
  act(() => (buttons[0] as HTMLButtonElement).click());
  expect(onOpen).toHaveBeenCalledWith(member, expect.any(Object));
});

it('UID 相同也合并，后来的完整成员资料优先且不修改输入', () => {
  const placeholder = { ...self, uid: member.id, identityValue: 'unknown' };
  const updated = { ...member, displayName: '更新的群名片' };
  const input = [placeholder, member, updated];
  expect(mergeGroupPreviewMembers(input)).toEqual([updated]);
  expect(input).toEqual([placeholder, member, updated]);
});

it('不同身份的同名成员不合并，无效 QQ 号不作为去重依据', () => {
  const first = { ...member, uin: '0', identityValue: '0' };
  const second = { ...first, id: 'u_other' };
  expect(mergeGroupPreviewMembers([first, second])).toEqual([first, second]);
  const third = { ...member, id: 'u_third', uin: '10002', identityValue: '10002' };
  expect(mergeGroupPreviewMembers([member, third])).toEqual([member, third]);
});
