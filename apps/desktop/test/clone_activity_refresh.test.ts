import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CloneChatPanel } from '../src/renderer/src/views/agentlab/CloneChatPanel';
import { GroupChatPanel } from '../src/renderer/src/views/agentlab/GroupChatPanel';

const fixture = vi.hoisted(() => ({
  invalidate: vi.fn(),
  mutate: vi.fn(),
  onEvent: undefined as ((event: unknown) => void) | undefined,
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: vi.fn(), confirm: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const empty: unknown[] = [];
  const detail = { group: { id: 'g', name: '合成群聊' }, members: empty };
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useUtils') return () => proxy();
        if (key === 'invalidate')
          return (...args: unknown[]) => {
            fixture.invalidate(path.at(-1), ...args);
            return Promise.resolve();
          };
        if (key === 'useQuery')
          return () => ({
            data: path.at(-1) === 'getAgentLabGroupDetail' ? detail : empty,
            isLoading: false,
            isFetching: false,
            isSuccess: true,
          });
        if (key === 'useMutation') return () => ({ mutateAsync: fixture.mutate, isLoading: false });
        if (key === 'subscribe')
          return (_input: unknown, handlers: { onData: (event: unknown) => void }) => {
            fixture.onEvent = handlers.onData;
            return { unsubscribe: vi.fn() };
          };
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => {
  fixture.onEvent = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function mount(kind: 'persona' | 'group') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const common = {
    sessionId: 's',
    onBack: vi.fn(),
    onSessionCreated: vi.fn(),
    onSwitchSession: vi.fn(),
    onNewSession: vi.fn(),
  };
  act(() =>
    root.render(
      kind === 'persona'
        ? createElement(CloneChatPanel, {
            ...common,
            personaId: 'p',
            persona: { id: 'p', name: '合成克隆', sourceId: 'u_fixture', sourceTitle: '' },
            modelLabel: '',
            onOpenSettings: vi.fn(),
          })
        : createElement(GroupChatPanel, {
            ...common,
            groupId: 'g',
            personaList: [],
            profileByUid: new Map(),
            faceDescToId: new Map(),
            onDeleted: vi.fn(),
          }),
    ),
  );
  return {
    async send() {
      const editor = host.querySelector('textarea')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          editor,
          '合成消息',
        );
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(fixture.mutate).toHaveBeenCalled();
    },
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it.each([
  { kind: 'persona' as const, silent: true },
  { kind: 'persona' as const, silent: false },
  { kind: 'group' as const, silent: false },
])('$kind 发送落库后刷新主列表的活动时间与预览（沉默 $silent）', async ({ kind, silent }) => {
  fixture.mutate.mockResolvedValue({ sessionId: 's', silent, text: '合成回复', replyDelayMs: 0 });
  const f = mount(kind);
  try {
    await f.send();
    expect(fixture.invalidate).toHaveBeenCalledWith(
      kind === 'persona' ? 'listAgentLabPersonas' : 'listAgentLabGroups',
    );
  } finally {
    f.close();
  }
});

it('群聊逐条消息刷新主列表，不等整轮结束；忽略其他群和重复事件', () => {
  const f = mount('group');
  const event = {
    kind: 'message',
    groupId: 'g',
    message: {
      id: 'm',
      groupId: 'g',
      senderId: 'self',
      senderKind: 'user',
      text: '合成消息',
      ts: 1,
    },
  };
  try {
    act(() => fixture.onEvent?.({ ...event, groupId: 'other' }));
    expect(fixture.invalidate).not.toHaveBeenCalled();
    act(() => fixture.onEvent?.(event));
    expect(fixture.invalidate).toHaveBeenCalledWith('listAgentLabGroups');
    fixture.invalidate.mockClear();
    act(() => fixture.onEvent?.(event));
    expect(fixture.invalidate).not.toHaveBeenCalled();
    act(() => fixture.onEvent?.({ kind: 'done', groupId: 'g' }));
    expect(fixture.invalidate).toHaveBeenCalledWith('listAgentLabGroups');
  } finally {
    f.close();
  }
});

it.each(['persona', 'group'] as const)('%s 生成失败仍重新读取可能已落库的活动', async (kind) => {
  fixture.mutate.mockRejectedValue(new Error('合成生成失败'));
  const f = mount(kind);
  try {
    await f.send();
    expect(fixture.invalidate).toHaveBeenCalledWith(
      kind === 'persona' ? 'listAgentLabPersonas' : 'listAgentLabGroups',
    );
  } finally {
    f.close();
  }
});
