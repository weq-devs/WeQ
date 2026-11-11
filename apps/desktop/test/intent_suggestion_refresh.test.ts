import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntentSuggestionBar } from '../src/renderer/src/components/intentSense/IntentSuggestionBar';
import type { ReplySuggestionHistoryEntry } from '@weq/service';

const fixture = vi.hoisted(() => ({
  data: [{ text: '旧候选' }] as { text: string }[] | undefined,
  fetching: false,
  status: {
    suggestionsEnabled: true,
    suggestionRevision: 0,
    suggestAfterSelf: false,
    suggestionMode: 'auto',
  },
  query: vi.fn(),
  refresh: vi.fn(),
  stop: vi.fn(async () => true),
  error: null as Error | null,
  historyQuery: vi.fn(),
  historyRefetch: vi.fn(async () => {}),
  detailQuery: vi.fn(),
  roundOverride: undefined as ReplySuggestionHistoryEntry | null | undefined,
  rounds: new WeakMap<object, ReplySuggestionHistoryEntry>(),
  sequence: 0,
}));
function roundFor(list: { text: string }[] | undefined, targetId?: string, useHistory = true) {
  if (!list) return undefined;
  if (!list.length) return null;
  const cached = fixture.rounds.get(list);
  if (cached) return cached;
  const history: ReplySuggestionHistoryEntry[] =
    fixture.historyQuery.mock.results.at(-1)?.value?.data ?? [];
  const round = (useHistory
    ? history.find((entry) => JSON.stringify(entry.suggestions) === JSON.stringify(list))
    : undefined) ?? {
    id: `fixture-${++fixture.sequence}`,
    createdAt: 0,
    target: { msgId: targetId ?? 'fixture', msgSeq: '77', senderUin: '10000', sendTime: 1000 },
    suggestions: list,
  };
  fixture.rounds.set(list, round);
  return round;
}
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseStatus: () => ({ data: fixture.status }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      intentSense: {
        getSuggestionRound: {
          query: async (input: { targetId?: string }) => {
            const value = await fixture.refresh(input);
            return Array.isArray(value) ? roundFor(value, input.targetId, false) : value;
          },
        },
        stopSuggestions: { mutate: fixture.stop },
      },
    },
  },
  trpc: {
    account: {
      intentSense: {
        getSuggestionRound: {
          useQuery: (input: { targetId?: string }, options: unknown) => {
            const result = fixture.query(input, options);
            return {
              ...result,
              data:
                fixture.roundOverride !== undefined
                  ? fixture.roundOverride
                  : roundFor(result.data, input.targetId),
            };
          },
        },
        getSuggestionHistory: { useQuery: fixture.historyQuery },
        getSuggestionDetails: { useQuery: fixture.detailQuery },
      },
    },
  },
}));
beforeEach(() => {
  fixture.data = [{ text: '旧候选' }];
  fixture.fetching = false;
  fixture.error = null;
  fixture.status = {
    suggestionsEnabled: true,
    suggestionRevision: 0,
    suggestAfterSelf: false,
    suggestionMode: 'auto',
  };
  fixture.query.mockReset().mockImplementation(() => ({
    data: fixture.data,
    isFetching: fixture.fetching,
    error: fixture.error,
  }));
  fixture.refresh.mockReset();
  fixture.roundOverride = undefined;
  fixture.rounds = new WeakMap();
  fixture.sequence = 0;
  fixture.detailQuery.mockReset().mockReturnValue({
    data: null,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
  fixture.stop.mockClear();
  fixture.historyRefetch.mockClear();
  fixture.historyQuery.mockReset().mockReturnValue({
    data: [],
    isLoading: false,
    isFetching: false,
    refetch: fixture.historyRefetch,
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each(['c2c', 'group'] as const)(
  '手动推荐 %s 只由开始按钮生成，收到新消息也不自动请求',
  async (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.status.suggestionMode = 'manual';
    fixture.data = undefined;
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (id: string, replyTargetId: string | null = id) =>
      act(() =>
        root.render(
          createElement(IntentSuggestionBar, {
            kind,
            conv: 'fixture',
            latestMessageId: id,
            replyTargetId,
            onInsert: vi.fn(),
          }),
        ),
      );
    try {
      render('first');
      expect(fixture.query.mock.calls.at(-1)?.[1].enabled).toBe(false);
      const button = host.querySelector<HTMLButtonElement>('[aria-label="开始推荐回复"]')!;
      expect(button.querySelector('.lucide-play')).not.toBeNull();
      expect(fixture.refresh).not.toHaveBeenCalled();
      fixture.refresh.mockResolvedValue([{ text: '手动候选' }]);
      render('self', null);
      await act(async () => button.click());
      expect(fixture.refresh).toHaveBeenCalledWith(
        expect.objectContaining({ refresh: true, targetId: 'self' }),
      );
      expect(host.textContent).toContain('手动候选');
      render('next');
      expect(fixture.query.mock.calls.at(-1)?.[1].enabled).toBe(false);
      expect(host.textContent).toContain('手动候选');
      expect(fixture.refresh).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  },
);

it('相同候选仍按轮次 ID 区分，正式详情和历史日期打开对应轮次，展开日志不重新生成', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const first: ReplySuggestionHistoryEntry = {
    id: 'first',
    createdAt: 1000,
    target: { msgId: 'original', msgSeq: '1', sendTime: 1, senderUin: '10000' },
    suggestions: [{ text: '相同候选' }],
    summary: '第一轮概括',
    generation: {
      source: 'api',
      model: 'model-first',
      providerName: '测试供应商',
      startedAt: 900,
      durationMs: 100,
      requestDurationMs: 90,
      inputMessages: 2,
    },
  };
  const second = {
    ...first,
    id: 'second',
    summary: '第二轮概括',
    target: { ...first.target, msgId: 'second', msgSeq: '2' },
  };
  fixture.roundOverride = first;
  fixture.historyQuery.mockReturnValue({
    data: [second, first],
    isLoading: false,
    isFetching: false,
    refetch: fixture.historyRefetch,
  });
  fixture.detailQuery.mockImplementation(({ id }: { id: string }) => ({
    data: {
      entry: id === 'first' ? first : second,
      trace: {
        prompt: { system: '实际系统提示词', user: '实际输入消息' },
        response: '{"summary":"原始概括"}',
      },
    },
    isLoading: false,
    error: null,
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, {
          kind: 'c2c',
          conv: 'fixture',
          latestMessageId: 'newer',
          onInsert: vi.fn(),
        }),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开回复历史"]')!.click());
    expect(host.querySelectorAll('.weq-int-history-row')).toHaveLength(1);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="查看当前推荐详情"]')!.click());
    expect(fixture.detailQuery.mock.calls.at(-1)?.[0].id).toBe('first');
    const panel = document.querySelector('.weq-int-round-details')!;
    expect(panel.textContent).toContain('第一轮概括');
    expect(panel.textContent).toContain('model-first');
    act(() => panel.querySelector<HTMLButtonElement>('.weq-int-round-log-toggle')!.click());
    expect(panel.querySelector('.weq-exp-log')?.textContent).toContain('实际系统提示词');
    expect(panel.querySelector('.weq-exp-log')?.textContent).toContain('实际输入消息');
    act(() => panel.querySelector<HTMLButtonElement>('[aria-label="关闭推荐详情"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="查看本轮推荐详情"]')!.click());
    expect(fixture.detailQuery.mock.calls.at(-1)?.[0].id).toBe('second');
    expect(document.querySelector('.weq-int-round-details')?.textContent).toContain('第二轮概括');
    expect(fixture.refresh).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each([false, true])(
  '生成中有旧候选=%s 仍可打开当前轮实时详情，完成后不跳到其他轮次',
  (hasPrevious) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.fetching = true;
    fixture.data = hasPrevious ? [{ text: '旧候选' }] : undefined;
    let done = false;
    const entry: ReplySuggestionHistoryEntry = {
      id: 'running-round',
      createdAt: 1000,
      target: { msgId: 'message', senderUin: '10000', sendTime: 1 },
      suggestions: [],
    };
    fixture.detailQuery.mockImplementation(() => ({
      data: {
        entry: done
          ? { ...entry, summary: '新一轮概括', suggestions: [{ text: '新候选' }] }
          : entry,
        progress: {
          id: entry.id,
          status: done ? 'completed' : 'running',
          stage: done ? '生成完成' : '等待模型返回',
          startedAt: 900,
          updatedAt: 1000,
        },
        trace: {
          logs: [
            { seq: 1, ts: 900, stage: '读取输入', level: 'info', text: '正在读取输入' },
            ...(done
              ? [{ seq: 2, ts: 1000, stage: '生成完成', level: 'info', text: '本轮生成完成' }]
              : []),
          ],
        },
      },
      isLoading: false,
      error: null,
    }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
      act(() =>
        root.render(
          createElement(IntentSuggestionBar, {
            kind: 'c2c',
            conv: 'fixture',
            latestMessageId: 'message',
            onInsert: vi.fn(),
          }),
        ),
      );
    try {
      render();
      const button = host.querySelector<HTMLButtonElement>('[aria-label="查看当前推荐详情"]')!;
      expect(button.disabled).toBe(false);
      act(() => button.click());
      expect(fixture.detailQuery.mock.calls[0]?.[0].id).toBeUndefined();
      expect(fixture.detailQuery.mock.calls.at(-1)?.[0].id).toBe(entry.id);
      let panel = document.querySelector('.weq-int-round-details')!;
      expect(panel.textContent).toContain('等待模型返回');
      expect(panel.querySelector('[role="log"]')?.textContent).toContain('正在读取输入');
      const interval = fixture.detailQuery.mock.calls.at(-1)?.[1].refetchInterval;
      expect(interval(fixture.detailQuery.mock.results.at(-1)?.value.data)).toBe(500);
      done = true;
      fixture.fetching = false;
      render();
      panel = document.querySelector('.weq-int-round-details')!;
      expect(panel.textContent).toContain('新一轮概括');
      expect(panel.querySelector('[role="log"]')?.textContent).toContain('本轮生成完成');
      expect(interval(fixture.detailQuery.mock.results.at(-1)?.value.data)).toBe(false);
      expect(fixture.refresh).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each([true, false])(
  '历史已覆盖最新消息=%s：过期推荐仅在输入仍为最新时复用，手动换一批始终可用',
  async (matchesLatest) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.data = undefined;
    fixture.fetching = true;
    fixture.historyQuery.mockReturnValue({
      data: [
        {
          id: 'expired',
          createdAt: Date.now() - 3_600_000,
          target: {
            msgId: matchesLatest ? 'latest' : 'older',
            msgSeq: '77',
            senderUin: '10000',
            sendTime: 1000,
          },
          suggestions: [{ text: '一小时前推荐' }],
        },
      ],
      isLoading: false,
      isFetching: false,
      refetch: fixture.historyRefetch,
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (id = 'latest') =>
      act(() =>
        root.render(
          createElement(IntentSuggestionBar, {
            kind: 'c2c',
            conv: 'fixture',
            latestMessageId: id,
            onInsert: vi.fn(),
          }),
        ),
      );
    try {
      render();
      expect(fixture.query.mock.calls.at(-1)?.[1].enabled).toBe(!matchesLatest);
      expect(host.querySelector('.weq-int-suggest-track')?.textContent).toBe(
        matchesLatest ? '一小时前推荐' : '正在生成推荐回复',
      );
      if (matchesLatest) {
        fixture.refresh.mockResolvedValue([{ text: '手动新推荐' }]);
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[aria-label="换一批建议"]')!.click(),
        );
        expect(fixture.refresh).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
        expect(host.querySelector('.weq-int-suggest-track')?.textContent).toBe('手动新推荐');
        fixture.fetching = false;
        render('next');
        expect(fixture.query.mock.calls.at(-1)?.[1].enabled).toBe(true);
      }
    } finally {
      act(() => root.unmount());
    }
  },
);

it('手动刷新后历史补全不把正式栏回退到旧的自动查询结果', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, {
          kind: 'c2c',
          conv: 'fixture',
          replyTargetId: 'peer',
          latestMessageId: 'peer',
          onInsert: vi.fn(),
        }),
      ),
    );
  try {
    render();
    fixture.refresh.mockResolvedValue([{ text: '手动推荐' }]);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="换一批建议"]')!.click(),
    );
    fixture.historyQuery.mockReturnValue({
      data: [
        {
          id: 'manual',
          createdAt: Date.now(),
          target: { msgId: 'peer', sendTime: 1000, senderUin: '10000' },
          suggestions: [{ text: '手动推荐' }],
        },
      ],
      isLoading: false,
      isFetching: false,
      refetch: fixture.historyRefetch,
    });
    render();
    expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('手动推荐');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开回复历史"]')!.click());
    expect(host.querySelectorAll('.weq-int-history-row')).toHaveLength(0);
  } finally {
    act(() => root.unmount());
  }
});

it('正式推荐栏的灯泡定位当前轮实际输入，历史定位使用相同灯泡', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const target = { msgId: 'original', msgSeq: '77', sendTime: 1000, senderUin: '10000' };
  fixture.historyQuery.mockReturnValue({
    data: [
      { id: 'current', createdAt: Date.now(), target, suggestions: [{ text: '旧候选' }] },
      {
        id: 'old',
        createdAt: 1000,
        target: { ...target, msgSeq: '66' },
        suggestions: [{ text: '更早候选' }],
      },
    ],
    isLoading: false,
    isFetching: false,
    refetch: fixture.historyRefetch,
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const onLocate = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, {
          kind: 'c2c',
          conv: 'fixture',
          latestMessageId: 'newer',
          onInsert: vi.fn(),
          onLocate,
        }),
      ),
    );
    const current = host.querySelector<HTMLButtonElement>(
      '[aria-label="定位到当前推荐的最后一条输入消息"]',
    )!;
    expect(current.disabled).toBe(false);
    expect(current.querySelector('.lucide-lightbulb')).not.toBeNull();
    act(() => current.click());
    expect(onLocate).toHaveBeenLastCalledWith(target);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开回复历史"]')!.click());
    expect(host.querySelector('.weq-int-history .lucide-lightbulb')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it.each([0, 60_000, 60_001])(
  '进入会话恢复 %sms 前的最新推荐，停留时不因时间流逝清空',
  async (age) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    fixture.data = undefined;
    fixture.fetching = true;
    fixture.historyQuery.mockReturnValue({
      data: [
        {
          id: 'recent',
          createdAt: now - age,
          target: { msgId: 'old', senderUin: '10000', sendTime: 1000 },
          suggestions: [{ text: '最近推荐' }],
        },
      ],
      isLoading: false,
      isFetching: false,
      refetch: fixture.historyRefetch,
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = () =>
      act(() =>
        root.render(
          createElement(IntentSuggestionBar, {
            kind: 'c2c',
            conv: 'fixture',
            onInsert: vi.fn(),
            onLocate: vi.fn(),
          }),
        ),
      );
    try {
      render();
      expect(host.querySelector('.weq-int-suggest-track')?.textContent).toBe(
        age <= 60_000 ? '最近推荐' : '正在生成推荐回复',
      );
      clock.mockReturnValue(now + 120_000);
      render();
      expect(host.querySelector('.weq-int-suggest-track')?.textContent).toBe(
        age <= 60_000 ? '最近推荐' : '正在生成推荐回复',
      );
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开回复历史"]')!.click());
      expect(host.querySelectorAll('.weq-int-history-row')).toHaveLength(age <= 60_000 ? 0 : 1);
      if (age > 60_000)
        expect(
          host.querySelector<HTMLButtonElement>('[aria-label="定位到本次推荐的最后一条输入消息"]')!
            .disabled,
        ).toBe(false);
    } finally {
      act(() => root.unmount());
      clock.mockRestore();
    }
  },
);

it('在途推荐悬停变为停止，停止保留候选并抑制本条重试，新消息恢复自动推荐', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.fetching = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (id = 'first') =>
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, {
          kind: 'c2c',
          conv: 'fixture',
          latestMessageId: id,
          onInsert: vi.fn(),
        }),
      ),
    );
  try {
    render();
    const button = host.querySelector<HTMLButtonElement>('.weq-int-suggest-action')!;
    act(() => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(button.getAttribute('aria-label')).toBe('停止推荐回复');
    await act(async () => button.click());
    expect(fixture.stop).toHaveBeenCalledWith({ kind: 'c2c', conv: 'fixture' });
    expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('旧候选');
    expect(fixture.query.mock.calls.at(-1)?.[1].enabled).toBe(false);
    fixture.fetching = false;
    render('next');
    expect(fixture.query.mock.calls.at(-1)?.[1].enabled).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});

it('首次生成用文字提示、刷新时保留候选，自动请求中不能叠加换一批', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.data = undefined;
  fixture.fetching = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, { kind: 'c2c', conv: 'fixture', onInsert: vi.fn() }),
      ),
    );
  try {
    render();
    expect(host.querySelector('.weq-int-suggest-track')?.textContent).toBe('正在生成推荐回复');
    expect(host.querySelector('.is-skeleton')).toBeNull();
    const refresh = host.querySelector<HTMLButtonElement>('[aria-label="换一批建议"]')!;
    expect(refresh.disabled).toBe(false);
    expect(fixture.refresh).not.toHaveBeenCalled();
    fixture.fetching = false;
    fixture.error = new Error('合成错误');
    render();
    expect(host.querySelector('.weq-int-suggest-track')?.textContent).toContain('失败');
    expect(refresh.disabled).toBe(false);
  } finally {
    act(() => root.unmount());
  }
});

it('箭头展开逐轮历史，点击历史候选只填草稿，左侧定位真实输入末条，更新时刷新历史', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const target = { msgId: 'snapshot-last', msgSeq: '77', senderUin: '10000', sendTime: 1000 };
  fixture.historyQuery.mockReturnValue({
    data: [
      {
        id: 'round-2',
        createdAt: 2000,
        target,
        suggestions: [{ text: '历史候选二' }, { text: '历史候选三' }],
      },
      {
        id: 'round-1',
        createdAt: 1000,
        target: { ...target, msgSeq: '66' },
        suggestions: [{ text: '历史候选一' }],
      },
    ],
    isLoading: false,
    isFetching: false,
    refetch: fixture.historyRefetch,
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const onInsert = vi.fn(),
    onLocate = vi.fn();
  const render = (conv = 'fixture') =>
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, {
          kind: 'c2c',
          conv,
          latestMessageId: 'newer-message',
          onInsert,
          onLocate,
        }),
      ),
    );
  try {
    render();
    expect(fixture.historyQuery).toHaveBeenCalled();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开回复历史"]')!.click());
    expect(host.querySelector('.weq-int-suggest')?.classList.contains('is-history-open')).toBe(
      true,
    );
    expect(host.querySelectorAll('.weq-int-history-row')).toHaveLength(2);
    expect(host.querySelector('[aria-label="收起回复历史"]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="定位到本次推荐的最后一条输入消息"]')!
        .click(),
    );
    expect(onLocate).toHaveBeenCalledWith({ ...target, msgSeq: '66' });
    act(() =>
      host.querySelector<HTMLButtonElement>('.weq-int-history-row .weq-int-suggest-pill')!.click(),
    );
    expect(onInsert).toHaveBeenCalledWith('历史候选一');
    fixture.data = [{ text: '新一轮候选' }];
    render();
    expect(fixture.historyRefetch).toHaveBeenCalledOnce();
    render('other');
    expect(host.querySelector('.weq-int-history')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('手动刷新返回空结果不清空已有候选，后续非空结果直接替换', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, {
          kind: 'group',
          conv: 'fixture',
          latestMessageId: 'peer',
          onInsert: vi.fn(),
        }),
      ),
    );
    const track = host.querySelector('.weq-int-suggest-track');
    const button = host.querySelector<HTMLButtonElement>('[aria-label="换一批建议"]')!;
    fixture.refresh.mockResolvedValue([]);
    await act(async () => button.click());
    expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('旧候选');
    fixture.refresh.mockResolvedValue([{ text: '新候选' }]);
    await act(async () => button.click());
    expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('新候选');
    expect(host.querySelector('.weq-int-suggest-track')).toBe(track);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each([false, true])(
  '自动查询允许=%s 时均可手动换一批，保留旧候选直到结果返回',
  async (replyAllowed) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let finish!: (list: { text: string }[]) => void;
    fixture.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (replyTargetId: string | null, latestMessageId: string) =>
      act(() =>
        root.render(
          createElement(IntentSuggestionBar, {
            kind: 'group',
            conv: 'fixture',
            replyTargetId,
            latestMessageId,
            onInsert: vi.fn(),
          }),
        ),
      );
    try {
      render('peer', 'peer');
      if (!replyAllowed) {
        fixture.data = undefined;
        render(null, 'self');
      }
      const button = host.querySelector<HTMLButtonElement>('[aria-label="换一批建议"]')!;
      expect(button.disabled).toBe(false);
      await act(async () => {
        button.click();
        button.click();
      });
      expect(fixture.refresh).toHaveBeenCalledTimes(1);
      expect(fixture.refresh).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'group',
          conv: 'fixture',
          refresh: true,
        }),
      );
      expect(fixture.refresh.mock.calls[0]?.[0].replyAllowed).not.toBe(false);
      expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('旧候选');
      await act(async () => finish([{ text: '手动新候选' }]));
      expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('手动新候选');
      expect(button.disabled).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each(['message', 'conversation', 'config', 'error'])(
  '手动刷新期间发生 %s 时新消息不打断，会话及配置切换丢弃旧结果，失败可重试',
  async (change) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let finish!: (list: { text: string }[]) => void;
    let fail!: (error: Error) => void;
    fixture.refresh.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (latestMessageId = 'peer', conv = 'fixture') =>
      act(() =>
        root.render(
          createElement(IntentSuggestionBar, {
            kind: 'group',
            conv,
            replyTargetId: latestMessageId,
            latestMessageId,
            onInsert: vi.fn(),
          }),
        ),
      );
    try {
      render();
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="换一批建议"]')!.click(),
      );
      if (change === 'error') {
        await act(async () => fail(new Error('合成失败')));
        expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('旧候选');
      } else {
        fixture.data = [{ text: '当前候选' }];
        if (change === 'config') fixture.status.suggestionRevision++;
        render(
          change === 'message' ? 'next-peer' : 'peer',
          change === 'conversation' ? 'other' : 'fixture',
        );
        await act(async () => finish([{ text: '迟到候选' }]));
        expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe(
          change === 'message' ? '迟到候选' : '当前候选',
        );
      }
      const button = host.querySelector<HTMLButtonElement>('[aria-label="换一批建议"]')!;
      expect(button.disabled).toBe(false);
      fixture.refresh.mockResolvedValue([{ text: '重试候选' }]);
      await act(async () => button.click());
      expect(host.querySelector('.weq-int-suggest-text')?.textContent).toBe('重试候选');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each([false, true])(
  '自己发送后推荐=%s 时保留原候选，等待新推荐直接替换，关闭功能后清空',
  (suggestAfterSelf) => {
    fixture.status.suggestAfterSelf = suggestAfterSelf;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onInsert = vi.fn();
    const render = (replyTargetId: string | null, latestMessageId: string) =>
      act(() =>
        root.render(
          createElement(IntentSuggestionBar, {
            kind: 'group',
            conv: 'fixture',
            replyTargetId,
            latestMessageId,
            onInsert,
          }),
        ),
      );
    const text = () => host.querySelector('.weq-int-suggest-text')?.textContent;
    try {
      render('peer', 'peer');
      const track = host.querySelector('.weq-int-suggest-track');
      fixture.data = undefined;
      fixture.fetching = suggestAfterSelf;
      render(null, 'self');
      expect(fixture.query.mock.calls.at(-1)?.[1].enabled).toBe(suggestAfterSelf);
      expect(text()).toBe('旧候选');
      expect(host.querySelector('.weq-int-suggest-track')).toBe(track);
      act(() => host.querySelector<HTMLButtonElement>('.weq-int-suggest-pill')!.click());
      expect(onInsert).toHaveBeenCalledWith('旧候选');
      if (!suggestAfterSelf) fixture.data = [];
      render(null, 'self-again');
      expect(text()).toBe('旧候选');
      fixture.data = undefined;
      fixture.fetching = true;
      render('next-peer', 'next-peer');
      expect(text()).toBe('旧候选');
      fixture.data = [{ text: '新推荐' }];
      fixture.fetching = false;
      render('next-peer', 'next-peer');
      expect(text()).toBe('新推荐');
      fixture.status.suggestionsEnabled = false;
      render(null, 'self-last');
      expect(host.querySelector('.weq-int-suggest')).toBeNull();
      fixture.status.suggestionsEnabled = true;
      fixture.data = undefined;
      render(null, 'self-last');
      expect(host.querySelector('.weq-int-suggest')).not.toBeNull();
      expect(host.querySelector('.weq-int-suggest-empty')?.textContent).toBe(
        suggestAfterSelf ? '暂无推荐回复' : '等待对方新消息',
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('新消息加载保留可点击的旧候选，结果到达后替换，会话及配置切换不沿用旧候选', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onInsert = vi.fn();
  const render = (latestMessageId = 'first', conv = 'fixture', kind: 'group' | 'c2c' = 'group') =>
    act(() =>
      root.render(createElement(IntentSuggestionBar, { kind, conv, latestMessageId, onInsert })),
    );
  const text = () => host.querySelector('.weq-int-suggest-text')?.textContent;
  try {
    render();
    fixture.data = undefined;
    fixture.fetching = true;
    render('second');
    expect(text()).toBe('旧候选');
    expect(host.querySelector('.is-skeleton')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.weq-int-suggest-pill')!.click());
    expect(onInsert).toHaveBeenCalledWith('旧候选');
    render('third');
    expect(text()).toBe('旧候选');
    fixture.data = [{ text: '新候选' }];
    fixture.fetching = false;
    render('third');
    expect(text()).toBe('新候选');
    fixture.data = undefined;
    fixture.fetching = true;
    render('fourth', 'other');
    expect(text()).toBeUndefined();
    fixture.data = [{ text: '另一会话候选' }];
    fixture.fetching = false;
    render('fourth', 'other');
    fixture.data = undefined;
    fixture.fetching = true;
    render('fifth', 'other', 'c2c');
    expect(text()).toBeUndefined();
    fixture.data = [{ text: '新配置前候选' }];
    fixture.fetching = false;
    render();
    fixture.data = undefined;
    fixture.fetching = true;
    fixture.status.suggestionRevision++;
    render('sixth');
    expect(text()).toBeUndefined();
    fixture.data = [];
    fixture.fetching = false;
    render('sixth');
    expect(host.querySelector('.weq-int-suggest')).not.toBeNull();
    expect(host.querySelector('.weq-int-suggest-empty')?.textContent).toBe('暂无推荐回复');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
