// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { WINDOW_LAYOUTS, applyWindowLayout } from '../src/main/window_layout';

it('同窗口重载后重复请求聊天布局，保留用户调整后的尺寸和位置', () => {
  let bounds = { x: 100, y: 100, width: 1180, height: 760 };
  const win = {
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => bounds,
    getContentSize: () => [bounds.width, bounds.height],
    setMinimumSize: vi.fn(),
    setContentSize: vi.fn(),
    setPosition: vi.fn(),
  };
  const area = { x: 0, y: 0, width: 1800, height: 1200 };
  applyWindowLayout(win, 'chat', area);
  bounds = { x: 230, y: 180, width: 1400, height: 900 };
  vi.clearAllMocks();
  applyWindowLayout(win, 'chat', area);
  expect(win.setContentSize).not.toHaveBeenCalled();
  expect(win.setPosition).not.toHaveBeenCalled();
  applyWindowLayout(win, 'home', area);
  expect(win.setContentSize).toHaveBeenCalledWith(
    WINDOW_LAYOUTS.home.width,
    WINDOW_LAYOUTS.home.height,
  );
});

it('回到登录页先放宽最小宽度，再收成竖版；返回聊天恢复原边界', () => {
  let bounds = { x: 100, y: 100, width: 1180, height: 760 };
  const calls: string[] = [];
  const win = {
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => bounds,
    getContentSize: (): [number, number] => [bounds.width, bounds.height],
    setMinimumSize: vi.fn(() => {
      calls.push('minimum');
    }),
    setContentSize: vi.fn((width: number, height: number) => {
      calls.push('size');
      bounds = { ...bounds, width, height };
    }),
    setPosition: vi.fn(),
  };
  applyWindowLayout(win, 'home', { x: 0, y: 0, width: 1440, height: 900 });
  expect(calls).toEqual(['minimum', 'size']);
  expect(win.setContentSize).toHaveBeenLastCalledWith(
    WINDOW_LAYOUTS.home.width,
    WINDOW_LAYOUTS.home.height,
  );
  expect(win.setMinimumSize).toHaveBeenLastCalledWith(
    WINDOW_LAYOUTS.home.minWidth,
    WINDOW_LAYOUTS.home.minHeight,
  );
  applyWindowLayout(win, 'chat', { x: 0, y: 0, width: 1024, height: 700 });
  expect(win.setContentSize).toHaveBeenLastCalledWith(1024, 700);
  expect(win.setMinimumSize).toHaveBeenLastCalledWith(
    WINDOW_LAYOUTS.chat.minWidth,
    WINDOW_LAYOUTS.chat.minHeight,
  );
  expect(win.setPosition).toHaveBeenLastCalledWith(0, 0);
});
it('最大化或全屏时不改变用户窗口', () => {
  const change = vi.fn();
  const win = {
    isMaximized: () => true,
    isFullScreen: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    getContentSize: (): [number, number] => [1440, 900],
    setMinimumSize: change,
    setContentSize: change,
    setPosition: change,
  };
  applyWindowLayout(win, 'home', win.getBounds());
  expect(change).not.toHaveBeenCalled();
  applyWindowLayout(
    { ...win, isMaximized: () => false, isFullScreen: () => true },
    'home',
    win.getBounds(),
  );
  expect(change).not.toHaveBeenCalled();
});
it('可用空间不足时为原生标题栏和边框预留空间，不把底部推到屏幕外', () => {
  let bounds = { x: 400, y: 200, width: 1180, height: 788 };
  const win = {
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => bounds,
    getContentSize: (): [number, number] => [bounds.width, bounds.height - 28],
    setMinimumSize: vi.fn(),
    setContentSize: vi.fn((width: number, height: number) => {
      bounds = { ...bounds, width, height: height + 28 };
    }),
    setPosition: vi.fn(),
  };
  applyWindowLayout(win, 'chat', { x: 0, y: 0, width: 1024, height: 700 });
  expect(win.setContentSize).toHaveBeenCalledWith(1024, 672);
  expect(bounds.height).toBe(700);
  expect(win.setPosition).toHaveBeenCalledWith(0, 0);
});
