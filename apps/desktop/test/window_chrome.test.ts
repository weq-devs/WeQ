// @vitest-environment node
import { expect, it } from 'vitest';
import { nativeWindowChrome, MACOS_WINDOW_CORNER } from '../src/shared/window_chrome';

const options = {
  platform: 'darwin',
  controls: 'native' as const,
  fullscreen: false,
  width: 600,
  height: 900,
};

it('macOS 原生按钮沿用现有占位约定，单栏由共用布局器消费', () => {
  expect(nativeWindowChrome(options)).toEqual({
    controls: 'native',
    inline: true,
    layout: {
      width: 600,
      height: 900,
      topLeft: MACOS_WINDOW_CORNER,
      topRight: { width: 0, height: 0 },
    },
  });
});

it('全屏保留单栏合并模式但清空占位，退出全屏后恢复', () => {
  const fullscreen = nativeWindowChrome({ ...options, fullscreen: true });
  expect(fullscreen.inline).toBe(true);
  expect(fullscreen.layout.topLeft).toEqual({ width: 0, height: 0 });
  expect(nativeWindowChrome(options).layout.topLeft).toEqual(MACOS_WINDOW_CORNER);
});

it.each(['linux', 'win32'])('%s 的原生装饰不当成 macOS 红绿灯', (platform) => {
  const value = nativeWindowChrome({ ...options, platform });
  expect(value.inline).toBe(false);
  expect(value.layout.topLeft).toEqual({ width: 0, height: 0 });
});

it('仿 Windows 按钮不合并窗口栏、不残留红绿灯占位', () => {
  const value = nativeWindowChrome({ ...options, controls: 'windows' });
  expect(value.inline).toBe(false);
  expect(value.controls).toBe('windows');
  expect(value.layout.topLeft).toEqual({ width: 0, height: 0 });
});
