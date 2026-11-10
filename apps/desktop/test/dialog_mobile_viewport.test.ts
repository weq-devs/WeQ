import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Modal } from '../src/renderer/src/components/Dialog';

vi.mock('../src/renderer/src/lib/target', async (original) => ({
  ...(await original<object>()),
  IS_WEB: true,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('Web 弹窗自身跟随键盘可视视口，不依赖主页面的 CSS 变量继承', () => {
  act(() => root.render(createElement(Modal, { centered: true }, '合成表单')));
  const layer = document.querySelector<HTMLElement>('.weq-web-dialog-layer')!;
  expect(layer.parentElement).toBe(document.body);
  expect(layer.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('844px');
  viewport.height = 320;
  viewport.offsetTop = 96;
  viewport.dispatchEvent(new Event('resize'));
  expect(layer.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('320px');
  expect(layer.style.getPropertyValue('--weq-mobile-viewport-top')).toBe('96px');
});

it('保留但隐藏的弹窗停用视口监听，再打开时读取当前尺寸', () => {
  const render = (open: boolean) =>
    act(() => root.render(createElement(Modal, { open }, '合成表单')));
  render(true);
  const layer = document.querySelector<HTMLElement>('.weq-web-dialog-layer')!;
  render(false);
  viewport.height = 320;
  viewport.dispatchEvent(new Event('resize'));
  expect(layer.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('');
  render(true);
  expect(layer.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('320px');
});
