import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMsgDecoration } from '../src/renderer/src/hooks/useMsgDecoration';

const fixture = vi.hoisted(() => ({
  bubble: {
    itemId: 21001,
    slice: [4, 4, 4, 4],
    imageSize: [40, 40],
    textColor: 'var(--foreground)',
  },
  font: { itemId: 31001, deriveVersion: 1, fx: null },
  widget: { itemId: 10001, animated: false, url: 'https://example.test/widget.png' },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      dressup: {
        resolveMsgDecoration: {
          useQuery: (ids: { bubbleId: number; fontId: number; widgetId: number }) => {
            // 各款已缓存，但新的组合键仍处于异步加载期。
            if ([ids.bubbleId, ids.fontId, ids.widgetId].filter(Boolean).length > 1)
              return { data: undefined };
            return {
              data: {
                bubble: ids.bubbleId ? fixture.bubble : null,
                font: ids.fontId ? fixture.font : null,
                widget: ids.widgetId ? fixture.widget : null,
              },
            };
          },
        },
      },
    },
  },
}));
afterEach(() => vi.unstubAllGlobals());

it('补齐字体和挂件、乐观消息被回读替换时，同款气泡和字体不闪回默认或重建样式', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe({ fontId, widgetId }: { fontId: number; widgetId: number }) {
    const decoration = useMsgDecoration({ bubbleId: 21001, fontId, widgetId });
    return createElement('div', {
      'data-bubble': decoration.bubbleId,
      'data-font': decoration.fontId,
    });
  }
  const render = (fontId: number, widgetId: number, key = 'optimistic') =>
    act(async () => root.render(createElement(Probe, { fontId, widgetId, key })));
  try {
    await render(0, 0);
    const bubbleStyle = document.head.querySelector('[data-weq-msg-decoration^="bubble:"]');
    expect(bubbleStyle).not.toBeNull();
    await render(31001, 0);
    expect(host.firstElementChild?.getAttribute('data-bubble')).toBe('21001');
    expect(host.firstElementChild?.getAttribute('data-font')).toBe('31001');
    expect(document.head.querySelector('[data-weq-msg-decoration^="bubble:"]')).toBe(bubbleStyle);
    const fontStyle = document.head.querySelector('[data-weq-msg-decoration^="font:"]');
    await render(31001, 10001);
    expect(host.firstElementChild?.getAttribute('data-bubble')).toBe('21001');
    expect(document.head.querySelector('[data-weq-msg-decoration^="font:"]')).toBe(fontStyle);
    await render(31001, 10001, 'local-sent');
    await render(31001, 10001, 'qq-record');
    expect(document.head.querySelector('[data-weq-msg-decoration^="bubble:"]')).toBe(bubbleStyle);
    expect(document.head.querySelector('[data-weq-msg-decoration^="font:"]')).toBe(fontStyle);
  } finally {
    await act(async () => root.unmount());
  }
  expect(document.head.querySelector('[data-weq-msg-decoration]')).toBeNull();
});
