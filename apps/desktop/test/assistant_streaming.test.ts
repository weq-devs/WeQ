import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import type { AssistantStep } from '@weq/service';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../src/renderer/src/views/agentlab/AssistantPanel';
import { rememberAssistantDraft } from '../src/renderer/src/lib/assistantWorkspace';

const fixture = vi.hoisted(() => ({
  conversation: [],
  sessionId: '',
  listener: null as
    | ((event: {
        runId: string;
        sessionId: string;
        messageId: string;
        step: AssistantStep;
      }) => void)
    | null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  error: vi.fn(),
  sendError: false,
  resumable: false,
  control: vi.fn(),
  utils: {
    account: {
      getAssistantConversation: { invalidate: vi.fn() },
      listAssistantSessions: { invalidate: vi.fn() },
      getAssistantResumeState: { invalidate: vi.fn() },
      assistantQueue: { invalidate: vi.fn() },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => fixture.utils,
    bootstrap: {
      getSettings: { useQuery: () => ({ data: undefined }) },
      listAgentLabProviders: { useQuery: () => ({ data: [] }) },
      synthesizeSpeech: { useMutation: () => ({ mutateAsync: vi.fn(), isLoading: false }) },
      getAgentLabDefaultModel: { useQuery: () => ({ data: { ref: null, available: false } }) },
    },
    account: new Proxy(
      {},
      {
        get(_target, path) {
          if (
            [
              'dressup',
              'emojiPanel',
              'sysEmoji',
              'roamingBackfill',
              'qqWrite',
              'qqActions',
              'intentSense',
            ].includes(String(path))
          )
            return new Proxy(
              {},
              {
                get: () => ({
                  useQuery: () => ({ data: undefined }),
                  useMutation: () => ({ mutate: vi.fn(), isLoading: false }),
                }),
              },
            );
          return {
            useQuery: () => ({
              data:
                path === 'getAssistantConfig'
                  ? { model: { providerId: 'synthetic', model: 'model-a' } }
                  : path === 'getAssistantConversation'
                    ? fixture.conversation
                    : path === 'getAssistantResumeState'
                      ? { resumable: fixture.resumable }
                      : path === 'getAccountConfig'
                        ? { uin: '10000', configId: 'synthetic' }
                        : undefined,
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
  client: {
    account: {
      controlAssistantQueue: { mutate: fixture.control },
      onAssistantEvent: { subscribe: fixture.subscribe },
      submitAssistantMessage: {
        mutate: async (input: { sessionId: string }) => {
          if (fixture.sendError) throw new Error('合成发送错误');
          fixture.sessionId = input.sessionId;
          fixture.listener?.({
            runId: 'synthetic-run',
            sessionId: input.sessionId,
            messageId: 'assistant-message',
            step: {
              kind: 'turn',
              turn: {
                id: 'assistant-message',
                role: 'assistant',
                text: '',
                ts: 1,
                status: 'running',
                steps: [],
              },
            },
          });
        },
      },
    },
  },
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
vi.mock('../src/renderer/src/views/agentlab/messageSearch.shared', () => ({
  GeneratedSearchNotice: () => null,
  useGeneratedSearchJump: () => false,
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantMessage', () => ({
  AssistantMessage: ({ text, streaming }: { text: string; streaming?: boolean }) =>
    h('div', { className: 'stream-body', 'data-streaming': Boolean(streaming) }, text),
}));

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  vi.clearAllMocks();
  frames.clear();
  fixture.listener = null;
  fixture.sendError = false;
  fixture.resumable = false;
  fixture.control.mockResolvedValue({ runId: 'resumed-run' });
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
  fixture.listener!({
    runId: 'synthetic-run',
    sessionId: fixture.sessionId,
    messageId: 'assistant-message',
    step,
  });
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
  document.body.append(host);
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
    expect(props.onActivityChange).toHaveBeenLastCalledWith('idle', undefined);
    expect(host.querySelector('.composer-editor')?.textContent).toBe('合成问题');
    expect(host.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(false);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.composer-send')!.click();
    });
    flushFrame();
    expect(props.onActivityChange).toHaveBeenLastCalledWith('running', undefined);
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
    expect(props.onActivityChange).toHaveBeenLastCalledWith('running', undefined);
    expect(fixture.subscribe).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
    emit({ kind: 'final', text: '第一段不能丢最后一段' });
    act(() => root.render(h(AssistantPanel, props)));
    flushFrame();
    expect(host.querySelector('.stream-body')?.textContent).toBe('第一段不能丢最后一段');
    expect(props.onActivityChange).toHaveBeenLastCalledWith('finished', expect.any(String));
    expect(fixture.utils.account.getAssistantConversation.invalidate).toHaveBeenCalledWith({
      sessionId: props.sessionId,
    });
  } finally {
    act(() => root.unmount());
    host.remove();
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
    document.body.append(host);
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
      await act(async () => host.querySelector<HTMLButtonElement>('.composer-send')!.click());
      if (kind !== 'send-error') {
        flushFrame();
        expect(activity).toHaveBeenCalledWith('running', undefined);
        emit(
          kind === 'stream-error' ? { kind: 'error', message: '合成流错误' } : { kind: 'aborted' },
        );
        flushFrame();
      }
      expect(activity).toHaveBeenLastCalledWith('finished', expect.any(String));
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('停止和恢复控件位于助手消息内，停止保留正文，恢复逐段追加且可以再次停止', async () => {
  rememberAssistantDraft('stop-resume', 'session', '合成问题');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(AssistantPanel, {
          sessionId: 'session',
          draftAccount: 'stop-resume',
          chatModels: [],
          onBack: vi.fn(),
          onSessionCreated: vi.fn(),
        }),
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('.composer-send')!.click());
    flushFrame();
    emit({ kind: 'text_delta', text: '已有正文\n\n' });
    flushFrame();
    const stop = host.querySelector<HTMLButtonElement>(
      '.weq-asst-content [aria-label="停止输出"]',
    )!;
    expect(stop).not.toBeNull();
    expect(host.querySelector('.composer [aria-label="停止输出"]')).toBeNull();
    await act(async () => stop.click());
    expect(fixture.control).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'stop' }));
    expect(host.querySelector('.stream-body')?.textContent).toBe('已有正文\n\n');
    fixture.resumable = true;
    emit({ kind: 'aborted' });
    flushFrame();
    expect(host.querySelector('.stream-body')?.textContent).toBe('已有正文\n\n');
    const resume = host.querySelector<HTMLButtonElement>(
      '.weq-asst-content [aria-label="恢复输出"]',
    )!;
    expect(resume).not.toBeNull();
    await act(async () => resume.click());
    expect(fixture.control).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'continue' }),
    );
    emit({
      kind: 'turn',
      turn: {
        id: 'assistant-message',
        role: 'assistant',
        text: '已有正文\n\n',
        ts: 1,
        status: 'running',
        steps: [],
      },
    });
    flushFrame();
    emit({ kind: 'text_delta', text: '后续片段' });
    flushFrame();
    expect(host.querySelector('.stream-body')?.textContent).toBe('已有正文\n\n后续片段');
    expect(host.querySelector('.stream-body')?.getAttribute('data-streaming')).toBe('true');
    expect(host.querySelector('.weq-asst-content [aria-label="停止输出"]')).not.toBeNull();
    emit({ kind: 'final', text: '已有正文\n\n后续片段' });
    flushFrame();
    expect(host.querySelector('[aria-label="停止输出"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
