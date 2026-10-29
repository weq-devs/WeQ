import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '../src/renderer/src/trpc/client';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { useToast } from '../src/renderer/src/components/Toast';
import type { Message } from '../src/renderer/src/im-template/template/types';

const rpc = vi.hoisted(() => ({
  selfSet: false,
  write: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/renderer/src/trpc/client')>();
  const proxy = (path = ''): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (path === '' && (key === 'Provider' || key === 'createClient' || key === 'useUtils'))
          return original.trpc[key];
        if (path === '.account' && (key === 'messageReactionUsers' || key === 'setMessageReaction'))
          return original.trpc.account[key];
        if (key === 'useQuery')
          return () => ({
            data: path.endsWith('.getSelfProfile') ? { uin: '10001' } : undefined,
            isLoading: false,
          });
        if (key === 'useMutation') return () => ({ mutate: vi.fn(), isLoading: false });
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/components/FaceEmoji', () => ({ FaceEmoji: () => null }));

const peer = { uid: 'u_peer', uin: '20002', card: '群友', remark: '', nick: '', avatarUrl: '' };
const self = { ...peer, uid: 'u_self', uin: '10001', card: '自己' };
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.useFakeTimers();
  rpc.selfSet = false;
  rpc.write.mockReset().mockResolvedValue({ ok: true });
  rpc.read.mockReset().mockImplementation(async () => ({
    items: rpc.selfSet ? [peer, self] : [peer],
    nextCursor: null,
  }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function fixture(selfSet = false) {
  rpc.selfSet = selfSet;
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'group')!;
  const message: Message = {
    id: 'reaction-source',
    conversationId: conversation.id,
    senderId: demo.user.id,
    body: '合成消息',
    createdAt: new Date().toISOString(),
    msgSeq: '42',
    setEmojiList: [{ emojiId: '76', setNum: selfSet ? 2 : 1, isSelfSet: selfSet }],
  };
  // 与应用相同：全局关闭重新挂载刷新；只有贴表情读写走真实 tRPC / React Query。
  const queries = new QueryClient({
    defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    logger: { log: console.log, warn: console.warn, error: vi.fn() },
  });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            void (async () => {
              if (op.path === 'account.setMessageReaction') {
                const result = await rpc.write(op.input);
                rpc.selfSet = (op.input as { isSet: boolean }).isSet;
                observer.next({ result: { data: result } });
              } else {
                observer.next({ result: { data: await rpc.read(op.input) } });
              }
              observer.complete();
            })().catch((error: unknown) => observer.error(TRPCClientError.from(error)));
          }),
    ],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (updated = false) => {
    const messages = updated
      ? [
          {
            ...message,
            setEmojiList: [{ emojiId: '76', setNum: rpc.selfSet ? 2 : 1, isSelfSet: rpc.selfSet }],
          },
        ]
      : [message];
    act(() =>
      root.render(
        h(
          trpc.Provider,
          { client, queryClient: queries },
          h(
            QueryClientProvider,
            { client: queries },
            h(ChatPane, {
              user: demo.user,
              conversation,
              messages,
              loading: false,
              draft: '',
              onSend: vi.fn(),
              onDraftChange: vi.fn(),
              onDraftClear: vi.fn(),
              onBack: vi.fn(),
            }),
          ),
        ),
      ),
    );
  };
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    queries.clear();
    host.remove();
  });
  const chip = () => host.querySelector<HTMLButtonElement>('.msg-reaction')!;
  const hover = async () => {
    act(() => chip().dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
    await settle(180);
    await settle();
  };
  return {
    render,
    chip,
    hover,
    conversation,
    queries,
    leave: () => act(() => root.render(null)),
  };
}

describe('自己的贴表情更新名单缓存', () => {
  it.each([false, true])(
    '名单关闭后提交成功立即刷新，下次打开显示最新名单（原来已贴=%s）',
    async (selfSet) => {
      const f = fixture(selfSet);
      await f.hover();
      expect(document.querySelectorAll('.reaction-likers-row')).toHaveLength(selfSet ? 2 : 1);
      act(() => f.chip().click());
      expect(document.querySelector('.reaction-likers')).toBeNull();
      await settle();
      expect(rpc.write).toHaveBeenCalledOnce();
      expect(rpc.write).toHaveBeenCalledWith({
        groupId: f.conversation.group.identityValue,
        sequence: 42,
        code: '76',
        isSet: !selfSet,
      });
      // 此时名单已卸载，不能只 invalidate 默认的 active queries。
      expect(rpc.read).toHaveBeenCalledTimes(2);
      f.render(true);
      await f.hover();
      expect(document.querySelectorAll('.reaction-likers-row')).toHaveLength(selfSet ? 1 : 2);
      expect(rpc.read).toHaveBeenCalledTimes(2);
    },
  );

  it('提交失败不刷新名单，保留原始回应', async () => {
    const f = fixture();
    await f.hover();
    rpc.write.mockRejectedValueOnce(new Error('合成提交失败'));
    act(() => f.chip().click());
    await settle();
    expect(rpc.read).toHaveBeenCalledOnce();
    expect(f.chip().getAttribute('aria-pressed')).toBe('false');
    expect(useToast.getState().toasts.some((toast) => toast.title === '贴表情失败')).toBe(true);
  });

  it('只刷新目标消息表情的所有分页规格，不刷新其他群、消息或表情', async () => {
    const f = fixture();
    const target = { groupId: f.conversation.group.identityValue, sequence: 42, emojiId: '76' };
    const inputs = [
      { ...target, count: 10 },
      { ...target, groupId: '99999', count: 30 },
      { ...target, sequence: 43, count: 30 },
      { ...target, emojiId: '14', count: 30 },
    ];
    for (const input of inputs)
      await f.queries.fetchInfiniteQuery({
        queryKey: getQueryKey(trpc.account.messageReactionUsers, input, 'infinite'),
        queryFn: () => rpc.read(input),
        staleTime: 30_000,
      });
    await f.hover();
    rpc.read.mockClear();
    act(() => f.chip().click());
    await settle();
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(rpc.read).toHaveBeenCalledWith(expect.objectContaining({ ...target, count: 10 }));
    expect(rpc.read).toHaveBeenCalledWith(expect.objectContaining({ ...target, count: 30 }));
  });

  it('名单刷新失败不误报提交失败，再次打开可重试读取而不重发', async () => {
    const f = fixture();
    await f.hover();
    rpc.read.mockRejectedValueOnce(new Error('合成读取失败'));
    act(() => f.chip().click());
    await settle();
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(useToast.getState().toasts.some((toast) => toast.title === '贴表情失败')).toBe(false);
    f.render(true);
    await f.hover();
    expect(document.querySelectorAll('.reaction-likers-row')).toHaveLength(2);
    expect(rpc.read).toHaveBeenCalledTimes(3);
    expect(rpc.write).toHaveBeenCalledOnce();
  });

  it('提交尚未返回就离开聊天页，成功后仍刷新已缓存的名单', async () => {
    const f = fixture();
    await f.hover();
    let finish!: (result: { ok: boolean }) => void;
    rpc.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => f.chip().click());
    await settle();
    f.leave();
    await act(async () => finish({ ok: true }));
    await settle();
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(rpc.write).toHaveBeenCalledOnce();
  });

  it('提交前已在途的旧名单迟到，不覆盖操作后的新结果', async () => {
    const f = fixture();
    await f.hover();
    let finish!: (page: { items: (typeof peer)[]; nextCursor: null }) => void;
    rpc.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => {
      void f.queries.refetchQueries({ queryKey: getQueryKey(trpc.account.messageReactionUsers) });
    });
    await settle();
    expect(rpc.read).toHaveBeenCalledTimes(2);
    act(() => f.chip().click());
    await settle();
    expect(rpc.read).toHaveBeenCalledTimes(3);
    f.render(true);
    await act(async () => finish({ items: [peer], nextCursor: null }));
    await f.hover();
    expect(document.querySelectorAll('.reaction-likers-row')).toHaveLength(2);
    expect(rpc.write).toHaveBeenCalledOnce();
  });

  it('超过缓存新鲜期后重新悬停会重读，未过期的重复悬停仍复用缓存', async () => {
    const f = fixture();
    await f.hover();
    act(() => f.chip().dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
    await settle(220);
    await f.hover();
    expect(rpc.read).toHaveBeenCalledOnce();
    act(() => f.chip().dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
    await settle(30_001);
    rpc.selfSet = true;
    await f.hover();
    expect(rpc.read).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('.reaction-likers-row')).toHaveLength(2);
  });
});
