import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleListRange, WindowedList } from '../src/renderer/src/components/WindowedList';

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
  it('滚动记录更新或后台刷新不重写当前位置，切换列表时才恢复', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    const items = Array.from({ length: 100 }, (_, index) => String(index));
    const render = (resetKey: string, restoreScrollTop: number) =>
      act(() =>
        root.render(
          createElement(WindowedList<string>, {
            items,
            rowHeight: 50,
            height: 300,
            itemKey: (item) => item,
            renderItem: (item) => createElement('button', null, item),
            resetKey,
            restoreScrollTop,
          }),
        ),
      );
    render('messages', 200);
    const list = host.querySelector<HTMLElement>('[data-weq-windowed-list]')!;
    expect(list.scrollTop).toBe(200);
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 300 });
    let physicalTop = 260;
    const writeTop = vi.fn((value: number) => {
      physicalTop = Math.max(0, value);
    });
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => physicalTop,
      set: writeTop,
    });
    render('messages', 250);
    expect(writeTop).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(260);
    render('groups', 700);
    expect(writeTop).toHaveBeenLastCalledWith(700);
    writeTop.mockClear();
    render('groups', 720);
    expect(writeTop).not.toHaveBeenCalled();
    render('messages', 250);
    expect(writeTop).toHaveBeenLastCalledWith(250);
  });

  it('顶部回弹使用零内容坐标，不保存负值或在刷新时打断原生回弹', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    const items = Array.from({ length: 100 }, (_, index) => String(index));
    let savedTop = 250;
    const visible = vi.fn();
    const saveTop = vi.fn((top: number) => {
      savedTop = top;
    });
    const render = () =>
      act(() =>
        root.render(
          createElement(WindowedList<string>, {
            items,
            rowHeight: 50,
            height: 300,
            itemKey: (item) => item,
            renderItem: (item) => createElement('button', null, item),
            resetKey: 'messages',
            restoreScrollTop: savedTop,
            onScrollTopChange: saveTop,
            onVisibleItems: visible,
          }),
        ),
      );
    render();
    const list = host.querySelector<HTMLElement>('[data-weq-windowed-list]')!;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 300 });
    let physicalTop = 250;
    const writeTop = vi.fn((value: number) => {
      physicalTop = Math.max(0, value);
    });
    // Safari 回弹可读出负 scrollTop；写入坐标会重新定位而中断回弹。
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => physicalTop,
      set: writeTop,
    });
    for (const top of [0, -15, -80, -25, 0]) {
      physicalTop = top;
      act(() => list.dispatchEvent(new Event('scroll', { bubbles: true })));
      render();
      act(() => {
        for (const observer of observers) observer.fire();
      });
      expect(saveTop).toHaveBeenLastCalledWith(0);
      expect(visible).toHaveBeenLastCalledWith(['0', '1', '2', '3', '4', '5']);
      expect(list.querySelector<HTMLElement>(':scope > div > div')?.style.top).toBe('0px');
      expect(writeTop).not.toHaveBeenCalled();
      expect(list.scrollTop).toBe(top);
    }
  });

  it('快速跳动滚动位置时，事件返回前已挂载目标行', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    act(() =>
      root.render(
        createElement(WindowedList<string>, {
          items: Array.from({ length: 1000 }, (_, index) => String(index)),
          rowHeight: 50,
          height: 300,
          itemKey: (item) => item,
          renderItem: (item) => createElement('button', null, item),
        }),
      ),
    );
    const list = host.querySelector<HTMLElement>('[data-weq-windowed-list]')!;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 300 });
    act(() => {
      list.scrollTop = 5000;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      expect(
        [...list.querySelectorAll('button')].some((button) => button.textContent === '100'),
      ).toBe(true);
    });
  });
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
    expect(list.querySelector<HTMLElement>(':scope > div > div')?.style.top).toBe(
      `${visibleListRange(items.length, 50, 300, list.scrollTop).start * 50}px`,
    );

    list.scrollTop = 0;
    act(() => {
      for (const observer of observers) observer.fire();
    });
    expect(list.querySelector<HTMLElement>(':scope > div > div')?.style.top).toBe('0px');
  });
});
