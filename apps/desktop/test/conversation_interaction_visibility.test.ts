import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Message } from '../src/renderer/src/im-template/template/types';
import { useChatTimelineNavigation } from '../src/renderer/src/im-template/template/useChatTimelineNavigation';
import {
  conversationInteractionId,
  type ConversationInteraction,
} from '../src/shared/conversation_interaction';
import { createTemplateDemoData } from './support/templateDemoData';

it('读到前台最新消息时确认该会话的互动，历史页仍按条确认', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'group')!;
  const recall: ConversationInteraction = {
    kind: 'group',
    conv: conversation.id,
    msgId: '90001',
    action: 'recall',
  };
  const offPage: ConversationInteraction = { ...recall, msgId: '90000', action: 'poke' };
  const pendingInteractions = [recall, offPage, { ...recall, conv: 'another-group' }];
  const earlier: Message = {
    id: 'recall-row',
    msgId: recall.msgId,
    msgSeq: '101',
    conversationId: conversation.id,
    senderId: 'peer',
    body: '已撤回',
    createdAt: conversation.updatedAt,
    recall: { revokeUid: 'peer', sameSender: true, recallTs: 1 },
  };
  const latest: Message = {
    ...earlier,
    id: 'latest-row',
    msgId: '90002',
    msgSeq: '102',
    body: '最新消息',
    recall: undefined,
  };
  const messages = [earlier, latest];
  const root = createRoot(document.createElement('div'));
  const onSeeInteractions = vi.fn();
  let observe!: ReturnType<typeof useChatTimelineNavigation>['observeMessageVisibility'];
  const parentJumpToSeq = vi.fn();

  function Harness({
    atLatest,
    latestMessageSeq,
  }: {
    atLatest: boolean;
    latestMessageSeq: string;
  }) {
    const navigation = useChatTimelineNavigation({
      atLatest,
      conversation,
      initialReadingPosition: undefined,
      jumpRequest: undefined,
      latestMessageSeq,
      loadError: null,
      loading: false,
      loadingNewer: false,
      timelineSettings: undefined,
      messages,
      onJumpToLatest: undefined,
      onReadCurrentConversation: undefined,
      pendingInteractions,
      onSeeInteractions,
      parentJumpToSeq,
      tabActive: true,
      unreadDock: null,
      user: demo.user,
      visibleMessages: messages,
    });
    observe = navigation.observeMessageVisibility;
    return h(
      'div',
      { ref: navigation.messageScrollRef },
      messages.map(({ id }) => h('div', { key: id, 'data-message-id': id })),
    );
  }

  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
  function show(atLatest: boolean, latestMessageSeq: string, visibleId: string) {
    bounds.mockImplementation(function (this: HTMLElement) {
      if (!this.dataset.messageId) return new DOMRect(0, 0, 300, 100);
      return new DOMRect(0, this.dataset.messageId === visibleId ? 20 : 120, 300, 20);
    });
    act(() => root.render(h(Harness, { atLatest, latestMessageSeq })));
    return observe();
  }

  let cleanup: ReturnType<typeof observe>;
  try {
    show(false, '102', latest.id)?.();
    show(true, '103', latest.id)?.();
    expect(onSeeInteractions).not.toHaveBeenCalled();

    show(true, '102', earlier.id)?.();
    expect(onSeeInteractions.mock.calls).toEqual([[[conversationInteractionId(recall)]]]);
    onSeeInteractions.mockClear();

    focus.mockReturnValue(false);
    cleanup = show(true, '102', latest.id);
    expect(onSeeInteractions).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    expect(onSeeInteractions.mock.calls).toEqual([
      [[conversationInteractionId(recall), conversationInteractionId(offPage)]],
    ]);
  } finally {
    cleanup?.();
    act(() => root.unmount());
    bounds.mockRestore();
    focus.mockRestore();
    vi.unstubAllGlobals();
  }
});
