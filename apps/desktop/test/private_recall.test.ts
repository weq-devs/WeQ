import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Message } from '../src/renderer/src/im-template/template/types';
import { isMineMessage } from '../src/renderer/src/lib/messageDirection';

const recall = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useQuery') return () => ({ data: undefined });
        if (key === 'useMutation')
          return () => ({ mutate: path.endsWith('.recallMessage') ? recall : vi.fn() });
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  recall.mockReset();
});

function mount(overrides: Partial<Message> = {}, sendAvailable = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const user = { ...demo.user, id: 'self:10001', identityValue: '10001', uid: 'u_self' };
  const conversation = demo.conversations.find((row) => row.type === 'direct')!;
  const message: Message = {
    id: 'recall-source',
    conversationId: conversation.id,
    senderId: user.id,
    body: '测试消息',
    createdAt: new Date().toISOString(),
    msgSeq: '42',
    clientSeq: '17',
    msgRandom: '123456',
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(ChatPane, {
        user,
        conversation,
        messages: [message],
        loading: false,
        sendAvailable,
        draft: '',
        onSend: vi.fn(),
        onDraftChange: vi.fn(),
        onDraftClear: vi.fn(),
        onBack: vi.fn(),
      }),
    );
  });
  const row = host.querySelector('[data-message-id="recall-source"] .message-bubble')!;
  act(() =>
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 })),
  );
  return {
    conversation,
    button: () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')).find(
        (button) => button.textContent === '撤回',
      ),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('私聊撤回入口', () => {
  it('缺少 QQ 号时按 UID 识别自己，不采信对方转发元素的 isSender', () => {
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((row) => row.type === 'direct')!;
    const user = { ...demo.user, uid: 'u_self', identityValue: '10001' };
    const message = { senderUid: 'u_self', senderUin: '0', elements: [] };
    expect(isMineMessage(message, conversation, user)).toBe(true);
    expect(isMineMessage({ ...message, senderUin: '' }, conversation, user)).toBe(true);
    expect(isMineMessage({ ...message, senderUin: '20002' }, conversation, user)).toBe(false);
    expect(
      isMineMessage(
        { ...message, senderUid: 'u_peer', elements: [{ data: { isSender: true } }] },
        conversation,
        user,
      ),
    ).toBe(false);
  });
  it.each([
    { senderId: 'self:10001' },
    { senderId: '10001' },
    { senderId: 'u_self' },
    { source: 'roaming' as const, ntSeqVerified: true, localSent: true },
    { source: 'roaming' as const, ntSeqVerified: true },
  ])('自己的消息显示撤回并传递完整定位 %j', (message) => {
    const f = mount(message);
    try {
      expect(f.button()).toBeDefined();
      expect(f.button()!.disabled).toBe(false);
      act(() => f.button()!.click());
      expect(recall).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'c2c',
          conv: f.conversation.otherUser.id,
          sequence: 42,
          clientSequence: 17,
          random: 123456,
          timestamp: expect.any(Number),
        }),
        expect.any(Object),
      );
    } finally {
      f.close();
    }
  });

  it.each([
    [{ source: 'roaming' as const }, true, '漫游'],
    [{ clientSeq: undefined }, true, '定位'],
    [{ msgRandom: undefined }, true, '定位'],
    [{ msgSeq: undefined }, true, '序号'],
    [{ createdAt: 'invalid' }, true, '定位'],
    [{ optimistic: 'sending' as const }, true, '发送中'],
    [{}, false, '受限模式'],
    [{ createdAt: new Date(Date.now() - 180_000).toISOString() }, true, '2 分钟'],
  ])('不可执行时保留菜单并说明原因 %j', (message, online, reason) => {
    const f = mount(message, online);
    try {
      expect(f.button()).toBeDefined();
      expect(f.button()!.disabled).toBe(true);
      expect(f.button()!.title).toContain(reason);
      act(() => f.button()!.click());
      expect(recall).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('对方消息不显示撤回', () => {
    const f = mount({ senderId: 'u_peer' });
    try {
      expect(f.button()).toBeUndefined();
    } finally {
      f.close();
    }
  });
});
