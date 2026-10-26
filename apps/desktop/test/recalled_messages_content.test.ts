import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    id: 'one',
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
    msgSeq: '2',
  },
];
function mount(embedded: boolean, error?: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const retry = vi.fn(),
    jump = vi.fn();
  act(() =>
    root.render(
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
  );
  return {
    host,
    retry,
    jump,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
describe('撤回气泡与筛选的共用呈现', () => {
  it('设置来源不再创建第二个容器，仍向原气泡传递消息并支持筛选与准确序号跳转', () => {
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
      expect(f.jump).toHaveBeenCalledWith('1');
    } finally {
      f.dispose();
    }
  });
  it('非设置来源仍为原独立浮窗，读取失败显示重试而不是空记录', () => {
    const f = mount(false, '合成读取失败');
    try {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('合成读取失败');
      expect(document.body.textContent).not.toContain('没有被撤回的消息');
      act(() => document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
      expect(f.retry).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });
});
