import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const fixture = vi.hoisted(() => ({
  provider: {} as {
    latestMessageId?: string | null;
    latestPeerMsgId?: string | null;
    latestSelfMessageIds?: readonly string[];
    roamingMessageKey?: string;
    manualPendingMessageIds?: ReadonlySet<string>;
  },
  bar: {} as { replyTargetId?: string | null },
  enabled: false,
  analyze: vi.fn(async () => null),
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  IntentSenseProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
    latestMessageId?: string | null;
    latestPeerMsgId?: string | null;
    latestSelfMessageIds?: readonly string[];
    roamingMessageKey?: string;
    manualPendingMessageIds?: ReadonlySet<string>;
  }) => {
    fixture.provider = props;
    return children;
  },
  useIntentSenseStatus: () => ({ data: { enabled: fixture.enabled, analysisMode: 'manual' } }),
  useIntentSenseContext: () => null,
}));
vi.mock('../src/renderer/src/components/intentSense/IntentSuggestionBar', () => ({
  IntentSuggestionBar: (props: { replyTargetId?: string | null }) => {
    fixture.bar = props;
    return null;
  },
}));
vi.mock('../src/renderer/src/components/intentSense/MessageIntentSense', () => ({
  MessageIntentSense: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return {
    trpc: proxy(),
    client: { account: { intentSense: { analyzeMessage: { mutate: fixture.analyze } } } },
  };
});
beforeEach(() => {
  fixture.enabled = false;
  fixture.analyze.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

it.each(['group', 'direct'] as const)(
  '%s 手动意图分析由真实右键与多选入口触发，只分析选中消息',
  async (type) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    fixture.enabled = true;
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((row) => row.type === type)!;
    const messages = ['1', '2'].map((id) => ({
      ...demo.messages[0]!,
      id,
      conversationId: conversation.id,
      body: '合成文本',
      qqElements: [{ type: 'text', data: { textContent: '合成文本' } }],
    }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(ChatPane, {
            user: demo.user,
            conversation,
            messages,
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
      expect(fixture.analyze).not.toHaveBeenCalled();
      const bubble = host.querySelector<HTMLElement>('.message-bubble')!;
      await act(async () =>
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
        ),
      );
      const menuButton = [
        ...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button'),
      ].find((button) => button.textContent === '意图感知')!;
      expect(menuButton).toBeDefined();
      let finish!: (value: null) => void;
      fixture.analyze.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            finish = resolve;
          }),
      );
      await act(async () => menuButton.click());
      expect([...(fixture.provider.manualPendingMessageIds ?? [])]).toEqual(['1']);
      expect(fixture.analyze).toHaveBeenLastCalledWith({
        kind: type === 'group' ? 'group' : 'c2c',
        conv: conversation.id,
        msgId: '1',
        manual: true,
      });
      await act(async () => finish(null));
      expect(fixture.provider.manualPendingMessageIds?.size ?? 0).toBe(0);
      await act(async () =>
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
        ),
      );
      const multi = [
        ...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button'),
      ].find((button) => button.textContent === '多选')!;
      await act(async () => multi.click());
      let fail!: (error: Error) => void;
      fixture.analyze.mockImplementationOnce(
        () =>
          new Promise<null>((_resolve, reject) => {
            fail = reject;
          }),
      );
      await act(async () =>
        host.querySelector<HTMLButtonElement>('.selection-bar [aria-label="意图感知"]')!.click(),
      );
      expect([...(fixture.provider.manualPendingMessageIds ?? [])]).toEqual(['1']);
      await act(async () => fail(new Error('合成分析失败')));
      expect(fixture.provider.manualPendingMessageIds?.size ?? 0).toBe(0);
      expect(fixture.analyze).toHaveBeenCalledTimes(2);
      expect(
        fixture.analyze.mock.calls.every(([input]) => (input as { msgId: string }).msgId === '1'),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each(['group', 'direct'] as const)(
  '%s 聊天区把自己的真实消息传给分析，把回复目标置空；新对方消息再恢复',
  async (type) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const demo = createTemplateDemoData(),
      conversation = demo.conversations.find((row) => row.type === type)!;
    const user = { ...demo.user, id: 'self:10000', identityValue: '10000', uid: 'u_self' };
    const message = (id: string, senderId: string) => ({
      ...demo.messages[0]!,
      id,
      conversationId: conversation.id,
      senderId,
      body: '合成正文',
      qqElements: [{ type: 'text', data: { textContent: '合成正文' } }],
    });
    const peer = message('peer', 'u_peer'),
      own = message('own', 'u_self');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (messages: Array<ReturnType<typeof message>>) =>
      act(async () =>
        root.render(
          h(ChatPane, {
            user,
            conversation,
            messages,
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
    try {
      const ownBefore = message('own-before', '10000');
      await render([peer, ownBefore, own]);
      expect(fixture.provider.latestMessageId).toBe('own');
      expect(fixture.provider.latestSelfMessageIds).toEqual(['own', 'own-before']);
      expect(fixture.provider.latestPeerMsgId).toBeNull();
      expect(fixture.bar.replyTargetId).toBeNull();
      await render([peer, message('roaming:protocol:2:77', 'u_peer'), ownBefore, own]);
      expect(fixture.provider.roamingMessageKey).toBe('roaming:protocol:2:77');
      expect(fixture.provider.latestMessageId).toBe('own');
      const next = message('new-peer', 'u_peer');
      await render([peer, own, next]);
      expect(fixture.provider.latestMessageId).toBe('new-peer');
      expect(fixture.provider.latestSelfMessageIds).toEqual([]);
      expect(fixture.bar.replyTargetId).toBe('new-peer');
      await act(async () =>
        root.render(
          h(ChatPane, {
            user,
            conversation,
            messages: [peer, own, next, { ...own, id: 'optimistic', optimistic: 'sending' }],
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
      expect(fixture.provider.latestMessageId).toBe('new-peer');
      expect(fixture.bar.replyTargetId).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
