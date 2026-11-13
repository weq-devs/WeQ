import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupCardIdentity } from '../src/renderer/src/components/groupProfile/GroupCardContent';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';
import { copyTextToClipboard } from '../src/renderer/src/im-template/template/clipboard';

vi.mock('../src/renderer/src/im-template/template/clipboard', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));
vi.mock('../src/renderer/src/components/QQProfileField', () => ({
  QQProfileField: ({ field, initial }: { field: string; initial: string }) =>
    h('button', { 'data-edit-field': field }, initial),
}));
vi.mock('../src/renderer/src/components/groupProfile/GroupProfileAvatarEditor', () => ({
  GroupProfileAvatarEditor: () => h('button', { 'data-avatar-edit': '' }, '更换群头像'),
}));
vi.mock('../src/renderer/src/components/groupProfile/GroupContent', () => ({
  GroupFreezeNotice: () => null,
  GroupTags: () => null,
  groupCreationDate: () => '',
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(role = 'member', listed = true) {
  const conversation: GroupConversation = {
    id: '20001',
    type: 'group',
    updatedAt: '',
    lastMessage: null,
    otherUser: null,
    members: [],
    group: {
      id: '20001',
      identityLabel: '群号',
      identityValue: '20001',
      name: '合成群名',
      avatarUrl: null,
      announcement: null,
      memberCount: 20,
      membershipKnown: true,
      roleKnown: true,
      role,
      listed,
    },
  };
  await act(async () => root.render(h(GroupCardIdentity, { conversation, metrics: null })));
}
it.each([true, false])('只读群名保持纯文本，群成员身份 %s 不影响阅读', async (listed) => {
  await render('member', listed);
  const title = host.querySelector<HTMLElement>('.weq-profile-name')!;
  expect(title.tagName).toBe('SPAN');
  expect(title.textContent).toBe('合成群名');
  await act(async () => title.click());
  expect(copyTextToClipboard).not.toHaveBeenCalled();
});
it('群号点击复制，标签不包含在复制热区内', async () => {
  await render();
  const value = host.querySelector<HTMLButtonElement>('[aria-label="复制 群号"]')!;
  expect(value.textContent).toBe('20001');
  await act(async () => value.click());
  expect(copyTextToClipboard).toHaveBeenLastCalledWith('20001', document);
});
it('拖选群名后不触发复制', async () => {
  await render();
  const title = host.querySelector<HTMLButtonElement>('.weq-profile-name')!;
  const range = document.createRange();
  range.selectNodeContents(title);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => title.click());
  expect(copyTextToClipboard).not.toHaveBeenCalled();
  selection.removeAllRanges();
});
it.each(['owner', 'admin'])('%s 保留群名原地编辑入口', async (role) => {
  await render(role);
  expect(host.querySelector('[data-edit-field="groupName"]')?.textContent).toBe('合成群名');
  expect(host.querySelector('[aria-label="复制群名"]')).toBeNull();
});
