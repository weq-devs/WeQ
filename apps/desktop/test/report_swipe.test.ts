import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  reportSwipeDirection,
  reportCanTurn,
  reportGestureTarget,
} from '../src/renderer/src/lib/reportSwipe';
import { AnnualReportStage } from '../src/renderer/src/views/annual-report/AnnualReportStage';

afterEach(() => document.body.replaceChildren());

it('上下滑动一次只返回一个方向，短距与横向手势不翻页', () => {
  expect(reportSwipeDirection(4, -70)).toBe(1);
  expect(reportSwipeDirection(4, 70)).toBe(-1);
  expect(reportSwipeDirection(4, 25)).toBe(0);
  expect(reportSwipeDirection(90, 60)).toBe(0);
});

it('当前页可继续滚动时不翻页，边缘才允许下一次手势', () => {
  const host = document.createElement('div');
  const page = document.createElement('div');
  page.style.overflowY = 'auto';
  host.append(page);
  document.body.append(host);
  Object.defineProperties(page, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
  page.scrollTop = 100;
  expect(reportCanTurn(page, host, 1)).toBe(false);
  expect(reportCanTurn(page, host, -1)).toBe(false);
  page.scrollTop = 600;
  expect(reportCanTurn(page, host, 1)).toBe(true);
  expect(reportCanTurn(page, host, -1)).toBe(false);
  page.scrollTop = 0;
  expect(reportCanTurn(page, host, -1)).toBe(true);
});

it('嵌套滚动容器、图表与交互控件不被舞台手势接管', () => {
  const host = document.createElement('div');
  host.innerHTML = '<button>分享</button><a href="#">链接</a><canvas></canvas><p>正文</p>';
  expect(reportGestureTarget(host.querySelector('button'))).toBe(false);
  expect(reportGestureTarget(host.querySelector('a'))).toBe(false);
  expect(reportGestureTarget(host.querySelector('canvas'))).toBe(false);
  expect(reportGestureTarget(host.querySelector('p'))).toBe(true);
});

it('报告滚到页边时保留同次惯性，只有下一次纵向滚轮才翻页', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 390, 844));
  const time = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const turn = vi.fn();
  try {
    const report = {
      index: 0,
      count: 3,
      onIndexChange: turn,
      children: createElement('div', {
        className: 'weq-report-slide is-active',
        style: { overflowY: 'auto' },
      }),
    };
    act(() => root.render(createElement(AnnualReportStage, report)));
    const slide = host.querySelector<HTMLElement>('.weq-report-slide')!;
    expect(slide.closest('[data-layout="reading"]')).not.toBeNull();
    Object.defineProperties(slide, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
    const wheel = (options: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
      // happy-dom 的 WheelEvent 没有继承 MouseEvent 的修饰键。
      if (options.ctrlKey) Object.defineProperty(event, 'ctrlKey', { value: true });
      return slide.dispatchEvent(event);
    };
    slide.scrollTop = 100;
    expect(wheel({ deltaY: 160 })).toBe(true);
    slide.scrollTop = 600;
    expect(wheel({ deltaY: 160 })).toBe(true);
    time.mockReturnValue(1400);
    expect(wheel({ deltaX: 160, deltaY: 30 })).toBe(true);
    expect(wheel({ deltaY: 160, ctrlKey: true })).toBe(true);
    expect(turn).not.toHaveBeenCalled();
    expect(wheel({ deltaY: 3, deltaMode: 1 })).toBe(false);
    expect(wheel({ deltaY: 160 })).toBe(false);
    expect(turn).toHaveBeenCalledOnce();
    expect(turn).toHaveBeenCalledWith(1);
  } finally {
    act(() => root.unmount());
    bounds.mockRestore();
    time.mockRestore();
    vi.unstubAllGlobals();
  }
});
