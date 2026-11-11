import { act, createElement as h, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  IntentSenseProvider,
  useIntentSenseContext,
  type IntentAnalysis,
  type IntentSenseContextValue,
} from '../src/renderer/src/components/intentSense/context';
import { IntentSuggestionBar } from '../src/renderer/src/components/intentSense/IntentSuggestionBar';
import { MessageIntentSense } from '../src/renderer/src/components/intentSense/MessageIntentSense';
import { DEFAULT_ANALYSIS_CONTEXT_MESSAGES } from '@weq/service/intent-context';
import type { IntentAnalysisProgress } from '@weq/service';

const fixture = vi.hoisted(() => ({
  status: {
    enabled: true,
    persistentDisplay: true,
    hoverDisplay: true,
    engine: 'local',
    localReady: true,
    suggestionsEnabled: true,
    analyzeAfterSelf: true,
    suggestAfterSelf: false,
    analysisContextMessages: 0,
    analysisRevision: 0,
    suggestionRevision: 0,
    analysisMode: 'auto',
    loadingAnimation: true,
  },
  list: vi.fn(),
  ensure: vi.fn(),
  analyze: vi.fn(),
  unsubscribe: vi.fn(),
  suggestQuery: vi.fn(),
  callbacks: [] as Array<
    (event: { kind: string; conv: string; results: IntentAnalysis[] }) => void
  >,
  progressCallbacks: [] as Array<(event: IntentAnalysisProgress) => void>,
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
        getSuggestionRound: { useQuery: fixture.suggestQuery },
        getSuggestionHistory: { useQuery: () => ({ data: [], isLoading: false }) },
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
        onAnalysisProgress: {
          subscribe: (
            _input: unknown,
            observer: { onData: (event: IntentAnalysisProgress) => void },
          ) => {
            fixture.progressCallbacks.push(observer.onData);
            return { unsubscribe: vi.fn() };
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
    persistentDisplay: true,
    hoverDisplay: true,
    analyzeAfterSelf: true,
    suggestAfterSelf: false,
    analysisContextMessages: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
    analysisRevision: 0,
    suggestionRevision: 0,
    analysisMode: 'auto',
    loadingAnimation: true,
  };
  fixture.list.mockReset().mockResolvedValue([sample]);
  fixture.ensure.mockReset().mockResolvedValue({ analyzed: 0 });
  fixture.analyze.mockReset().mockResolvedValue(null);
  fixture.unsubscribe.mockClear();
  fixture.callbacks.length = 0;
  fixture.progressCallbacks.length = 0;
  fixture.suggestQuery.mockReset().mockReturnValue({ data: [], isFetching: false });
  fixture.utils.account.intentSense.getSuggestions.invalidate.mockClear();
  fixture.utils.account.intentSense.getProfile.invalidate.mockClear();
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});

function renderFixture() {
  let context: IntentSenseContextValue | null = null;
  const commits: Array<{ cacheState: string | undefined; animated: number }> = [];
  function Consumer({ ids }: { ids: string[] }) {
    context = useIntentSenseContext();
    const ref = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
      commits.push({
        cacheState: context?.cacheState,
        animated: ref.current!.querySelectorAll('.weq-intent-loading-reel').length,
      });
    });
    return h(
      'span',
      { ref },
      context?.getAnalysis('old')?.intent ?? '无缓存',
      ...ids.map((msgId) =>
        h(MessageIntentSense, { key: msgId, msgId, bubbleRef: ref, analyzable: true }),
      ),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (
    latestMessageId?: string | null,
    roamingMessageKey?: string,
    {
      conv = 'u_peer',
      ids = [latestMessageId ?? 'old'],
      manualPendingMessageIds,
    }: { conv?: string; ids?: string[]; manualPendingMessageIds?: ReadonlySet<string> } = {},
  ) =>
    act(async () =>
      root.render(
        h(
          IntentSenseProvider,
          {
            kind: 'c2c',
            conv,
            latestPeerMsgId: null,
            latestMessageId,
            roamingMessageKey,
            manualPendingMessageIds,
          } as Parameters<typeof IntentSenseProvider>[0],
          h(Consumer, { ids }),
        ),
      ),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { render, get: () => context!, commits, host };
}

it('手动分析只标记本轮指定消息，首次提交即有动画，完成或失败后清理，不启动自动分析', async () => {
  fixture.status.analysisMode = 'manual';
  const f = renderFixture();
  const ids = ['old', 'first', 'second', 'unselected'];
  await f.render('second', '', { ids });
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(0);
  const commit = f.commits.length;
  await f.render('second', '', { ids, manualPendingMessageIds: new Set(['first', 'second']) });
  expect(f.get().isPending?.('first')).toBe(true);
  expect(f.get().isPending?.('unselected')).toBe(false);
  expect(f.commits[commit]?.animated).toBe(4);
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(4);
  await act(async () =>
    fixture.callbacks.at(-1)!({
      kind: 'c2c',
      conv: 'u_peer',
      results: [{ ...sample, msgId: 'first' }],
    }),
  );
  await f.render('second', '', { ids, manualPendingMessageIds: new Set(['second']) });
  expect(f.get().isPending?.('first')).toBe(false);
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(2);
  await f.render('second', '', { ids });
  expect(f.get().isPending?.('second')).toBe(false);
  expect(f.host.querySelector('.is-loading')).toBeNull();
  expect(fixture.ensure).not.toHaveBeenCalled();
  expect(fixture.analyze).not.toHaveBeenCalled();
});

it('手动意图模式读取缓存但不自动补齐或悬停分析，新消息和漫游补入也不启动', async () => {
  fixture.status.analysisMode = 'manual';
  const f = renderFixture();
  await f.render('old', '', { ids: ['old', 'unknown'] });
  expect(f.get().getAnalysis('old')).toEqual(sample);
  expect(f.get().automatic).toBe(false);
  expect(f.host.querySelector('.is-loading')).toBeNull();
  await f.render('new', 'roaming:protocol:2:77');
  await act(async () => f.get().requestAnalysis('new'));
  expect(fixture.ensure).not.toHaveBeenCalled();
  expect(fixture.analyze).not.toHaveBeenCalled();
  fixture.status.analysisMode = 'auto';
  await f.render('new', 'roaming:protocol:2:77');
  expect(fixture.ensure).toHaveBeenCalled();
});

it('缓存及真实批次延迟返回时，首个提交已有随机动画，结果原位替换', async () => {
  let finish!: (value: IntentAnalysis[]) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fixture.ensure.mockImplementation(() => new Promise(() => {}));
  const f = renderFixture();
  await f.render('old');
  expect(f.commits[0]).toEqual({ cacheState: 'loading', animated: 2 });
  expect(f.host.querySelector('.weq-intent-chips')?.getAttribute('data-intent-state')).toBe(
    'preparing',
  );
  expect(f.get().isPending?.('old')).toBe(false);
  await act(async () => finish([]));
  expect(f.get().cacheState).toBe('ready');
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(2);
  await act(async () =>
    fixture.progressCallbacks.at(-1)!({
      kind: 'c2c',
      conv: 'u_peer',
      revision: 0,
      total: 1,
      completed: 0,
      failed: 0,
      pendingIds: ['old'],
    }),
  );
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(2);
  await act(async () =>
    fixture.callbacks.at(-1)!({ kind: 'c2c', conv: 'u_peer', results: [sample] }),
  );
  expect(f.host.querySelectorAll('.weq-intent-pill')).toHaveLength(2);
  expect(f.host.querySelector('.is-loading')).toBeNull();
  expect(f.host.querySelector('.weq-intent-chips')?.getAttribute('aria-busy')).toBe('false');
  expect(fixture.analyze).not.toHaveBeenCalled();
});

it('历史翻页、获取和漫游补入首次提交即有占位，不扩大分析范围', async () => {
  fixture.ensure.mockResolvedValue({ analyzed: 0, latestMsgId: 'old' });
  const f = renderFixture();
  await f.render('old');
  const count = fixture.ensure.mock.calls.length;
  await f.render('old', '', { ids: ['history', 'old'] });
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(2);
  expect(fixture.ensure).toHaveBeenCalledTimes(count);
  fixture.ensure.mockResolvedValue({ analyzed: 0, latestMsgId: 'fetched' });
  await f.render('fetched', '', { ids: ['history', 'old', 'fetched'] });
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(4);
  await f.render('fetched', 'roaming:protocol:2:77', {
    ids: ['history', 'roaming:protocol:2:77', 'old', 'fetched'],
  });
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(6);
  expect(fixture.analyze).not.toHaveBeenCalled();
});

it('切换会话后缓存重新读取，旧会话迟到的结果不能结束当前准备态', async () => {
  let finish!: (value: IntentAnalysis[]) => void;
  fixture.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fixture.list.mockImplementationOnce(() => new Promise(() => {}));
  fixture.ensure.mockImplementation(() => new Promise(() => {}));
  const f = renderFixture();
  await f.render('old');
  await f.render('old', '', { conv: 'other' });
  await act(async () => finish([sample]));
  expect(f.get().cacheState).toBe('loading');
  expect(f.get().getAnalysis('old')).toBeUndefined();
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(2);
});

it('缓存读取失败后保留随机动画，但不误报单条分析在途', async () => {
  fixture.list.mockRejectedValueOnce(new Error('合成缓存读取失败'));
  const f = renderFixture();
  await f.render();
  expect(f.get().cacheState).toBe('error');
  expect(f.host.querySelectorAll('.is-loading')).toHaveLength(2);
  expect(f.get().isPending?.('old')).toBe(false);
  expect(f.host.querySelector('.weq-intent-chips')?.getAttribute('aria-busy')).toBe('false');
});

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
  act(() => {
    f.get().requestAnalysis('late');
  });
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
    { kind: 'group', conv: '123', revision: 0, replyAllowed: true },
    expect.anything(),
  );
  fixture.status.suggestionRevision++;
  await act(async () =>
    root.render(h(IntentSuggestionBar, { kind: 'group', conv: '123', onInsert: () => {} })),
  );
  expect(fixture.suggestQuery).toHaveBeenLastCalledWith(
    { kind: 'group', conv: '123', revision: 1, replyAllowed: true },
    expect.anything(),
  );
});

it('自己的新消息触发增量分析，旧批次未包含它时单条补齐，不触发推荐刷新', async () => {
  fixture.list.mockResolvedValue([]);
  let finish!: (stats: { analyzed: number; failed: number; latestMsgId: string }) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  fixture.ensure.mockReturnValue(pending);
  fixture.analyze.mockResolvedValue({ ...sample, msgId: 'own', mine: true });
  const f = renderFixture();
  await f.render(null);
  await f.render('own');
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
  await act(async () => finish({ analyzed: 1, failed: 0, latestMsgId: 'peer-before' }));
  expect(fixture.analyze).toHaveBeenCalledTimes(1);
  expect(fixture.analyze).toHaveBeenCalledWith({ kind: 'c2c', conv: 'u_peer', msgId: 'own' });
  expect(f.get().getAnalysis('own')?.mine).toBe(true);
  expect(f.get().latestMessageId).toBe('own');
  expect(fixture.utils.account.intentSense.getSuggestions.invalidate).not.toHaveBeenCalled();
});

it('快速连发复用旧批次时重新补齐范围，不只单查最后一条', async () => {
  fixture.list.mockResolvedValue([]);
  let finish!: (stats: { analyzed: number; failed: number; latestMsgId: string }) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  fixture.ensure.mockReturnValueOnce(pending).mockReturnValueOnce(pending);
  fixture.ensure.mockImplementationOnce(async () => {
    fixture.callbacks.at(-1)!({
      kind: 'c2c',
      conv: 'u_peer',
      results: ['own-1', 'own-2', 'own-3'].map((msgId) => ({ ...sample, msgId, mine: true })),
    });
    return { analyzed: 3, peerAnalyzed: 0, failed: 0, latestMsgId: 'own-3' };
  });
  const f = renderFixture();
  await f.render(null);
  await f.render('own-3');
  await act(async () => finish({ analyzed: 0, failed: 0, latestMsgId: 'peer-before' }));
  expect(fixture.ensure).toHaveBeenCalledTimes(3);
  for (const msgId of ['own-1', 'own-2', 'own-3'])
    expect(f.get().getAnalysis(msgId)?.mine).toBe(true);
  expect(fixture.analyze).not.toHaveBeenCalled();
  expect(fixture.utils.account.intentSense.getSuggestions.invalidate).not.toHaveBeenCalled();
});

it.each([{ failed: 1 }, { error: 'fixture-error' }, { skipped: 'disabled' }])(
  '旧批次失败或被禁用时不追加重试：%j',
  async (stats) => {
    fixture.list.mockResolvedValue([]);
    fixture.ensure.mockResolvedValue({ analyzed: 0, latestMsgId: 'peer-before', ...stats });
    const f = renderFixture();
    await f.render('own');
    expect(fixture.ensure).toHaveBeenCalledTimes(1);
    expect(fixture.analyze).not.toHaveBeenCalled();
    expect(f.get().settled).toBe(true);
  },
);

it('关闭自己发送后分析时不发增量请求，推荐开关独立控制建议查询', async () => {
  fixture.status.analyzeAfterSelf = false;
  const f = renderFixture();
  await f.render('own');
  expect(fixture.ensure).not.toHaveBeenCalled();
  expect(f.get().settled).toBe(true);
  const host = document.createElement('div');
  const root = createRoot(host);
  cleanups.push(() => act(() => root.unmount()));
  const render = () =>
    act(async () =>
      root.render(
        h(IntentSuggestionBar, {
          kind: 'c2c',
          conv: 'u_peer',
          replyTargetId: null,
          latestMessageId: 'own',
          onInsert: () => {},
        }),
      ),
    );
  await render();
  expect(fixture.suggestQuery).toHaveBeenLastCalledWith(
    expect.objectContaining({ replyAllowed: false }),
    expect.objectContaining({ enabled: false }),
  );
  fixture.status.suggestAfterSelf = true;
  await render();
  expect(fixture.suggestQuery).toHaveBeenLastCalledWith(
    expect.objectContaining({ replyAllowed: true, targetId: 'own' }),
    expect.objectContaining({ enabled: true }),
  );
  expect(fixture.ensure).not.toHaveBeenCalled();
});

it('只更新自己的分析时，不触发对方画像或建议的模型刷新', async () => {
  fixture.list.mockResolvedValue([]);
  fixture.ensure.mockResolvedValue({ analyzed: 1, peerAnalyzed: 0, failed: 0, latestMsgId: 'own' });
  const f = renderFixture();
  await f.render('own');
  expect(fixture.utils.account.intentSense.getProfile.invalidate).not.toHaveBeenCalled();
  expect(fixture.utils.account.intentSense.getSuggestions.invalidate).not.toHaveBeenCalled();
});

it('补入较早的漫游消息时，最新消息不变也重新补齐分析；相同列表不重复触发', async () => {
  fixture.ensure.mockResolvedValue({ analyzed: 0, failed: 0, latestMsgId: 'own' });
  const f = renderFixture();
  await f.render('own', '');
  expect(fixture.ensure).toHaveBeenCalledTimes(1);
  await f.render('own', 'roaming:protocol:2:77');
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
  await f.render('own', 'roaming:protocol:2:77');
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
  fixture.status.analyzeAfterSelf = false;
  await f.render('own', 'roaming:protocol:2:77|roaming:protocol:3:77');
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
});

it('显示开关即时进入消息上下文，不清空结果、不额外触发自动分析', async () => {
  fixture.ensure.mockResolvedValue({ analyzed: 0, failed: 0, latestMsgId: 'own' });
  const f = renderFixture();
  await f.render('own');
  fixture.status.persistentDisplay = false;
  await f.render('own');
  expect(f.get()).toMatchObject({ persistentDisplay: false, hoverDisplay: true });
  fixture.status.hoverDisplay = false;
  await f.render('own');
  expect(f.get()).toMatchObject({ persistentDisplay: false, hoverDisplay: false });
  expect(f.get().getAnalysis('old')).toBeDefined();
  expect(fixture.ensure).toHaveBeenCalledTimes(1);
});

it('单条分析在途状态逐条通知，结束后停止窄条并标记不可用', async () => {
  let finish!: (value: null) => void;
  fixture.analyze.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = renderFixture();
  await f.render();
  act(() => {
    f.get().requestAnalysis('pending');
  });
  expect(f.get().isPending?.('pending')).toBe(true);
  expect(f.get().isPending?.('another')).toBe(false);
  await act(async () => finish(null));
  expect(f.get().isPending?.('pending')).toBe(false);
  expect(f.get().isUnavailable('pending')).toBe(true);
});

it('批次只标记真实待分析消息，拒收其他会话及旧配置进度', async () => {
  fixture.ensure.mockImplementation(() => new Promise(() => {}));
  const f = renderFixture();
  await f.render('own');
  const publish = fixture.progressCallbacks.at(-1)!;
  const event: IntentAnalysisProgress = {
    kind: 'c2c',
    conv: 'u_peer',
    revision: 0,
    total: 2,
    completed: 1,
    failed: 0,
    pendingIds: ['pending'],
  };
  await act(async () => publish(event));
  expect(f.get().isPending?.('pending')).toBe(true);
  expect(f.get().isPending?.('outside')).toBe(false);
  expect(document.querySelector('.weq-int-batch')).toBeNull();
  await act(async () => publish({ ...event, conv: 'other', pendingIds: ['outside'] }));
  expect(f.get().isPending?.('outside')).toBe(false);
  fixture.status.analysisRevision++;
  await f.render('own');
  await act(async () => publish(event));
  expect(f.get().isPending?.('pending')).toBe(false);
});

it('批次失败显示可重试状态，成功重试清除失败且保留旧分析', async () => {
  fixture.ensure.mockResolvedValueOnce({ analyzed: 0, failed: 1, latestMsgId: 'own' });
  const f = renderFixture();
  await f.render('own');
  expect(document.body.textContent).toContain('分析未完成：1 条消息失败');
  expect(f.get().getAnalysis('old')).toBeDefined();
  fixture.ensure.mockResolvedValue({ analyzed: 1, failed: 0, latestMsgId: 'own' });
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="重试分析"]')!.click(),
  );
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.weq-int-batch')).toBeNull();
});

it('分析中不显示批次状态，结束后仅显示失败提示与重试入口', async () => {
  let finish!: (stats: { analyzed: number; failed: number; latestMsgId: string }) => void;
  fixture.ensure.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = renderFixture();
  await f.render('own');
  const publish = fixture.progressCallbacks.at(-1)!;
  await act(async () =>
    publish({
      kind: 'c2c',
      conv: 'u_peer',
      revision: 0,
      total: 18,
      completed: 12,
      failed: 3,
      pendingIds: ['pending'],
    }),
  );
  expect(document.querySelector('.weq-int-batch')).toBeNull();
  expect(document.querySelector('[aria-label="重试分析"]')).toBeNull();
  await act(async () => finish({ analyzed: 15, failed: 3, latestMsgId: 'own' }));
  const status = document.querySelector<HTMLElement>('.weq-int-batch')!;
  expect(status.textContent).toContain('分析未完成：3 条消息失败');
  expect(status.querySelector('span')?.title).toContain('已处理 18/18，成功 15，失败 3');
  expect(document.querySelector('[aria-label="重试分析"]')).not.toBeNull();
});

it('全部失败时显示失败数量，重试成功后隐藏状态', async () => {
  fixture.ensure.mockResolvedValueOnce({ analyzed: 0, failed: 2, latestMsgId: 'own' });
  const f = renderFixture();
  await f.render('own');
  expect(document.body.textContent).toContain('分析未完成：2 条消息失败');
  fixture.ensure.mockResolvedValueOnce({ cached: 1, analyzed: 2, failed: 0, latestMsgId: 'own' });
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="重试分析"]')!.click(),
  );
  expect(document.querySelector('.weq-int-batch')).toBeNull();
  expect(document.querySelector('[aria-label="重试分析"]')).toBeNull();
});

it.each([0, 2])('分析成功或已是最新时不显示状态（新增 %i 条）', async (analyzed) => {
  fixture.ensure.mockResolvedValueOnce({ analyzed, failed: 0, latestMsgId: 'own' });
  const f = renderFixture();
  await f.render('own');
  expect(document.querySelector('.weq-int-batch')).toBeNull();
});

it('分析请求异常时显示错误，重试在途时收起提示', async () => {
  fixture.ensure.mockRejectedValueOnce(new Error('合成错误'));
  const f = renderFixture();
  await f.render('own');
  expect(document.body.textContent).toContain('分析未完成：合成错误');
  fixture.ensure.mockImplementationOnce(() => new Promise(() => {}));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="重试分析"]')!.click(),
  );
  expect(document.querySelector('.weq-int-batch')).toBeNull();
});

it('单条请求失败不冒充纯媒体，允许重试而不会无限转圈', async () => {
  fixture.analyze.mockRejectedValueOnce(new Error('合成错误'));
  const f = renderFixture();
  await f.render();
  await act(async () => f.get().requestAnalysis('failed'));
  expect(f.get().isPending?.('failed')).toBe(false);
  expect(f.get().isUnavailable('failed')).toBe(false);
  expect(f.get().getFailure?.('failed')).toBe('合成错误');
  fixture.analyze.mockResolvedValue({ ...sample, msgId: 'failed' });
  await act(async () => f.get().requestAnalysis('failed'));
  expect(f.get().getFailure?.('failed')).toBeUndefined();
  expect(f.get().getAnalysis('failed')).toBeDefined();
});
