import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupFeatureSurface } from '../src/renderer/src/components/GroupFeatureSurface';
import { OverlayLayer } from '../src/renderer/src/components/OverlayLayer';

let dispose = () => {};
afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});

function mount(element: ReturnType<typeof h>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

function press(element: Element) {
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

it('群功能点外收起后，同次点击仍执行目标操作', () => {
  const outside = vi.fn();
  function Fixture() {
    const [opened, setOpened] = useState(true);
    return h(
      'div',
      null,
      h('button', { 'data-outside': true, onClick: outside }, '聊天操作'),
      opened
        ? h(
            GroupFeatureSurface,
            { presentation: 'popover', title: '群精华', onClose: () => setOpened(false) },
            h('section', { 'data-feature': true }, '精华内容'),
          )
        : null,
    );
  }
  const host = mount(h(Fixture));
  expect(document.querySelector('.weq-group-feature-layer.is-popover')).not.toBeNull();
  press(host.querySelector('[data-outside]')!);
  expect(document.querySelector('[data-feature]')).toBeNull();
  expect(outside).toHaveBeenCalledOnce();
});

it('触发点与内容点击不触发外部关闭，子菜单打开时父浮窗仍保留', () => {
  const close = vi.fn();
  const anchor = document.createElement('button');
  document.body.append(anchor);
  try {
    mount(
      h(
        GroupFeatureSurface,
        { presentation: 'popover', anchor, title: '群待办', onClose: close },
        h(
          'section',
          null,
          h('button', { 'data-inside': true }, '待办'),
          h(
            OverlayLayer,
            { presentation: 'popover', onClose: vi.fn() },
            h('div', { role: 'menu', 'data-child': true }, '子菜单'),
          ),
        ),
      ),
    );
    press(anchor);
    press(document.querySelector('[data-child]')!);
    expect(close).not.toHaveBeenCalled();
  } finally {
    anchor.remove();
  }
});

it('Esc 只关闭最上层子菜单，再按一次才关闭群功能浮窗', () => {
  const close = vi.fn();
  function Fixture() {
    const [child, setChild] = useState(true);
    return h(
      GroupFeatureSurface,
      { presentation: 'popover', title: '群公告', onClose: close },
      h(
        'section',
        null,
        h('button', { 'data-parent': true }, '公告操作'),
        child
          ? h(
              OverlayLayer,
              { presentation: 'popover', onClose: () => setChild(false) },
              h('button', { 'data-child': true }, '菜单操作'),
            )
          : null,
      ),
    );
  }
  mount(h(Fixture));
  const pressEscape = () =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  pressEscape();
  expect(document.querySelector('[data-child]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  act(() => document.querySelector<HTMLButtonElement>('[data-parent]')!.focus());
  pressEscape();
  expect(close).toHaveBeenCalledOnce();
});

it('资料页嵌入内容不生成额外浮层', () => {
  const host = mount(
    h(
      GroupFeatureSurface,
      { embedded: true, presentation: 'popover', title: '群打卡', onClose: vi.fn() },
      h('section', null, '打卡记录'),
    ),
  );
  expect(host.querySelector('.weq-profile-detail-embedded')?.textContent).toBe('打卡记录');
  expect(document.querySelector('.weq-group-feature-layer')).toBeNull();
});
