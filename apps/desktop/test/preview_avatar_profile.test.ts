import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GapMessagesModal } from '../src/renderer/src/components/compose/GapMessagesModal';
import type { MemberProfileCard } from '../src/renderer/src/components/MemberProfileCard';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { resolveMessageSender } from '../src/renderer/src/im-template/template/conversationDisplay';
import { ChatNavigationContext } from '../src/renderer/src/lib/chatNavigation';

const { profile } = vi.hoisted(() => ({ profile: vi.fn() }));
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
vi.mock('../src/renderer/src/components/MemberProfileCard', () => ({
  MemberProfileCard: (props: ComponentProps<typeof MemberProfileCard>) => {
    profile(props);
    return createElement(
      'div',
      { role: 'dialog', 'aria-label': '用户资料' },
      createElement('button', { onClick: props.onClose }, '关闭名片'),
      createElement('button', { onClick: props.onOpenChat }, '查看消息'),
    );
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(['direct', 'group'] as const)(
  '%s 预览的双方头像打开对应名片，关闭保留预览及阅读位置',
  (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === kind)!;
    const peer = kind === 'direct' ? conversation.otherUser! : conversation.members[0]!;
    const messages = [peer, demo.user].map((sender, index) => ({
      ...demo.messages[0]!,
      id: `preview-${index}`,
      conversationId: conversation.id,
      senderId: sender.id,
      body: `合成预览 ${index}`,
    }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const close = vi.fn();
    const open = vi.fn();
    try {
      act(() =>
        root.render(
          createElement(
            ChatNavigationContext.Provider,
            { value: open },
            createElement(GapMessagesModal, {
              preview: true,
              embedded: true,
              conversation,
              user: demo.user,
              messages,
              loading: false,
              loadingMore: false,
              error: null,
              hasMore: false,
              moreFailed: false,
              totalCount: messages.length,
              onLoadMore: vi.fn(),
              onClose: close,
            }),
          ),
        ),
      );
      const scroll = host.querySelector<HTMLElement>('.weq-private-preview-scroll')!;
      scroll.scrollTop = 123;
      const avatars = host.querySelectorAll<HTMLButtonElement>('.message-avatar-button');
      expect(avatars).toHaveLength(2);
      for (const [index, avatar] of [...avatars].entries()) {
        act(() => avatar.click());
        const props = profile.mock.lastCall![0] as ComponentProps<typeof MemberProfileCard>;
        expect(props.member).toEqual(
          resolveMessageSender(messages[index]!, conversation, demo.user),
        );
        expect(props.groupCode).toBe(kind === 'group' ? conversation.id : undefined);
        expect(props.groupName).toBe(kind === 'group' ? conversation.group!.name : undefined);
        expect(open).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        act(() => props.onClose());
        expect(host.querySelector('[aria-label="用户资料"]')).toBeNull();
        expect(scroll.scrollTop).toBe(123);
        expect(host.querySelector('.weq-private-preview-scroll')).toBe(scroll);
      }
      act(() => avatars[0]!.click());
      const props = profile.mock.lastCall![0] as ComponentProps<typeof MemberProfileCard>;
      act(() => props.onOpenChat!());
      expect(close).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith({ kind: 'direct', user: props.member });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
