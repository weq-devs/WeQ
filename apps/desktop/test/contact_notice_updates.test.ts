// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useContactNoticeUpdates } from '../src/renderer/src/hooks/useContactNoticeUpdates';
import type { QQWriteBinding } from '../src/renderer/src/hooks/useQQWriteSession';

const f = vi.hoisted(() => ({
  subscribe: vi.fn(),
  utils: {
    account: {
      listBuddyRequests: { invalidate: vi.fn() },
      listGroupNotifies: { invalidate: vi.fn() },
      qqActions: { requestInbox: { invalidate: vi.fn() } },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { onContactNoticesChanged: { subscribe: f.subscribe } } },
  trpc: { useUtils: () => f.utils },
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

it.each(['friend', 'group'] as const)(
  '%s 面板仅刷新该类在线申请；重复事件限频并保留尾轮',
  async (kind) => {
    const { reads, subscriptions } = fixture(kind);
    await tick();
    expect(reads.online).toHaveBeenCalledTimes(2);
    subscriptions[0]!.onData({ kind });
    await tick(1);
    expect(reads.online).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 10; i++) {
      subscriptions[0]!.onData({ kind });
      await tick(100);
    }
    expect(reads.online).toHaveBeenCalledTimes(4);
    await tick(4000);
    expect(reads.online).toHaveBeenCalledTimes(6);
    const allowed = kind === 'friend' ? ['friend', 'doubtFriend'] : ['group', 'filteredGroup'];
    expect(
      f.utils.account.qqActions.requestInbox.invalidate.mock.calls.every(
        ([input]) => allowed.includes(input.kind) && input.expectedAccountConfigId === 'source-a',
      ),
    ).toBe(true);
  },
);

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
