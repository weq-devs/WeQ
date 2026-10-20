import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { GroupMemberRole, User } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useQuery') return () => ({ data: undefined });
        if (key === 'useMutation') return () => ({ mutate: vi.fn() });
        return proxy();
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function fixture(role: GroupMemberRole, online = true, self = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const user = { ...demo.user, id: 'self:10001', uid: 'u_self', identityValue: '10001' };
  const peer: User = {
    ...user,
    id: self ? 'u_self' : 'u_peer',
    uid: self ? 'u_self' : 'u_peer',
    identityValue: self ? '10001' : '10002',
    uin: self ? '10001' : '10002',
    displayName: '目标成员',
    role: 'member',
  };
  const original = demo.conversations.find((row) => row.type === 'group')!;
  const conversation = { ...original, members: [peer], group: { ...original.group, role } };
  const rename = vi.fn(),
    title = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(ChatPane, {
        user,
        conversation,
        messages: [
          {
            id: 'avatar-message',
            conversationId: conversation.id,
            senderId: peer.id,
            body: '合成消息',
            createdAt: new Date().toISOString(),
            msgSeq: '42',
          },
        ],
        loading: false,
        sendAvailable: online,
        draft: '',
        onSend: vi.fn(),
        onDraftChange: vi.fn(),
        onDraftClear: vi.fn(),
        onBack: vi.fn(),
        onOpenGroupMember: vi.fn(),
        onRenameGroupMember: rename,
        onChangeGroupMemberTitle: title,
      }),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const open = (source: 'message' | 'sidebar') => {
    const avatar = host.querySelector(
      source === 'sidebar'
        ? '.group-info-member-row .member-avatar-wrap'
        : '.message-avatar-button, .message-avatar-wrap',
    )!;
    expect(avatar).not.toBeNull();
    act(() =>
      avatar.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }),
      ),
    );
  };
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.avatar-context-menu button')].find(
      (item) => item.textContent === name,
    );
  return { open, button, rename, title, peer, conversation };
}

describe('群成员头像菜单', () => {
  for (const source of ['message', 'sidebar'] as const) {
    it.each(['owner', 'admin', 'member'] as const)(
      `${source}：%s 仅按当前角色提供群名片与头衔操作`,
      (role) => {
        const f = fixture(role);
        f.open(source);
        expect(Boolean(f.button('修改群名片'))).toBe(role !== 'member');
        expect(Boolean(f.button('编辑专属头衔'))).toBe(role === 'owner');
        if (role === 'owner') {
          act(() => f.button('编辑专属头衔')!.click());
          expect(f.title).toHaveBeenCalledWith(f.conversation, f.peer, 'u_peer');
          expect(f.rename).not.toHaveBeenCalled();
        } else if (role === 'admin') {
          act(() => f.button('修改群名片')!.click());
          expect(f.rename).toHaveBeenCalledWith(f.conversation, f.peer, 'u_peer');
        }
      },
    );
  }
  it('普通成员仍可修改自己的名片，但不能编辑头衔', () => {
    const f = fixture('member', true, true);
    f.open('sidebar');
    expect(f.button('修改群名片')).toBeDefined();
    expect(f.button('编辑专属头衔')).toBeUndefined();
  });
  it('离线保留群主入口并置灰，不调用任何编辑回调', () => {
    const f = fixture('owner', false);
    f.open('sidebar');
    expect(f.button('编辑专属头衔')!.disabled).toBe(true);
    expect(f.button('修改群名片')!.disabled).toBe(true);
    act(() => f.button('编辑专属头衔')!.click());
    expect(f.title).not.toHaveBeenCalled();
  });
});
