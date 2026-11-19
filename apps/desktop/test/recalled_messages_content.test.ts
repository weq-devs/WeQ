import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeletedMessagesModal } from '../src/renderer/src/components/compose/DeletedMessagesModal';
import { RecalledMessagesModal } from '../src/renderer/src/components/compose/RecalledMessagesModal';
import type { Conversation, Message, User } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/im-template/template/messageBubble', () => ({
  MessageBubble: ({ message }: { message: Message }) =>
    h('span', { 'data-real-bubble-input': message.id }, message.body),
}));
afterEach(() => vi.unstubAllGlobals());
const user: User = {
  id: 'self',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: '自己',
  displayName: '自己',
  avatarUrl: null,
};
const peer: User = {
  ...user,
  id: 'u_fixture',
  identityValue: '10002',
  username: '合成好友',
  displayName: '合成好友',
};
const conversation: Conversation = {
  id: peer.id,
  type: 'direct',
  updatedAt: '2026-10-25',
  lastMessage: null,
  otherUser: peer,
  group: null,
  members: [],
};
const messages: Message[] = [
  {
    id: 'roaming:protocol:1:9007199254740993',
    msgId: '9007199254740993',
    conversationId: peer.id,
    senderId: peer.id,
    body: '合成内容甲',
    createdAt: '2026-10-25',
    msgSeq: '1',
  },
  {
    id: 'two',
    conversationId: peer.id,
    senderId: user.id,
    body: '合成内容乙',
    createdAt: '2026-10-25',
    msgSeq: '1',
  },
];
function render(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function mount(embedded: boolean, error?: string) {
  const retry = vi.fn();
  const jump = vi.fn();
  return {
    ...render(
      h(RecalledMessagesModal, {
        conversation,
        user,
        messages,
        embedded,
        error,
        onRetry: retry,
        loading: false,
        onClose: vi.fn(),
        onJumpToMessage: jump,
      }),
    ),
    retry,
    jump,
  };
}
describe('撤回气泡与筛选的共用呈现', () => {
  it('设置来源不再创建第二个容器，筛选后按完整消息身份区分同序号记录', () => {
    const f = mount(true);
    try {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(f.host.querySelectorAll('[data-real-bubble-input]')).toHaveLength(2);
      const input = f.host.querySelector<HTMLInputElement>('input[type="search"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '内容甲',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(f.host.querySelectorAll('[data-real-bubble-input]')).toHaveLength(1);
      act(() => f.host.querySelector<HTMLElement>('.weq-msglist-item')!.click());
      expect(f.jump).toHaveBeenCalledWith('1', messages[0]!.id);
    } finally {
      f.dispose();
    }
  });
  it('会话侧栏读取失败时显示重试而不是空记录', () => {
    const f = mount(false, '合成读取失败');
    try {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const panel = f.host.querySelector('aside[aria-label="已撤回消息"]')!;
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain('合成读取失败');
      expect(panel.textContent).not.toContain('没有被撤回的消息');
      act(() => panel.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
      expect(f.retry).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });
  it('会话内的撤回摘要只定位，按完整身份区分同序号的两条消息', () => {
    const f = mount(false);
    try {
      const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('ul li button')];
      expect(buttons).toHaveLength(2);
      expect(f.host.querySelector('[data-real-bubble-input]')).toBeNull();
      for (const button of buttons) act(() => button.click());
      expect(f.jump.mock.calls).toEqual(messages.map((message) => [message.msgSeq, message.id]));
      expect(f.host.querySelector('[data-real-bubble-input]')).toBeNull();
    } finally {
      f.dispose();
    }
  });
  it('删除索引只定位可见且有可靠序号的消息，恢复不会触发定位', async () => {
    const jump = vi.fn();
    const restore = vi.fn().mockResolvedValue(undefined);
    const hidden = messages[0]!;
    const visible = { ...messages[1]!, deletedKind: 'qq' as const };
    const f = render(
      h(DeletedMessagesModal, {
        conversation,
        user,
        messages: [hidden, visible, { ...visible, id: 'unverified', sourceFormat: 'protocol' }],
        hiddenIds: new Set(['roaming:1:9007199254740993']),
        loading: false,
        error: null,
        onRetry: vi.fn(),
        onClose: vi.fn(),
        onLocate: jump,
        onRestore: restore,
      }),
    );
    try {
      const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('ul li button')];
      expect(buttons).toHaveLength(2);
      const locate = buttons.find((button) => button.textContent?.includes(visible.body))!;
      const recover = buttons.find((button) => button !== locate)!;
      act(() => locate.click());
      await act(async () => recover.click());
      expect(jump.mock.calls).toEqual([[visible.msgSeq, visible.id]]);
      expect(restore.mock.calls).toEqual([[hidden.id]]);
    } finally {
      f.dispose();
    }
  });
});
