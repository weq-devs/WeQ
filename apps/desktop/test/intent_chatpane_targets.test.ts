import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const fixture = vi.hoisted(() => ({
  provider: {} as {
    latestMessageId?: string | null;
    latestPeerMsgId?: string | null;
    latestSelfMessageIds?: readonly string[];
  },
  bar: {} as { replyTargetId?: string | null },
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
  }) => {
    fixture.provider = props;
    return children;
  },
  useIntentSenseStatus: () => ({ data: undefined }),
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
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => vi.unstubAllGlobals());

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
