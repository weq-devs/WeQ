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

const f = vi.hoisted(() => ({
  refreshing: false,
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
          return async () =>
            ['getUnreadInfos', 'getGroupMembersByUids', 'listGroupMembers'].includes(
              path.at(-1) ?? '',
            )
              ? []
              : undefined;
        if (key === 'subscribe')
          return (
            input: { conv: string },
            handlers: { onData: (stage: MessagePageStage<TestMessage>) => void },
          ) => {
            if (path.at(-1) === 'latestPage')
              f.reads.push({ conv: input.conv, show: handlers.onData });
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
  vi.unstubAllGlobals();
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
