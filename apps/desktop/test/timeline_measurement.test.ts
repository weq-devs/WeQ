import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useVirtualTimeline } from '../src/renderer/src/hooks/useVirtualTimeline';

it('时间线使用现成行高，不重复读取布局，隐藏时仍保留已测高度', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let timeline: ReturnType<typeof useVirtualTimeline> | undefined;
  const ids = ['fixture'];
  let active = true;
  function Fixture() {
    timeline = useVirtualTimeline({
      ids,
      orderedIds: ids,
      scope: 'fixture',
      scrollRef: useRef<HTMLDivElement>(null),
      active,
      estimateSize: () => 96,
    });
    return null;
  }
  const row = document.createElement('div');
  row.dataset.index = '0';
  const rects = vi.spyOn(row, 'getClientRects');
  const bounds = vi.spyOn(row, 'getBoundingClientRect');
  const entries = (height: number): ResizeObserverEntry => ({
    target: row,
    borderBoxSize: [{ blockSize: height, inlineSize: 100 }],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
    contentRect: new DOMRect(0, 0, 100, height),
  });
  try {
    act(() => root.render(createElement(Fixture)));
    const instance = timeline!.virtualizer;
    const measure = (entry?: ResizeObserverEntry) =>
      instance.options.measureElement(row, entry, instance);
    expect(measure(entries(42.25))).toBe(42.25);
    expect(rects).not.toHaveBeenCalled();
    expect(bounds).not.toHaveBeenCalled();

    const one = [new DOMRect(0, 0, 100, 51.75)];
    rects.mockReturnValue(Object.assign(one, { item: (index: number) => one[index]! }));
    expect(measure()).toBe(51.75);
    expect(bounds).not.toHaveBeenCalled();

    const viewport = document.createElement('div');
    let width = 600;
    let height = 400;
    Object.defineProperties(viewport, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
    });
    let notify: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    instance.scrollElement = viewport;
    instance.targetWindow = window;
    const resized = vi.fn();
    const cleanup = instance.options.observeElementRect(instance, resized);
    expect(resized).toHaveBeenLastCalledWith({ width, height });
    width = height = 0;
    notify!([], {} as ResizeObserver);
    expect(resized).toHaveBeenCalledTimes(1);
    width = 500;
    height = 300;
    notify!([], {} as ResizeObserver);
    expect(resized).toHaveBeenLastCalledWith({ width, height });
    cleanup?.();

    viewport.scrollTop = 120;
    const offsets = vi.fn();
    const stopOffsets = instance.options.observeElementOffset(instance, offsets);
    viewport.dispatchEvent(new Event('scroll'));
    expect(offsets).toHaveBeenLastCalledWith(120, true);
    act(() => {
      active = false;
      root.render(createElement(Fixture));
    });
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    expect(offsets).toHaveBeenCalledTimes(1);
    act(() => {
      active = true;
      root.render(createElement(Fixture));
    });
    viewport.scrollTop = 180;
    viewport.dispatchEvent(new Event('scroll'));
    expect(offsets).toHaveBeenLastCalledWith(180, true);
    stopOffsets?.();

    const fragments = [new DOMRect(0, 0, 100, 20), new DOMRect(0, 20, 100, 30)];
    rects.mockReturnValue(Object.assign(fragments, { item: (index: number) => fragments[index]! }));
    bounds.mockReturnValue(new DOMRect(0, 0, 100, 50.5));
    expect(measure()).toBe(50.5);
    expect(bounds).toHaveBeenCalledOnce();

    bounds.mockClear();
    rects.mockReturnValue(Object.assign([], { item: () => new DOMRect() }));
    expect(measure(entries(0))).toBe(96);
    instance.itemSizeCache.set('fixture', 51.75);
    expect(measure(entries(0))).toBe(51.75);
    expect(measure()).toBe(51.75);
    expect(bounds).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
