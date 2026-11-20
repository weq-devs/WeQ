import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DressConfigService } from '../src/account/dress_config';
import { DressConversationStore } from '../src/account/dress_conversations';
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
  it('旧范围迁移到三类，分别调整并重开后仍保留各自设置', () => {
    const { dir, config } = configFixture();
    writeFileSync(join(dir, 'dress.json'), JSON.stringify({ scope: 'fallback' }));
    expect(config.read().scopes).toEqual({
      bubble: 'fallback',
      font: 'fallback',
      widget: 'fallback',
    });
    config.setScope('all', 'bubble');
    config.setScope('mine', 'font');
    const reopened = new DressConfigService(dir);
    expect(reopened.read().scopes).toEqual({ bubble: 'all', font: 'mine', widget: 'fallback' });
    reopened.setScope('mine');
    expect(config.read().scopes).toEqual({ bubble: 'mine', font: 'mine', widget: 'mine' });
  });

  it('会话装扮独立持久化，显式关闭保留，恢复跟随后移除例外', () => {
    const { dir } = configFixture();
    const store = new DressConversationStore(dir);
    const direct = { kind: 'c2c', conv: '12345', title: '朋友' } as const;
    const group = { kind: 'group', conv: '12345', title: '小组' } as const;
    store.set(direct, { slot: 'callbg', value: 'off' });
    store.set(direct, { slot: 'screen', value: { widgetId: '1', opacity: 0.6 } });
    store.set(group, { slot: 'background', value: { source: 'qq', opacity: 0.4 } });
    const reopened = new DressConversationStore(dir);
    expect(reopened.get(direct)).toMatchObject({
      callbg: 'off',
      screen: { widgetId: '1', opacity: 0.6 },
    });
    expect(reopened.get(group)).toMatchObject({ background: { source: 'qq', opacity: 0.4 } });
    expect(new DressConversationStore(join(dir, 'different-source')).get(direct)).toBeUndefined();
    reopened.setOpacity(group, 'background', 0);
    expect(store.get(group)?.background).toEqual({ source: 'qq', opacity: 0 });
    reopened.set(direct, { slot: 'screen', value: null });
    expect(() => reopened.setOpacity(direct, 'screen', 0)).toThrow('请先单独选择');
    expect(store.get(direct)).toEqual({ ...direct, callbg: 'off' });
    reopened.set(direct, { slot: 'callbg', value: null });
    expect(store.get(direct)).toBeUndefined();
  });

  it.each(['mine', 'fallback', 'all'] as const)(
    '渲染范围 %s 保存后重开仍保留，不改变激活项',
    (scope) => {
      const { dir, config } = configFixture();
      config.setActive('bubble', 11);
      config.setScope(scope);
      expect(new DressConfigService(dir).read()).toMatchObject({ scope, activeBubble: 11 });
    },
  );

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

  it('旧配置承接背景不透明度，浮屏挂件的值独立保存且支持全透明', () => {
    const { dir, config } = configFixture();
    writeFileSync(
      join(dir, 'dress.json'),
      JSON.stringify({ backgroundOpacity: 0.4, widgetId: '1' }),
    );
    expect(config.read()).toMatchObject({ backgroundOpacity: 0.4, widgetOpacity: 1 });
    config.setWidgetOpacity(0);
    config.setBackgroundOpacity(0.65);
    config.setWidget('');
    config.setWidget('1');
    const manifest = new DressService(new DressConfigService(dir), {} as DressSharedCache).read();
    expect(manifest).toMatchObject({ backgroundOpacity: 0.65, widgetOpacity: 0, widgetId: '1' });
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
