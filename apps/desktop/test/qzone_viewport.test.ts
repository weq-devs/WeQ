import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useNearViewport } from '../src/renderer/src/views/qzoneShared.shared';

it('空间同一节点的一次性与持续观察分别交付，并在最后一个订阅离开后释放', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const observers: TestObserver[] = [];
  class TestObserver {
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
    constructor(private readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    notify(target: Element, isIntersecting: boolean) {
      this.callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
  }
  vi.stubGlobal('IntersectionObserver', TestObserver);
  function Probe() {
    const ref = useRef<HTMLDivElement>(null);
    const once = useNearViewport(ref, true);
    const current = useNearViewport(ref);
    return createElement('div', { ref }, `${once}:${current}`);
  }
  const host = document.createElement('div');
  host.className = 'weq-qzn-scroll';
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(Probe)));
    const target = host.firstElementChild!;
    expect(observers).toHaveLength(1);
    const [observer] = observers;
    expect(observer!.observe).toHaveBeenCalledOnce();
    act(() => observer!.notify(target, true));
    expect(host.textContent).toBe('true:true');
    act(() => observer!.notify(target, false));
    expect(host.textContent).toBe('true:false');
    expect(observer!.disconnect).not.toHaveBeenCalled();
    act(() => root.render(null));
    expect(observer!.disconnect).toHaveBeenCalledOnce();
    act(() => root.render(createElement(Probe)));
    expect(observers).toHaveLength(2);
    expect(host.textContent).toBe('false:false');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
