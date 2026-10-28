import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzoneLikesPopover } from '../src/renderer/src/components/QzoneLikesPopover';

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('点赞名单独立挂到文档浮层，移入名单不断开，移出或 Escape 可收起', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const clipped = document.createElement('div');
  clipped.style.overflow = 'hidden';
  document.body.append(clipped);
  const root = createRoot(clipped);
  close = () => {
    act(() => root.unmount());
    clipped.remove();
  };
  await act(async () =>
    root.render(
      h(
        QzoneLikesPopover,
        {
          trigger: h('button', { type: 'button' }, '点赞'),
        },
        h('button', { type: 'button' }, '合成点赞者'),
      ),
    ),
  );
  const anchor = clipped.querySelector('.weq-qzn-like-hover')!;
  await act(async () => anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  const panel = document.querySelector<HTMLElement>('[aria-label="点赞列表"]')!;
  expect(panel).not.toBeNull();
  expect(clipped.contains(panel)).toBe(false);
  expect(panel.parentElement!.parentElement).toBe(document.body);
  await act(async () => {
    anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: panel }));
    panel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: anchor }));
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(document.querySelector('[aria-label="点赞列表"]')).toBe(panel);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[aria-label="点赞列表"]')).toBeNull();
  await act(async () => anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await act(async () => {
    anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(document.querySelector('[aria-label="点赞列表"]')).toBeNull();
});
