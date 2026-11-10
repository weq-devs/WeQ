import {
  act,
  createElement as h,
  StrictMode,
  useLayoutEffect,
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

type TestMessage = {
  msgId: string;
  msgSeq: string;
  sendTime: string;
  senderUid: string;
  senderUin: string;
  elements: { type: string; text: string }[];
};
type UnreadInput = { targets: Array<{ chatType: number; uid: string }>; watermarksOnly?: boolean };

const f = vi.hoisted(() => ({
  refreshing: false,
  unreadMode: false,
  unreadReads: [] as UnreadInput[],
  dbChanged: undefined as (() => void) | undefined,
  unreadChanged: undefined as ((targets: UnreadInput['targets']) => void) | undefined,
  commit: undefined as (() => void) | undefined,
  reads: [] as { conv: string; show: (stage: MessagePageStage<TestMessage>) => void }[],
  recent: ['10001', '10002', 'u_peer'].map((targetUid, index) => ({
    targetUid,
    targetUin: '20001',
    chatType: index === 2 ? 1 : 2,
    sendTime: 1794200000,
    preview: [],
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
          return () =>
            path.join('.') === 'account.getAccountConfig'
              ? config
              : path.join('.') === 'account.listRecentContacts'
                ? f.refreshing
                  ? refreshing
                  : recent
                : [
                      'listAllGroups',
                      'listHiddenSessions',
                      'listDeletedSessions',
                      'listTopContacts',
                    ].includes(path.at(-1) ?? '')
                  ? directory
                  : empty;
        if (key === 'useInfiniteQuery') return () => (f.refreshing ? refreshingPages : pages);
        if (key === 'useMutation')
          return () => ({ mutate: vi.fn(), mutateAsync: refetch, isLoading: false });
        if (key === 'useSubscription') return () => {};
        if (key === 'query' || key === 'mutate' || key === 'invalidate')
          return async (input?: UnreadInput) => {
            if (path.at(-1) === 'getUnreadInfos' && f.unreadMode && input) {
              f.unreadReads.push(input);
              return input.targets.map((target) => ({
                ...target,
                peer: `${target.chatType}_${target.uid}`,
                msgSeq: '1',
                latestSeq: '100',
                ...(input.watermarksOnly ? { countPending: true } : { unreadCount: 0 }),
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
        h(actual.ChatMainContent, props),
      );
    },
  };
});

afterEach(() => {
  useViewState.getState().setOpenedUin(null);
  f.reads.length = 0;
  f.refreshing = false;
  f.commit = undefined;
  f.unreadMode = false;
  f.unreadReads.length = 0;
  f.dbChanged = undefined;
  f.unreadChanged = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
