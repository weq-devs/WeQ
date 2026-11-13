import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageIntentSense } from '../src/renderer/src/components/intentSense/MessageIntentSense';
import type { IntentSenseResult } from '@weq/service';
import { Modal } from '../src/renderer/src/components/Dialog';

const context = vi.hoisted(() => ({
  active: true,
  version: 1,
  conv: 'fixture-a',
  kind: 'group',
  latestPeerMsgId: null,
  settled: true,
  hasResult: true,
  loadingAnimation: true,
  persistentDisplay: true,
  hoverDisplay: true,
  getAnalysis: (): IntentSenseResult | undefined =>
    context.hasResult
      ? {
          msgId: 'fixture',
          intent: 'request',
          emotion: 'neutral',
          intensity: 60,
          sentiment: 5,
          confidence: 0.9,
          engine: 'local',
          mine: false,
          sendTime: 1000,
          analyzedAt: 1000,
        }
      : undefined,
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
  context.hasResult = true;
  context.loadingAnimation = true;
  context.persistentDisplay = true;
  context.hoverDisplay = true;
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
  it('Esc 先收起意图浮窗，不关闭它下面的业务弹窗', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const parentClose = vi.fn();
    try {
      act(() =>
        root.render(createElement(Modal, { onClose: parentClose }, createElement(Fixture))),
      );
      const bubble = document.querySelector('.message-content')!;
      act(() => {
        bubble.dispatchEvent(new Event('pointerenter'));
        vi.advanceTimersByTime(300);
      });
      expect(document.querySelector('.weq-intent-popover')).not.toBeNull();
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
      );
      expect(document.querySelector('.weq-intent-popover')).toBeNull();
      expect(parentClose).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
  it('关闭等待动画时首次提交无胶囊和占位，结果到达后直接显示，常驻关闭优先', async () => {
    context.hasResult = false;
    context.loadingAnimation = false;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(Fixture)));
      expect(host.querySelector('.message-text')?.textContent).toBe('合成消息');
      expect(host.querySelector('.weq-intent-chips')).toBeNull();
      expect(host.querySelector('.weq-intent-focus-trigger')).toBeNull();
      context.hasResult = true;
      act(() => root.render(createElement(Fixture)));
      expect(host.querySelectorAll('.weq-intent-pill')).toHaveLength(2);
      context.persistentDisplay = false;
      act(() => root.render(createElement(Fixture)));
      expect(host.querySelector('.weq-intent-chips')).toBeNull();
      context.hoverDisplay = false;
      act(() => root.render(createElement(Fixture)));
      expect(host.querySelector('.weq-intent-focus-trigger')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
  it('键盘聚焦胶囊可打开详情，并通过 aria-describedby 关联到工具提示', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Fixture)));
      const button = host.querySelector<HTMLElement>('[aria-label="消息意图与情绪"]')!;
      act(() => button.focus());
      const tooltip = document.querySelector('.weq-intent-popover')!;
      expect(tooltip).not.toBeNull();
      expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
      act(() =>
        button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
      );
      expect(document.querySelector('.weq-intent-popover')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
  it.each(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'])(
    '单按 %s 保留意图浮窗，松开后也不关闭',
    async (key) => {
      const f = await fixture();
      try {
        const tooltip = document.querySelector('.weq-intent-popover');
        expect(tooltip).not.toBeNull();
        for (const type of ['keydown', 'keyup']) {
          act(() => f.host.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key })));
          expect(document.querySelector('.weq-intent-popover')).toBe(tooltip);
        }
      } finally {
        f.close();
      }
    },
  );
  it.each([
    { key: 'Escape' },
    { key: 'Tab' },
    { key: 'a' },
    { key: 'c', ctrlKey: true },
    { key: 'c', metaKey: true },
    { key: 'ArrowDown', shiftKey: true },
  ])('按下 $key 仍立即关闭意图浮窗（包括组合键）', async (init) => {
    const f = await fixture();
    try {
      act(() => f.host.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })));
      expect(document.querySelector('.weq-intent-popover')).toBeNull();
    } finally {
      f.close();
    }
  });
  it('离开会裁切的业务祖先，按聊天底边上翻且使用浮层栈', async () => {
    const f = await fixture();
    try {
      const tooltip = document.querySelector<HTMLElement>('.weq-intent-popover')!;
      expect(tooltip.parentElement).toBe(document.body);
      expect(f.host.contains(tooltip)).toBe(false);
      expect(Number.parseFloat(tooltip.style.top)).toBe(202);
      expect(Number(tooltip.style.zIndex)).toBeGreaterThan(1200);
      expect(tooltip.textContent).toContain('情绪强度');
      expect(tooltip.querySelector('.weq-intent-pill')).toBeNull();
      expect(tooltip.querySelector('button, a, [role="button"]')).toBeNull();
      expect(f.host.querySelector('.weq-intent-details')?.tagName).toBe('SPAN');
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
