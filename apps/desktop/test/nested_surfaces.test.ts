import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal, DialogHost, useDialog } from '../src/renderer/src/components/Dialog';
import { OverlayLayer } from '../src/renderer/src/components/OverlayLayer';
import { OverlayAnchorProvider } from '../src/renderer/src/lib/overlayAnchor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['popover', 'floating', 'overlay'] as const)(
  '父浮窗重新聚焦、点击或重新打开后，%s 子窗仍在父窗上方',
  (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let reopen = () => {};
    function View() {
      const [open, setOpen] = useState(true);
      reopen = () => setOpen(!open);
      const child = h('button', { 'data-child': true }, '子窗');
      return h(
        Modal,
        { presentation: 'floating', open },
        h('button', { 'data-parent': true }, '父窗'),
        kind === 'overlay' ? h(OverlayLayer, null, child) : h(Modal, { presentation: kind }, child),
      );
    }
    const parent = () => document.querySelector<HTMLButtonElement>('[data-parent]')!;
    const layer = (selector: string) =>
      Number(
        document
          .querySelector(selector)!
          .closest<HTMLElement>('.weq-window-layer, .weq-dialog-layer, .weq-overlay-layer')!.style
          .zIndex,
      );
    const assertOrder = () => expect(layer('[data-child]')).toBeGreaterThan(layer('[data-parent]'));
    try {
      act(() => root.render(h(View)));
      assertOrder();
      act(() => parent().focus());
      assertOrder();
      act(() => parent().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      assertOrder();
      act(() => reopen());
      act(() => reopen());
      assertOrder();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each(['popover', 'panel', 'modal', 'overlay'] as const)(
  '%s 子窗沿用实际入口位置，入口收起后仍能避让视口边缘',
  (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('innerWidth', 375);
    vi.stubGlobal('innerHeight', 800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.hasAttribute('data-trigger')
        ? new DOMRect(340, 740, 27, 30)
        : new DOMRect(0, 0, 228, 171);
    });
    // 入场动画缩放后的矩形不能用来决定动画结束时的边缘避让。
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    function View() {
      const [open, setOpen] = useState(false);
      const content = h('button', { 'data-positioned': true }, '子弹窗');
      return h(
        OverlayAnchorProvider,
        null,
        h('button', { 'data-trigger': true, hidden: open, onClick: () => setOpen(true) }, '打开'),
        open &&
          (kind === 'overlay'
            ? h(OverlayLayer, { presentation: 'popover' }, content)
            : h(Modal, { presentation: kind, onClose: () => setOpen(false) }, content)),
      );
    }
    try {
      act(() => root.render(h(View)));
      act(() => document.querySelector<HTMLButtonElement>('[data-trigger]')!.click());
      const layer = document
        .querySelector('[data-positioned]')!
        .closest<HTMLElement>('.weq-dialog-layer, .weq-overlay-layer')!;
      expect(layer.classList.contains('is-anchored-popover')).toBe(true);
      expect(layer.style.getPropertyValue('--weq-popover-left')).toBe('127px');
      expect(layer.style.getPropertyValue('--weq-popover-top')).toBe('552px');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('模态父窗中的非模态子窗只响应自己的 Escape，不连带关闭父窗', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const parentClose = vi.fn();
  const childClose = vi.fn();
  function View() {
    const [open, setOpen] = useState(false);
    return h(
      Modal,
      { onClose: parentClose },
      h('button', { 'data-open-child': true, onClick: () => setOpen(true) }, '打开'),
      open &&
        h(
          Modal,
          { presentation: 'popover', onClose: childClose },
          h('button', { 'data-escape-child': true }, '子窗'),
        ),
    );
  }
  try {
    act(() => root.render(h(View)));
    act(() => document.querySelector<HTMLButtonElement>('[data-open-child]')!.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-escape-child]')!.focus());
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(childClose).toHaveBeenCalledOnce();
    expect(parentClose).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('任务浮窗里打开删除确认后，确认框居中且不会被浮窗抢层压住', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const layerOf = (selector: string) =>
    Number(
      document
        .querySelector(selector)!
        .closest<HTMLElement>('.weq-window-layer, .weq-dialog-layer, .weq-overlay-layer')!.style
        .zIndex,
    );
  try {
    act(() =>
      root.render(
        h(
          'div',
          null,
          h(
            Modal,
            { presentation: 'anchored', width: 560, title: '任务' },
            h('button', { 'data-task': true }, '删除导出缓存'),
          ),
          h(DialogHost),
        ),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>('[data-task]')!;
    act(() => {
      // 任务窗内先聚焦、再 pointerdown（WindowSurface 会在这两处抬层）。
      trigger.focus();
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      void useDialog.getState().confirm('删除尚未保存的结果', '确认删除？');
    });
    const dialog = document.querySelector<HTMLElement>('[aria-modal="true"]')!;
    expect(dialog).not.toBeNull();
    // 全局确认框不应按入口锚定到任务窗内的按钮。
    expect(dialog.closest('.is-anchored-popover')).toBeNull();
    expect(layerOf('[aria-modal="true"]')).toBeGreaterThan(layerOf('[data-task]'));
  } finally {
    act(() => {
      useDialog.getState().close();
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
