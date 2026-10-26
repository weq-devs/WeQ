import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import type { AssistantStep } from '@weq/service';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../src/renderer/src/views/agentlab/AssistantPanel';
import { rememberAssistantDraft } from '../src/renderer/src/lib/assistantWorkspace';

const fixture = vi.hoisted(() => ({
  conversation: [],
  listener: null as ((event: { runId: string; step: AssistantStep }) => void) | null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  error: vi.fn(),
  sendError: false,
  utils: {
    account: {
      getAssistantConversation: { invalidate: vi.fn() },
      listAssistantSessions: { invalidate: vi.fn() },
      getAssistantResumeState: { invalidate: vi.fn() },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => fixture.utils,
    bootstrap: {
      getAgentLabDefaultModel: { useQuery: () => ({ data: { ref: null, available: false } }) },
    },
    account: new Proxy(
      {},
      {
        get(_target, path) {
          return {
            useQuery: () => ({
              data:
                path === 'getAssistantConfig'
                  ? { model: { providerId: 'synthetic', model: 'model-a' } }
                  : path === 'getAssistantConversation'
                    ? fixture.conversation
                    : {},
              isSuccess: true,
            }),
            useMutation: () => ({
              mutateAsync: async () => {
                if (path === 'chatWithAssistant' && fixture.sendError)
                  throw new Error('合成发送错误');
                return { runId: 'synthetic-run' };
              },
              isLoading: false,
            }),
          };
        },
      },
    ),
  },
  client: { account: { onAssistantEvent: { subscribe: fixture.subscribe } } },
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  // 与真实 hook 一样，每次渲染返回新对象，而方法本身保持稳定。
  useAppDialog: () => ({ error: fixture.error, confirm: vi.fn() }),
}));
vi.mock('../src/renderer/src/views/agentlab/useGeneratedSelection', () => ({
  useGeneratedSelection: () => ({
    control: null,
    rootProps: { ref: () => {} },
    itemProps: () => ({}),
    selected: () => false,
  }),
}));
vi.mock('../src/renderer/src/views/agentlab/messageSearch', () => ({
  GeneratedSearchNotice: () => null,
  useGeneratedSearchJump: () => false,
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantMessage', () => ({
  AssistantMessage: ({ text }: { text: string }) => h('div', { className: 'stream-body' }, text),
}));

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  vi.clearAllMocks();
  frames.clear();
  fixture.listener = null;
  fixture.sendError = false;
  fixture.subscribe.mockImplementation(
    (_input: unknown, observer: { onData: NonNullable<typeof fixture.listener> }) => {
      fixture.listener = observer.onData;
      return {
        unsubscribe: () => {
          fixture.unsubscribe();
          fixture.listener = null;
        },
      };
    },
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

function emit(step: AssistantStep): void {
  fixture.listener!({ runId: 'synthetic-run', step });
}
function flushFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of callbacks) callback(0);
  });
}

it('流式重渲不重建订阅，尚未刷新的增量在父组件重渲后仍按顺序显示', async () => {
  rememberAssistantDraft('synthetic-streaming', 'synthetic-session', '合成问题');
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = {
    sessionId: 'synthetic-session',
    draftAccount: 'synthetic-streaming',
    chatModels: [],
    compact: true,
    onBack: vi.fn(),
    onSessionCreated: vi.fn(),
    onActivityChange: vi.fn(),
  };
  try {
    act(() => root.render(h(AssistantPanel, props)));
    expect(props.onActivityChange).toHaveBeenLastCalledWith('idle');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();
    });
    expect(props.onActivityChange).toHaveBeenLastCalledWith('running');
    emit({ kind: 'text_delta', text: '第一段' });
    flushFrame();
    expect(host.querySelector('.stream-body')?.textContent).toBe('第一段');

    emit({ kind: 'text_delta', text: '不能丢' });
    act(() => root.render(h(AssistantPanel, { ...props, workspaceTitle: '更新标题' })));
    flushFrame();
    expect(host.querySelector('.stream-body')?.textContent).toBe('第一段不能丢');
    emit({ kind: 'text_delta', text: '最后一段' });
    flushFrame();
    expect(host.querySelector('.stream-body')?.textContent).toBe('第一段不能丢最后一段');
    expect(props.onActivityChange).toHaveBeenLastCalledWith('running');
    expect(fixture.subscribe).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
    emit({ kind: 'final', text: '第一段不能丢最后一段' });
    act(() => root.render(h(AssistantPanel, props)));
    flushFrame();
    expect(host.querySelector('.stream-body')?.textContent).toBe('第一段不能丢最后一段');
    expect(props.onActivityChange).toHaveBeenLastCalledWith('finished');
    expect(fixture.utils.account.getAssistantConversation.invalidate).toHaveBeenCalledWith({
      sessionId: props.sessionId,
    });
  } finally {
    act(() => root.unmount());
  }
  expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
});

it.each(['stream-error', 'send-error', 'aborted'] as const)(
  '助手 %s 从在途转为结束提醒',
  async (kind) => {
    fixture.sendError = kind === 'send-error';
    rememberAssistantDraft('activity-errors', 'session', '合成问题');
    const host = document.createElement('div');
    const root = createRoot(host);
    const activity = vi.fn();
    try {
      act(() =>
        root.render(
          h(AssistantPanel, {
            sessionId: 'session',
            draftAccount: 'activity-errors',
            chatModels: [],
            compact: true,
            onBack: vi.fn(),
            onSessionCreated: vi.fn(),
            onActivityChange: activity,
          }),
        ),
      );
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click(),
      );
      expect(activity).toHaveBeenCalledWith('running');
      if (kind !== 'send-error') {
        emit(
          kind === 'stream-error' ? { kind: 'error', message: '合成流错误' } : { kind: 'aborted' },
        );
        flushFrame();
      }
      expect(activity).toHaveBeenLastCalledWith('finished');
    } finally {
      act(() => root.unmount());
    }
  },
);
