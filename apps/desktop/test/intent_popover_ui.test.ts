import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageIntentSense } from '../src/renderer/src/components/intentSense/MessageIntentSense';

const context = vi.hoisted(() => ({
  active: true,
  version: 1,
  conv: 'fixture-a',
  kind: 'group',
  latestPeerMsgId: null,
  settled: true,
  getAnalysis: () => ({
    msgId: 'fixture',
    intent: 'request',
    emotion: 'neutral',
    intensity: 60,
    sentiment: 5,
    confidence: 0.9,
    engine: 'local',
  }),
  isUnavailable: () => false,
  requestAnalysis: vi.fn(),
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseContext: () => context,
}));
function Fixture() {
  const bubble = useRef<HTMLDivElement>(null);
  return createElement(
    'div',
    { className: 'message-scroll', style: { overflow: 'hidden', transform: 'translateZ(0)' } },
    createElement(
      'div',
      { ref: bubble, className: 'message-content' },
      createElement('span', { className: 'message-text' }, '合成消息'),
      createElement(MessageIntentSense, { msgId: 'fixture', bubbleRef: bubble }),
    ),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  context.conv = 'fixture-a';
  context.requestAnalysis.mockClear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('message-scroll')) return new DOMRect(0, 100, 390, 300);
    if (this.classList.contains('message-content')) return new DOMRect(20, 340, 160, 40);
    return new DOMRect(0, 0, 220, 132);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
async function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Fixture)));
  await act(async () => {
    host.querySelector('.message-content')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(300);
  });
  return { host, root, close: () => act(() => root.unmount()) };
}
describe('意图浮窗的宿主与关闭', () => {
  it('离开会裁切的业务祖先，按聊天底边上翻且使用浮层栈', async () => {
    const f = await fixture();
    try {
      const tooltip = document.querySelector<HTMLElement>('.weq-intent-popover')!;
      expect(tooltip.parentElement).toBe(document.body);
      expect(f.host.contains(tooltip)).toBe(false);
      expect(Number.parseFloat(tooltip.style.top)).toBe(202);
      expect(Number(tooltip.style.zIndex)).toBeGreaterThan(1200);
      expect(tooltip.textContent).toContain('请求');
      expect(context.requestAnalysis).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it.each(['scroll', 'resize'])('%s 时立即关闭，卸载后无悬浮残留', async (type) => {
    const f = await fixture();
    try {
      expect(document.querySelector('.weq-intent-popover')).not.toBeNull();
      act(() => (type === 'resize' ? window : f.host).dispatchEvent(new Event(type)));
      expect(document.querySelector('.weq-intent-popover')).toBeNull();
    } finally {
      f.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('切换会话时关闭旧浮窗，而不是继续展示旧位置', async () => {
    const f = await fixture();
    try {
      context.conv = 'fixture-b';
      await act(async () => f.root.render(createElement(Fixture)));
      expect(document.querySelector('.weq-intent-popover')).toBeNull();
    } finally {
      f.close();
    }
  });
});
