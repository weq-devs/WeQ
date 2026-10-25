import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMsgDecoration } from '../src/renderer/src/hooks/useMsgDecoration';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { decorationImageCache } from '../src/renderer/src/lib/decodedImageCache';

const state = vi.hoisted(() => ({
  data: { widget: { animated: true, itemId: 95001, frameCount: 20, frameTimeMs: 100, repeat: 0 } },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      dressup: {
        resolveMsgDecoration: { useQuery: () => ({ data: state.data }) },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QqMessageContent', async () => {
  const { createContext } = await import('react');
  return { MsgDecorationEnabledContext: createContext(true) };
});
afterEach(() => vi.unstubAllGlobals());
it('离开可见范围、隐藏标签或卸载时释放，重新可见仍可开播', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let visibility: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof visibility) {
        visibility = callback;
      }
      observe() {
        visibility([{ isIntersecting: true }]);
      }
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 256;
      naturalHeight = 256;
      async decode() {}
      removeAttribute() {
        this.src = '';
      }
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  function Message() {
    const ref = useRef<HTMLDivElement | null>(null);
    useMsgDecoration({ widgetId: 95001, bubbleId: 0, fontId: 0 }, ref);
    return createElement('div', { ref });
  }
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(createElement(TabActivity, { active: true }, createElement(Message))),
    );
    await vi.waitFor(() => expect(decorationImageCache.stats().pinnedImages).toBe(20));
    await act(async () => visibility([{ isIntersecting: false }]));
    expect(decorationImageCache.stats().pinnedImages).toBe(0);
    expect(document.querySelectorAll('[data-weq-msg-decoration]')).toHaveLength(0);
    await act(async () => visibility([{ isIntersecting: true }]));
    await vi.waitFor(() => expect(decorationImageCache.stats().pinnedImages).toBe(20));
    await act(async () =>
      root.render(createElement(TabActivity, { active: false }, createElement(Message))),
    );
    expect(decorationImageCache.stats().pinnedImages).toBe(0);
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
  expect(disconnect).toHaveBeenCalled();
  expect(decorationImageCache.stats().totalPendingImages).toBe(0);
});
