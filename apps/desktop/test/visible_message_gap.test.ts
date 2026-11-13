import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageGapDivider } from '../src/renderer/src/im-template/template/messageGap';

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('可见缺口只自动触发一次；离屏、关闭和多选时不触发，手动入口仍可用', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const callbacks: IntersectionObserverCallback[] = [];
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const host = document.createElement('div');
  host.className = 'message-scroll';
  document.body.append(host);
  const root = createRoot(host);
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  const fetch = vi.fn(async () => {});
  const render = (autoFetch: boolean, selectionMode = false) =>
    act(async () =>
      root.render(
        h(MessageGapDivider, {
          count: 10,
          id: 'gap:10:21',
          onOpen: fetch,
          autoFetch,
          selectionMode,
        }),
      ),
    );
  await render(false);
  expect(observe).not.toHaveBeenCalled();
  await render(true, true);
  expect(observe).not.toHaveBeenCalled();
  await render(true);
  expect(observe).toHaveBeenCalledTimes(1);
  const intersect = (isIntersecting: boolean) =>
    callbacks.at(-1)!(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  await act(async () => intersect(false));
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => intersect(true));
  await act(async () => intersect(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(true);
  await render(false);
  await act(async () => host.querySelector('button')!.click());
  expect(fetch).toHaveBeenLastCalledWith(false);
  expect(disconnect).toHaveBeenCalled();
});
