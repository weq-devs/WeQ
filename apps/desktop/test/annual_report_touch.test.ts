import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnnualReportStage } from '../src/renderer/src/views/annual-report/AnnualReportStage';

afterEach(() => vi.unstubAllGlobals());

it('阅读模式先滚动内容，下一次边缘滑动才翻页，按钮和多指不误翻', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 400, height: 700 } as DOMRect);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const change = vi.fn();
  const touch = (element: Element, type: string, y: number, count = 1) => {
    const point = { identifier: 1, clientX: 100, clientY: y };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: type === 'touchend' ? [] : Array.from({ length: count }, () => point) },
      changedTouches: { value: [point] },
    });
    act(() => element.dispatchEvent(event));
  };
  try {
    act(() =>
      root.render(
        createElement(
          AnnualReportStage,
          { index: 1, count: 4, onIndexChange: change },
          createElement(
            'div',
            { className: 'weq-report-slide', style: { overflowY: 'auto' } },
            createElement('p', null, '报告正文'),
            createElement('button', null, '分享'),
          ),
        ),
      ),
    );
    expect(host.querySelector('[data-layout="reading"]')).not.toBeNull();
    const page = host.querySelector<HTMLElement>('.weq-report-slide')!;
    const text = page.querySelector('p')!;
    Object.defineProperties(page, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
    page.scrollTop = 500;
    touch(text, 'touchstart', 180);
    page.scrollTop = 600;
    touch(text, 'touchmove', 100);
    touch(text, 'touchend', 100);
    expect(change).not.toHaveBeenCalled();
    touch(text, 'touchstart', 180);
    touch(text, 'touchmove', 100);
    touch(text, 'touchend', 100);
    expect(change).toHaveBeenCalledWith(2);
    change.mockClear();
    const button = page.querySelector('button')!;
    touch(button, 'touchstart', 180);
    touch(button, 'touchend', 100);
    touch(text, 'touchstart', 180, 2);
    touch(text, 'touchend', 100);
    expect(change).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    bounds.mockRestore();
  }
});
