import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useChatTimelineNavigation } from '../src/renderer/src/im-template/template/useChatTimelineNavigation';
import { createTemplateDemoData } from './support/templateDemoData';

it('定位进行中不消耗跳转点，失败可重试，旧会话任务结束不推进新队列', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const data = createTemplateDemoData();
  const messages: [] = [];
  const dock = {
    unread: 2,
    stops: [
      { kind: 'atMe' as const, seq: '101' },
      { kind: 'replyMe' as const, seq: '102' },
    ],
  };
  const parentJumpToSeq = vi.fn<() => Promise<void>>();
  let release!: () => void;
  parentJumpToSeq.mockReturnValueOnce(
    new Promise<void>((done) => {
      release = done;
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness({ conversationId }: { conversationId: string }) {
    const navigation = useChatTimelineNavigation({
      atLatest: false,
      conversation: { ...data.conversations[0]!, id: conversationId },
      initialReadingPosition: undefined,
      jumpRequest: undefined,
      latestMessageSeq: undefined,
      loadError: null,
      loading: false,
      loadingNewer: false,
      timelineSettings: undefined,
      messages,
      onJumpToLatest: undefined,
      onReadCurrentConversation: undefined,
      parentJumpToSeq,
      selectionOrder: messages,
      tabActive: true,
      unreadDock: dock,
      user: data.user,
      visibleMessages: messages,
    });
    return h(
      'button',
      { disabled: navigation.dockJumping, onClick: () => void navigation.jumpDockStop() },
      navigation.dockIndex,
    );
  }
  try {
    await act(async () => root.render(h(Harness, { conversationId: '777' })));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toBe('0');
    expect(host.querySelector('button')!.disabled).toBe(true);
    await act(async () => root.render(h(Harness, { conversationId: '888' })));
    await act(async () => release());
    expect(host.textContent).toBe('0');
    parentJumpToSeq.mockRejectedValueOnce(new Error('fixture failure'));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toBe('0');
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toBe('1');
  } finally {
    act(() => root.unmount());
    host.remove();
    error.mockRestore();
    vi.unstubAllGlobals();
  }
});
