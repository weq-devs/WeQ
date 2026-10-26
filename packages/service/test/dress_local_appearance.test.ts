import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DressConfigService } from '../src/account/dress_config';
import { DressService } from '../src/account/dress_service';
import type { DressSharedCache } from '../src/account/dress_shared_cache';
import { migrateDressData } from '../src/account/dress_migrate';

const dirs: string[] = [];

function configFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-local-dress-'));
  dirs.push(dir);
  return { dir, config: new DressConfigService(dir) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('本地装扮默认不覆盖消息', () => {
  it('新账号不启用气泡、字体、挂件和 QQ 背景', () => {
    const { config } = configFixture();
    expect(config.read()).toMatchObject({
      activeBubble: 0,
      activeFont: 0,
      activeWidget: 0,
      background: 'none',
    });
  });

  it('旧配置取消来源不明的消息覆盖，保留已装资源与自定义背景', () => {
    const { dir, config } = configFixture();
    writeFileSync(
      join(dir, 'dress.json'),
      JSON.stringify({
        installedBubbles: [11],
        installedFonts: [22],
        installedWidgets: [33],
        activeBubble: 11,
        activeFont: 22,
        activeWidget: 33,
        background: 'custom',
        backgroundFile: 'scene.png',
      }),
    );
    expect(config.read()).toMatchObject({
      installedBubbles: [11],
      installedFonts: [22],
      installedWidgets: [33],
      activeBubble: 0,
      activeFont: 0,
      activeWidget: 0,
      background: 'custom',
      backgroundFile: 'scene.png',
    });
    config.setActive('font', 44);
    expect(new DressConfigService(dir).read()).toMatchObject({
      activeBubble: 0,
      activeFont: 44,
      activeWidget: 0,
    });
  });

  it('明确使用、取消和再次读取均保留选择', () => {
    const { dir, config } = configFixture();
    config.setActive('bubble', 11);
    config.setActive('font', 22);
    config.setActive('widget', 33);
    expect(new DressConfigService(dir).read()).toMatchObject({
      activeBubble: 11,
      activeFont: 22,
      activeWidget: 33,
    });
    config.setActive('font', 0);
    expect(new DressConfigService(dir).read().activeFont).toBe(0);
  });

  it('迁移旧资源清单不会重新启用旧版消息覆盖', () => {
    const { dir, config } = configFixture();
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        bubbles: [],
        fonts: [],
        activeBubble: 11,
        activeFont: 22,
        scope: 'all',
        background: 'none',
        widgetId: '',
        backgroundOpacity: 1,
      }),
    );
    migrateDressData(dir, join(dir, 'shared'), config);
    expect(config.read()).toMatchObject({ activeBubble: 0, activeFont: 0, scope: 'all' });
  });

  it('同步 QQ 装扮只准备资源，不启用或覆盖本地选择，取消后也不自动恢复', async () => {
    const { config } = configFixture();
    const service = new DressService(config, {} as DressSharedCache);
    // 安装成功和失败均不得改变激活项。
    const bubble = vi.spyOn(service, 'installBubble').mockImplementation(async (id) => {
      config.markBubbleInstalled(id);
      return {} as Awaited<ReturnType<DressService['installBubble']>>;
    });
    const font = vi.spyOn(service, 'installFont').mockImplementation(async (id) => {
      config.markFontInstalled(id);
      return {} as Awaited<ReturnType<DressService['installFont']>>;
    });
    const widget = vi.spyOn(service, 'installWidget').mockRejectedValue(new Error('离线'));
    const own = { bubbleId: 11, fontId: 22, widgetId: 33, chatBgUrl: 'https://example.test/bg' };
    await service.syncFromQq(own);
    expect(config.read()).toMatchObject({
      installedBubbles: [own.bubbleId],
      installedFonts: [own.fontId],
      activeBubble: 0,
      activeFont: 0,
      activeWidget: 0,
      background: 'none',
    });
    widget.mockImplementation(async (id) => {
      config.markWidgetInstalled(id);
      return {} as Awaited<ReturnType<DressService['installWidget']>>;
    });
    config.setActive('font', 44);
    await service.syncFromQq(own);
    expect(config.read().activeFont).toBe(44);
    config.setActive('font', 0);
    await service.syncFromQq(own);
    expect(config.read().activeFont).toBe(0);
    expect(config.read()).toMatchObject({ installedWidgets: [own.widgetId], activeWidget: 0 });
    expect(bubble).toHaveBeenCalledTimes(1);
    expect(font).toHaveBeenCalledTimes(1);
  });
});
