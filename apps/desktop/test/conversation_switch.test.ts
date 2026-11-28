import {
  act,
  createElement as h,
  StrictMode,
  Fragment,
  startTransition,
  useLayoutEffect,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Storage } from 'happy-dom';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MainView } from '../src/renderer/src/views/MainView';
import { GROUP_INITIAL_PAGE_SIZE, PAGE_SIZE } from '../src/renderer/src/views/workspace/paging';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { useViewState } from '../src/renderer/src/state/view';
import type { ChatMainContent } from '../src/renderer/src/im-template/template/chatMainContent';
import type { ChatSidebarContent } from '../src/renderer/src/im-template/template/chatSidebarContent';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import type { GroupSearchHit } from '../src/renderer/src/components/search/types';
import type { MessageDbNotice, MessagePageStage } from '../src/shared/message_read';
import type { QqLiveBusinessBatch, QqLivePeer } from '../src/shared/qq_live_business';
import { publishQQPeerUpdate } from '../src/renderer/src/lib/qqPeerUpdates';
import type { GapMessagesModal } from '../src/renderer/src/components/compose/GapMessagesModal';
import {
  GapMessagesModal as LazyGapMessagesModal,
  SearchResultsPanel,
} from '../src/renderer/src/components/lazyMainPanels';
import * as replyPreview from '../src/renderer/src/lib/replyPreview';
import * as conversationOrder from '@weq/service/conversation-order';
import * as conversationRows from '../src/renderer/src/lib/conversationListOrder';
import { timelineViewport } from '../src/renderer/src/lib/timelineViewport';
import { UNREAD_BATCH_SIZE } from '../src/renderer/src/lib/unreadRefresh';
import type { QQWriteBinding } from '../src/renderer/src/hooks/useQQWriteSession';
import { ReplyJumpContext } from '../src/renderer/src/state/messageContext';
import type { ReplyJumpTarget } from '../src/renderer/src/components/QqMessageContent';
import {
  acceptPreferences,
  accountBinding,
  bindAccountState,
} from '../src/renderer/src/lib/clientPreferences';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { elementToToken } from '../src/renderer/src/im-template/template/draftElements';
import { pageSnapshots } from '../src/renderer/src/lib/pageSnapshots';
import { releaseObjectUrl } from '../src/renderer/src/lib/objectUrl';
import { WEB_NOTICE_OPEN } from '../src/renderer/src/lib/browserNotifications';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';

beforeAll(() => LazyGapMessagesModal.preload());

vi.mock('../src/renderer/src/hooks/useRecentContactQueries', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/renderer/src/hooks/useRecentContactQueries')>();
  const { trpc } = await import('../src/renderer/src/trpc/client');
  return {
    ...actual,
    useRecentContactQueries: (binding: QQWriteBinding | null, active: boolean) => {
      const input = binding ?? { expectedAccountUin: '', expectedAccountConfigId: '' };
      return {
        contacts: trpc.account.listRecentContacts.useInfiniteQuery({ ...input, limit: 500 }),
        head: trpc.account.listRecentContacts.useQuery(
          { ...input, limit: 50, cursor: 0 },
          { enabled: active },
        ),
      };
    },
  };
});

type TestMessage = {
  source?: 'roaming';
  localSent?: boolean;
  ntSeqVerified?: boolean;
  msgId: string;
  msgSeq: string;
  msgRandom?: string;
  clientSeq?: string;
  sendTime: string;
  senderUid: string;
  senderUin: string;
  elements: { type: string; text?: string; data?: Record<string, unknown> }[];
  recall?: { revokeUid: string; sameSender: boolean; recallTs: number };
};
type UnreadInput = { targets: Array<{ chatType: number; uid: string }>; watermarksOnly?: boolean };
type TestLiveConversation = {
  kind: 'c2c' | 'group';
  conv: string;
  live: true;
  livePeer: QqLivePeer;
  messages: TestMessage[];
};

const f = vi.hoisted(() => ({
  refreshing: false,
  readFromFirstUnread: false,
  showMessageUnreadBadge: true,
  unreadMode: false,
  unreadCounts: {} as Record<string, number>,
  unreadGroupNotifyLevels: {} as Record<string, number>,
  deletedResponse: [] as string[],
  hiddenDeletionResponse: [] as string[],
  deletedReply: undefined as (() => Promise<string[]>) | undefined,
  hiddenDeletionReply: undefined as (() => Promise<string[]>) | undefined,
  deletionSets: {} as { deleted?: Set<string>; hidden?: Set<string> },
  headRefreshes: 0,
  recentInvalidations: 0,
  freshPreview: false,
  previewTarget: null as string | null,
  groups: [] as Array<{
    groupCode: string;
    groupName: string;
    remark: string;
    memberCount: number;
    maxMemberCount: number;
    customLabels: Array<{ content: string }>;
    directory: { memberCount: number; role: 'member'; notifyLevel: number } | null;
  }>,
  searchGroups: [] as GroupSearchHit[],
  headEnabled: false,
  unreadReads: [] as UnreadInput[],
  unreadFailures: 0,
  unreadReply: undefined as (() => Promise<unknown>) | undefined,
  markedRead: [] as Array<{
    chatType: number;
    uid: string;
    latestSeq?: string;
    visibleSeqs?: string[];
  }>,
  readCurrent: undefined as (() => void) | undefined,
  markReadReply: undefined as (() => Promise<void>) | undefined,
  dbChanged: undefined as ((notice?: MessageDbNotice) => void) | undefined,
  liveBusiness: undefined as ((batch: QqLiveBusinessBatch) => void) | undefined,
  liveConversation: undefined as ((change: TestLiveConversation) => void) | undefined,
  newMessages: undefined as ((batch: { messages: TestMessage[] }) => void) | undefined,
  peerTyping: undefined as string | undefined,
  notificationSubscriptions: { group: [], conversation: [] } as Record<
    'group' | 'conversation',
    Array<{ notify: () => void; unsubscribe: () => void }>
  >,
  notificationReads: { group: 0, conversation: 0 },
  groupJumps: [] as Array<{ groupCode: string; msgSeq: string }>,
  conversationJumps: [] as Array<{
    kind: 'c2c' | 'group';
    conv: string;
    seq?: string;
    msgId?: string;
  }>,
  conversationJumpReply: undefined as
    | (() => Promise<{ kind: 'c2c' | 'group'; conv: string } | null>)
    | undefined,
  unreadChanged: undefined as ((targets: UnreadInput['targets']) => void) | undefined,
  refreshRows: undefined as TestMessage[] | undefined,
  refreshReads: [] as string[],
  gapRows: [] as TestMessage[],
  gapRequests: [] as unknown[],
  jump: undefined as ((target: ReplyJumpTarget) => void | Promise<void>) | undefined,
  automaticGap: false,
  beforeRows: [] as TestMessage[],
  beforeReply: undefined as ((beforeSeq: string) => TestMessage[]) | undefined,
  afterReply: undefined as ((afterSeq: string) => Promise<TestMessage[]>) | undefined,
  previewMessages: [] as ComponentProps<typeof GapMessagesModal>['messages'],
  previewMore: undefined as (() => void) | undefined,
  profiles: [] as Array<{ uid: string; uin: string; nick: string; remark: string }>,
  bots: [] as string[],
  memberDetails: undefined as
    | { uid: string; uin: string; card: string; nick: string; adminFlag: number; joinTime: string }
    | undefined,
  messages: [] as ComponentProps<typeof ChatMainContent>['messages'],
  send: undefined as ComponentProps<typeof ChatMainContent>['onSend'] | undefined,
  sendCalls: [] as string[],
  sendPending: false,
  sendReply: undefined as
    | ((random?: number) => Promise<{ ok: true; groupSequence: number; random: number }>)
    | undefined,
  sendError: undefined as string | undefined,
  messageCommits: [] as Array<{ id?: string; rows: string[] }>,
  atLatest: true as ComponentProps<typeof ChatMainContent>['atLatest'],
  commit: undefined as (() => void) | undefined,
  reads: [] as { conv: string; show: (stage: MessagePageStage<TestMessage>) => void }[],
  recent: ['10001', '10002', 'u_peer'].map((targetUid, index) => ({
    targetUid,
    targetUin: '20001',
    chatType: index === 2 ? 1 : 2,
    msgSeq: '1',
    sendTime: '1794200000',
    preview: { kind: 'text', textContent: '旧预览' },
    remark: targetUid,
    nick: targetUid,
  })),
}));
vi.mock('../src/renderer/src/hooks/useConditionalDirectory', () => {
  const empty = { data: [], isSuccess: true, isLoading: false, isFetching: false };
  const refetch = async () => ({ isError: false });
  return {
    useConditionalDirectory: (_key: unknown, name: string) => ({
      ...empty,
      data: name === 'listAllGroups' ? f.groups : name === 'listProfiles' ? f.profiles : empty.data,
      refetch,
    }),
  };
});
vi.mock('../src/renderer/src/trpc/client', () => {
  const refetch = vi.fn(async () => ({ data: undefined }));
  const empty = { data: undefined, isSuccess: false, isLoading: false, isFetching: false, refetch };
  const config = { ...empty, data: { uin: '90001', configId: 'switch-test', static: false } };
  const recent = { ...empty, isSuccess: true, data: { items: f.recent } };
  const pages = { ...empty, isSuccess: true, data: { pages: [{ items: f.recent }] } };
  const refreshing = { ...recent, isFetching: true, data: { items: [] } };
  const refreshingPages = { ...pages, isFetching: true, data: { pages: [{ items: [] }] } };
  const directory = { ...empty, isSuccess: true, data: [] };
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === '_def') return () => ({ path });
        if (key === 'useQuery')
          return (_input: unknown, options?: { enabled?: boolean }) => {
            const [head, setHead] = useState(recent);
            if (path.join('.') === 'account.listRecentContacts')
              f.headEnabled = options?.enabled === true;
            if (path.join('.') === 'bootstrap.getSettings')
              return {
                ...empty,
                data: {
                  readFromFirstUnread: f.readFromFirstUnread,
                  showMessageUnreadBadge: f.showMessageUnreadBadge,
                  voiceTranscribe: { modelId: '' },
                },
              };
            if (
              path.at(-1) === 'getGroupAlbumAccessState' &&
              (f.sendPending || f.sendError || f.sendReply)
            )
              return { ...empty, data: { qqOnline: true, attachEnabled: true } };
            return path.join('.') === 'account.getAccountConfig'
              ? config
              : path.join('.') === 'account.listProfiles'
                ? { ...empty, isSuccess: true, data: f.profiles }
                : path.join('.') === 'account.botUids'
                  ? { ...empty, isSuccess: true, data: f.bots }
                  : path.join('.') === 'account.listRecentContacts'
                    ? f.refreshing
                      ? refreshing
                      : {
                          ...head,
                          refetch: async () => {
                            f.headRefreshes++;
                            if (f.freshPreview)
                              setHead({
                                ...recent,
                                data: {
                                  items: f.recent.map((row) =>
                                    f.previewTarget === null || f.previewTarget === row.targetUid
                                      ? {
                                          ...row,
                                          msgSeq: '2',
                                          sendTime: '1794200060',
                                          preview: { kind: 'text', textContent: '最新消息' },
                                        }
                                      : row,
                                  ),
                                },
                              });
                            return { isError: false };
                          },
                        }
                    : path.join('.') === 'account.listAllGroups'
                      ? { ...directory, data: f.groups }
                      : ['listHiddenSessions', 'listDeletedSessions', 'listTopContacts'].includes(
                            path.at(-1) ?? '',
                          )
                        ? directory
                        : empty;
          };
        if (key === 'useInfiniteQuery') return () => (f.refreshing ? refreshingPages : pages);
        if (key === 'useMutation')
          return () => ({ mutate: vi.fn(), mutateAsync: refetch, isLoading: false });
        if (key === 'useSubscription') return () => {};
        if (key === 'query' || key === 'mutate' || key === 'invalidate')
          return async (
            input?: UnreadInput & {
              conv?: string;
              beforeSeq?: string;
              afterSeq?: string;
              random?: number;
            },
          ) => {
            if (path.at(-1) === 'searchQuick')
              return { conversations: [], friends: [], groupMembers: [], groups: f.searchGroups };
            if (path.at(-1) === 'searchSlow')
              return {
                chatRecords: [],
                files: [],
                collections: [],
                cloneMessages: [],
                assistantMessages: [],
              };
            if (key === 'query' && path.at(-1) === 'listRecentContacts')
              return { items: f.recent, total: f.recent.length };
            if (key === 'invalidate' && path.at(-1) === 'listRecentContacts')
              f.recentInvalidations++;
            if (path.at(-1) === 'peerQqShow') return null;
            if (
              [
                'prepareChatDecoration',
                'sendElements',
                'sendAiVoice',
                'forwardFlashTransfer',
              ].includes(path.at(-1) ?? '')
            ) {
              f.sendCalls.push(path.at(-1)!);
              if (f.sendError) throw new Error(f.sendError);
              if (path.at(-1) === 'sendElements' && f.sendReply) return f.sendReply(input?.random);
              if (f.sendPending) return new Promise(() => {});
            }
            if (path.at(-1) === 'consumeGroupKeywordJump') {
              f.notificationReads.group++;
              return f.groupJumps.shift() ?? null;
            }
            if (path.at(-1) === 'consumeConversationJump') {
              f.notificationReads.conversation++;
              const reply = f.conversationJumpReply;
              f.conversationJumpReply = undefined;
              return reply ? reply() : (f.conversationJumps.shift() ?? null);
            }
            if (path.at(-1) === 'markConversationRead' || path.at(-1) === 'markViewportRead') {
              f.markedRead.push(input as unknown as (typeof f.markedRead)[number]);
              if (f.markReadReply) await f.markReadReply();
              return { changed: true, report: { state: 'disabled' } };
            }
            if (path.at(-1) === 'memberDetails') return f.memberDetails;
            if (path.at(-1) === 'listBefore')
              return f.beforeReply?.(input?.beforeSeq ?? '') ?? f.beforeRows;
            if (path.at(-1) === 'listAfter') return f.afterReply?.(input?.afterSeq ?? '') ?? [];
            if (path.at(-1) === 'fetchGapMessages') {
              f.gapRequests.push(input);
              return { ok: true, messages: f.gapRows, nextStartSeq: null };
            }
            if (path.at(-1) === 'deletedMsgIds')
              return f.deletedReply?.() ?? [...f.deletedResponse];
            if (path.at(-1) === 'hiddenDeletedMsgIds')
              return f.hiddenDeletionReply?.() ?? [...f.hiddenDeletionResponse];
            if (['listLatest', 'listFrom'].includes(path.at(-1) ?? '')) {
              if (input?.conv) f.refreshReads.push(input.conv);
              return f.refreshRows;
            }
            if (path.at(-1) === 'getUnreadInfos' && f.unreadMode && input) {
              f.unreadReads.push(input);
              if (f.unreadFailures > 0) {
                f.unreadFailures--;
                throw new Error('首次未读读取失败');
              }
              if (f.unreadReply) {
                const reply = f.unreadReply;
                f.unreadReply = undefined;
                return reply();
              }
              return input.targets.map((target) => ({
                ...target,
                peer: `${target.chatType}_${target.uid}`,
                msgSeq: '1',
                latestSeq: '100',
                groupNotifyLevel: f.unreadGroupNotifyLevels[target.uid],
                ...(input.watermarksOnly
                  ? { countPending: true }
                  : { unreadCount: f.unreadCounts[target.uid] ?? 0 }),
              }));
            }
            return [
              'getUnreadInfos',
              'getGroupMembersByUids',
              'getGroupMembersByUins',
              'getProfilesByUids',
              'listGroupMembers',
            ].includes(path.at(-1) ?? '')
              ? []
              : undefined;
          };
        if (key === 'subscribe')
          return (
            input: { conv: string },
            handlers: {
              onData: (
                data:
                  | MessagePageStage<TestMessage>
                  | UnreadInput['targets']
                  | { at?: number }
                  | QqLiveBusinessBatch
                  | TestLiveConversation,
              ) => void;
            },
          ) => {
            if (['onGroupKeywordJump', 'onConversationJump'].includes(path.at(-1) ?? '')) {
              const subscription = {
                notify: () => handlers.onData({}),
                unsubscribe: vi.fn(),
              };
              const kind = path.at(-1) === 'onGroupKeywordJump' ? 'group' : 'conversation';
              f.notificationSubscriptions[kind].push(subscription);
              return subscription;
            }
            if (path.at(-1) === 'latestPage')
              f.reads.push({ conv: input.conv, show: handlers.onData });
            if (path.at(-1) === 'onDbChanged')
              f.dbChanged = (notice) => handlers.onData(notice ?? {});
            if (path.at(-1) === 'onUnreadChanged')
              f.unreadChanged = (targets) => handlers.onData(targets);
            if (path.at(-1) === 'onQqLiveBusiness') f.liveBusiness = handlers.onData;
            if (path.at(-1) === 'onRoamingMessages') f.liveConversation = handlers.onData;
            if (path.at(-1) === 'onNewMessages') f.newMessages = handlers.onData;
            return { unsubscribe: vi.fn() };
          };
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/im-template/template/chatShell', () => ({
  ChatShell: ({
    mainContent,
    sidebarContent,
    searchPanel,
    onSearchFocus,
    onQueryChange,
    children,
    messageBadgeCount,
    onViewChange,
    onMessageBadgeClick,
  }: {
    mainContent: ReactNode;
    sidebarContent: ReactNode;
    searchPanel: ReactNode;
    onSearchFocus: () => void;
    onQueryChange: (query: string) => void;
    children: ReactNode;
    messageBadgeCount: number;
    onViewChange: (view: 'messages' | 'contacts') => void;
    onMessageBadgeClick: () => void;
  }) =>
    h(
      'div',
      { 'data-message-badge-count': messageBadgeCount },
      h('button', { 'data-messages': true, onClick: () => onViewChange('messages') }, '消息'),
      h('button', { 'data-contacts': true, onClick: () => onViewChange('contacts') }, '联系人'),
      h('button', { 'data-locate-unread': true, onClick: () => onMessageBadgeClick() }, '定位未读'),
      f.searchGroups.length
        ? h(
            'button',
            {
              'data-workspace-search': true,
              onClick: () => {
                onQueryChange('合成');
                onSearchFocus();
              },
            },
            '搜索',
          )
        : null,
      searchPanel,
      sidebarContent,
      mainContent,
      children,
    ),
}));
vi.mock('../src/renderer/src/im-template/template/chatSidebarContent', () => ({
  ChatSidebarContent: (props: ComponentProps<typeof ChatSidebarContent>) => {
    const directory = useContext(ConversationDirectoryContext);
    if (f.searchGroups.length && props.view === 'messages')
      return h(ConversationList, {
        active: props.active,
        conversations: props.conversations,
        activeConversationId: props.activeConversationId,
        preferences: props.conversationPrefs,
        drafts: props.drafts,
        onSelect: props.onSelectConversation,
      });
    return h(
      'nav',
      { 'data-list-view': directory?.view },
      h('span', { 'data-list-locate': directory?.locate?.id ?? '' }),
      h('span', { 'data-previews': true }, JSON.stringify(props.conversations)),
      ...(['hidden', 'all', 'groupAssistant'] as const).map((view) =>
        h(
          'button',
          {
            key: view,
            'data-list-switch': view,
            onClick: () => {
              directory?.onListInteraction?.();
              directory?.onViewChange(view);
            },
          },
          view,
        ),
      ),
      ...f.recent.map((row) =>
        h(
          'button',
          { key: row.targetUid, onClick: () => props.onSelectConversation(row.targetUid) },
          row.targetUid,
        ),
      ),
    );
  },
}));
vi.mock('../src/renderer/src/im-template/template/chatMainContent', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/src/im-template/template/chatMainContent')
    >();
  return {
    ChatMainContent: (props: ComponentProps<typeof ChatMainContent>) => {
      f.jump = useContext(ReplyJumpContext);
      f.messages = props.messages;
      f.peerTyping = props.peerTyping;
      f.send = props.onSend;
      f.readCurrent = () => {
        if (props.activeConversation) props.onReadCurrentConversation?.(props.activeConversation);
      };
      f.atLatest = props.atLatest;
      f.deletionSets = { deleted: props.deletedIds, hidden: props.hiddenDeletedIds };
      useLayoutEffect(() => {
        f.commit?.();
        f.commit = undefined;
      }, [props.activeConversation?.id]);
      useLayoutEffect(() => {
        f.messageCommits.push({
          id: props.activeConversation?.id,
          rows: props.messages.map((row) => row.id),
        });
      }, [props.activeConversation?.id, props.messages]);
      return h(
        'div',
        null,
        h(
          'output',
          null,
          JSON.stringify({
            id: props.activeConversation?.id ?? null,
            loading: props.loadingMessages,
            rows: props.messages.map((row) => row.id),
          }),
        ),
        h('button', { 'data-back': true, onClick: props.onBackConversation }, '返回'),
        h(
          'button',
          {
            'data-gap': true,
            onClick: () =>
              props.activeConversation &&
              props.onOpenGapMessages?.(
                {
                  conversation: props.activeConversation,
                  previousSeq: '1',
                  currentSeq: '3',
                  count: 1,
                },
                f.automaticGap,
              ),
          },
          '拉取缺口',
        ),
        h(
          'button',
          {
            'data-preview': true,
            onClick: () =>
              props.activeConversation && props.onPreviewLatest?.(props.activeConversation),
          },
          '预览',
        ),
        h(actual.ChatMainContent, props),
      );
    },
  };
});
vi.mock('../src/renderer/src/components/compose/GapMessagesModal', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/src/components/compose/GapMessagesModal')
    >();
  return {
    GapMessagesModal: (props: ComponentProps<typeof GapMessagesModal>) => {
      if (props.preview) {
        f.previewMessages = props.messages;
        f.previewMore = props.onLoadMore;
      }
      return h(actual.GapMessagesModal, props);
    },
  };
});

afterEach(() => {
  useViewState.getState().setOpenedUin(null);
  f.reads.length = 0;
  f.refreshing = false;
  f.readFromFirstUnread = false;
  f.showMessageUnreadBadge = true;
  f.commit = undefined;
  f.unreadMode = false;
  f.unreadCounts = {};
  f.unreadGroupNotifyLevels = {};
  f.deletedResponse = [];
  f.hiddenDeletionResponse = [];
  f.deletedReply = undefined;
  f.hiddenDeletionReply = undefined;
  f.deletionSets = {};
  f.headRefreshes = 0;
  f.recentInvalidations = 0;
  f.freshPreview = false;
  f.previewTarget = null;
  f.groups = [];
  f.searchGroups = [];
  f.headEnabled = false;
  f.unreadReads.length = 0;
  f.unreadFailures = 0;
  f.unreadReply = undefined;
  f.dbChanged = undefined;
  f.liveBusiness = undefined;
  f.liveConversation = undefined;
  f.newMessages = undefined;
  f.peerTyping = undefined;
  f.notificationSubscriptions = { group: [], conversation: [] };
  f.notificationReads = { group: 0, conversation: 0 };
  f.groupJumps = [];
  f.conversationJumps = [];
  f.conversationJumpReply = undefined;
  f.unreadChanged = undefined;
  f.refreshRows = undefined;
  f.refreshReads = [];
  f.gapRows = [];
  f.gapRequests = [];
  f.jump = undefined;
  f.automaticGap = false;
  f.beforeRows = [];
  f.beforeReply = undefined;
  f.afterReply = undefined;
  f.previewMessages = [];
  f.previewMore = undefined;
  f.profiles = [];
  f.bots = [];
  f.memberDetails = undefined;
  f.messages = [];
  f.send = undefined;
  f.sendCalls = [];
  f.sendPending = false;
  f.sendReply = undefined;
  f.sendError = undefined;
  f.messageCommits = [];
  f.markedRead = [];
  f.readCurrent = undefined;
  f.markReadReply = undefined;
  f.atLatest = true;
  // 先把排队的页面快照写进本用例的 Storage，避免下个用例恢复本次选择。
  pageSnapshots.flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('电脑请求不返回时，发送内容仍立即在本端回显且不查询装扮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.sendPending = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [] }));
    await act(async () => {
      void f.send!('本地立即显示');
    });
    expect(
      f.messages.some((row) => row.body === '本地立即显示' && row.optimistic === 'sending'),
    ).toBe(true);
    expect(host.textContent).toContain('本地立即显示');
    expect(f.sendCalls).not.toContain('prepareChatDecoration');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it('图片回声早于发送回执时也只显示一行，随后 QQ 回读保留气泡身份和本地原图', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.refreshRows = [];
  let requestRandom: number | undefined;
  let accept!: () => void;
  f.sendReply = (random) => {
    requestRandom = random;
    return new Promise((resolve) => {
      accept = () => resolve({ ok: true, groupSequence: 11, random: random! });
    });
  };
  const picture = { fileName: 'photo.png', fileToken: 'uploaded' };
  const url = 'blob:sent-photo';
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [] }));
    let sending!: ReturnType<NonNullable<typeof f.send>>;
    await act(async () => {
      sending = f.send!(
        elementToToken({ kind: 'pic', fileName: 'photo.png', localPreviewUrl: url }),
        [{ key: url, name: 'photo.png', previewUrl: url, bytes: new Uint8Array([1]) }],
      );
    });
    expect(requestRandom).toBeGreaterThan(0);
    const optimisticId = f.messages[0]?.id;
    expect(optimisticId).toMatch(/^optimistic-/);
    const commits = f.messageCommits.length;
    expect(f.messages[0]?.qqElements?.[0]?.data?.localPreviewUrl).toBe(url);

    const sent: TestMessage = {
      msgId: 'cache-11',
      msgSeq: '11',
      msgRandom: String(requestRandom),
      sendTime: String(Math.floor(Date.now() / 1000)),
      senderUid: '',
      senderUin: '90001',
      elements: [{ type: 'pic', data: picture }],
    };
    f.refreshRows = [{ ...sent, localSent: true, source: 'roaming' }];
    await act(async () => f.dbChanged!());
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]?.msgId).toBe('cache-11');
    expect(f.messages[0]?.outgoingId).toBe(optimisticId);
    expect(f.messages[0]?.optimistic).toBeUndefined();
    expect(f.messages[0]?.qqElements?.[0]?.data).toEqual({ ...picture, localPreviewUrl: url });
    releaseObjectUrl(url);
    expect(revoke).not.toHaveBeenCalledWith(url);
    await act(async () => {
      accept();
      await sending;
    });

    const readbackPicture = { ...picture, thumbnailUrl: '/qq-thumb.png' };
    f.refreshRows = [
      { ...sent, msgId: 'qq-11', elements: [{ type: 'pic', data: readbackPicture }] },
    ];
    await act(async () => f.dbChanged!());
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]?.msgId).toBe('qq-11');
    expect(f.messages[0]?.outgoingId).toBe(optimisticId);
    expect(f.messages[0]?.qqElements?.[0]?.data).toEqual({
      ...readbackPicture,
      localPreviewUrl: url,
    });
    expect(f.messageCommits.slice(commits).every(({ rows }) => rows.length === 1)).toBe(true);
    expect(revoke).not.toHaveBeenCalledWith(url);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
  expect(revoke).toHaveBeenCalledWith(url);
});

it.each(['video', 'aiVoice', 'flashTransfer'])(
  '%s 在媒体读取或电脑请求未完成时也保留本地回显',
  async (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    f.sendPending = true;
    const file = new File(['video'], 'slow.mp4');
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise(() => {}) });
    const body = elementToToken(
      kind === 'video'
        ? { kind: 'video', localPreviewUrl: 'blob:slow', fileName: 'slow.mp4' }
        : kind === 'aiVoice'
          ? { kind: 'ptt', isAiVoice: true, pttTranscript: '合成语音', pttVoiceId: 'voice' }
          : { kind: 'markdown', flashTransferInfo: { fileSetId: 'fileset' } },
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === '10001')!
          .click(),
      );
      await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [] }));
      await act(async () => {
        void f.send!(body, [{ key: 'blob:slow', name: file.name, file, previewUrl: 'blob:slow' }]);
      });
      expect(f.messages).toHaveLength(1);
      expect(f.messages[0]?.optimistic).toBe('sending');
      expect(f.sendCalls).not.toContain('prepareChatDecoration');
      if (kind === 'video') expect(f.sendCalls).not.toContain('sendElements');
    } finally {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    }
  },
);

it.each(['传给电脑失败', '请求超时，操作结果暂未确认，请刷新核对。'])(
  '发送请求异常时保留失败消息并显示失败横幅：%s',
  async (reason) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    useToast.setState({ toasts: [], leaving: [] });
    f.sendError = reason;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === '10001')!
          .click(),
      );
      await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [] }));
      await act(async () => {
        void f.send!('不能丢失的内容');
      });
      const failed = f.messages.find((row) => row.body === '不能丢失的内容');
      expect(failed?.optimistic).toBe('failed');
      expect(failed?.optimisticError).toBe(reason);
      expect(
        useToast
          .getState()
          .toasts.some((toast) => toast.tone === 'error' && toast.detail === reason),
      ).toBe(true);
      expect(f.sendCalls.filter((call) => call === 'sendElements')).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      useToast.setState({ toasts: [], leaving: [] });
    }
  },
);

it.each(['10001', 'u_peer'])(
  '会话 %s 的同序号戳一戳灰条不等待未读变化或一秒目录校准',
  async (id) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const original: TestMessage = {
      msgId: 'original',
      msgSeq: '1',
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', data: { textContent: '原消息' } }],
    };
    const poke: TestMessage = {
      ...original,
      msgId: 'poke',
      sendTime: '1794200001',
      elements: [
        {
          type: 'grayTipPoke',
          data: {
            grayTipXmlContent: '<gtip><nor txt="你戳了戳好友"/></gtip>',
          },
        },
      ],
    };
    try {
      await act(async () =>
        root.render(
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === id)!
          .click(),
      );
      await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [original] }));
      expect(f.messages.map((row) => row.msgId)).toEqual(['original']);
      await act(async () => {
        f.refreshRows = [poke, original];
        f.dbChanged!();
      });
      expect(f.messages.map((row) => row.msgId)).toEqual(['original', 'poke']);
      expect(host.textContent).toContain('你戳了戳好友');
      // 后续重复通知仍按稳定 ID 合并，不能把同序号灰条追加两遍。
      await act(async () => f.dbChanged!());
      expect(f.messages.map((row) => row.msgId)).toEqual(['original', 'poke']);
    } finally {
      act(() => root.unmount());
      client.clear();
      host.remove();
    }
  },
);

it('其他会话的新消息和当前未读变化都不重读当前正文，当前新消息仍即时校准', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  f.headEnabled = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const original: TestMessage = {
    msgId: 'original',
    msgSeq: '1',
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: '原消息' } }],
  };
  const latest = { ...original, msgId: 'latest', msgSeq: '2', sendTime: '1794200001' };
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [original] }));
    f.refreshReads.length = 0;
    f.refreshRows = [latest, original];
    await act(async () => {
      f.dbChanged!({ at: Date.now(), targets: [{ kind: 'group', conv: '10002' }] });
      f.unreadChanged!([{ chatType: 2, uid: '10001' }]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(f.refreshReads).toEqual([]);
    expect(f.messages.map((row) => row.msgId)).toEqual(['original']);
    await act(async () =>
      f.dbChanged!({ at: Date.now(), targets: [{ kind: 'group', conv: '10001' }] }),
    );
    expect(f.refreshReads).toEqual(['10001']);
    expect(f.messages.map((row) => row.msgId)).toEqual(['original', 'latest']);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    f.headRefreshes = 0;
    await act(async () => {
      const observedAt = Date.now();
      f.dbChanged!({ at: observedAt });
      f.dbChanged!({ at: observedAt, targets: [{ kind: 'group', conv: '10002' }] });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(f.headRefreshes).toBe(1);
    f.headRefreshes = 0;
    f.refreshReads.length = 0;
    await act(async () => {
      const observedAt = Date.now();
      f.dbChanged!({ at: observedAt, targets: [{ kind: 'group', conv: '10002' }] });
      f.dbChanged!({ at: observedAt, backgroundReconcile: true });
      f.dbChanged!({ at: observedAt, draftChanged: true });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(f.refreshReads).toEqual([]);
    expect(f.headRefreshes).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(f.refreshReads).toEqual(['10001']);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it('未知文件变化后快速返回仍复用最近窗口，停留时只校准返回的窗口', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const row = (msgId: string): TestMessage => ({
    msgId,
    msgSeq: '1',
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: msgId } }],
  });
  const open = (id: string) =>
    act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === id)!
        .click(),
    );
  const show = (msgId: string) =>
    act(async () => f.reads.at(-1)!.show({ complete: true, rows: [row(msgId)] }));
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await open('10001');
    await show('first');
    await open('10002');
    await show('second');
    f.refreshRows = [row('second')];
    await act(async () => f.dbChanged!());
    f.refreshReads.length = 0;
    f.refreshRows = [
      { ...row('first'), elements: [{ type: 'text', data: { textContent: '编辑后' } }] },
    ];
    const coldReads = f.reads.length;
    await open('10001');
    expect(f.reads).toHaveLength(coldReads);
    expect(f.messages.map((message) => message.body)).toEqual(['first']);
    expect(f.refreshReads).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(f.refreshReads).toEqual(['10001']);
    expect(f.messages.map((message) => message.body)).toEqual(['编辑后']);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each(['10001', 'u_peer'])(
  '会话 %s 首屏完成与阅读设置更新交错时，采用完整缓存并结束底部加载',
  async (id) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      );
    const message = (seq: string): TestMessage => ({
      msgId: seq,
      msgSeq: seq,
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', text: `消息 ${seq}` }],
    });
    try {
      await act(async () => render());
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === id)!
          .click(),
      );
      const read = f.reads.at(-1)!;
      await act(async () => read.show({ complete: false, rows: [message('1')] }));
      expect(host.querySelector('[aria-label="正在加载后续消息"]')).toBeNull();
      await act(async () => {
        // 完整页先同步写入缓存；尚未续跑的旧入口随设置更新失效。
        read.show({ complete: true, rows: [message('2'), message('1')] });
        f.readFromFirstUnread = true;
        flushSync(render);
      });
      expect(host.querySelector('[aria-label="正在加载后续消息"]')).toBeNull();
      expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual({
        id,
        loading: false,
        rows: ['1', '2'],
      });
      expect(f.reads).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      client.clear();
      host.remove();
    }
  },
);

it.each(['首屏校准', '向上空页', '向下空页'])('%s后停在边缘会自动续读', async (scenario) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const row = (seq: number, renderable = true): TestMessage => ({
    msgId: `paging-${seq}`,
    msgSeq: String(seq),
    sendTime: String(1794200000 + seq),
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: renderable ? [{ type: 'text', text: `消息 ${seq}` }] : [],
  });
  const firstSeq = PAGE_SIZE + 10;
  const entryPending = scenario === '首屏校准';
  const forward = scenario === '向下空页';
  const targetSeq = firstSeq - 1;
  const forwardCursors = [targetSeq, targetSeq + PAGE_SIZE, targetSeq + 2 * PAGE_SIZE] as const;
  const finalSeq = forward ? forwardCursors[2] + 1 : targetSeq - (entryPending ? 0 : PAGE_SIZE);
  const before = vi.fn((cursor: string) => {
    if (forward) return [row(targetSeq)];
    if (!entryPending && cursor === String(firstSeq))
      return Array.from({ length: PAGE_SIZE }, (_, index) => row(firstSeq - 1 - index, false));
    return [row(finalSeq)];
  });
  const after = vi.fn(async (cursor: string) => {
    const seq = Number(cursor);
    return seq === forwardCursors[2]
      ? [row(finalSeq)]
      : Array.from({ length: PAGE_SIZE }, (_, index) => row(seq + index + 1, seq === targetSeq));
  });
  f.beforeReply = before;
  if (forward) f.afterReply = after;
  const flushFrames = () => act(async () => vi.advanceTimersByTimeAsync(64));
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    const read = f.reads.at(-1)!;
    await act(async () =>
      read.show({
        complete: !entryPending,
        rows: Array.from({ length: GROUP_INITIAL_PAGE_SIZE }, (_, index) =>
          row(firstSeq + GROUP_INITIAL_PAGE_SIZE - 1 - index),
        ),
      }),
    );
    expect(f.messages).toHaveLength(GROUP_INITIAL_PAGE_SIZE);
    if (forward) {
      await act(async () => {
        void f.jump!({ seq: String(targetSeq), index: String(targetSeq) });
      });
      await flushFrames();
      expect(f.atLatest).toBe(false);
      expect(after.mock.calls.flat()).toEqual([String(targetSeq)]);
    }
    const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
    Object.defineProperties(scroll, {
      clientHeight: { value: 300 },
      clientWidth: { value: 600 },
      scrollHeight: { value: 1200 },
    });
    const rect = new DOMRect(0, 0, 600, 300);
    vi.spyOn(scroll, 'getClientRects').mockReturnValue(Object.assign([rect], { item: () => rect }));
    act(() => {
      scroll.scrollTop = forward ? 900 : 0;
      scroll.dispatchEvent(new Event('scroll'));
    });
    await flushFrames();
    if (entryPending) {
      expect(before).not.toHaveBeenCalled();
      await act(async () => read.show({ complete: true, rows: [], reuseLocal: true }));
    } else if (!forward) {
      expect(before.mock.calls[0]).toEqual([String(firstSeq)]);
    }
    await flushFrames();
    if (forward) {
      expect(after.mock.calls.flat()).toEqual(forwardCursors.map(String));
    } else {
      expect(before.mock.calls.flat()).toEqual(
        entryPending ? [String(firstSeq)] : [String(firstSeq), String(firstSeq - PAGE_SIZE)],
      );
    }
    expect(f.messages.map((message) => message.msgSeq)).toContain(String(finalSeq));
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([
  { summarySeq: '900', mismatch: 'none' },
  { summarySeq: '50', mismatch: 'none' },
  { summarySeq: '900', mismatch: 'uid' },
  { summarySeq: '900', mismatch: 'chatType' },
  { summarySeq: '900', mismatch: 'switched' },
])(
  '自动已读只用目标会话小表水位：摘要 $summarySeq，快照身份 $mismatch',
  async ({ summarySeq, mismatch }) => {
    if (mismatch === 'none') vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    f.unreadMode = true;
    const contact = f.recent.find((row) => row.targetUid === '10002')!;
    const originalSeq = contact.msgSeq;
    contact.msgSeq = summarySeq;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          h(
            QueryClientProvider,
            { client: queryClient },
            h(ContentSelectionProvider, null, h(MainView)),
          ),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === '10002')!
          .click(),
      );
      await act(async () =>
        f.reads.at(-1)!.show({
          complete: true,
          rows: [
            {
              msgId: 'target-message',
              msgSeq: '100',
              sendTime: '1794200000',
              senderUid: 'u_peer',
              senderUin: '20001',
              elements: [{ type: 'text', data: { textContent: '目标会话' } }],
            },
          ],
        }),
      );
      if (mismatch === 'none') await act(async () => vi.advanceTimersByTimeAsync(200));
      f.markedRead = [];
      const unreadReadsBefore = f.unreadReads.length;
      let release: (() => void) | undefined;
      if (mismatch === 'switched')
        f.unreadReply = () =>
          new Promise((resolve) => {
            release = () =>
              resolve([{ chatType: 2, uid: '10002', latestSeq: '100', unreadCount: 0 }]);
          });
      else if (mismatch !== 'none')
        f.unreadReply = async () => [
          {
            chatType: mismatch === 'chatType' ? 1 : 2,
            uid: mismatch === 'uid' ? '10001' : '10002',
            latestSeq: '100',
            unreadCount: 0,
          },
        ];
      await act(async () => f.readCurrent?.());
      if (mismatch === 'switched') {
        expect(release).toBeTypeOf('function');
        await act(async () =>
          [...host.querySelectorAll<HTMLButtonElement>('nav button')]
            .find((button) => button.textContent === '10001')!
            .click(),
        );
        await act(async () => release!());
      }
      if (mismatch === 'none') {
        expect(f.markedRead).toHaveLength(1);
        expect(f.markedRead[0]).toMatchObject({ chatType: 2, uid: '10002', latestSeq: '100' });
        await act(async () => vi.advanceTimersByTimeAsync(200));
        const reads = f.unreadReads.slice(unreadReadsBefore);
        expect(reads.length).toBeGreaterThan(0);
        for (const { targets } of reads) expect(targets).toEqual([{ chatType: 2, uid: '10002' }]);
      } else expect(f.markedRead).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
      host.remove();
      contact.msgSeq = originalSeq;
    }
  },
);

it('首次会话未读读取失败后，收到该会话的有效快照会补交自动已读', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    f.unreadFailures = 1;
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    await act(async () =>
      f.reads.at(-1)!.show({
        complete: true,
        rows: [
          {
            msgId: 'target-message',
            msgSeq: '100',
            sendTime: '1794200000',
            senderUid: 'u_peer',
            senderUin: '20001',
            elements: [{ type: 'text', data: { textContent: '已显示的消息' } }],
          },
        ],
      }),
    );
    expect(host.querySelector('[data-message-id="target-message"]')).not.toBeNull();
    expect(f.markedRead).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(f.markedRead).toEqual([
      expect.objectContaining({ chatType: 2, uid: '10001', latestSeq: '100' }),
    ]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([false, true])('首批消息立即显示未读分界线，进入会话后的快照延迟=%s', async (delayed) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  f.unreadCounts = { '10001': 5 };
  let finishRead: (() => void) | undefined;
  f.markReadReply = () =>
    new Promise((resolve) => {
      finishRead = resolve;
    });
  const rows = [105, 104, 103, 102, 101, 100].map(
    (seq): TestMessage => ({
      msgId: String(seq),
      msgSeq: String(seq),
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', data: { textContent: `消息 ${seq}` } }],
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const markedId = () =>
    host
      .querySelector('[aria-label="以下为未读消息"]')
      ?.nextElementSibling?.getAttribute('data-message-id');
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    const snapshot = {
      uid: '10001',
      chatType: 2,
      readSeq: '100',
      latestSeq: '105',
      unreadCount: 5,
    };
    if (delayed) {
      f.unreadReply = async () => [snapshot];
      await act(async () => vi.advanceTimersByTimeAsync(100));
      f.unreadReply = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ ...snapshot, readSeq: '101', unreadCount: 4 }]), 500);
        });
    } else {
      f.unreadReply = async () => [snapshot];
    }
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    const page = f.reads.at(-1)!;
    await act(async () => page.show({ complete: false, rows }));
    expect(markedId()).toBe('101');
    expect(f.markedRead).toEqual([]);

    await act(async () => page.show({ complete: true, rows }));
    if (delayed) {
      await act(async () => vi.advanceTimersByTimeAsync(499));
      expect(markedId()).toBe('101');
      expect(f.markedRead).toEqual([]);
      await act(async () => vi.advanceTimersByTimeAsync(1));
    }
    expect(f.markedRead).toEqual([expect.objectContaining({ uid: '10001', latestSeq: '105' })]);
    expect(markedId()).toBe(delayed ? '102' : '101');
  } finally {
    await act(async () => {
      root.unmount();
      finishRead?.();
    });
    client.clear();
    host.remove();
  }
});

it.each([false, true])('切回会话保留未完成的跳转，按类别仅显示一次=%s', async (entryOnly) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  const epoch = `fixture-jump-${entryOnly}`;
  acceptPreferences({
    revision: 1,
    epoch,
    values: { firstUnreadJumpMode: entryOnly ? 'entry' : 'keep' },
    records: {},
  });
  const important = { kind: 'atMe', rawKind: 1, msgSeq: '104', senderUid: 'u_peer' };
  const original = {
    uid: '10001',
    chatType: 2,
    readSeq: '100',
    latestSeq: '105',
    unreadCount: 5,
    highlights: [important],
  };
  const read = { ...original, readSeq: '105', unreadCount: 0, highlights: [] };
  const rows = [106, 105, 104, 103, 102, 101, 100].map(
    (seq): TestMessage => ({
      msgId: String(seq),
      msgSeq: String(seq),
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', data: { textContent: `消息 ${seq}` } }],
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const select = (id: string) =>
    act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === id)!
        .click(),
    );
  const load = () => act(async () => f.reads.at(-1)!.show({ complete: true, rows }));
  const targets = () =>
    Array.from(host.querySelectorAll('.weq-important-dock > button:first-child'), (button) =>
      button.getAttribute('title'),
    );
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    f.unreadReply = async () => [original];
    await select('10001');
    await load();
    expect(targets()).toEqual(['跳到首条未读', '下一条：有人@我']);
    expect(f.markedRead).toContainEqual(
      expect.objectContaining({ uid: '10001', latestSeq: '105' }),
    );

    await select('10002');
    f.unreadReply = async () => [read];
    await select('10001');
    await load();
    expect(targets()).toEqual(
      entryOnly ? ['下一条：有人@我'] : ['跳到首条未读', '下一条：有人@我'],
    );
    const marked = f.markedRead.length;
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${entryOnly ? '收起跳转提示' : '收起重要消息跳转'}"]`,
        )!
        .click(),
    );
    expect(targets()).toEqual(entryOnly ? [] : ['跳到首条未读']);
    if (!entryOnly)
      await act(async () =>
        host.querySelector<HTMLButtonElement>('button[aria-label="收起跳转提示"]')!.click(),
      );
    expect(targets()).toEqual([]);
    expect(f.markedRead).toHaveLength(marked);

    await select('10002');
    f.unreadReply = async () => [original];
    await select('10001');
    await load();
    expect(targets()).toEqual([]);

    await select('10002');
    f.unreadReply = async () => [{ ...original, latestSeq: '106', unreadCount: 6 }];
    await select('10001');
    await load();
    expect(targets()).toEqual(['跳到首条未读']);
  } finally {
    act(() => root.unmount());
    acceptPreferences({ revision: 2, epoch, values: {}, records: {} });
    client.clear();
    host.remove();
  }
});

it.each([false, true])('当前会话收到新消息时不新增分界线：续读模式=%s', async (resume) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.readFromFirstUnread = resume;
  f.unreadMode = true;
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const message = (seq: string): TestMessage => ({
    msgId: seq,
    msgSeq: seq,
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: `消息 ${seq}` } }],
  });
  const snapshot = (latestSeq: string, unreadCount: number, readSeq = '100') => [
    { uid: '10001', chatType: 2, readSeq, latestSeq, unreadCount },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const divider = () => host.querySelector('[aria-label="以下为未读消息"]');
  const select = (id: string) =>
    act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === id)!
        .click(),
    );
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    f.unreadReply = async () => snapshot('100', 0);
    await select('10001');
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [message('100')] }));
    expect(divider()).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(200));
    f.unreadReply = async () => snapshot('101', 1);
    f.refreshRows = [message('101'), message('100')];
    await act(async () => {
      f.dbChanged!({ at: Date.now(), targets: [{ kind: 'group', conv: '10001' }] });
      f.unreadChanged!([{ chatType: 2, uid: '10001' }]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.querySelector('[data-message-id="101"]')).not.toBeNull();
    expect(divider()).toBeNull();

    await select('10002');
    f.unreadReply = async () => snapshot('101', 1);
    await select('10001');
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: f.refreshRows! }));
    expect(divider()?.nextElementSibling?.getAttribute('data-message-id')).toBe('101');

    if (resume) {
      f.unreadReply = async () => snapshot('102', 1, '101');
      f.refreshRows = [message('102'), ...f.refreshRows!];
      await act(async () => {
        f.dbChanged!({ at: Date.now(), targets: [{ kind: 'group', conv: '10001' }] });
        f.unreadChanged!([{ chatType: 2, uid: '10001' }]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(host.querySelector('[data-message-id="102"]')).not.toBeNull();
      expect(divider()).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it('续读模式在消息滑出上沿或触底时提交已读，并保留跳过的序号', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  useViewState.getState().setOpenedUin('90001');
  f.readFromFirstUnread = true;
  f.unreadMode = true;
  f.unreadCounts = { '10001': 5 };
  f.unreadReply = async () => [
    { uid: '10001', chatType: 2, readSeq: '100', latestSeq: '105', unreadCount: 5 },
  ];
  const message = (seq: number): TestMessage => ({
    msgId: String(seq),
    msgSeq: String(seq),
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: `消息 ${seq}` } }],
  });
  let offset = 0;
  const realBounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('message-scroll')) {
      Object.defineProperties(this, {
        clientHeight: { value: 100, configurable: true },
        scrollHeight: { value: 300, configurable: true },
      });
      return new DOMRect(0, 0, 400, 100);
    }
    if (this.classList.contains('message-line'))
      return new DOMRect(0, (Number(this.dataset.messageId) - 101) * 50 - offset, 400, 50);
    return realBounds.call(this);
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    await act(async () =>
      f.reads.at(-1)!.show({ complete: true, rows: [105, 104, 103, 102, 101, 100].map(message) }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(32));
    expect(f.markedRead).toEqual([]);
    expect(
      host
        .querySelector('[aria-label="以下为未读消息"]')
        ?.nextElementSibling?.getAttribute('data-message-id'),
    ).toBe('101');
    expect(f.unreadReads.filter(({ targets }) => targets.length === 1)).toHaveLength(1);

    const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
    hasFocus.mockReturnValue(true);
    await act(async () => {
      offset = scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(32);
    });
    await act(async () => {
      scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
      offset = scroll.scrollTop = 100;
      scroll.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(f.markedRead.map(({ visibleSeqs }) => visibleSeqs)).toEqual([['101', '102']]);

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2000);
    await act(async () => {
      offset = scroll.scrollTop = 200;
      scroll.dispatchEvent(new Event('scroll'));
      f.readCurrent?.();
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(f.markedRead.map(({ visibleSeqs }) => visibleSeqs)).toEqual([
      ['101', '102'],
      ['101', '102', '105'],
    ]);
    expect(f.recentInvalidations).toBe(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([
  ['10001', false],
  ['u_peer', false],
  ['10001', true],
  ['u_peer', true],
] as const)('会话 %s 无阅读位置时保持最新页且不显示后续加载：续读模式=%s', async (id, resume) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.readFromFirstUnread = resume;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const select = (target: string) =>
    act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === target)!
        .click(),
    );
  const message = (seq: string): TestMessage => ({
    msgId: seq,
    msgSeq: seq,
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', text: `消息 ${seq}` }],
  });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await select(id);
    const read = f.reads.at(-1)!;
    await act(async () => read.show({ complete: false, rows: [message('1')] }));
    // 本地最新页已经可读，后台合并迟迟未完成也不应冒充向下分页。
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(host.querySelector('[data-message-id="1"]')).not.toBeNull();
    expect(f.atLatest).toBe(true);
    expect(host.querySelector('[aria-label="正在加载后续消息"]')).toBeNull();
    await act(async () => read.show({ complete: true, rows: [message('1')] }));
    await select('10002');
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    const readAfter = vi.fn(() => []);
    f.afterReply = readAfter;
    await select(id);
    expect(host.querySelector('[data-message-id="1"]')).not.toBeNull();
    expect(readAfter).not.toHaveBeenCalled();
    expect(f.atLatest).toBe(true);
    expect(host.querySelector('[aria-label="正在加载后续消息"]')).toBeNull();
    await act(async () =>
      f.reads.at(-1)!.show({ complete: true, rows: [message('2'), message('1')] }),
    );
    expect(host.querySelector('[aria-label="正在加载后续消息"]')).toBeNull();
    expect(host.querySelector('[data-message-id="2"]')).not.toBeNull();
    expect(f.atLatest).toBe(true);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([false, true])('保留非底部阅读位置并在读到底后清除：自动续读=%s', async (resume) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.readFromFirstUnread = resume;
  const rows = [106, 105, 104, 103, 102, 101].map(
    (seq): TestMessage => ({
      msgId: String(seq),
      msgSeq: String(seq),
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', text: `消息 ${seq}` }],
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scroll = () => host.querySelector<HTMLElement>('.message-scroll')!;
  const jumpButton = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '跳到上次阅读位置',
    );
  const select = (id: string) =>
    act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('nav button'))
        .find((button) => button.textContent === id)!
        .click();
    });
  const position = (top: number) =>
    act(async () => {
      const element = scroll();
      element.getBoundingClientRect();
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
    });
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('message-scroll')) {
      Object.defineProperties(this, {
        clientHeight: { value: 100, configurable: true },
        scrollHeight: { value: 300, configurable: true },
      });
      return new DOMRect(0, 0, 400, 100);
    }
    if (this.classList.contains('message-line'))
      return new DOMRect(
        0,
        (Number(this.dataset.messageId) - 101) * 50 - (scroll()?.scrollTop ?? 0),
        400,
        50,
      );
    return bounds.call(this);
  });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await select('10001');
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows }));
    expect(jumpButton()).toBeUndefined();
    await position(75);
    await select('10002');
    await select('10001');
    if (resume) {
      expect(jumpButton()).toBeUndefined();
    } else {
      expect(jumpButton()).toBeDefined();
      await position(200);
      await select('10002');
      await select('10001');
      expect(jumpButton()).toBeDefined();
      await act(async () => jumpButton()!.click());
      expect(jumpButton()).toBeUndefined();
    }
    expect(scroll().scrollTop).toBe(75);
    await position(200);
    await select('10002');
    await select('10001');
    expect(jumpButton()).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(32));
    expect(scroll().scrollTop).not.toBe(75);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it('等值删除标记迟到不重复贴底，真实标记增删和正文更新仍即时出现', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const message = (body: string): TestMessage => ({
    msgId: '71',
    msgSeq: '1',
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: body } }],
  });
  const update = async (body: string) => {
    f.refreshRows = [message(body)];
    await act(async () => {
      f.dbChanged!();
      await vi.advanceTimersByTimeAsync(1100);
    });
  };
  let finishDeleted: ((ids: string[]) => void) | undefined;
  let finishHidden: ((ids: string[]) => void) | undefined;
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll('nav button')]
        .find((button) => button.textContent === '10001')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [message('初始正文')] }));
    expect(host.querySelector('[data-message-id="71"]')).not.toBeNull();
    const before = f.deletionSets;
    f.deletedReply = () =>
      new Promise((resolve) => {
        finishDeleted = resolve;
      });
    f.hiddenDeletionReply = () =>
      new Promise((resolve) => {
        finishHidden = resolve;
      });
    await update('已更新正文');
    await act(async () => vi.advanceTimersByTimeAsync(32));
    expect(f.messages[0]?.body).toBe('已更新正文');
    expect(host.querySelector('[data-message-id="71"]')?.textContent).toContain('已更新正文');
    const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
    const bottom = vi.spyOn(timelineViewport(scroll)!, 'bottom');
    await act(async () => {
      finishDeleted!([]);
      finishHidden!([]);
    });
    expect(bottom).not.toHaveBeenCalled();
    expect(f.deletionSets.deleted).toBe(before.deleted);
    expect(f.deletionSets.hidden).toBe(before.hidden);
    f.deletedReply = undefined;
    f.hiddenDeletionReply = undefined;
    f.deletedResponse = ['71', '71'];
    f.hiddenDeletionResponse = ['71'];
    await update('隐藏前的正文');
    expect([...f.deletionSets.deleted!]).toEqual(['71']);
    expect([...f.deletionSets.hidden!]).toEqual(['71']);
    expect(host.querySelector('[data-message-id="71"]')).toBeNull();
    const marked = f.deletionSets;
    await update('标记未变的正文');
    expect(f.deletionSets.deleted).toBe(marked.deleted);
    expect(f.deletionSets.hidden).toBe(marked.hidden);
    f.deletedResponse = [];
    f.hiddenDeletionResponse = [];
    await update('清除标记后的正文');
    expect(f.deletionSets.deleted?.size).toBe(0);
    expect(f.deletionSets.hidden?.size).toBe(0);
    expect(host.querySelector('[data-message-id="71"]')?.textContent).toContain('清除标记后的正文');
  } finally {
    act(() => root.unmount());
    finishDeleted?.([]);
    finishHidden?.([]);
    client.clear();
    host.remove();
  }
});

it('全局搜索优先留在当前会话视图，跨视图连续查看后返回出发位置', async () => {
  await SearchResultsPanel.preload();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.groups = [
    {
      groupCode: '10001',
      groupName: '合成折叠群',
      remark: '',
      memberCount: 2,
      maxMemberCount: 500,
      customLabels: [],
      directory: { memberCount: 2, role: 'member', notifyLevel: 2 },
    },
  ];
  f.searchGroups = (
    [
      { groupCode: '10001', name: '合成折叠群', conversationView: 'groupAssistant' },
      { groupCode: '10002', name: '合成普通群', conversationView: 'regular' },
    ] as const
  ).map(
    (row): GroupSearchHit => ({
      ...row,
      category: 'group',
      remark: '',
      inDirectory: true,
      hasConversation: true,
      aliases: [],
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const click = (selector: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  const search = async (name: string) => {
    await click('[data-workspace-search]');
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-search-category="group"]'),
    ].find((button) => button.textContent?.includes(name));
    expect(row, name).toBeDefined();
    await act(async () => row!.click());
  };
  const viewButton = () => host.querySelector<HTMLButtonElement>('[aria-label="会话视图"]');
  const switchView = async (label: string) => {
    await click('[aria-label="会话视图"]');
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find((button) => button.textContent === label)!
        .click(),
    );
  };
  const scroll = () => host.querySelector<HTMLElement>('[data-weq-windowed-list]')!;
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await click('[data-messages]');
    await click('[data-conversation-id="u_peer"]');
    await act(async () => {
      scroll().scrollTop = 42;
      scroll().dispatchEvent(new Event('scroll'));
    });
    await search('合成折叠群');
    expect(host.querySelector('[data-conversation-id="10001"]')).not.toBeNull();
    expect(viewButton()).toBeNull();
    await search('合成普通群');
    expect(viewButton()?.title).toBe('会话视图：常规视图');
    await search('合成折叠群');
    await click('[aria-label="返回常规视图"]');
    expect(viewButton()?.title).toBe('会话视图：常规视图');
    expect(scroll().scrollTop).toBe(42);
    expect(f.reads.at(-1)?.conv).toBe('u_peer');

    await switchView('克隆会话');
    await search('合成折叠群');
    const back = '[aria-label="返回克隆会话"]';
    expect(host.querySelector<HTMLButtonElement>(back)?.title).toBe('返回克隆会话');
    await search('合成普通群');
    await click(back);
    expect(viewButton()?.title).toBe('会话视图：克隆会话');

    await switchView('全部会话');
    await search('合成折叠群');
    expect(viewButton()?.title).toBe('会话视图：全部会话');
    expect(host.querySelector('[data-conversation-id="10001"].is-locate-target')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it('返回消息页不重放上一次未读定位，下次点击继续定位下一项', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  f.unreadCounts = { '10001': 3, '10002': 2 };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const click = (id: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(`[data-${id}]`)!.click());
  const locateTarget = () =>
    host.querySelector('[data-list-locate]')?.getAttribute('data-list-locate');
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await click('messages');
    await act(async () => vi.advanceTimersByTimeAsync(200));
    const badge = () =>
      host.querySelector('[data-message-badge-count]')?.getAttribute('data-message-badge-count');
    expect(badge()).toBe('5');
    f.showMessageUnreadBadge = false;
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    expect(badge()).toBe('0');
    f.showMessageUnreadBadge = true;
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await click('locate-unread');
    const first = locateTarget();
    expect(['10001', '10002']).toContain(first);
    await click('contacts');
    await click('messages');
    expect(locateTarget()).toBe('');
    await click('locate-unread');
    expect(locateTarget()).toBe(first === '10001' ? '10002' : '10001');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([0, 3])('有 %i 条未读时，消息入口在分类、常规和全部会话中的行为', async (count) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  f.unreadCounts = { '10001': count };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const click = (selector: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  const view = () => host.querySelector('[data-list-view]')?.getAttribute('data-list-view');
  const locate = () => host.querySelector('[data-list-locate]')?.getAttribute('data-list-locate');
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await click('[data-messages]');
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await click('[data-list-switch="hidden"]');
    expect(view()).toBe('hidden');
    await click('[data-locate-unread]');
    expect(view()).toBe('regular');
    expect(locate()).toBe('');
    await click('[data-locate-unread]');
    expect(view()).toBe('regular');
    expect(locate()).toBe(count ? '10001' : '');

    await click('[data-list-switch="all"]');
    expect(view()).toBe('all');
    if (count) {
      f.unreadCounts = { '10001': 0, '10002': 2 };
      await act(async () => {
        f.unreadChanged!([
          { chatType: 2, uid: '10001' },
          { chatType: 2, uid: '10002' },
        ]);
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    await click('[data-locate-unread]');
    expect(view()).toBe('all');
    expect(locate()).toBe(count ? '10002' : '');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each(['success', 'failed', 'pending'] as const)(
  'MainView 首次读取=%s 时实时未读仍立即回显，迟到快照及清零只更新对应会话',
  async (firstRead) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    f.unreadMode = true;
    f.unreadFailures = firstRead === 'failed' ? 1 : 0;
    let finishSnapshot: (() => void) | undefined;
    if (firstRead === 'pending')
      f.unreadReply = () =>
        new Promise((resolve) => {
          finishSnapshot = () =>
            resolve(f.recent.map((row) => ({ uid: row.targetUid, unreadCount: 0 })));
        });
    const projectOrder = vi.spyOn(conversationRows, 'updateConversationOrder');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const projected = () => projectOrder.mock.results.at(-1)?.value.rows;
    const count = () =>
      (
        JSON.parse(host.querySelector('[data-previews]')!.textContent!) as Array<{
          id: string;
          unreadCount?: number;
        }>
      ).find((row) => row.id === '10001')?.unreadCount;
    try {
      await act(async () =>
        root.render(
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await act(async () => vi.advanceTimersByTimeAsync(200));
      const before = new Map(projected()!.map((row) => [row.id, row]));
      expect(before.size).toBe(f.recent.length);
      projectOrder.mockClear();
      f.unreadCounts['10001'] = 9;
      await act(async () => {
        f.unreadChanged!([{ chatType: 2, uid: '10001' }]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(count()).toBe(9);
      const after = projected()!;
      expect(after.filter((row) => row !== before.get(row.id)).map((row) => row.id)).toEqual([
        '10001',
      ]);
      if (finishSnapshot) {
        await act(async () => {
          finishSnapshot!();
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(count()).toBe(9);
      }
      const byId = new Map(after.map((row) => [row.id, row]));
      projectOrder.mockClear();
      f.unreadCounts['10001'] = 0;
      await act(async () => {
        f.unreadChanged!([{ chatType: 2, uid: '10001' }]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(count()).toBe(0);
      expect(
        projected()!
          .filter((row) => row !== byId.get(row.id))
          .map((row) => row.id),
      ).toEqual(['10001']);
    } finally {
      act(() => root.unmount());
      finishSnapshot?.();
      client.clear();
      host.remove();
    }
  },
);

it('MainView 单行预览更新时只计算该会话的排序时间', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const originalLength = f.recent.length;
  for (let index = 0; index < 197; index++) {
    f.recent.push({
      ...f.recent[0]!,
      targetUid: String(30000 + index),
      sendTime: String(1794200000 + ((index * 137) % 197)),
    });
  }
  const time = vi.spyOn(conversationOrder, 'conversationActivityTime');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    time.mockClear();
    f.freshPreview = true;
    f.previewTarget = '10001';
    await act(async () => {
      f.dbChanged!();
      await vi.advanceTimersByTimeAsync(1100);
    });
    const rows = JSON.parse(host.querySelector('[data-previews]')!.textContent!) as Array<{
      id: string;
      lastMessage?: { body: string };
    }>;
    expect(rows.find((row) => row.id === '10001')?.lastMessage?.body).toBe('最新消息');
    expect(time).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
    f.recent.splice(originalLength);
  }
});

it('单个会话预览更新不重复转换未变群资料，真实群资料变化仍即时更新', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  let detailReads = 0;
  f.groups = ['10001', '10002'].map((groupCode) => ({
    groupCode,
    groupName: `合成群 ${groupCode}`,
    remark: '',
    memberCount: 2,
    maxMemberCount: 500,
    get customLabels() {
      if (groupCode === '10002') detailReads++;
      return [];
    },
    directory: { memberCount: 2, role: 'member' as const, notifyLevel: 1 },
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = () =>
    act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
  const sidebar = () =>
    JSON.parse(host.querySelector('[data-previews]')!.textContent!) as Array<{
      id: string;
      group?: { name: string };
      lastMessage?: { body: string };
    }>;
  try {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    expect(detailReads).toBeGreaterThan(0);
    detailReads = 0;
    f.freshPreview = true;
    f.previewTarget = '10001';
    await act(async () => {
      f.dbChanged!();
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(sidebar().find((row) => row.id === '10001')?.lastMessage?.body).toBe('最新消息');
    expect(detailReads).toBe(0);
    f.groups = f.groups.map((group) =>
      group.groupCode === '10002' ? { ...group, groupName: '已更新的本地群名' } : group,
    );
    await render();
    expect(sidebar().find((row) => row.id === '10002')?.group?.name).toBe('已更新的本地群名');
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([
  ['10001', 'group'],
  ['u_peer', 'c2c'],
] as const)('会话 %s 的预览复用整页转换与引用索引，翻页和本地名称仍即时更新', async (id, kind) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.profiles = [{ uid: 'u_peer', uin: '20001', nick: '本地昵称', remark: '本地备注' }];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = () =>
    act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
  const message = (seq: number): TestMessage => ({
    msgId: String(seq),
    msgSeq: String(seq),
    clientSeq: String(seq + 100),
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: `预览正文 ${seq}` } }],
  });
  const initial = Array.from({ length: 50 }, (_, index) => message(index + 2));
  initial.at(-1)!.elements.unshift({
    type: 'reply',
    data: {
      ...(kind === 'group' ? { origMsgSeq: '1' } : { origClientSeq: '101' }),
      origSenderUin: '20001',
      origElements: [],
    },
  });
  f.refreshRows = [...initial].reverse();
  const quotes = vi.spyOn(replyPreview, 'findReplyPreview');
  const quotedElements = () =>
    (
      f.previewMessages.find((row) => row.msgId === '51')?.qqElements?.[0] as
        | {
            data: { origElements: unknown[] };
          }
        | undefined
    )?.data.origElements;
  try {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === id)!
        .click(),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-preview]')!.click());
    expect(f.previewMessages).toHaveLength(initial.length);
    const first = f.previewMessages;
    expect(quotedElements()).toEqual([]);
    expect(quotes).toHaveBeenCalled();
    expect(quotes.mock.calls.every((call) => !Array.isArray(call[2]))).toBe(true);
    quotes.mockClear();
    await render();
    expect(f.previewMessages).toBe(first);
    expect(quotes).not.toHaveBeenCalled();

    const original = message(1);
    f.beforeRows = [original];
    await act(async () => f.previewMore!());
    expect(f.previewMessages).toHaveLength(initial.length + 1);
    expect(quotedElements()).toEqual(original.elements);
    expect(f.previewMessages).not.toBe(first);
    const expanded = f.previewMessages;
    await render();
    expect(f.previewMessages).toBe(expanded);
    f.profiles = f.profiles.map((profile) => ({ ...profile, remark: '修改后的本地备注' }));
    await render();
    expect(f.previewMessages[0]?.sender?.displayName).toBe('修改后的本地备注');
    expect(quotedElements()).toEqual(original.elements);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it('群资料批次更新只替换实际变化的消息发送者，不重建其他正文与消息对象', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.profiles = [
    { uid: 'u_alice', uin: '20001', nick: '甲昵称', remark: '甲备注' },
    { uid: 'u_bob', uin: '20002', nick: '乙昵称', remark: '乙备注' },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = () =>
    act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
  const row = (msgId: string) => f.messages.find((item) => item.msgId === msgId)!;
  try {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    await act(async () =>
      f.reads.at(-1)!.show({
        complete: true,
        rows: [
          ...f.profiles.map((profile, index) => ({
            msgId: profile.uid,
            msgSeq: String(index + 1),
            senderUid: profile.uid,
            senderUin: profile.uin,
            sendTime: '1794200000',
            elements: [{ type: 'text', data: { textContent: `正文 ${profile.uid}` } }],
            ...(index === 1
              ? { recall: { revokeUid: 'u_alice', sameSender: false, recallTs: 1794200010 } }
              : {}),
          })),
          {
            msgId: 'reply',
            msgSeq: '3',
            senderUid: 'u_bob',
            senderUin: '20002',
            sendTime: '1794200000',
            elements: [
              {
                type: 'reply',
                data: {
                  origSenderUid: 'u_alice',
                  origSenderUin: '20001',
                  origElements: [{ type: 'text', data: { textContent: '内嵌引用' } }],
                },
              },
            ],
          },
        ],
      }),
    );
    const alice = row('u_alice'),
      bob = row('u_bob');
    expect(alice.sender?.displayName).toBe('甲备注');
    f.profiles = [
      ...f.profiles,
      { uid: 'u_unrelated', uin: '20003', nick: '无关昵称', remark: '' },
    ];
    await render();
    expect(row('u_alice')).toBe(alice);
    expect(row('u_bob')).toBe(bob);
    f.profiles = f.profiles.map((profile) =>
      profile.uid === 'u_alice' ? { ...profile, remark: '新备注' } : profile,
    );
    await render();
    expect(row('u_alice')).not.toBe(alice);
    expect(row('u_alice').sender?.displayName).toBe('新备注');
    expect(row('u_alice').qqElements).toBe(alice.qqElements);
    expect(row('u_alice').body).toBe(alice.body);
    expect(row('u_bob')).toBe(bob);
    const renamed = row('u_alice');
    f.bots = ['u_bob'];
    await render();
    expect(row('u_alice')).toBe(renamed);
    expect(row('u_bob')).not.toBe(bob);
    expect(row('u_bob').sender?.kind).toBe('bot');
    f.bots = [];
    f.profiles = f.profiles.filter((profile) => profile.uid !== 'u_alice');
    await render();
    expect(row('u_alice').sender?.displayName).toBe('20001');
    expect(row('u_bob').sender?.kind).toBe('human');
    const updateMember = (card: string) =>
      act(async () => {
        f.memberDetails = {
          uid: 'u_alice',
          uin: '20001',
          card,
          nick: '',
          adminFlag: 0,
          joinTime: '1',
        };
        await publishQQPeerUpdate({
          binding: { expectedAccountUin: '90001', expectedAccountConfigId: 'switch-test' },
          target: { kind: 'member', groupCode: '10001', uid: 'u_alice' },
        });
      });
    const quotedName = () =>
      (row('reply').qqElements?.[0] as { data: { origSenderDisplayName?: string } } | undefined)
        ?.data.origSenderDisplayName;
    await updateMember('群名片');
    expect(row('u_alice').sender?.displayName).toBe('群名片');
    expect(row('u_bob').recallRevokerName).toBe('群名片');
    expect(quotedName()).toBe('群名片');
    await updateMember('');
    expect(row('u_alice').sender?.displayName).toBe('20001');
    expect(row('u_bob').recallRevokerName).toBe('20001');
    expect(quotedName()).toBe('20001');
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([
  ['10001', 'group'],
  ['u_peer', 'c2c'],
] as const)('会话 %s 的引用只在原文变化时替换对象，迟到原文与重号仍正确更新', async (id, kind) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const message = (msgId: string, msgSeq: string, text: string): TestMessage => ({
    msgId,
    msgSeq,
    senderUid: 'u_peer',
    senderUin: '20001',
    sendTime: '1794200000',
    elements: [{ type: 'text', data: { textContent: text } }],
  });
  const boundary = message('boundary', '1', '窗口起点');
  const original = { ...message('original', '2', '原文'), clientSeq: '7' };
  const replyData = {
    ...(kind === 'group' ? { origMsgSeq: '2' } : { origClientSeq: '7' }),
    origSenderUin: '20001',
    origMsgTime: '1794200000',
    origElements: [],
  };
  const reply = message('reply', '3', '引用回复');
  reply.elements.unshift({ type: 'reply', data: replyData });
  const embedded = message('embedded', '4', '自带摘要');
  embedded.elements.unshift({
    type: 'reply',
    data: { ...replyData, origElements: [{ type: 'text', data: { textContent: '内嵌原文' } }] },
  });
  const row = (msgId: string) => f.messages.find((item) => item.msgId === msgId)!;
  const quote = () =>
    (
      row('reply').qqElements!.find((item) => (item as { type: string }).type === 'reply') as {
        data: { origElements?: unknown[] };
      }
    ).data.origElements;
  const update = (messages: TestMessage[]) =>
    act(async () => {
      f.refreshRows = [...messages].sort((a, b) => Number(b.msgSeq) - Number(a.msgSeq));
      f.dbChanged!();
      await vi.advanceTimersByTimeAsync(1100);
    });
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === id)!
        .click(),
    );
    await act(async () =>
      f.reads.at(-1)!.show({ complete: true, rows: [embedded, reply, boundary] }),
    );
    const pending = row('reply');
    const independent = row('embedded');
    expect(quote()).toEqual([]);
    const unrelated = message('unrelated', '5', '无关追加');
    const rest = [boundary, reply, embedded, unrelated];
    await update(rest);
    expect(row('reply')).toBe(pending);
    expect(row('embedded')).toBe(independent);
    await update([...rest, original]);
    expect(quote()).toEqual(original.elements);
    expect(row('reply')).not.toBe(pending);
    expect(row('embedded')).toBe(independent);
    const resolved = row('reply');
    await update([
      ...rest,
      { ...original, elements: [{ type: 'text', data: { textContent: '原文' } }] },
    ]);
    expect(row('reply')).toBe(resolved);
    const edited = {
      ...original,
      elements: [{ type: 'text', data: { textContent: '原文已编辑' } }],
    };
    await update([...rest, edited]);
    expect(quote()).toEqual(edited.elements);
    expect(row('reply')).not.toBe(resolved);
    expect(row('embedded')).toBe(independent);
    await update(rest);
    expect(quote()).toEqual([]);
    await update([...rest, edited]);
    expect(quote()).toEqual(edited.elements);
    await update([...rest, edited, { ...edited, msgId: 'duplicate' }]);
    expect(quote()).toEqual([]);
    expect(row('embedded')).toBe(independent);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each(['10001', 'u_peer'])(
  '没有库通知时，会话 %s 的新正文也会校准列表预览和时间，追上后不重复刷新',
  async (id) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
    const preview = () =>
      JSON.parse(host.querySelector('[data-previews]')!.textContent!).find(
        (row: { id: string }) => row.id === id,
      );
    try {
      await act(async () =>
        root.render(
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      // 当前目录读取由 useRecentContactQueries 共用首屏，消息页启用最近页。
      expect(f.headEnabled).toBe(true);
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === id)!
          .click(),
      );
      expect(preview().lastMessage.body).toBe('旧预览');
      f.freshPreview = true;
      await act(async () =>
        f.reads.at(-1)!.show({
          complete: true,
          rows: [
            {
              msgId: '2',
              msgSeq: '2',
              sendTime: '1794200060',
              senderUid: 'u_peer',
              senderUin: '20001',
              elements: [{ type: 'text', text: '最新消息' }],
            },
          ],
        }),
      );
      await advance(200);
      expect(f.headRefreshes).toBe(1);
      expect(preview().lastMessage.body).toBe('最新消息');
      expect(Date.parse(preview().updatedAt)).toBe(1794200060000);
      await advance(5000);
      expect(f.headRefreshes).toBe(1);
    } finally {
      act(() => root.unmount());
      client.clear();
      host.remove();
    }
  },
);

it.each([
  ['10001', undefined],
  ['u_peer', undefined],
  ['10001', 'roaming'],
  ['u_peer', 'roaming'],
] as const)(
  '会话 %s 的最近会话表持续落后时，%s 正文直接更新预览，刷新和切换会话不回退',
  async (id, source) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const preview = () =>
      JSON.parse(host.querySelector('[data-previews]')!.textContent!).find(
        (row: { id: string }) => row.id === id,
      );
    const select = (target: string) =>
      act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === target)!
          .click(),
      );
    try {
      await act(async () =>
        root.render(
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await select(id);
      await act(async () =>
        f.reads.at(-1)!.show({
          complete: true,
          rows: [
            {
              msgId: '2',
              msgSeq: '2',
              sendTime: '1794200060',
              senderUid: 'u_latest',
              source,
              ntSeqVerified: source === 'roaming',
              senderUin: '20002',
              elements: [{ type: 'text', data: { textContent: '正文里的最新消息' } }],
            },
          ],
        }),
      );
      expect(preview().lastMessage.body).toBe('正文里的最新消息');
      expect(preview().lastMessage.senderId).toBe('u_latest');
      expect(Date.parse(preview().updatedAt)).toBe(1794200060000);
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(f.headRefreshes).toBe(source === 'roaming' ? 0 : 1);
      expect(preview().lastMessage.body).toBe('正文里的最新消息');
      await select('10002');
      await act(async () => f.dbChanged?.());
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(preview().lastMessage.body).toBe('正文里的最新消息');
    } finally {
      act(() => root.unmount());
      client.clear();
      host.remove();
    }
  },
);

it('未确认 NT 序号的私聊漫游仅更新预览，不混入正文时间线', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const native: TestMessage = {
    msgId: 'native',
    msgSeq: '1',
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: '本地正文' } }],
  };
  f.gapRows = [
    {
      ...native,
      msgId: 'remote',
      msgSeq: '99999',
      sendTime: '1794200060',
      ntSeqVerified: false,
      elements: [{ type: 'text', data: { textContent: '漫游最新正文' } }],
    },
  ];
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === 'u_peer')!
        .click(),
    );
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [native] }));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-gap]')!.click());
    const preview = JSON.parse(host.querySelector('[data-previews]')!.textContent!).find(
      (row: { id: string }) => row.id === 'u_peer',
    );
    expect(preview.lastMessage.body).toBe('漫游最新正文');
    expect(Date.parse(preview.updatedAt)).toBe(1794200060000);
    expect(f.messages.map((row) => row.msgId)).toEqual(['native']);
    expect(f.headRefreshes).toBe(0);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([false, true])('可见缺口自动拉取遵循开关且重复触发只请求一次：%s', async (enabled) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const epoch = `automatic-gap-${enabled}`;
  acceptPreferences(
    { epoch, revision: 1, records: {}, values: { autoFetchMissingMessages: enabled } },
    false,
  );
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const native: TestMessage = {
    msgId: 'native',
    msgSeq: '1',
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: '本地' } }],
  };
  f.gapRows = [{ ...native, msgId: 'fetched', msgSeq: '2' }];
  f.automaticGap = true;
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === '10001')!
        .click(),
    );
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [native] }));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-gap]')!.click();
      host.querySelector<HTMLButtonElement>('[data-gap]')!.click();
    });
    expect(f.gapRequests).toHaveLength(enabled ? 1 : 0);
    expect(f.messages.some((row) => row.msgSeq === '2')).toBe(enabled);
    if (!enabled) {
      f.automaticGap = false;
      await act(async () => host.querySelector<HTMLButtonElement>('[data-gap]')!.click());
      expect(f.gapRequests).toHaveLength(1);
    }
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
    acceptPreferences({ epoch, revision: 2, records: {}, values: {} }, false);
  }
});

it.each([
  { id: '10001', enabled: false, verified: true },
  { id: '10001', enabled: true, verified: true },
  { id: 'u_peer', enabled: true, verified: true },
  { id: 'u_peer', enabled: true, verified: false },
])(
  '定位缺失消息按共享设置拉取上下文：$id / $enabled / $verified',
  async ({ id, enabled, verified }) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const epoch = `missing-${id}-${enabled}-${verified}`;
    acceptPreferences(
      {
        epoch,
        revision: 1,
        records: {},
        values: {
          autoFetchMissingMessages: false,
          autoFetchMissingContext: enabled,
          missingMessageContextCount: 47,
        },
      },
      false,
    );
    useViewState.getState().setOpenedUin('90001');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const message = (seq: string): TestMessage => ({
      msgId: `context-${seq}`,
      msgSeq: seq,
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      ntSeqVerified: verified,
      elements: [{ type: 'text', data: { textContent: `消息 ${seq}` } }],
    });
    f.beforeRows = [message('1')];
    f.afterReply = async () => [message('200')];
    f.gapRows = [message('100')];
    try {
      await act(async () =>
        root.render(
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === id)!
          .click(),
      );
      await act(async () =>
        f.reads.at(-1)!.show({ complete: true, rows: [message('1'), message('200')] }),
      );
      let locating: void | Promise<void>;
      await act(async () => {
        locating = f.jump!({ seq: '100', index: '100' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
        await locating;
      });
      expect(f.gapRequests).toHaveLength(enabled ? 1 : 0);
      if (enabled)
        expect(f.gapRequests[0]).toMatchObject({
          kind: id === '10001' ? 'group' : 'c2c',
          conv: id,
          startSeq: 76,
          endSeq: 123,
          expectedAccountUin: '90001',
          expectedAccountConfigId: 'switch-test',
        });
      expect(f.messages.some((row) => row.msgSeq === '100')).toBe(
        enabled && (id === '10001' || verified),
      );
    } finally {
      act(() => root.unmount());
      client.clear();
      host.remove();
      acceptPreferences({ epoch, revision: 2, records: {}, values: {} }, false);
    }
  },
);

it('全目录一次获取共享结果，不在前端轮询精算，服务快照通知定向刷新', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  f.unreadMode = true;
  f.unreadCounts = { '10003': 7 };
  const olderGroups: typeof f.groups = [
    {
      groupCode: '10003',
      groupName: '尚未分页到的群助手会话',
      remark: '',
      memberCount: 1,
      maxMemberCount: 100,
      customLabels: [],
      directory: { memberCount: 1, role: 'member', notifyLevel: 2 },
    },
  ];
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
  const precise = () => f.unreadReads.filter((read) => !read.watermarksOnly);
  const render = () =>
    root.render(h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))));
  try {
    await act(async () => render());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await advance(200);
    expect(f.unreadReads[0]?.watermarksOnly).toBeUndefined();
    expect(precise()).toHaveLength(1);
    expect(precise()[0]?.targets).toHaveLength(f.recent.length);
    f.groups = olderGroups;
    await act(async () => render());
    await advance(10);
    expect(precise()).toHaveLength(2);
    expect(precise()[1]?.targets).toEqual([{ chatType: 2, uid: '10003' }]);
    const regular = JSON.parse(host.querySelector('[data-previews]')!.textContent!);
    expect(regular).toContainEqual(
      expect.objectContaining({ id: 'merged:group-assistant', unreadCount: 7 }),
    );
    for (let change = 0; change < 3; change++) {
      await act(async () => f.dbChanged?.());
      await advance(15000);
      expect(precise()).toHaveLength(2);
    }
    // 无前端精算或周期补扫；纯水位变化由服务端小表快照主动通知。
    await advance(31000);
    expect(precise()).toHaveLength(2);
    // 定向消息不等待下一轮低频校准。
    await act(async () => f.unreadChanged?.([{ chatType: 2, uid: '10001' }]));
    await advance(10);
    expect(precise()).toHaveLength(3);
    expect(precise().at(-1)?.targets).toEqual([{ chatType: 2, uid: '10001' }]);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it('群未读先于列表分页到达时不点亮红点，后台只切换接收方式也会更新角标', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  f.unreadMode = true;
  f.unreadCounts = { '10003': 126, '10004': 117 };
  f.unreadGroupNotifyLevels = { '10003': 2, '10004': 4 };
  f.groups = ['10003', '10004'].map((groupCode) => ({
    groupCode,
    groupName: groupCode,
    remark: '',
    memberCount: 1,
    maxMemberCount: 100,
    customLabels: [],
    directory: groupCode === '10003' ? null : { memberCount: 1, role: 'member', notifyLevel: 1 },
  }));
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const badge = () =>
    host.querySelector('[data-message-badge-count]')?.getAttribute('data-message-badge-count');
  const refresh = (uids: string[]) =>
    act(async () => {
      f.unreadChanged!(uids.map((uid) => ({ chatType: 2, uid })));
      await vi.advanceTimersByTimeAsync(10);
    });
  const rows = () => JSON.parse(host.querySelector('[data-previews]')!.textContent ?? '[]');
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(badge()).toBe('0');

    await refresh(['10003', '10004']);
    expect(badge()).toBe('0');
    expect(rows()).not.toContainEqual(expect.objectContaining({ id: '10003' }));
    expect(rows()).toContainEqual(
      expect.objectContaining({ id: 'merged:group-assistant', unreadCount: 126 }),
    );
    expect(rows()).toContainEqual(
      expect.objectContaining({
        id: '10004',
        unreadCount: 117,
        preference: expect.objectContaining({ muted: true }),
      }),
    );

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(f.headEnabled).toBe(false);
    f.unreadGroupNotifyLevels['10004'] = 1;
    await refresh(['10004']);
    expect(badge()).toBe('117');
    f.unreadGroupNotifyLevels['10004'] = 4;
    await refresh(['10004']);
    expect(badge()).toBe('0');
  } finally {
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

it('未读请求有失败批次时主列表和群助手仍显示成功结果，只补查失败目标', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  localStorage.setItem('weq:group-assistant-pins:90001', '{"10001":true}');
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  f.unreadFailures = 1;
  f.unreadCounts = { u_peer: 3, '10001': 5, '10002': 7, '30000': 9 };
  f.groups = ['10001', '10002'].map((groupCode) => ({
    groupCode,
    groupName: groupCode,
    remark: '',
    memberCount: 1,
    maxMemberCount: 100,
    customLabels: [],
    directory: { memberCount: 1, role: 'member', notifyLevel: 2 },
  }));
  const filler = Array.from({ length: UNREAD_BATCH_SIZE }, (_, index) => ({
    ...f.recent[0]!,
    targetUid: String(30000 + index),
  }));
  f.recent.unshift(...filler);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rows = () => JSON.parse(host.querySelector('[data-previews]')!.textContent!);
  const click = (selector: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await click('[data-messages]');
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(f.unreadReads).toHaveLength(2);
    expect(rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'u_peer', unreadCount: 3 }),
        expect.objectContaining({ id: 'merged:group-assistant', unreadCount: 12 }),
      ]),
    );
    await click('[data-list-switch="groupAssistant"]');
    expect(rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: '10001',
          unreadCount: 5,
          preference: expect.objectContaining({ pinned: true }),
        }),
        expect.objectContaining({
          id: '10002',
          unreadCount: 7,
          preference: expect.objectContaining({ pinned: false }),
        }),
      ]),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(f.unreadReads).toHaveLength(3);
    expect(f.unreadReads[2]?.targets).toEqual(f.unreadReads[0]?.targets);
    await click('[data-locate-unread]');
    expect(rows()).toContainEqual(expect.objectContaining({ id: '30000', unreadCount: 9 }));
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
    f.recent.splice(0, filler.length);
  }
});

it('代理首条私聊先进入列表，输入状态只显示给当前对方并随切换清理', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const select = (id: string) =>
    act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('nav button')]
        .find((button) => button.textContent === id)!
        .click(),
    );
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await select('u_peer');
    const expiresAt = Date.now() + 3000;
    const typing = (uid: string) =>
      act(async () =>
        f.liveBusiness?.({
          events: [{ kind: 'input-status', uid, speaking: false, expiresAt }],
        }),
      );
    await typing('u_other');
    expect(f.peerTyping).toBeUndefined();
    await typing('u_peer');
    expect(f.peerTyping).toBe('对方正在输入…');
    await select('10001');
    expect(f.peerTyping).toBeUndefined();
    await select('u_peer');
    expect(f.peerTyping).toBeUndefined();
    await typing('u_peer');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(f.peerTyping).toBeUndefined();

    const first: TestLiveConversation = {
      kind: 'c2c',
      conv: 'u_new',
      live: true,
      livePeer: { peerUin: '20022', peerName: '新会话', temporary: true },
      messages: [
        {
          source: 'roaming',
          ntSeqVerified: true,
          msgId: '9',
          msgSeq: '1',
          msgRandom: '9',
          sendTime: '1794200001',
          senderUid: 'u_new',
          senderUin: '20022',
          elements: [{ type: 'text', data: { textContent: '第一条' } }],
        },
      ],
    };
    await act(async () => {
      f.liveConversation?.(first);
      f.liveConversation?.(first);
    });
    const rows = () =>
      JSON.parse(host.querySelector('[data-previews]')!.textContent!).filter(
        (row: { id: string }) => row.id === 'u_new',
      );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.lastMessage.body).toBe('第一条');
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(rows()).toHaveLength(0);
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([
  { from: '10001', to: '10002', deferred: false, strict: false },
  { from: '10001', to: '10002', deferred: true, strict: false },
  { from: '10001', to: '10002', deferred: true, strict: true },
  { from: 'u_peer', to: '10002', deferred: true, strict: false },
])(
  '$from 切到 $to 不串正文、摘要或缓存：deferred=$deferred / strict=$strict',
  async ({ from, to, deferred, strict }) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    useViewState.getState().setOpenedUin('90001');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const select = (id: string) =>
      act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('nav button')]
          .find((button) => button.textContent === id)!
          .click(),
      );
    const conversation = (id: string) =>
      JSON.parse(host.querySelector('[data-previews]')!.textContent!).find(
        (row: { id: string }) => row.id === id,
      );
    const preview = (id: string) => conversation(id).lastMessage.body;
    const message = (id: string, sendTime: string): TestMessage => ({
      msgId: id,
      msgSeq: '2',
      sendTime,
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', data: { textContent: id } }],
    });
    try {
      await act(async () =>
        root.render(
          h(
            strict ? StrictMode : Fragment,
            null,
            h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
          ),
        ),
      );
      await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
      await select(from);
      await act(async () =>
        f.reads.at(-1)!.show({ complete: false, rows: [message('group-a', '1794200100')] }),
      );
      await act(async () => {
        const update = () =>
          f.reads.at(-1)!.show({ complete: false, rows: [message('group-a-next', '1794200200')] });
        if (deferred) startTransition(update);
        else update();
        flushSync(() =>
          [...host.querySelectorAll<HTMLButtonElement>('nav button')]
            .find((button) => button.textContent === to)!
            .click(),
        );
      });
      expect(preview(to)).toBe('旧预览');
      await act(async () =>
        f.reads.at(-1)!.show({ complete: true, rows: [message('group-b', '1794200060')] }),
      );
      expect(f.messages.map((row) => row.id)).toEqual(['group-b']);
      expect(preview(from)).toMatch(/^group-a/);
      expect(preview(to)).toBe('group-b');
      expect(Date.parse(conversation(to).updatedAt)).toBe(1794200060000);
      await select(from);
      expect(f.messages).toHaveLength(1);
      expect(f.messages[0]!.id).toMatch(/^group-a/);
      expect(preview(to)).toBe('group-b');
      await select(to);
      expect(f.messages.map((row) => row.id)).toEqual(['group-b']);
      expect(Date.parse(conversation(to).updatedAt)).toBe(1794200060000);
      for (const commit of f.messageCommits) {
        if (commit.id === to) expect(commit.rows.every((id) => id === 'group-b')).toBe(true);
        if (commit.id === from)
          expect(commit.rows.every((id) => id.startsWith('group-a'))).toBe(true);
      }
    } finally {
      act(() => root.unmount());
      client.clear();
      host.remove();
    }
  },
);

it('跳转订阅不随重绘重建，通知仍能连续切换会话，旧工作区迟到结果不回灌', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (key = 'first') =>
    act(async () =>
      root.render(
        h(
          StrictMode,
          null,
          h(
            QueryClientProvider,
            { client },
            h(ContentSelectionProvider, null, h(MainView, { key })),
          ),
        ),
      ),
    );
  try {
    await render();
    const groups = f.notificationSubscriptions.group.length;
    const conversations = f.notificationSubscriptions.conversation.length;
    const reads = { ...f.notificationReads };
    for (let round = 0; round < 5; round++) {
      f.refreshing = !f.refreshing;
      await render();
    }
    f.refreshing = false;
    await render();
    expect(f.notificationSubscriptions.group).toHaveLength(groups);
    expect(f.notificationSubscriptions.conversation).toHaveLength(conversations);
    expect(f.notificationReads).toEqual(reads);
    const group = f.notificationSubscriptions.group.at(-1)!;
    const conversation = f.notificationSubscriptions.conversation.at(-1)!;
    f.groupJumps.push({ groupCode: '10002', msgSeq: '42' });
    await act(async () => group.notify());
    expect(JSON.parse(host.querySelector('output')!.textContent!).id).toBe('10002');
    const neighbor: TestMessage = {
      msgId: '9007199254740993',
      msgSeq: '70',
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', data: { textContent: '同序号的其他消息' } }],
    };
    const recalled = {
      ...neighbor,
      msgId: '9007199254740994',
      recall: { revokeUid: 'u_peer', sameSender: true, recallTs: 1794200010 },
    };
    f.beforeRows = [recalled, neighbor];
    f.conversationJumps.push({
      kind: 'c2c',
      conv: 'u_peer',
      seq: recalled.msgSeq,
      msgId: recalled.msgId,
    });
    await act(async () => conversation.notify());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(JSON.parse(host.querySelector('output')!.textContent!).id).toBe('u_peer');
    expect(host.querySelector('.weq-reply-target-flash')?.getAttribute('data-message-id')).toBe(
      recalled.msgId,
    );
    expect(f.notificationSubscriptions.group).toHaveLength(groups);
    expect(f.notificationSubscriptions.conversation).toHaveLength(conversations);
    let resolve!: (jump: { kind: 'group'; conv: string }) => void;
    f.conversationJumpReply = () =>
      new Promise((done) => {
        resolve = done;
      });
    await act(async () => conversation.notify());
    await render('replacement');
    const newReads = f.reads.length;
    await act(async () => resolve({ kind: 'group', conv: '10001' }));
    expect(f.reads).toHaveLength(newReads);
    expect(JSON.parse(host.querySelector('output')!.textContent!).id).not.toBe('10001');
    expect(group.unsubscribe).toHaveBeenCalledOnce();
    expect(conversation.unsubscribe).toHaveBeenCalledOnce();
    f.conversationJumps.push({ kind: 'group', conv: '10002' });
    await act(async () => f.notificationSubscriptions.conversation.at(-1)!.notify());
    expect(JSON.parse(host.querySelector('output')!.textContent!).id).toBe('10002');
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});

it.each([false, true])('代理通知按精确落库信号重读并高亮消息（信号先到=%s）', async (early) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const previousBinding = accountBinding();
  bindAccountState({ expectedAccountUin: '90001', expectedAccountConfigId: 'switch-test' });
  const policy = useNotificationPolicy.getState();
  useNotificationPolicy.getState().setEvents({
    ...policy.events,
    directMessage: { banner: true, system: false },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const neighbor = {
    kind: 'c2c',
    conv: 'u_peer',
    msgId: '9007199254740993',
    msgSeq: '70',
    msgRandom: '8',
    sendTime: '1794200000',
    senderUid: 'u_peer',
    senderUin: '20001',
    elements: [{ type: 'text', data: { textContent: '同序号的其他消息' } }],
  };
  const target = { ...neighbor, msgId: '9007199254740994', msgRandom: '7' };
  const before = vi.fn(() => f.beforeRows);
  const firstAfter = Promise.withResolvers<TestMessage[]>();
  if (early) f.afterReply = () => firstAfter.promise;
  f.beforeReply = before;
  f.beforeRows = [neighbor];
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[data-contacts]')!.click());
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WEB_NOTICE_OPEN, {
          detail: {
            uin: '90001',
            configId: 'switch-test',
            kind: 'message',
            target: { kind: 'c2c', conv: 'u_peer', seq: '70', msgId: 'proxy:70:7:u_peer' },
          },
        }),
      );
    });
    expect(before.mock.calls).toEqual([['71']]);
    await act(async () => f.newMessages!({ messages: [neighbor] }));
    expect(before).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.weq-reply-target-flash')).toBeNull();
    f.beforeRows = [target, neighbor];
    await act(async () => f.newMessages!({ messages: [target] }));
    if (early) {
      expect(before).toHaveBeenCalledTimes(1);
      await act(async () => firstAfter.resolve([]));
    }
    expect(before.mock.calls).toEqual([['71'], ['71']]);
    expect(host.querySelector('.weq-reply-target-flash')?.getAttribute('data-message-id')).toBe(
      target.msgId,
    );
  } finally {
    act(() => root.unmount());
    bindAccountState(previousBinding);
    useNotificationPolicy.setState({ events: policy.events, ready: policy.ready });
    client.clear();
    host.remove();
  }
});

it('切换会话立即更新目标并启动对应消息读取，返回时立即恢复窗口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const select = async (id: string) =>
    act(async () =>
      [...host.querySelectorAll('nav button')]
        .find((button) => button.textContent === id)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
  const state = () => JSON.parse(host.querySelector('output')!.textContent!);
  const render = async () =>
    act(async () =>
      root.render(
        h(
          StrictMode,
          null,
          h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
        ),
      ),
    );
  try {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-messages]')!.click());
    await select('10001');
    expect(state()).toEqual({ id: '10001', loading: true, rows: [] });
    expect(f.reads.map((read) => read.conv)).toEqual(['10001']);
    const message = (id: string): TestMessage => ({
      msgId: id,
      msgSeq: '1',
      sendTime: '1794200000',
      senderUid: 'u_peer',
      senderUin: '20001',
      elements: [{ type: 'text', text: id }],
    });
    await act(async () => f.reads[0]!.show({ complete: false, rows: [message('partial-a')] }));
    f.commit = () => f.reads[0]!.show({ complete: false, rows: [message('stale-a')] });
    await select('10002');
    expect(state()).toEqual({ id: '10002', loading: true, rows: [] });
    await select('10001');
    // 冷加载期间切走的会话仍可读取，旧订阅的迟到结果不能回灌。
    expect(state().rows).not.toContain('stale-a');
    const currentA = f.reads.at(-1)!;
    await act(async () => currentA.show({ complete: true, rows: [message('message-a')] }));
    expect(state().rows).toEqual(['message-a']);
    await select('10002');
    expect(state()).toEqual({ id: '10002', loading: true, rows: [] });
    await act(async () => f.reads.at(-1)!.show({ complete: true, rows: [message('message-b')] }));
    expect(state().rows).toEqual(['message-b']);
    f.refreshing = true;
    await render();
    expect(state()).toEqual({ id: '10002', loading: false, rows: ['message-b'] });
    f.refreshing = false;
    await render();
    await select('10001');
    expect(state()).toEqual({ id: '10001', loading: false, rows: ['message-a'] });
    await select('u_peer');
    expect(state()).toEqual({ id: 'u_peer', loading: true, rows: [] });
    expect(f.reads.at(-1)?.conv).toBe('u_peer');
    const direct = f.reads.at(-1)!;
    await act(async () => direct.show({ complete: false, rows: [message('direct-partial')] }));
    f.commit = () => direct.show({ complete: false, rows: [message('stale-direct')] });
    await select('10002');
    expect(state()).toEqual({ id: '10002', loading: false, rows: ['message-b'] });
    await act(async () => direct.show({ complete: true, rows: [message('late-direct')] }));
    expect(state().rows).toEqual(['message-b']);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-back]')!.click());
    expect(state()).toEqual({ id: null, loading: false, rows: [] });
    f.refreshing = true;
    await render();
    await select('10002');
    expect(state()).toEqual({ id: '10002', loading: false, rows: ['message-b'] });
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
  }
});
