import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactProfileSurface } from '../src/renderer/src/components/contactProfile/ContactProfileSurface';
import { GroupProfileSurface } from '../src/renderer/src/components/groupProfile/GroupProfileSurface';
import { ProfileInlineField } from '../src/renderer/src/components/ProfileInlineField';
import { Modal } from '../src/renderer/src/components/Dialog';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../src/renderer/src/components/WorkspacePages';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/hooks/useContactCard', () => ({
  useContactProfile: (contact: Contact) => ({ profile: contact, scope: ['synthetic'] }),
  useContactCardSettings: () => ({}),
}));
vi.mock('../src/renderer/src/hooks/useGroupProfile', () => ({
  useGroupProfile: (conversation: GroupConversation) => ({
    conversation,
    scope: 'synthetic',
    members: [],
  }),
}));
vi.mock('../src/renderer/src/components/contactProfile/ContactContent', () => ({
  ContactIdentity: () => h('span', null, '联系人'),
}));
vi.mock('../src/renderer/src/components/contactProfile/ContactActions', () => ({
  ContactActions: () => null,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({ binding: null, available: false }),
}));
vi.mock('../src/renderer/src/components/ContactWorkspace', () => ({
  ContactWorkspace: () => h(Editor),
}));
vi.mock('../src/renderer/src/components/groupProfile/GroupWorkspace', () => ({
  GroupWorkspace: () => h(Editor),
}));
vi.mock('../src/renderer/src/components/groupProfile/GroupContent', () => ({
  GroupIdentity: () => h('span', null, '群'),
  GroupDescription: () => null,
  GroupTags: () => null,
  GroupFacts: () => null,
  GroupFreezeNotice: () => null,
  GroupMemberPreview: () => null,
}));

const person: Contact = {
  id: 'u_synthetic',
  username: 'synthetic',
  displayName: '联系人',
  identityLabel: 'QQ',
  identityValue: '10001',
  avatarUrl: null,
  createdAt: '',
};
const group: GroupConversation = {
  id: '10002',
  type: 'group',
  updatedAt: '',
  otherUser: null,
  lastMessage: null,
  members: [],
  group: {
    id: '10002',
    name: '群',
    identityLabel: '群号',
    identityValue: '10002',
    avatarUrl: null,
    announcement: null,
    memberCount: 0,
  },
};
function Editor() {
  return h(ProfileInlineField, {
    label: '备注',
    initial: '合成备注',
    editable: true,
    disabled: false,
    onSave: async () => true,
  });
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function mount(node: ReturnType<typeof h>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(h(QueryClientProvider, { client: cache }, node)));
  cleanups.push(() => {
    act(() => root.unmount());
    cache.clear();
    host.remove();
  });
  return host;
}
function pressEscape() {
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
}
function surface(kind: 'person' | 'group', onClose: () => void) {
  return kind === 'person'
    ? h(ContactProfileSurface, { contact: person, embedded: true, onClose })
    : h(GroupProfileSurface, { conversation: group, embedded: true, onClose });
}
it.each(['person', 'group'] as const)('%s 完整资料：Esc 先退出编辑，再关闭资料', (kind) => {
  const close = vi.fn();
  const host = mount(surface(kind, close));
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑备注"]')!.click());
  expect(document.activeElement).toBe(host.querySelector('input'));
  pressEscape();
  expect(host.querySelector('input')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  pressEscape();
  expect(close).toHaveBeenCalledOnce();
});
it.each(['person', 'group'] as const)('%s 完整资料：叉号与 Esc 调用同一关闭行为', (kind) => {
  const close = vi.fn();
  const host = mount(surface(kind, close));
  act(() => host.querySelector<HTMLButtonElement>('.weq-profile-page-close')!.click());
  expect(close).toHaveBeenCalledOnce();
});
it.each(['person', 'group'] as const)('%s 完整资料：Esc 优先关闭上层弹窗', (kind) => {
  const close = vi.fn();
  function Page() {
    const [open, setOpen] = useState(false);
    return h(
      'div',
      null,
      surface(kind, close),
      h('button', { onClick: () => setOpen(true), 'data-open': true }, '打开弹窗'),
      open ? h(Modal, { onClose: () => setOpen(false) }, '上层弹窗') : null,
    );
  }
  const host = mount(h(Page));
  act(() => host.querySelector<HTMLButtonElement>('[data-open]')!.click());
  pressEscape();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
});
it('从工具页查看资料期间保留编辑现场，返回恢复工具页，另行导航正常关闭', () => {
  let navigate: (key: string, suspended: boolean) => void = () => {};
  const close = vi.fn();
  function Tool() {
    const [count, setCount] = useState(0);
    return h('button', { 'data-tool': true, onClick: () => setCount(count + 1) }, count);
  }
  function Page() {
    const [state, setState] = useState({ key: 'tools', suspended: false });
    navigate = (key, suspended) => setState({ key, suspended });
    return h(
      WorkspacePages,
      { navigationKey: state.key, suspended: state.suspended },
      h(WorkspaceContent, null, h('p', { 'data-base': true }, '资料页')),
      h(WorkspacePage, { title: '工具页', onClose: close }, h(Tool)),
    );
  }
  const host = mount(h(Page));
  const button = host.querySelector<HTMLButtonElement>('[data-tool]')!;
  act(() => button.click());
  act(() => navigate('contacts:person', true));
  expect(host.querySelector('.weq-workspace-page')?.hasAttribute('hidden')).toBe(true);
  expect(host.querySelector('#workspace-base-page')?.hasAttribute('hidden')).toBe(false);
  expect(close).not.toHaveBeenCalled();
  act(() => navigate('tools', false));
  expect(host.querySelector('[data-tool]')).toBe(button);
  expect(button.textContent).toBe('1');
  expect(host.querySelector('.weq-workspace-page')?.hasAttribute('hidden')).toBe(false);
  expect(close).not.toHaveBeenCalled();
  act(() => navigate('contacts:group', true));
  act(() => navigate('home', false));
  expect(close).toHaveBeenCalledOnce();
});

it.each(['main', 'sidecar'] as const)(
  '从 %s 查看资料时新开的设置可见，关闭恢复资料及来源工具现场',
  (placement) => {
    let navigate: (key: string, suspended: boolean) => void = () => {};
    const close = vi.fn();
    function Tool() {
      const [count, setCount] = useState(0);
      return h('button', { 'data-tool': true, onClick: () => setCount(count + 1) }, count);
    }
    function Page() {
      const [state, setState] = useState({ key: 'tools', suspended: false });
      const [settings, setSettings] = useState(false);
      navigate = (key, suspended) => setState({ key, suspended });
      return h(
        WorkspacePages,
        { navigationKey: state.key, suspended: state.suspended },
        h(
          WorkspaceContent,
          null,
          h('button', { 'data-open-settings': true, onClick: () => setSettings(true) }, '打开设置'),
        ),
        h(WorkspacePage, { title: '来源工具', placement, onClose: close }, h(Tool)),
        settings &&
          h(
            WorkspacePage,
            { title: '设置', standalone: true, onClose: () => setSettings(false) },
            h(
              'button',
              { 'data-close-settings': true, onClick: () => setSettings(false) },
              '关闭设置',
            ),
          ),
      );
    }
    const host = mount(h(Page));
    const tool = host.querySelector<HTMLButtonElement>('[data-tool]')!;
    act(() => tool.click());
    act(() => navigate('contacts:self', true));
    act(() => host.querySelector<HTMLButtonElement>('[data-open-settings]')!.click());
    expect(host.querySelector('[data-close-settings]')?.closest('[hidden]')).toBeNull();
    expect(host.querySelector('[data-close-settings]')).not.toBeNull();
    expect(host.querySelector('.weq-workspace-page-host')?.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('#workspace-base-page')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('[data-tool]')).toBe(tool);
    expect(tool.closest('[hidden]')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
    pressEscape();
    expect(host.querySelector('[data-close-settings]')).toBeNull();
    expect(host.querySelector('#workspace-base-page')?.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('[data-tool]')).toBe(tool);
    act(() => navigate('tools', false));
    expect(tool.closest('[hidden]')).toBeNull();
    expect(tool.textContent).toBe('1');
    expect(close).not.toHaveBeenCalled();
  },
);
