// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useGroupNoticeInbox } from '../src/renderer/src/components/qq-actions/RequestActions.shared';
import { useContactNoticeUpdates } from '../src/renderer/src/hooks/useContactNoticeUpdates';
import type { QQWriteBinding } from '../src/renderer/src/hooks/useQQWriteSession';

const f = vi.hoisted(() => ({
  subscribe: vi.fn(),
  queryInbox: vi.fn(),
  utils: {
    account: {
      listBuddyRequests: { invalidate: vi.fn() },
      listGroupNotifies: { invalidate: vi.fn() },
      qqActions: { requestInbox: { invalidate: vi.fn() } },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      onContactNoticesChanged: { subscribe: f.subscribe },
      qqActions: { requestInbox: { query: f.queryInbox } },
    },
  },
  trpc: {
    useUtils: () => f.utils,
    account: {
      qqActions: {
        requestInbox: {
          useQuery: (input: QQWriteBinding & { kind: string }, options: { enabled: boolean }) =>
            useQuery(['group-inbox', input], () => f.queryInbox(input), options),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/qq-actions/shared.shared', () => ({
  useQQAction: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQReadActivity: (enabled: boolean) => ({ enabled }),
  useQQAutoRefresh: vi.fn(),
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(panel: 'friend' | 'group' | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reads = {
    friend: vi.fn(async () => ['friend']),
    group: vi.fn(async () => ['group']),
    online: vi.fn(async () => ['pending']),
  };
  const subscriptions: Array<{
    onData: (data: { kind: 'friend' | 'group' }) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  f.subscribe.mockImplementation((_binding, handlers) => {
    const unsubscribe = vi.fn();
    subscriptions.push({ ...handlers, unsubscribe });
    return { unsubscribe };
  });
  f.utils.account.listBuddyRequests.invalidate.mockImplementation(() =>
    queryClient.invalidateQueries(['local', 'friend']),
  );
  f.utils.account.listGroupNotifies.invalidate.mockImplementation(() =>
    queryClient.invalidateQueries(['local', 'group']),
  );
  f.utils.account.qqActions.requestInbox.invalidate.mockImplementation(({ kind }) =>
    queryClient.invalidateQueries(['online', kind]),
  );
  const root = createRoot(document.createElement('div'));
  function OnlineReader({ kind }: { kind: 'friend' | 'doubtFriend' | 'group' | 'filteredGroup' }) {
    useQuery(['online', kind], reads.online, {
      enabled: panel === (kind === 'friend' || kind === 'doubtFriend' ? 'friend' : 'group'),
    });
    return null;
  }
  function Reader({ binding }: { binding: QQWriteBinding | null }) {
    useContactNoticeUpdates(binding);
    useQuery(['local', 'friend'], reads.friend);
    useQuery(['local', 'group'], reads.group);
    return h(
      'div',
      null,
      ...(['friend', 'doubtFriend', 'group', 'filteredGroup'] as const).map((kind) =>
        h(OnlineReader, { kind, key: kind }),
      ),
    );
  }
  const render = (configId: string | null = 'source-a') =>
    act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(Reader, {
            binding: configId
              ? { expectedAccountUin: '10001', expectedAccountConfigId: configId }
              : null,
          }),
        ),
      ),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    queryClient.clear();
  });
  render();
  return { reads, subscriptions, render };
}
const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it('未打开联系人或通知面板也刷新对应本地列表，不读取在线申请', async () => {
  const { reads, subscriptions } = fixture();
  await tick();
  subscriptions[0]!.onData({ kind: 'friend' });
  await tick(1);
  expect(reads.friend).toHaveBeenCalledTimes(2);
  expect(reads.group).toHaveBeenCalledTimes(1);
  expect(reads.online).not.toHaveBeenCalled();
  subscriptions[0]!.onData({ kind: 'group' });
  await tick(1);
  expect(reads.group).toHaveBeenCalledTimes(2);
});

it('好友面板的在线补读合并重复事件并保留尾轮', async () => {
  const { reads, subscriptions } = fixture('friend');
  await tick();
  expect(reads.online).toHaveBeenCalledTimes(2);
  subscriptions[0]!.onData({ kind: 'friend' });
  await tick(1);
  expect(reads.online).toHaveBeenCalledTimes(4);
  for (let i = 0; i < 10; i++) {
    subscriptions[0]!.onData({ kind: 'friend' });
    await tick(100);
  }
  expect(reads.online).toHaveBeenCalledTimes(4);
  await tick(4000);
  expect(reads.online).toHaveBeenCalledTimes(6);
  const allowed = ['friend', 'doubtFriend'];
  expect(
    f.utils.account.qqActions.requestInbox.invalidate.mock.calls.every(
      ([input]) => allowed.includes(input.kind) && input.expectedAccountConfigId === 'source-a',
    ),
  ).toBe(true);
});

it('群面板打开时，群通知变化也只刷新本地列表', async () => {
  const { reads, subscriptions } = fixture('group');
  await tick();
  expect(reads.online).toHaveBeenCalledTimes(2);
  subscriptions[0]!.onData({ kind: 'group' });
  await tick(61_000);
  expect(reads.group).toHaveBeenCalledTimes(2);
  expect(reads.online).toHaveBeenCalledTimes(2);
});

it('群通知只在打开时读取；空闲期间无轮询，在线刷新失败后保留已有申请', async () => {
  const queryClient = new QueryClient();
  const root = createRoot(document.createElement('div'));
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
  let inbox: ReturnType<typeof useGroupNoticeInbox> | undefined;
  f.queryInbox.mockResolvedValue({ operations: [{ token: 'request' }], canReportRead: false });
  function Reader({ open }: { open: boolean }) {
    inbox = useGroupNoticeInbox(open, binding);
    return null;
  }
  const render = (open: boolean) =>
    act(() => root.render(h(QueryClientProvider, { client: queryClient }, h(Reader, { open }))));
  cleanups.push(() => {
    act(() => root.unmount());
    queryClient.clear();
  });
  render(false);
  await tick(61_000);
  expect(f.queryInbox).not.toHaveBeenCalled();
  render(true);
  await tick(61_000);
  expect(f.queryInbox.mock.calls.map(([input]) => input.kind)).toEqual(['group', 'filteredGroup']);
  expect(inbox?.operations).toHaveLength(2);

  f.queryInbox.mockRejectedValueOnce(new Error('服务端限制'));
  act(() => inbox?.onRefresh?.());
  await tick(61_000);
  expect(f.queryInbox).toHaveBeenCalledTimes(3);
  expect(inbox?.error).toBe('服务端限制');
  expect(inbox?.operations).toHaveLength(2);
});

it('同源重绘不重建订阅，换源后清理定时器并拒绝旧订阅的迟到通知', async () => {
  const { reads, subscriptions, render } = fixture('group');
  await tick();
  render();
  expect(f.subscribe).toHaveBeenCalledTimes(1);
  subscriptions[0]!.onData({ kind: 'group' });
  await tick(1);
  subscriptions[0]!.onData({ kind: 'group' });
  await tick(1);
  render('source-b');
  expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  const previous = reads.online.mock.calls.length;
  subscriptions[0]!.onData({ kind: 'friend' });
  await tick(10_000);
  expect(reads.online).toHaveBeenCalledTimes(previous);
  expect(reads.friend).toHaveBeenCalledTimes(1);
  subscriptions[1]!.onData({ kind: 'friend' });
  await tick(1);
  expect(reads.friend).toHaveBeenCalledTimes(2);
  render(null);
  expect(subscriptions[1]!.unsubscribe).toHaveBeenCalledTimes(1);
});
