import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HoverTooltip } from '../src/renderer/src/components/HoverTooltip';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('提示框按内容确定宽度，边框和内边距计入窗口宽度上限', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(
    resolve(__dirname, '../src/renderer/src/styles/hover-tooltip.css'),
    'utf8',
  );
  const bubble = document.createElement('div');
  bubble.className = 'weq-hover-tooltip';
  document.head.append(style);
  document.body.append(bubble);
  try {
    const computed = getComputedStyle(bubble);
    expect(computed.width).toBe('max-content');
    expect(computed.boxSizing).toBe('border-box');
  } finally {
    bubble.remove();
    style.remove();
  }
});

it('靠近右下角时按完整提示尺寸向左、向上避让', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 240, 46),
  );
  const host = document.createElement('div');
  const button = document.createElement('button');
  button.title = '发送正在输入状态（已开启）';
  document.body.append(host, button);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(HoverTooltip)));
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent('pointerover', {
          bubbles: true,
          clientX: window.innerWidth - 10,
          clientY: window.innerHeight - 20,
        }),
      );
      vi.advanceTimersByTime(300);
    });
    const bubble = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(bubble.textContent).toBe(button.getAttribute('aria-label'));
    expect(bubble.style.left).toBe(`${window.innerWidth - 240 - 8}px`);
    expect(Number.parseFloat(bubble.style.top) + 46).toBeLessThan(window.innerHeight);
  } finally {
    act(() => root.unmount());
    host.remove();
    button.remove();
  }
});
