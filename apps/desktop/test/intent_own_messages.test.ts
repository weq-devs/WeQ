import { act, createElement as h, useRef, type ReactNode } from 'react';
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
  trpc: { account: { intentSense: { getSuggestions: { useQuery: fixture.query } } } },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  fixture.context.getAnalysis.mockReset().mockReturnValue(fixture.result);
  fixture.context.isUnavailable.mockReset().mockReturnValue(false);
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

function OwnBubble({ msgId = 'own' }: { msgId?: string } = {}) {
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
        h(MessageIntentSense, { msgId, bubbleRef: ref, analyzable: true }),
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
  return host;
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

it('更早轮次的自己消息仍仅悬停展示，不扩大常驻范围', async () => {
  const host = await render(h(OwnBubble, { msgId: 'older-own' }));
  expect(host.querySelector('.weq-intent-chips')).toBeNull();
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

it('自己发送后禁用推荐查询并隐藏旧候选，而不是把旧缓存继续显示', async () => {
  const host = await render(
    h(IntentSuggestionBar, {
      kind: 'group',
      conv: 'fixture',
      replyTargetId: null,
      onInsert: () => {},
    }),
  );
  expect(fixture.query.mock.calls[0]?.[1]?.enabled).toBe(false);
  expect(host.querySelector('.weq-int-suggest')).toBeNull();
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
