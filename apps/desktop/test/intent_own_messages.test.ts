import {
  act,
  cloneElement,
  isValidElement,
  createElement as h,
  useRef,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageIntentSense } from '../src/renderer/src/components/intentSense/MessageIntentSense';
import { IntentSuggestionBar } from '../src/renderer/src/components/intentSense/IntentSuggestionBar';

const fixture = vi.hoisted(() => ({
  result: {
    msgId: 'own',
    mine: true,
    sendTime: 1000,
    intent: 'chat',
    emotion: 'neutral',
    intensity: 20,
    sentiment: 0,
    confidence: 0.8,
    engine: 'local',
    analyzedAt: 1000,
  },
  context: {
    active: true,
    persistentDisplay: true,
    hoverDisplay: true,
    version: 1,
    kind: 'group',
    conv: 'fixture',
    latestPeerMsgId: null,
    latestMessageId: 'own',
    latestSelfMessageIds: new Set(['own', 'own-before']),
    settled: true,
    getAnalysis: vi.fn(),
    isUnavailable: vi.fn(),
    requestAnalysis: vi.fn(),
    isPending: vi.fn(),
    getFailure: vi.fn(),
  },
  query: vi.fn(),
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseContext: () => fixture.context,
  useIntentSenseStatus: () => ({
    data: {
      enabled: true,
      engine: 'local',
      localReady: true,
      suggestionsEnabled: true,
      suggestionRevision: 0,
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      intentSense: {
        getSuggestions: { useQuery: fixture.query },
        getSuggestionRound: { useQuery: fixture.query },
        getSuggestionHistory: { useQuery: () => ({ data: [], isLoading: false }) },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  fixture.context.getAnalysis.mockReset().mockReturnValue(fixture.result);
  fixture.context.active = true;
  fixture.context.persistentDisplay = true;
  fixture.context.hoverDisplay = true;
  fixture.context.settled = true;
  fixture.context.isPending.mockReset().mockReturnValue(false);
  fixture.context.isUnavailable.mockReset().mockReturnValue(false);
  fixture.context.getFailure.mockReset().mockReturnValue(undefined);
  fixture.context.requestAnalysis.mockClear();
  fixture.query.mockReset().mockReturnValue({ data: [{ text: '旧候选' }], isFetching: false });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('message-scroll')) return new DOMRect(0, 0, 390, 400);
    if (this.classList.contains('message-bubble')) return new DOMRect(240, 200, 120, 40);
    return new DOMRect(0, 0, 220, 132);
  });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function OwnBubble({
  msgId = 'own',
  analyzable = true,
}: {
  msgId?: string;
  analyzable?: boolean;
} = {}) {
  const ref = useRef<HTMLDivElement>(null);
  return h(
    'div',
    { className: 'message-scroll' },
    h(
      'div',
      { className: 'message-line mine' },
      h(
        'div',
        { ref, className: 'message-bubble' },
        h('span', { className: 'message-content qq-text-run' }, '自己的文本'),
        h(MessageIntentSense, { msgId, bubbleRef: ref, analyzable }),
      ),
    ),
  );
}
async function render(component: ReactNode = h(OwnBubble)) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(component));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return Object.assign(host, {
    rerender: () =>
      act(async () => root.render(isValidElement(component) ? cloneElement(component) : component)),
  });
}

it('最新自己的消息常驻显示意图，悬停按自己的气泡右侧对齐', async () => {
  const host = await render();
  expect(host.querySelector('.weq-intent-chips')?.textContent).toContain('闲聊');
  await act(async () => {
    host.querySelector('.message-bubble')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(300);
  });
  const tooltip = document.querySelector<HTMLElement>('.weq-intent-popover')!;
  expect(Number.parseFloat(tooltip.style.left) + tooltip.getBoundingClientRect().width).toBe(360);
});

it('连续自己发言时，非最新一条的分析结果仍常驻显示', async () => {
  const host = await render(h(OwnBubble, { msgId: 'own-before' }));
  expect(host.querySelector('.weq-intent-chips')?.textContent).toContain('闲聊');
});

it.each(['older-own', 'older-peer', 'roaming:protocol:2:77'])(
  '任意历史消息 %s 已有结果时都常驻展示',
  async (msgId) => {
    const host = await render(h(OwnBubble, { msgId }));
    expect(host.querySelector('.weq-intent-chips')?.textContent).toContain('闲聊');
  },
);

it('批量进度到达前后，无结果的文本均播放随机图标动画', async () => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.settled = false;
  fixture.context.isPending.mockImplementation((id) => id !== 'older-own');
  const host = await render(
    h(
      'div',
      null,
      h(OwnBubble, { msgId: 'older-own' }),
      h(OwnBubble, { msgId: 'older-peer' }),
      h(OwnBubble, { msgId: 'roaming:2:77' }),
    ),
  );
  expect(host.querySelectorAll('.weq-intent-chips')).toHaveLength(3);
  expect(host.querySelectorAll('.weq-intent-pill.is-loading')).toHaveLength(6);
  expect(host.querySelector('[data-intent-state="idle"]')?.getAttribute('aria-busy')).toBe('false');
});

it('单条历史消息分析在途时，即使批次已结束也显示加载窄条', async () => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.isPending.mockImplementation((id) => id === 'older-peer');
  const host = await render(h(OwnBubble, { msgId: 'older-peer' }));
  expect(host.querySelectorAll('.weq-intent-pill.is-loading')).toHaveLength(2);
  expect(host.querySelector('[data-loading-kind="intent"] svg')).not.toBeNull();
  expect(host.querySelector('[data-loading-kind="emotion"] svg')).not.toBeNull();
  expect(host.querySelectorAll('.weq-intent-loading-reel')).toHaveLength(2);
  expect(host.querySelectorAll('.weq-intent-pill.is-loading[aria-hidden="true"]')).toHaveLength(2);
});

it.each(['history', 'fetched', 'roaming:protocol:2:77'])(
  '%s 首次挂载就播放随机图标动画，不等待批次进度，也不触发分析',
  async (msgId) => {
    fixture.context.getAnalysis.mockReturnValue(undefined);
    const host = await render(h(OwnBubble, { msgId }));
    expect(host.querySelectorAll('.weq-intent-pill.is-loading')).toHaveLength(2);
    expect(host.querySelector('.weq-intent-details.is-empty')).toBeNull();
    expect(host.querySelectorAll('.weq-intent-loading-reel')).toHaveLength(2);
    expect(host.querySelector('.weq-intent-chips')?.getAttribute('aria-busy')).toBe('false');
    expect(fixture.context.requestAnalysis).not.toHaveBeenCalled();
    const reel = host.querySelector('.weq-intent-loading-reel');
    fixture.context.isPending.mockReturnValue(true);
    await host.rerender();
    expect(host.querySelectorAll('.weq-intent-pill.is-loading')).toHaveLength(2);
    expect(host.querySelector('.weq-intent-loading-reel')).toBe(reel);
    fixture.context.getAnalysis.mockReturnValue(fixture.result);
    await host.rerender();
    expect(host.querySelectorAll('.weq-intent-pill')).toHaveLength(2);
    expect(host.querySelector('.is-placeholder')).toBeNull();
    expect(host.querySelector('.weq-intent-chips')?.getAttribute('aria-busy')).toBe('false');
  },
);

it('关闭悬停后仍播放随机图标动画；纯媒体不因批次在途出现加载胶囊', async () => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.hoverDisplay = false;
  const host = await render(h(OwnBubble));
  expect(host.querySelectorAll('.weq-intent-pill.is-loading')).toHaveLength(2);
  fixture.context.isPending.mockReturnValue(true);
  const media = await render(h(OwnBubble, { analyzable: false }));
  expect(media.querySelector('.weq-intent-chips')).toBeNull();
});

it('失败状态原位显示，不因残留批次进度继续播放加载动画', async () => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.getFailure.mockReturnValue('合成错误');
  fixture.context.isPending.mockReturnValue(true);
  const host = await render();
  expect(host.querySelector('.weq-intent-chips')?.getAttribute('data-intent-state')).toBe('error');
  expect(host.querySelector('.weq-intent-chips')?.getAttribute('aria-busy')).toBe('false');
  expect(host.textContent).toContain('分析失败');
  expect(host.querySelector('.is-loading')).toBeNull();
});

it('待分析胶囊每轮离场后切换图标，忽略内部笔画周期并分别随机覆盖两套图标', async () => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.isPending.mockReturnValue(true);
  const host = await render();
  for (const [kind, count] of [
    ['intent', 17],
    ['emotion', 15],
  ] as const) {
    const reel = () =>
      host.querySelector(`[data-loading-kind="${kind}"] .weq-intent-loading-reel`)!;
    const iconClass = () => reel().querySelector('svg')!.getAttribute('class');
    const initial = iconClass();
    await act(async () => {
      reel()
        .querySelector('svg')!
        .dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(iconClass()).toBe(initial);
    const sequence = new Set<string | null>();
    let previous = '';
    for (let index = 0; index < count; index++) {
      sequence.add(iconClass());
      previous = iconClass()!;
      await act(async () => reel().dispatchEvent(new Event('animationend', { bubbles: true })));
    }
    expect(sequence.size).toBe(count);
    expect(iconClass()).not.toBe(previous);
  }
});

it('批次结束但未收到结果时动画继续，已有结果原位替换', async () => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.settled = false;
  fixture.context.isPending.mockReturnValue(true);
  const host = await render(h(OwnBubble, { msgId: 'older-peer' }));
  expect(host.querySelector('.is-loading')).not.toBeNull();
  fixture.context.settled = true;
  fixture.context.isPending.mockReturnValue(false);
  await host.rerender();
  expect(host.querySelector('.weq-intent-chips')).not.toBeNull();
  expect(host.querySelectorAll('.is-loading')).toHaveLength(2);
  expect(host.querySelector('.weq-intent-chips')?.getAttribute('aria-busy')).toBe('false');
  fixture.context.getAnalysis.mockReturnValue(fixture.result);
  await host.rerender();
  expect(host.querySelector('.is-loading')).toBeNull();
  expect(host.querySelector('.weq-intent-chips')?.textContent).toContain('闲聊');
});

it('关闭常驻显示隐藏结果和窄条，但保留悬停详情', async () => {
  fixture.context.persistentDisplay = false;
  const host = await render(h(OwnBubble, { msgId: 'older-peer' }));
  expect(host.querySelector('.weq-intent-chips')).toBeNull();
  await act(async () => {
    host.querySelector('.message-bubble')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(300);
  });
  expect(document.querySelector('.weq-intent-popover')?.textContent).toContain('情绪强度');
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.settled = false;
  await host.rerender();
  expect(host.querySelector('.weq-intent-chips')).toBeNull();
});

it('关闭悬停显示立即收起弹层，保留常驻结果且不触发悬停分析', async () => {
  const host = await render();
  await act(async () => {
    host.querySelector('.message-bubble')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(300);
  });
  expect(document.querySelector('.weq-intent-popover')).not.toBeNull();
  fixture.context.hoverDisplay = false;
  await host.rerender();
  expect(document.querySelector('.weq-intent-popover')).toBeNull();
  expect(host.querySelector('.weq-intent-chips')?.textContent).toContain('闲聊');
  fixture.context.getAnalysis.mockReturnValue(undefined);
  await host.rerender();
  await act(async () => {
    host.querySelector('.message-bubble')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(300);
  });
  expect(fixture.context.requestAnalysis).not.toHaveBeenCalled();
});

it.each(['unavailable', 'media', 'disabled'])('%s 状态不显示虚假的加载窄条', async (state) => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  fixture.context.active = state !== 'disabled';
  fixture.context.isUnavailable.mockReturnValue(state === 'unavailable');
  const host = await render(h(OwnBubble, { msgId: 'older-peer', analyzable: state !== 'media' }));
  expect(host.querySelector('.is-loading')).toBeNull();
  expect(!!host.querySelector('.weq-intent-chips')).toBe(state !== 'media' && state !== 'disabled');
});

it('自己的真实文本容器无需旧 message-text 类也能触发悬停分析', async () => {
  fixture.context.getAnalysis.mockReturnValue(undefined);
  const host = await render();
  await act(async () => {
    host.querySelector('.message-bubble')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(300);
  });
  expect(fixture.context.requestAnalysis).toHaveBeenCalledWith('own');
  expect(document.querySelector('.weq-intent-popover')?.textContent).toContain('正在分析');
});

it('首次进入仅有自己消息的会话时禁用推荐查询，不展示查询旧缓存', async () => {
  const host = await render(
    h(IntentSuggestionBar, {
      kind: 'group',
      conv: 'fixture',
      replyTargetId: null,
      onInsert: () => {},
    }),
  );
  expect(fixture.query.mock.calls[0]?.[1]?.enabled).toBe(false);
  expect(host.querySelector('.weq-int-suggest')).not.toBeNull();
  expect(host.textContent).toContain('等待对方新消息');
  expect(host.textContent).not.toContain('旧候选');
});

it('同会话对方消息变化不创建高基数查询键，失活候选立即回收', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const renderTarget = (replyTargetId: string) =>
    act(async () =>
      root.render(
        h(IntentSuggestionBar, {
          kind: 'group',
          conv: 'fixture',
          replyTargetId,
          onInsert: () => {},
        }),
      ),
    );
  await renderTarget('peer-a');
  const first = fixture.query.mock.calls.at(-1)!;
  await renderTarget('peer-b');
  const second = fixture.query.mock.calls.at(-1)!;
  expect(second[0]).toEqual(first[0]);
  expect(second[1]?.cacheTime).toBe(0);
});
