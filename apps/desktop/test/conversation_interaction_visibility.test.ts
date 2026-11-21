import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Message } from '../src/renderer/src/im-template/template/types';
import { useChatTimelineNavigation } from '../src/renderer/src/im-template/template/useChatTimelineNavigation';
import {
  conversationInteractionId,
  interactionBannerPrefix,
  type ConversationInteraction,
  type ConversationInteractionSnapshot,
} from '../src/shared/conversation_interaction';
import { createTemplateDemoData } from './support/templateDemoData';
import {
  mergeUnsequencedInteractionRows,
  useConversationInteractionBadges,
} from '../src/renderer/src/hooks/useConversationInteractionBadges';
import { useToast } from '../src/renderer/src/components/Toast.shared';

const interactionPush = vi.hoisted(() => ({
  onData: undefined as ((snapshot: ConversationInteractionSnapshot) => void) | undefined,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      interactionBadges: {
        state: {
          subscribe: (_: unknown, handler: { onData: typeof interactionPush.onData }) => {
            interactionPush.onData = handler.onData;
            return {
              unsubscribe: () => {
                interactionPush.onData = undefined;
              },
            };
          },
        },
      },
    },
  },
}));

it('按撤回互动身份收起横幅，确认晚到的横幅也收起且不串数据源', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'live' };
  const key = interactionBannerPrefix('10001', 'live');
  const id = (msgId: string) =>
    conversationInteractionId({ kind: 'c2c', conv: 'peer', msgId, action: 'recall' });
  function Probe() {
    useConversationInteractionBadges(binding, true);
    return null;
  }
  try {
    act(() => root.render(h(Probe)));
    const store = useToast.getState();
    const first = store.push({ event: 'recall', key: key + id('1'), title: 'first' });
    store.push({ event: 'recall', key: key + id('2'), title: 'other' });
    store.push({
      event: 'recall',
      key: interactionBannerPrefix('10001', 'backup') + id('1'),
      title: 'backup',
    });
    act(() => interactionPush.onData?.({ pending: [], badges: [], seen: [] }));
    expect(useToast.getState().leaving).toEqual([]);
    act(() => interactionPush.onData?.({ pending: [], badges: [], seen: [id('1'), id('3')] }));
    const late = store.push({ event: 'recall', key: key + id('3'), title: 'late' });
    expect(useToast.getState().leaving).toEqual([first, late]);
  } finally {
    act(() => root.unmount());
    useToast.setState({ toasts: [], leaving: [], seq: 0 });
    vi.unstubAllGlobals();
  }
});

it('前台最新消息可确认撤回横幅，但未露出的角标互动不随尾页确认', () => {
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
  const offPage: ConversationInteraction = { ...recall, msgId: '90000', action: 'seqless' };
  const banner: ConversationInteraction = { ...recall, msgId: '89999', bannerPending: true };
  const pendingInteractions = [recall, offPage, banner, { ...recall, conv: 'another-group' }];
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
  const seqless: Message = {
    ...latest,
    id: 'seqless-row',
    msgId: offPage.msgId,
    msgSeq: '0',
    body: '无序号消息',
  };
  const messages = [earlier, latest, seqless];
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
    expect(onSeeInteractions.mock.calls).toEqual([[[conversationInteractionId(banner)], true]]);
    onSeeInteractions.mockClear();
    show(true, '102', seqless.id)?.();
    expect(onSeeInteractions.mock.calls).toEqual([[[conversationInteractionId(offPage)]]]);
  } finally {
    cleanup?.();
    act(() => root.unmount());
    bounds.mockRestore();
    focus.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('将未进入序号分页的消息按时间和身份插回窗口，不重复已有消息', () => {
  const message = (msgId: string, msgSeq: string, sendTime: string) => ({
    msgId,
    msgSeq,
    sendTime,
    senderUid: 'peer',
    senderUin: '1',
    elements: [],
  });
  const first = message('9007199254740992', '100', '1000');
  const second = message('9007199254740995', '101', '1000');
  const between = message('9007199254740993', '0', '1000');
  const next = message('9007199254740996', '0', '1001');
  expect(mergeUnsequencedInteractionRows([first, second], [next, between, first])).toEqual([
    first,
    between,
    second,
    next,
  ]);
});
