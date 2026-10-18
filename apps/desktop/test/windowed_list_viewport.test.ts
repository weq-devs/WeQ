import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WindowedList } from '../src/renderer/src/components/WindowedList';

it('列表被布局压缩后，按真实可视高度定位目标，而不是使用原始请求高度', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const items = Array.from({ length: 1000 }, (_, index) => String(index));
  const render = (target?: string) =>
    act(() =>
      root.render(
        createElement(WindowedList<string>, {
          items,
          rowHeight: 64,
          height: 480,
          itemKey: (item) => item,
          renderItem: (item) => createElement('button', null, item),
          scrollToKey: target,
          scrollRevision: 1,
        }),
      ),
    );
  try {
    render();
    const viewport = host.querySelector<HTMLDivElement>('[data-weq-windowed-list]')!;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 144 });
    render('30');
    expect(viewport.scrollTop).toBe(30 * 64 - 144 / 2 + 64 / 2);
    expect(30 * 64 - viewport.scrollTop).toBeLessThan(viewport.clientHeight);
    expect(host.querySelectorAll('button').length).toBeLessThan(40);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
