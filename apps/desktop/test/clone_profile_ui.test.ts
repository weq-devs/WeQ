import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { ContactWorkspaceNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { MemberProfileCard } from '../src/renderer/src/components/MemberProfileCard';
import { CloneMemberProfileCard } from '../src/renderer/src/views/agentlab/CloneMemberProfileCard';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { cloneQueries } from './browser/clone-conversation.stub';
import {
  cloneChatConversation,
  cloneChatMessages,
  cloneChatUser,
} from '../src/renderer/src/views/agentlab/cloneChatAdapter';

vi.mock('../src/renderer/src/trpc/client', () => import('./browser/clone-conversation.stub'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

for (const kind of ['persona', 'group'] as const) {
  it(`克隆${kind === 'group' ? '群聊' : '好友'}头像、昵称与标题打开共用名片，无联系人跳转`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const user = cloneChatUser('self', '我', '10000');
    const peer = cloneChatUser('clone', '本地克隆名称', undefined, true);
    const conversation = cloneChatConversation({
      target: { kind, ownerId: 'clone', sessionId: 's' },
      viewId: 'virtual:clone:fixture',
      name: kind === 'group' ? '本地克隆群' : peer.displayName,
      peer,
      members: [user, peer],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const openContact = vi.fn();
    const openVirtual = vi.fn();
    const target = {
      id: 'virtual:persona:clone',
      kind: 'persona' as const,
      ownerId: 'clone',
      name: peer.displayName,
    };
    try {
      await act(async () =>
        root.render(
          h(
            ConversationDirectoryContext.Provider,
            { value: { virtual: [target], onVirtual: openVirtual, onCreate: vi.fn() } },
            h(
              ContactWorkspaceNavigationContext.Provider,
              { value: openContact },
              h(ChatPane, {
                user,
                conversation,
                messages: cloneChatMessages(
                  [{ id: 'm', text: '合成记录', ts: 1 }],
                  conversation.id,
                  () => peer,
                ),
                loading: false,
                preference: undefined,
                draft: '',
                onSend: vi.fn(),
                onBack: vi.fn(),
              }),
            ),
          ),
        ),
      );
      for (const selector of [
        '.message-avatar-button',
        ...(kind === 'group' ? ['.weq-message-name-profile'] : []),
      ]) {
        await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
        const card = document.querySelector('[aria-label="用户资料"]')!;
        expect(card).not.toBeNull();
        expect(card.textContent).toContain(peer.displayName);
        expect(card.textContent).not.toContain('virtual:');
        expect(card.querySelector('.weq-profile-expand')).toBeNull();
        expect(card.querySelector('.weq-member-loading')).toBeNull();
        act(() => card.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
        expect(document.querySelector('[aria-label="用户资料"]')).toBeNull();
      }
      await act(async () =>
        host.querySelector<HTMLButtonElement>('.weq-conversation-title-profile')!.click(),
      );
      const card = document.querySelector(
        `[role="dialog"][aria-label="${kind === 'group' ? '群资料' : '用户资料'}"]`,
      )!;
      expect(card).not.toBeNull();
      expect(card.querySelector('.weq-profile-expand')).toBeNull();
      expect(card.textContent).not.toContain('virtual:');
      if (kind === 'group') {
        expect(card.querySelectorAll('.weq-profile-member')).toHaveLength(2);
        await act(async () =>
          card.querySelectorAll<HTMLButtonElement>('.weq-profile-member')[1]!.click(),
        );
        expect(document.querySelector('[role="dialog"][aria-label="群资料"]')).toBeNull();
        expect(document.querySelector('[aria-label="用户资料"]')?.textContent).toContain(
          peer.displayName,
        );
      }
      const personCard = document.querySelector('[aria-label="用户资料"]')!;
      const openButton = [...personCard.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === '查看私聊',
      )!;
      expect(openButton).not.toBeUndefined();
      act(() => openButton.click());
      expect(document.querySelector('[aria-label="用户资料"]')).toBeNull();
      if (kind === 'group') expect(openVirtual).toHaveBeenCalledWith(target);
      else expect(openVirtual).not.toHaveBeenCalled();
      expect(openContact).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
}

it('克隆身份不携带源好友的 QQ 身份，只沿用头像', () => {
  const peer = cloneChatUser('clone-id', '克隆名称', '20001', true);
  expect(peer.id).toBe('virtual:clone-id');
  expect(peer.uid).toBeUndefined();
  expect(peer.identityLabel).toBe('克隆体');
  expect(peer.identityValue).toBe(peer.id);
  expect(peer.avatarUrl).toContain('20001');
});

it('克隆名片不读取真实人的资料，即使残留源 UID、QQ号或机器人标记', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cloneQueries.length = 0;
  try {
    for (const member of [
      {
        ...cloneChatUser('a', '克隆甲', '20001', true),
        uid: 'u_source',
        identityLabel: 'QQ',
        identityValue: '20001',
        kind: 'bot' as const,
      },
      cloneChatUser('b', '克隆乙', '20002', true),
    ]) {
      await act(async () =>
        root.render(
          h(MemberProfileCard, {
            member,
            anchor: { x: 10, y: 10 },
            onClose: vi.fn(),
            localClone: member.kind === 'bot' ? true : undefined,
          }),
        ),
      );
      const card = document.querySelector('[aria-label="用户资料"]')!;
      expect(card.textContent).toContain(member.displayName);
      expect(card.textContent).not.toContain('克隆体');
      expect(card.textContent).not.toContain('QQ');
      expect(card.textContent).not.toContain('u_source');
      expect(card.querySelector('[aria-label="克隆体"]')).not.toBeNull();
    }
    expect(cloneQueries).toHaveLength(0);
    expect(document.querySelector('.weq-member-loading')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

for (const kind of ['persona', 'group'] as const) {
  it(`名片${kind}沿用查看私聊、预览私聊和复制 ID 按钮，不添加文字身份标签`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const user = cloneChatUser('self', '我', '10000');
    const member = cloneChatUser('p', '合成好友', '20001', true);
    const conversation = cloneChatConversation({
      target: { kind, ownerId: kind === 'group' ? 'g' : 'p', sessionId: 's' },
      viewId: 'virtual:test',
      name: '合成会话',
      peer: member,
      members: [user, member],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const open = vi.fn();
    const close = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(CloneMemberProfileCard, {
            member,
            anchor: { x: 10, y: 10 },
            user,
            conversation,
            messages: cloneChatMessages(
              [{ id: 'current', text: '当前私聊消息', ts: 1 }],
              conversation.id,
              () => member,
            ),
            onClose: close,
            onOpenChat: open,
          }),
        ),
      );
      const card = document.querySelector('[aria-label="用户资料"]')!;
      expect(card.querySelector('[aria-label="克隆体"]')).not.toBeNull();
      expect(card.textContent).not.toContain('克隆体');
      expect(card.querySelector('[aria-label="复制 ID"]')).not.toBeNull();
      const button = (label: string) =>
        [...card.querySelectorAll<HTMLButtonElement>('button')].find(
          (item) => item.textContent === label,
        )!;
      expect(button('查看私聊')).not.toBeUndefined();
      await act(async () => button('预览私聊').click());
      expect(card.textContent).toContain(kind === 'persona' ? '当前私聊消息' : '合成消息');
      act(() => card.querySelector<HTMLButtonElement>('[aria-label="返回资料"]')!.click());
      act(() => button('查看私聊').click());
      expect(open).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
}
