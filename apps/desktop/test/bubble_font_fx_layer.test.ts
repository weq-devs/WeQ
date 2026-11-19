import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { FontFx } from '@weq/service';
import { useBubbleFontFx } from '../src/renderer/src/hooks/useBubbleFontFx';
import { FONT_FX_LAYER_CLASS } from '../src/renderer/src/lib/dressSkin';

it('字体绘制层留在原内容上，正文同尺寸替换时移动到新内容', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const frames: FontFx = { variants: [{ width: 200, height: 75, frames: [1, 2] }] };
  function Row({
    contentKey,
    text,
    enabled,
  }: {
    contentKey: string;
    text: string;
    enabled: boolean;
  }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const attr = useBubbleFontFx(
      enabled ? { itemId: 42001, deriveVersion: 1, fx: frames } : null,
      ref,
    );
    return createElement(
      'div',
      { ref, 'data-fontfx': attr },
      createElement('div', { key: contentKey, className: 'message-content' }, text),
    );
  }
  const render = (contentKey: string, text: string, enabled = true) =>
    act(async () => {
      root.render(createElement(Row, { contentKey, text, enabled }));
    });
  const mutationsFlushed = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const fx = () => host.querySelector(`.${FONT_FX_LAYER_CLASS}`);
  try {
    await render('a', 'First');
    const first = fx();
    const firstContent = first?.parentElement;
    expect(first?.parentElement?.textContent).toBe('First');
    await render('a', 'Updated');
    await mutationsFlushed();
    expect(fx()).toBe(first);

    await render('b', 'Replaced');
    await mutationsFlushed();
    expect(firstContent?.isConnected).toBe(false);
    expect(fx()).toBe(first);
    expect(fx()?.parentElement?.textContent).toBe('Replaced');
    expect(host.querySelectorAll(`.${FONT_FX_LAYER_CLASS}`)).toHaveLength(1);

    await render('b', 'Replaced', false);
    expect(fx()).toBeNull();
    expect(host.textContent).toBe('Replaced');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
