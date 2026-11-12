import { afterEach, expect, it, vi } from 'vitest';
import {
  observeRemoteWindowLayout,
  resolveWindowChrome,
  windowCornerRects,
} from '../src/renderer/src/lib/remoteWindowLayout';

const layout = {
  width: 1000,
  height: 800,
  topLeft: { width: 100, height: 32 },
  topRight: { width: 0, height: 0 },
};
const wide = { left: 0, top: 0, right: 1000, bottom: 56 };
const corners = windowCornerRects(layout, 1000);

afterEach(() => {
  delete window.weqRemoteWindowLayout;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('桌面原生快照复用同一计算器，偏好切换清理旧占位，卸载退订', () => {
  const root = document.createElement('div');
  root.className = 'weq-web-shell';
  const header = document.createElement('header');
  header.className = 'weq-mobile-header';
  root.append(header);
  document.body.append(root);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
    ...wide,
    width: 1000,
    height: 56,
  } as DOMRect);
  let changed: (value: import('../src/shared/window_chrome').NativeWindowChrome) => void = () => {};
  const unsubscribe = vi.fn();
  vi.stubGlobal('weq', {
    windowChrome: {
      getSnapshot: () => ({ controls: 'native', inline: true, layout }),
      onChange: (listener: typeof changed) => {
        changed = listener;
        return unsubscribe;
      },
    },
  });
  const stop = observeRemoteWindowLayout(document);
  expect(document.documentElement.hasAttribute('data-weq-inline-native-controls')).toBe(true);
  expect(header.style.getPropertyValue('--weq-window-chrome-left')).toBe('108px');
  changed({
    controls: 'windows',
    inline: false,
    layout: { ...layout, topLeft: { width: 0, height: 0 } },
  });
  expect(document.documentElement.hasAttribute('data-weq-inline-native-controls')).toBe(false);
  expect(header.hasAttribute('data-weq-window-chrome')).toBe(false);
  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('宽标题只在相交处横向避让，其他栏与下方标题不移动', () => {
  expect(resolveWindowChrome(wide, corners)).toEqual({ left: 108, right: 0, top: 0 });
  expect(resolveWindowChrome({ ...wide, left: 300 }, corners)).toEqual({
    left: 0,
    right: 0,
    top: 0,
  });
  expect(resolveWindowChrome({ ...wide, top: 44, bottom: 100 }, corners)).toEqual({
    left: 0,
    right: 0,
    top: 0,
  });
  expect(
    resolveWindowChrome({ ...wide, left: 120, top: 12, right: 880, bottom: 600 }, corners),
  ).toEqual({ left: 0, right: 0, top: 0 });
});

it('窄窗口不足以保留触控区域时下移，不同时叠加横向留白', () => {
  expect(resolveWindowChrome({ ...wide, right: 320 }, corners)).toEqual({
    left: 0,
    right: 0,
    top: 32,
  });
});

it('普通顶部安全区已经覆盖占位时不重复内缩', () => {
  expect(resolveWindowChrome(wide, corners, 32)).toEqual({ left: 0, right: 0, top: 0 });
});

it('同时处理两侧角部并按网页布局像素换算', () => {
  const scaled = windowCornerRects({ ...layout, topRight: { width: 20, height: 24 } }, 500);
  expect(scaled).toEqual([
    { left: 0, right: 50, top: 0, bottom: 16 },
    { left: 490, right: 500, top: 0, bottom: 12 },
  ]);
  expect(resolveWindowChrome({ ...wide, right: 500 }, scaled)).toEqual({
    left: 58,
    right: 18,
    top: 0,
  });
});

it.each([null, {}, { ...layout, width: 0 }, { ...layout, height: NaN }, { ...layout, width: -1 }])(
  '无效或尚未测量的布局不产生占位：%j',
  (value) => {
    expect(windowCornerRects(value, 1000)).toEqual([]);
  },
);

it('全屏零占位与无效角部不产生额外间距', () => {
  expect(windowCornerRects({ ...layout, topLeft: { width: 0, height: 0 } }, 1000)).toEqual([]);
  expect(windowCornerRects({ ...layout, topLeft: { width: NaN, height: 32 } }, 1000)).toEqual([]);
});

it('补读早到布局，原地更新并在全屏或卸载时清除，不替换正文', () => {
  const root = document.createElement('div');
  root.className = 'weq-web-shell';
  const header = document.createElement('header');
  header.className = 'weq-mobile-header';
  const input = document.createElement('input');
  input.value = '保留草稿';
  root.append(header, input);
  document.body.append(root);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
    ...wide,
    width: 1000,
    height: 56,
  } as DOMRect);
  window.weqRemoteWindowLayout = layout;
  const stop = observeRemoteWindowLayout(document);
  expect(header.style.getPropertyValue('--weq-window-chrome-left')).toBe('108px');
  input.focus();
  window.weqRemoteWindowLayout = { ...layout, topLeft: { width: 0, height: 0 } };
  window.dispatchEvent(new Event('weq-remote-window-layout'));
  expect(header.hasAttribute('data-weq-window-chrome')).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('保留草稿');
  window.weqRemoteWindowLayout = layout;
  window.dispatchEvent(new Event('weq-remote-window-layout'));
  expect(header.style.getPropertyValue('--weq-window-chrome-left')).toBe('108px');
  stop();
  expect(header.hasAttribute('data-weq-window-chrome')).toBe(false);
  expect(document.documentElement.style.getPropertyValue('--weq-window-header-top')).toBe('');
});
