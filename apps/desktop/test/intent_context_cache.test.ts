import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  IntentSenseProvider,
  useIntentSenseContext,
  type IntentAnalysis,
  type IntentSenseContextValue,
} from '../src/renderer/src/components/intentSense/context';
import { IntentSuggestionBar } from '../src/renderer/src/components/intentSense/IntentSuggestionBar';
import { DEFAULT_ANALYSIS_CONTEXT_MESSAGES } from '@weq/service/intent-context';

const fixture = vi.hoisted(() => ({
  status: {
    enabled: true,
    engine: 'local',
    localReady: true,
    suggestionsEnabled: true,
    analysisContextMessages: 0,
    analysisRevision: 0,
    suggestionRevision: 0,
  },
  list: vi.fn(),
  ensure: vi.fn(),
  analyze: vi.fn(),
  unsubscribe: vi.fn(),
  suggestQuery: vi.fn(),
  callbacks: [] as Array<
    (event: { kind: string; conv: string; results: IntentAnalysis[] }) => void
  >,
  utils: {
    account: {
      intentSense: {
        getProfile: { invalidate: vi.fn(async () => {}) },
        getSuggestions: { invalidate: vi.fn(async () => {}) },
        getStatus: { invalidate: vi.fn(async () => {}) },
      },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => fixture.utils,
    account: {
      intentSense: {
        getStatus: { useQuery: () => ({ data: fixture.status }) },
        getSuggestions: { useQuery: fixture.suggestQuery },
      },
    },
  },
  client: {
    account: {
      intentSense: {
        listMessageAnalyses: { query: fixture.list },
        ensureAnalysis: { mutate: fixture.ensure },
        analyzeMessage: { mutate: fixture.analyze },
        onAnalyzed: {
          subscribe: (
            _input: unknown,
            observer: {
              onData: (event: { kind: string; conv: string; results: IntentAnalysis[] }) => void;
            },
          ) => {
            fixture.callbacks.push(observer.onData);
            return { unsubscribe: fixture.unsubscribe };
          },
        },
      },
    },
  },
}));

const sample: IntentAnalysis = {
  msgId: 'old',
  mine: false,
  sendTime: 1000,
  intent: 'chat',
  emotion: 'neutral',
  intensity: 20,
  sentiment: 0,
  confidence: 0.8,
  engine: 'local',
  analyzedAt: 1000,
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.status = {
    ...fixture.status,
    analysisContextMessages: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
    analysisRevision: 0,
    suggestionRevision: 0,
  };
  fixture.list.mockReset().mockResolvedValue([sample]);
  fixture.ensure.mockReset().mockResolvedValue({ analyzed: 0 });
  fixture.analyze.mockReset().mockResolvedValue(null);
  fixture.unsubscribe.mockClear();
  fixture.callbacks.length = 0;
  fixture.suggestQuery.mockReset().mockReturnValue({ data: [], isFetching: false });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});

function renderFixture() {
  let context: IntentSenseContextValue | null = null;
  function Consumer() {
    context = useIntentSenseContext();
    return h('span', null, context?.getAnalysis('old')?.intent ?? '无缓存');
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        h(
          IntentSenseProvider,
          {
            kind: 'c2c',
            conv: 'u_peer',
            latestPeerMsgId: null,
          } as Parameters<typeof IntentSenseProvider>[0],
          h(Consumer),
        ),
      ),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { render, get: () => context! };
}

it('清空缓存版本变化时清除界面旧结果，旧订阅不能把结果插回', async () => {
  const f = renderFixture();
  await f.render();
  expect(f.get().getAnalysis('old')).toBeDefined();
  const oldCallback = fixture.callbacks[0]!;
  fixture.list.mockResolvedValue([]);
  fixture.status.analysisRevision++;
  await f.render();
  expect(f.get().getAnalysis('old')).toBeUndefined();
  await act(async () => oldCallback({ kind: 'c2c', conv: 'u_peer', results: [sample] }));
  expect(f.get().getAnalysis('old')).toBeUndefined();
  const current = fixture.callbacks.at(-1)!;
  await act(async () => current({ kind: 'c2c', conv: 'u_peer', results: [sample] }));
  expect(f.get().getAnalysis('old')).toBeDefined();
  expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
});

it('旧条数的悬停请求迟到，不把新上下文标为不可分析，允许重新请求', async () => {
  fixture.list.mockResolvedValue([]);
  let finish!: (value: IntentAnalysis | null) => void;
  fixture.analyze.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = renderFixture();
  await f.render();
  act(() => f.get().requestAnalysis('late'));
  expect(fixture.analyze).toHaveBeenCalledTimes(1);
  fixture.status.analysisContextMessages = 0;
  fixture.status.analysisRevision++;
  await f.render();
  await act(async () => finish(null));
  expect(f.get().isUnavailable('late')).toBe(false);
  fixture.analyze.mockResolvedValue({ ...sample, msgId: 'late' });
  await act(async () => f.get().requestAnalysis('late'));
  expect(fixture.analyze).toHaveBeenCalledTimes(2);
  expect(f.get().getAnalysis('late')).toBeDefined();
});

it('推荐缓存版本参与真实组件查询键，不复用旧条数下的客户端结果', async () => {
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(h(IntentSuggestionBar, { kind: 'group', conv: '123', onInsert: () => {} })),
  );
  expect(fixture.suggestQuery).toHaveBeenLastCalledWith(
    { kind: 'group', conv: '123', revision: 0 },
    expect.anything(),
  );
  fixture.status.suggestionRevision++;
  await act(async () =>
    root.render(h(IntentSuggestionBar, { kind: 'group', conv: '123', onInsert: () => {} })),
  );
  expect(fixture.suggestQuery).toHaveBeenLastCalledWith(
    { kind: 'group', conv: '123', revision: 1 },
    expect.anything(),
  );
});
