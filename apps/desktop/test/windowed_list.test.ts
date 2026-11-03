import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowedList } from '../src/renderer/src/components/WindowedList';

const observers: TestResizeObserver[] = [];

class TestResizeObserver {
  private active = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }

  observe() {
    this.active = true;
  }

  disconnect() {
    this.active = false;
  }

  fire() {
    if (this.active) this.callback([], this as unknown as ResizeObserver);
  }
}

let cleanup = () => {};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  observers.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('会话列表窗口', () => {
  it('隐藏时延迟定位，并在视口滚动位置复位后同步渲染行', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    const items = Array.from({ length: 100 }, (_, index) => `会话 ${index}`);
    act(() =>
      root.render(
        createElement(WindowedList<string>, {
          items,
          rowHeight: 50,
          height: 300,
          itemKey: (item) => item,
          renderItem: (item) => createElement('button', null, item),
          scrollToKey: '会话 30',
        }),
      ),
    );

    const list = host.querySelector<HTMLElement>('[data-weq-windowed-list]')!;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 0 },
      scrollHeight: { configurable: true, value: 5000 },
    });
    list.scrollTop = 0;
    expect(list.scrollTop).toBe(0);

    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 300 });
    act(() => {
      for (const observer of observers) observer.fire();
    });
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(list.querySelector<HTMLElement>(':scope > div > div')?.style.top).toBe('1100px');

    list.scrollTop = 0;
    act(() => {
      for (const observer of observers) observer.fire();
    });
    expect(list.querySelector<HTMLElement>(':scope > div > div')?.style.top).toBe('0px');
  });
});
