// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => ({
  resolveResource: vi.fn(),
  createFromPath: vi.fn(),
  createEmpty: vi.fn(),
  buildFromTemplate: vi.fn(),
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class TrayStub extends EventEmitter {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    popUpContextMenu = vi.fn();
    constructor(readonly image: unknown) {
      super();
    }
  }
  return {
    nativeImage: { createFromPath: mocks.createFromPath, createEmpty: mocks.createEmpty },
    Menu: { buildFromTemplate: mocks.buildFromTemplate },
    Tray: TrayStub,
  };
});
vi.mock('../src/main/resource', () => ({ resolveResource: mocks.resolveResource }));

import { createSystemTray } from '../src/main/system_tray';

function imageStub(empty = false) {
  const image = {
    isEmpty: () => empty,
    resize: vi.fn((_size: { width: number; height: number }) => imageStub()),
    toPNG: vi.fn(() => Buffer.from('png')),
    addRepresentation: vi.fn((_options: { scaleFactor: number; buffer: Buffer }) => {}),
    setTemplateImage: vi.fn(),
  };
  return image;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveResource.mockReturnValue('/resources/brand/logo.png');
  mocks.createFromPath.mockImplementation(() => imageStub());
  mocks.createEmpty.mockImplementation(() => imageStub(true));
  mocks.buildFromTemplate.mockImplementation((items: MenuItemConstructorOptions[]) => ({ items }));
});

function setup(platform: NodeJS.Platform = 'darwin', locale = 'zh-CN') {
  const openMainWindow = vi.fn();
  const quit = vi.fn();
  const tray = createSystemTray({ platform, locale, openMainWindow, quit });
  return { tray, openMainWindow, quit };
}

describe('系统托盘', () => {
  it('macOS 保留彩色 Logo，不能把有圆形背景的品牌图误当单色模板', () => {
    setup();
    const source = mocks.createFromPath.mock.results[0]!.value;
    expect(source.setTemplateImage).not.toHaveBeenCalled();
    for (const resized of source.resize.mock.results) {
      expect(resized.value.setTemplateImage).not.toHaveBeenCalled();
    }
  });

  it('macOS 提供 18pt 的普通和 Retina 图像', () => {
    const { tray } = setup();
    const source = mocks.createFromPath.mock.results[0]!.value;
    expect(source.resize).toHaveBeenCalledWith({ width: 18, height: 18 });
    expect(source.resize).toHaveBeenCalledWith({ width: 36, height: 36 });
    const { image } = tray as unknown as { image: ReturnType<typeof imageStub> };
    expect(image.addRepresentation.mock.calls.map(([options]) => options.scaleFactor)).toEqual([
      1, 2,
    ]);
  });

  it('macOS 单击和双击只打开窗口，右键才显示菜单且不打开窗口', () => {
    const { tray, openMainWindow, quit } = setup();
    expect(tray.setContextMenu).not.toHaveBeenCalled();
    tray.emit('click');
    expect(openMainWindow).toHaveBeenCalledTimes(1);
    expect(tray.popUpContextMenu).not.toHaveBeenCalled();
    tray.emit('double-click');
    expect(openMainWindow).toHaveBeenCalledTimes(2);
    openMainWindow.mockClear();
    tray.emit('right-click');
    expect(tray.popUpContextMenu).toHaveBeenCalledWith(
      mocks.buildFromTemplate.mock.results[0]!.value,
    );
    expect(openMainWindow).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'en-US'])('菜单保留显示窗口和直接退出入口（%s）', (locale) => {
    const { openMainWindow, quit } = setup('darwin', locale);
    const items = mocks.buildFromTemplate.mock.calls[0]![0] as MenuItemConstructorOptions[];
    expect(items.map((item) => item.label ?? item.type)).toEqual(
      locale === 'zh-CN'
        ? ['显示主窗口', 'separator', '退出 WeQ']
        : ['Show Main Window', 'separator', 'Quit WeQ'],
    );
    const show = items[0]!.click as () => void;
    const exit = items[2]!.click as () => void;
    show();
    expect(openMainWindow).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    exit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'] as const)('%s 保持系统托盘菜单和窗口唤起行为', (platform) => {
    const { tray, openMainWindow } = setup(platform);
    expect(tray.setContextMenu).toHaveBeenCalledWith(
      mocks.buildFromTemplate.mock.results[0]!.value,
    );
    tray.emit('click');
    expect(openMainWindow).toHaveBeenCalledTimes(1);
    expect(mocks.createFromPath.mock.results[0]!.value.resize).toHaveBeenCalledWith({
      width: 16,
      height: 16,
    });
  });

  it('图标缺失或无法解码时明确失败，不创建空白托盘', () => {
    mocks.resolveResource.mockReturnValue(null);
    expect(() => setup()).toThrow('找不到 WeQ 托盘图标');
    mocks.resolveResource.mockReturnValue('/resources/brand/logo.png');
    mocks.createFromPath.mockReturnValue(imageStub(true));
    expect(() => setup()).toThrow('无法读取 WeQ 托盘图标');
    expect(mocks.buildFromTemplate).not.toHaveBeenCalled();
  });
});
