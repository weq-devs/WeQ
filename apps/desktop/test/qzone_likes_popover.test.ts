import { act, createElement as h, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzoneLikesPopover } from '../src/renderer/src/components/QzoneLikesPopover';
import { useSurfaceOutside } from '../src/renderer/src/lib/surfaceOutside';

let close: (() => void) | undefined;
it('浮层内点击点赞人不会被底层资料弹窗当作点外关闭或吞掉点击', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const dismissed = vi.fn(),
    opened = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useSurfaceOutside(ref, dismissed, true);
    return h(
      'div',
      { ref, 'data-weq-surface': true, style: { zIndex: 1 } },
      h(
        QzoneLikesPopover,
        { trigger: h('button', null, '点赞') },
        h('button', { onClick: opened }, '合成点赞人'),
      ),
    );
  }
  await act(async () => root.render(h(Harness)));
  await act(async () => host.querySelector('button')!.focus());
  const person = document.querySelector<HTMLButtonElement>('.weq-qzn-like-popover button')!;
  await act(async () => {
    person.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    person.click();
  });
  expect(dismissed).not.toHaveBeenCalled();
  expect(opened).toHaveBeenCalledOnce();
});
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
