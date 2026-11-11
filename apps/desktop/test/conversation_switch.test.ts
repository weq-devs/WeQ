import {
  act,
  createElement as h,
  StrictMode,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MainView } from '../src/renderer/src/views/MainView';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { useViewState } from '../src/renderer/src/state/view';
import type { ChatMainContent } from '../src/renderer/src/im-template/template/chatMainContent';
import type { ChatSidebarContent } from '../src/renderer/src/im-template/template/chatSidebarContent';
import type { MessagePageStage } from '../src/shared/message_read';
import { publishQQPeerUpdate } from '../src/renderer/src/lib/qqPeerUpdates';
import type { GapMessagesModal } from '../src/renderer/src/components/compose/GapMessagesModal';
import * as replyPreview from '../src/renderer/src/lib/replyPreview';
import * as conversationOrder from '@weq/service/conversation-order';
import * as conversationRows from '../src/renderer/src/lib/conversationListOrder';

type TestMessage = {
  msgId: string;
  msgSeq: string;
  clientSeq?: string;
  sendTime: string;
  senderUid: string;
  senderUin: string;
  elements: { type: string; text?: string; data?: Record<string, unknown> }[];
  recall?: { revokeUid: string; sameSender: boolean; recallTs: number };
};
type UnreadInput = { targets: Array<{ chatType: number; uid: string }>; watermarksOnly?: boolean };

const f = vi.hoisted(() => ({
  refreshing: false,
  unreadMode: false,
  unreadCounts: {} as Record<string, number>,
  headRefreshes: 0,
  freshPreview: false,
  previewTarget: null as string | null,
  groups: [] as Array<{
    groupCode: string;
    groupName: string;
    remark: string;
    memberCount: number;
    maxMemberCount: number;
    customLabels: Array<{ content: string }>;
    directory: { memberCount: number; role: 'member'; notifyLevel: number };
  }>,
  headEnabled: false,
  unreadReads: [] as UnreadInput[],
  dbChanged: undefined as (() => void) | undefined,
  unreadChanged: undefined as ((targets: UnreadInput['targets']) => void) | undefined,
  refreshRows: undefined as TestMessage[] | undefined,
  beforeRows: [] as TestMessage[],
  previewMessages: [] as ComponentProps<typeof GapMessagesModal>['messages'],
  previewMore: undefined as (() => void) | undefined,
  profiles: [] as Array<{ uid: string; uin: string; nick: string; remark: string }>,
  bots: [] as string[],
  memberDetails: undefined as
    | { uid: string; uin: string; card: string; nick: string; adminFlag: number; joinTime: string }
    | undefined,
  messages: [] as ComponentProps<typeof ChatMainContent>['messages'],
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
        if (key === 'useQuery')
          return (_input: unknown, options?: { enabled?: boolean }) => {
            const [head, setHead] = useState(recent);
            if (path.join('.') === 'account.listRecentContacts')
              f.headEnabled = options?.enabled === true;
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
          return async (input?: UnreadInput) => {
            if (path.at(-1) === 'memberDetails') return f.memberDetails;
            if (path.at(-1) === 'listBefore') return f.beforeRows;
            if (['listLatest', 'listFrom'].includes(path.at(-1) ?? '')) return f.refreshRows;
            if (path.at(-1) === 'getUnreadInfos' && f.unreadMode && input) {
              f.unreadReads.push(input);
              return input.targets.map((target) => ({
                ...target,
                peer: `${target.chatType}_${target.uid}`,
                msgSeq: '1',
                latestSeq: '100',
                ...(input.watermarksOnly
                  ? { countPending: true }
                  : { unreadCount: f.unreadCounts[target.uid] ?? 0 }),
              }));
            }
            return [
              'getUnreadInfos',
              'getGroupMembersByUids',
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
                data: MessagePageStage<TestMessage> | UnreadInput['targets'] | { at?: number },
              ) => void;
            },
          ) => {
            if (path.at(-1) === 'latestPage')
              f.reads.push({ conv: input.conv, show: handlers.onData });
            if (path.at(-1) === 'onDbChanged') f.dbChanged = () => handlers.onData({});
            if (path.at(-1) === 'onUnreadChanged')
              f.unreadChanged = (targets) => handlers.onData(targets);
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
    children,
    onViewChange,
  }: {
    mainContent: ReactNode;
    sidebarContent: ReactNode;
    children: ReactNode;
    onViewChange: (view: 'messages') => void;
  }) =>
    h(
      'div',
      null,
      h('button', { 'data-messages': true, onClick: () => onViewChange('messages') }, '消息'),
      sidebarContent,
      mainContent,
      children,
    ),
}));
vi.mock('../src/renderer/src/im-template/template/chatSidebarContent', () => ({
  ChatSidebarContent: (props: ComponentProps<typeof ChatSidebarContent>) =>
    h(
      'nav',
      null,
      h('span', { 'data-previews': true }, JSON.stringify(props.conversations)),
      ...f.recent.map((row) =>
        h(
          'button',
          { key: row.targetUid, onClick: () => props.onSelectConversation(row.targetUid) },
          row.targetUid,
        ),
      ),
    ),
}));
vi.mock('../src/renderer/src/im-template/template/chatMainContent', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/src/im-template/template/chatMainContent')
    >();
  return {
    ChatMainContent: (props: ComponentProps<typeof ChatMainContent>) => {
      f.messages = props.messages;
      useLayoutEffect(() => {
        f.commit?.();
        f.commit = undefined;
      }, [props.activeConversation?.id]);
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
  f.commit = undefined;
  f.unreadMode = false;
  f.unreadCounts = {};
  f.headRefreshes = 0;
  f.freshPreview = false;
  f.previewTarget = null;
  f.groups = [];
  f.headEnabled = false;
  f.unreadReads.length = 0;
  f.dbChanged = undefined;
  f.unreadChanged = undefined;
  f.refreshRows = undefined;
  f.beforeRows = [];
  f.previewMessages = [];
  f.previewMore = undefined;
  f.profiles = [];
  f.bots = [];
  f.memberDetails = undefined;
  f.messages = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('MainView 单条未读更新在深比较前只重建受影响会话，清零仍即时更新', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.getState().setOpenedUin('90001');
  f.unreadMode = true;
  const reconcile = vi.spyOn(conversationRows, 'reconcileConversationRows');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const projected = () =>
    reconcile.mock.calls
      .filter(([, rows]) => rows.some((row) => 'pinStateKnown' in row))
      .at(-1)?.[1];
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
    reconcile.mockClear();
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
    const byId = new Map(after.map((row) => [row.id, row]));
    reconcile.mockClear();
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
    client.clear();
    host.remove();
  }
});

it('MainView 单行预览更新时每条会话只计算一次排序时间', async () => {
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
    expect(time).toHaveBeenCalledTimes(f.recent.length);
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

it('全目录先查水位，持续库通知不重算稳定会话，零红点同水位修正仍定期校准', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  f.unreadMode = true;
  useViewState.getState().setOpenedUin('90001');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
  const precise = () => f.unreadReads.filter((read) => !read.watermarksOnly);
  try {
    await act(async () =>
      root.render(
        h(QueryClientProvider, { client }, h(ContentSelectionProvider, null, h(MainView))),
      ),
    );
    await advance(200);
    expect(f.unreadReads[0]?.watermarksOnly).toBe(true);
    expect(precise()).toHaveLength(1);
    expect(precise()[0]?.targets).toHaveLength(f.recent.length);
    for (let change = 0; change < 3; change++) {
      await act(async () => f.dbChanged?.());
      await advance(15000);
      expect(precise()).toHaveLength(1);
    }
    // 已经没有新的库通知，也没有红点供 1.5 秒轮询选择，仍需独立推进到期补算。
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
