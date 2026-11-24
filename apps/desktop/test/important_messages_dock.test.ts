import { act, createElement as h, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useChatTimelineNavigation } from '../src/renderer/src/im-template/template/useChatTimelineNavigation';
import {
  consumeUnreadDock,
  mergeUnreadDock,
} from '../src/renderer/src/im-template/template/unreadDock';
import type { ReplyJumpTarget } from '../src/renderer/src/state/messageContext';
import { createTemplateDemoData } from './support/templateDemoData';

it('定位进行中不消耗跳转点，失败可重试，旧会话任务结束不推进新队列', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const data = createTemplateDemoData();
  const messages: [] = [];
  const dock = {
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

it('列表与队列共享定位进度，确认缺失只结束对应的浮动提醒', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const demo = createTemplateDemoData();
  const jump = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const messages: [] = [];
  const dock = {
    stops: [
      { kind: 'newFile' as const, seq: '103', identity: { senderUid: 'u_file', sendTime: '1000' } },
      { kind: 'replyMe' as const, seq: '102' },
      { kind: 'unread' as const, seq: '101' },
    ],
  };
  let state!: ReturnType<typeof useChatTimelineNavigation>;
  function Harness({ conversationId = '777' }: { conversationId?: string }) {
    const [queues, setQueues] = useState(
      () => new Map(['777', '888'].map((id) => [id, mergeUnreadDock(undefined, dock)!])),
    );
    const onConsumeUnreadDock = useCallback(
      (seqs: string[]) => {
        setQueues((current) =>
          new Map(current).set(
            conversationId,
            consumeUnreadDock(current.get(conversationId)!, seqs),
          ),
        );
      },
      [conversationId],
    );
    state = useChatTimelineNavigation({
      atLatest: false,
      conversation: { ...demo.conversations[0]!, id: conversationId },
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
      tabActive: true,
      unreadDock: queues.get(conversationId)!.dock,
      onConsumeUnreadDock,
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
    let earlier!: Promise<boolean>;
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
    expect(state.dockImportantRemaining).toBe(1);
    await act(async () => state.jumpToSeq({ seq: '102' }));
    expect(state.dockRemaining).toBe(2);
    jump.mockResolvedValueOnce(false);
    await act(async () => state.jumpDockStop());
    expect(state.dockRemaining).toBe(2);
    jump.mockRejectedValueOnce(new Error('fixture failure'));
    await act(async () => state.jumpDockStop());
    expect(state.dockRemaining).toBe(2);
    expect(state.locatedSeq).toBe('102');
    await act(async () => state.jumpDockStop());
    expect(state.locatedSeq).toBe('103');
    expect(jump).toHaveBeenLastCalledWith({
      seq: '103',
      importantMessage: dock.stops[0]?.identity,
      onMissing: expect.any(Function),
    });
    expect(state.dockStop?.seq).toBe('101');
    expect(state.dockRemaining).toBe(1);
    expect(state.dockImportantRemaining).toBe(0);
    await act(async () => state.jumpDockStop());
    expect(jump).toHaveBeenLastCalledWith({ seq: '101', mode: 'firstUnread' });
    expect(state.dockRemaining).toBe(0);
    await act(async () => root.render(h(Harness, { conversationId: '888' })));
    expect(state.dockStop?.kind).toBe('newFile');
    jump.mockImplementationOnce(async (target: ReplyJumpTarget) => {
      target.onMissing?.();
      return false;
    });
    await act(async () => expect(await state.jumpDockStop()).toBe(false));
    expect(state.locatedSeq).toBeNull();
    expect(state.dockStop?.kind).toBe('replyMe');
    expect(state.dockImportantRemaining).toBe(1);
    await act(async () => root.render(h(Harness, { conversationId: '777' })));
    expect(state.dockStop).toBeNull();
    await act(async () => root.render(h(Harness, { conversationId: '888' })));
    expect(state.dockStop?.kind).toBe('replyMe');
  } finally {
    act(() => root.unmount());
    host.remove();
    log.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  '历史滚动与未读定位后追加消息不会拖回最新（实时窗口 %s）',
  async (atLatest) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const demo = createTemplateDemoData();
    const conversation = demo.conversations[0]!;
    const rows = demo.messages.filter((row) => row.conversationId === conversation.id);
    const initial = rows.slice(0, -1);
    const host = document.createElement('div');
    const root = createRoot(host);
    let state!: ReturnType<typeof useChatTimelineNavigation>;
    let height = 1000;
    const jump = vi.fn(async () => true);
    function Harness({ latest, messages }: { latest: boolean; messages: typeof rows }) {
      state = useChatTimelineNavigation({
        atLatest: latest,
        conversation,
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
        tabActive: true,
        unreadDock: undefined,
        user: demo.user,
        visibleMessages: messages,
      });
      return h('div', { ref: state.messageScrollRef });
    }
    try {
      expect(initial.length).toBeGreaterThan(0);
      act(() => root.render(h(Harness, { latest: atLatest, messages: initial })));
      const scroll = host.firstElementChild as HTMLElement;
      Object.defineProperties(scroll, {
        scrollHeight: { get: () => height },
        clientHeight: { get: () => 400 },
      });
      if (atLatest) await act(async () => state.jumpToSeq({ seq: '101', mode: 'firstUnread' }));
      scroll.scrollTop = 600;
      act(() => state.handleMessageScroll());

      height = 1500;
      act(() => root.render(h(Harness, { latest: true, messages: rows })));
      expect(scroll.scrollTop).toBe(600);
      await act(async () => state.jumpToBottomAndRead());
      expect(scroll.scrollTop).toBe(1500);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
