// @vitest-environment jsdom
import { act, createElement as h, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Modal } from '../src/renderer/src/components/Dialog';
import { OverlayLayer } from '../src/renderer/src/components/OverlayLayer';
import { useSurfaceEscape } from '../src/renderer/src/lib/surfaceEscape';

const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

function mount(render: (close: () => void) => ReactElement) {
  const trigger = document.createElement('button');
  const background = document.createElement('button');
  const host = document.createElement('div');
  document.body.append(trigger, background, host);
  trigger.focus();
  const root = createRoot(host);
  const close = vi.fn();
  function View() {
    const [open, setOpen] = useState(true);
    return open
      ? render(() => {
          close();
          setOpen(false);
        })
      : null;
  }
  act(() => root.render(h(View)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
    trigger.remove();
    background.remove();
  });
  return { host, trigger, background, close };
}

function pressEscape(init: KeyboardEventInit = {}) {
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    ),
  );
}

it.each(['panel', 'popover', 'floating', 'anchored', 'overlay'] as const)(
  '%s 弹窗失焦后 Esc 仍关闭顶层并归还入口焦点',
  (presentation) => {
    const f = mount((close) =>
      presentation === 'overlay'
        ? h(OverlayLayer, { presentation: 'popover', onClose: close }, h('button', null, '内容'))
        : h(Modal, { presentation, onClose: close }, h('button', null, '内容')),
    );
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    pressEscape();
    expect(f.close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(f.trigger);
  },
);

it('非模态弹窗主动操作其他背景控件后不消费 Esc', () => {
  const f = mount((close) => h(Modal, { presentation: 'panel', onClose: close }, h('input')));
  act(() => f.background.focus());
  pressEscape();
  expect(f.close).not.toHaveBeenCalled();
  act(() => f.trigger.focus());
  pressEscape();
  expect(f.close).toHaveBeenCalledOnce();
});

it('普通非模态页面失焦后不响应 Esc，重新聚焦页面才关闭', () => {
  function Page({ onClose }: { onClose: () => void }) {
    const ref = useRef<HTMLElement>(null);
    useSurfaceEscape(ref, onClose, true, false);
    return h('section', { ref, tabIndex: -1 }, h('button', null, '页面内容'));
  }
  const f = mount((close) => h(Page, { onClose: close }));
  act(() => (document.activeElement as HTMLElement).blur());
  pressEscape();
  expect(f.close).not.toHaveBeenCalled();
  act(() => f.trigger.focus());
  pressEscape();
  expect(f.close).not.toHaveBeenCalled();
  act(() => f.host.querySelector<HTMLButtonElement>('button')!.focus());
  pressEscape();
  expect(f.close).toHaveBeenCalledOnce();
});

it.each([{ isComposing: true }, { keyCode: 229 }])('失焦弹窗不消费输入法的 Esc：%j', (init) => {
  const f = mount((close) => h(Modal, { presentation: 'popover', onClose: close }, h('input')));
  act(() => (document.activeElement as HTMLElement).blur());
  pressEscape(init);
  expect(f.close).not.toHaveBeenCalled();
  pressEscape();
  expect(f.close).toHaveBeenCalledOnce();
});
