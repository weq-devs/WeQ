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

it('列表与队列共享定位进度，乱序选择只完成自身，重定位和失败不跳过其它提醒', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const demo = createTemplateDemoData();
  const jump = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const messages: [] = [];
  const dock = {
    unread: 3,
    stops: [
      { kind: 'atMe' as const, seq: '103' },
      { kind: 'replyMe' as const, seq: '102' },
      { kind: 'unread' as const, seq: '101' },
    ],
  };
  let state!: ReturnType<typeof useChatTimelineNavigation>;
  function Harness() {
    state = useChatTimelineNavigation({
      atLatest: false,
      conversation: demo.conversations[0],
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
      parentJumpToSeq: jump,
      selectionOrder: [],
      tabActive: true,
      unreadDock: dock,
      user: demo.user,
      visibleMessages: messages,
    });
    return null;
  }
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(h(Harness)));
    let release!: () => void;
    jump.mockReturnValueOnce(
      new Promise<void>((done) => {
        release = done;
      }),
    );
    let earlier!: void | Promise<void>;
    act(() => {
      earlier = state.jumpToSeq({ seq: '103' });
    });
    await act(async () => state.jumpToSeq({ seq: '102', msgId: '900102' }));
    await act(async () => {
      release();
      await earlier;
    });
    expect(state.locatedSeq).toBe('102');
    expect(state.dockStop?.seq).toBe('103');
    expect(state.dockRemaining).toBe(2);
    await act(async () => state.jumpToSeq({ seq: '102' }));
    expect(state.dockRemaining).toBe(2);
    jump.mockRejectedValueOnce(new Error('fixture failure'));
    await act(async () => state.jumpDockStop());
    expect(state.dockRemaining).toBe(2);
    expect(state.locatedSeq).toBe('102');
    await act(async () => state.jumpDockStop());
    expect(state.locatedSeq).toBe('103');
    expect(state.dockStop?.seq).toBe('101');
    expect(state.dockRemaining).toBe(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    log.mockRestore();
    vi.unstubAllGlobals();
  }
});
