import { act, createElement as h } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactActions } from '../src/renderer/src/components/contactProfile/ContactActions';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { QzoneNavigationContext } from '../src/renderer/src/lib/qzoneNavigation';
import type { ProfilePerson } from '../src/renderer/src/hooks/useContactCard';
import { createQueryRoot } from './support/query_root';

vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({ binding: { configId: 'fixture' } }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { conversationBoundary: { query: async () => null } } },
}));

afterEach(() => vi.unstubAllGlobals());

const person: ProfilePerson = {
  id: 'u_fixture',
  uid: 'u_fixture',
  displayName: '合成联系人',
  username: 'fixture',
  identityLabel: 'QQ',
  identityValue: '10002',
  avatarUrl: null,
  profileContext: { groupCode: '10003', groupName: '合成群', member: { uid: 'u_fixture' } },
};

it('全部适用操作直接常驻，打开会话、预览、空间和分析仍使用当前对象', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createQueryRoot(host);
  const close = vi.fn();
  const open = vi.fn();
  const preview = vi.fn();
  const space = vi.fn();
  const analyze = vi.fn();
  try {
    await act(async () =>
      root.render(
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              virtual: [],
              profileConversationExists: () => true,
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
            },
          },
          h(
            QzoneNavigationContext.Provider,
            { value: space },
            h(ContactActions, {
              person,
              onClose: close,
              onOpenChat: open,
              onPreviewChat: preview,
              onAnalyze: analyze,
            }),
          ),
        ),
      ),
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.weq-contact-actions > button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      '打开会话',
      '预览消息',
      '本群发言',
      '查看空间',
      '聊天分析',
    ]);
    expect(buttons.every((button) => button.className === 'weq-contact-secondary')).toBe(true);
    expect(host.querySelector('details')).toBeNull();
    for (const label of ['查看消息', '更多操作', '预览空间', '赞资料卡'])
      expect(host.textContent).not.toContain(label);
    act(() => buttons[0]!.click());
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    act(() => buttons[1]!.click());
    expect(preview).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    act(() => buttons[3]!.click());
    expect(space).toHaveBeenCalledWith(person.identityValue, person.displayName);
    act(() => buttons[4]!.click());
    expect(analyze).toHaveBeenCalledWith({
      kind: 'member',
      groupCode: '10003',
      memberUid: person.uid,
      memberUin: person.identityValue,
    });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('没有历史会话时仍显示发起会话，不额外展示不适用操作', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createQueryRoot(host);
  try {
    await act(async () => {
      root.render(
        h(ContactActions, {
          person: { ...person, profileContext: undefined },
          onOpenChat: vi.fn(),
        }),
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(host.textContent).toBe('发起会话');
    });
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelector('button')?.className).toBe('weq-contact-secondary');
  } finally {
    act(() => root.unmount());
  }
});
