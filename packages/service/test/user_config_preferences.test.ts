import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserConfigService, DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';
import { configFixture as fixture } from './support/user_config';

it('账号窗口在共享配置中接续不同字段的写入并收到外部更新', async () => {
  const { platform } = fixture({ settings: { home: { showGreeting: true, showTags: true } } });
  const a = new UserConfigService(platform, true);
  const b = new UserConfigService(platform, true);
  const stop = a.watchSharedSettings();
  try {
    a.getSettings();
    b.getSettings();
    a.setSettings({ home: { showGreeting: false } });
    b.setSettings({ home: { showTags: false } });
    await expect
      .poll(() => a.getSettings().home)
      .toMatchObject({
        showGreeting: false,
        showTags: false,
      });
  } finally {
    stop();
  }
});

it('桌面与 Remote 的图片加载来源分别持久化，旧设置不自动开启手机直取', () => {
  const f = fixture({ settings: { preferCdn: true } });
  expect(f.open().getSettings()).toMatchObject({ preferCdn: true, preferRemoteCdn: false });
  f.service.setSettings({ preferRemoteCdn: true });
  f.service.setSettings({ preferCdn: false });
  const settings = f.open().getSettings();
  expect(settings).toMatchObject({ preferCdn: false, preferRemoteCdn: true });
  const snapshot = snapshotWeqSettings(settings);
  expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
  expect(snapshot).toMatchObject({ preferCdn: false, preferRemoteCdn: true });
});

describe('QQ 秀分钟缓存配置', () => {
  it.each([
    [{}, 5],
    [{ qqShowCacheDays: 14 }, 5],
    [{ qqShowCacheDays: 2 }, 2880],
    [{ qqShowCacheDays: 14, qqShowCacheMinutes: 8 }, 8],
    [{ qqShowCacheMinutes: 0 }, 5],
    [{ qqShowCacheMinutes: 525601 }, 5],
  ])('迁移旧默认、保留自定义值并拒绝越界：%j', (settings, expected) => {
    const f = fixture({ settings });
    expect(f.open().getSettings().qqShowCacheMinutes).toBe(expected);
    f.service.setSettings({ qqShowCacheMinutes: 3 });
    expect(f.open().getSettings().qqShowCacheMinutes).toBe(3);
    f.service.setSettings({ qqShowCacheMinutes: 0 });
    expect(f.open().getSettings().qqShowCacheMinutes).toBe(3);
  });

  it('旧备份仍可验证与恢复，分钟设置可往返保存', () => {
    const f = fixture();
    expect(() => validateWeqAppSettings({ qqShowCacheDays: 14 })).not.toThrow();
    f.service.setSettings({ qqShowCacheMinutes: 20 });
    f.service.setSettings({ qqShowCacheDays: 14 });
    expect(f.open().getSettings().qqShowCacheMinutes).toBe(5);
    f.service.setSettings({ qqShowCacheMinutes: 1 });
    const snapshot = snapshotWeqSettings(f.open().getSettings());
    expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
    const restored = fixture();
    restored.service.setSettings(snapshot);
    expect(restored.open().getSettings().qqShowCacheMinutes).toBe(1);
  });
});

describe('聊天阅读偏好', () => {
  it.each([
    [{}, true],
    [{ restrictedModeIndicatorEnabled: false }, false],
    [{ restrictedModeIndicatorEnabled: true, qqProxyIndicatorEnabled: false }, false],
    [{ restrictedModeIndicatorEnabled: false, qqStatusIndicatorEnabled: true }, true],
  ])('窗口提示合并旧偏好，已保存的新值优先：%j', (settings, expected) => {
    const f = fixture({ settings });
    expect(f.open().getSettings().qqStatusIndicatorEnabled).toBe(expected);
    f.service.setSettings({ restrictedModeBannerEnabled: false });
    expect(f.open().getSettings().qqStatusIndicatorEnabled).toBe(expected);
    f.service.setSettings({ qqStatusIndicatorEnabled: !expected });
    const snapshot = snapshotWeqSettings(f.open().getSettings());
    expect(snapshot.qqStatusIndicatorEnabled).toBe(!expected);
    expect(snapshot).not.toHaveProperty('restrictedModeIndicatorEnabled');
    expect(snapshot).not.toHaveProperty('qqProxyIndicatorEnabled');
    expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
    expect(() => validateWeqAppSettings({ qqStatusIndicatorEnabled: 'false' })).toThrow();
  });
  it('受限横幅默认开启，旧配置兼容，持久化与备份恢复保留独立偏好', () => {
    const f = fixture();
    expect(f.open().getSettings().restrictedModeBannerEnabled).toBe(true);
    f.service.setSettings({ restrictedModeBannerEnabled: false });
    expect(f.open().getSettings().restrictedModeBannerEnabled).toBe(false);
    const snapshot = snapshotWeqSettings(f.open().getSettings());
    expect(snapshot.restrictedModeBannerEnabled).toBe(false);
    expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
    const { restrictedModeBannerEnabled: _banner, ...legacy } = snapshot;
    expect(() => validateWeqAppSettings(legacy)).not.toThrow();
    expect(() => validateWeqAppSettings({ restrictedModeBannerEnabled: 'false' })).toThrow();
    f.service.setSettings({ showMessageTime: true });
    expect(f.open().getSettings().restrictedModeBannerEnabled).toBe(false);
    const restored = fixture();
    restored.service.setSettings(snapshot);
    expect(restored.open().getSettings().restrictedModeBannerEnabled).toBe(false);
  });
});

describe('消息汇总红点', () => {
  it('联系人未读数默认关闭，独立持久保存', () => {
    const { platform, service } = fixture();
    expect(service.getSettings().showContactUnreadCount).toBe(
      DEFAULT_APP_SETTINGS.showContactUnreadCount,
    );
    expect(DEFAULT_APP_SETTINGS.showContactUnreadCount).toBe(false);
    service.setSettings({ showContactUnreadCount: true });
    expect(new UserConfigService(platform).getSettings()).toMatchObject({
      showContactUnreadCount: true,
      showMessageUnreadBadge: true,
    });
    service.setSettings({ showContactUnreadCount: false });
    expect(new UserConfigService(platform).getSettings().showContactUnreadCount).toBe(false);
  });
  it('汇总红点默认开启，关闭后重启保留，实时监听独立设置', () => {
    const { platform, service } = fixture({
      settings: { realtimeEnabled: true },
    });
    expect(service.getSettings().showMessageUnreadBadge).toBe(
      DEFAULT_APP_SETTINGS.showMessageUnreadBadge,
    );
    expect(DEFAULT_APP_SETTINGS.showMessageUnreadBadge).toBe(true);
    service.setSettings({ showMessageUnreadBadge: false });
    const reopened = new UserConfigService(platform);
    expect(reopened.getSettings()).toMatchObject({
      showMessageUnreadBadge: false,
      realtimeEnabled: true,
    });
    reopened.setSettings({ showMessageTime: true });
    expect(new UserConfigService(platform).getSettings().showMessageUnreadBadge).toBe(false);
    reopened.setSettings({ showMessageUnreadBadge: true });
    expect(new UserConfigService(platform).getSettings().showMessageUnreadBadge).toBe(true);
  });
});

describe('阅读与群助手', () => {
  it('阅读与群助手偏好兼容旧配置，独立保存并在重开后保留', () => {
    const { platform, service: config } = fixture({ settings: { showMessageTime: true } });
    const defaults = {
      readFromFirstUnread: false,
      autoFollowLatestMessages: true,
      jumpToLatestAfterSend: true,
      showScrollToBottomButton: true,
      showGroupAssistantMessageCount: false,
    };
    expect(DEFAULT_APP_SETTINGS).toMatchObject(defaults);
    expect(config.getSettings()).toMatchObject({ ...defaults, showMessageTime: true });
    config.setSettings({ readFromFirstUnread: true });
    config.setSettings({ autoFollowLatestMessages: false });
    config.setSettings({ jumpToLatestAfterSend: false });
    config.setSettings({ showScrollToBottomButton: false });
    config.setSettings({ showGroupAssistantMessageCount: true });
    config.setSettings({ showMessageTime: false });
    expect(new UserConfigService(platform).getSettings()).toMatchObject({
      readFromFirstUnread: true,
      autoFollowLatestMessages: false,
      jumpToLatestAfterSend: false,
      showScrollToBottomButton: false,
      showGroupAssistantMessageCount: true,
      showMessageTime: false,
    });
    config.setSettings(defaults);
    expect(new UserConfigService(platform).getSettings()).toMatchObject(defaults);
  });
});

describe('输入框个性字体', () => {
  it('删除群聊选款后回到默认字体，重开时保留偏好及其他字体', () => {
    const f = fixture();
    f.service.setSettings({
      composerFont: { choice: 8915 },
      defaultMessageFont: 'plain',
      sharedPreferences: {
        dress: {
          localAppearanceVersion: 1,
          activeFont: 8915,
          installedFonts: [8915, 8920],
          fontMeta: { 8915: { name: '选用字体' }, 8920: { name: '另一款字体' } },
        },
      },
    });
    expect(f.service.removeComposerFont(8915)).toEqual({ choice: 'default' });
    const reopened = f.open();
    expect(reopened.getSetting('composerFont')).toEqual({ choice: 'default' });
    expect(reopened.getSetting('defaultMessageFont')).toBe('plain');
    expect(reopened.getSharedPreference('dress')).toMatchObject({
      activeFont: 0,
      installedFonts: [8920],
    });
    expect(reopened.getSharedPreference('dress').fontMeta).toEqual({
      8920: { name: '另一款字体' },
    });
  });

  it('迁移旧发送开关，重开和还原备份都保留默认偏好和全局群聊选款', () => {
    const f = fixture({ settings: { sendWithQqFont: false, sendWithDressFont: true } });
    expect(f.open().getSetting('composerFont')).toEqual({ choice: 'legacy-dress' });
    const old = { sendWithQqFont: false };
    expect(() => validateWeqAppSettings(old)).not.toThrow();
    expect(f.service.setSettings(old)).toMatchObject({
      composerFont: { choice: 'default' },
      defaultMessageFont: 'plain',
    });
    f.service.setSettings({ composerFont: { choice: 8915 } });
    const settings = f.open().getSettings();
    expect(settings).toMatchObject({
      composerFont: { choice: 8915 },
      defaultMessageFont: 'plain',
    });
    const backup = snapshotWeqSettings(settings);
    expect(() => validateWeqAppSettings(backup)).not.toThrow();
    expect(() => validateWeqAppSettings({ composerFont: { choice: 65536 } })).toThrow();
    expect(() => validateWeqAppSettings({ defaultMessageFont: 'unknown' })).toThrow();
    expect(fixture().service.setSettings(backup)).toMatchObject({
      composerFont: settings.composerFont,
      defaultMessageFont: settings.defaultMessageFont,
    });
  });

  it('默认使用账号字体，旧关闭偏好迁为普通字体，群聊恢复默认时保留该偏好', () => {
    expect(fixture().service.getSetting('defaultMessageFont')).toBe('account');
    const f = fixture({ settings: { composerFont: { choice: 8915, send: false, preview: true } } });
    expect(f.service.getSettings()).toMatchObject({
      composerFont: { choice: 8915 },
      defaultMessageFont: 'plain',
    });
    f.service.setSettings({ composerFont: { choice: 'default' } });
    expect(f.open().getSettings()).toMatchObject({
      composerFont: { choice: 'default' },
      defaultMessageFont: 'plain',
    });
  });
});

describe('开机启动', () => {
  describe('自启显示窗口偏好', () => {
    it('新配置及缺少字段的旧配置默认关闭', () => {
      const f = fixture();
      expect(f.open().getSettings().showWindowOnAutostart).toBe(false);
      f.write({ settings: { preferCdn: true } });
      const settings = f.open().getSettings();
      expect(settings.showWindowOnAutostart).toBe(false);
      expect(settings.preferCdn).toBe(true);
    });
    it('修改可持久化，写入其他设置不丢失，关闭后重开仍关闭', () => {
      const f = fixture();
      f.open().setSettings({ showWindowOnAutostart: true });
      expect(f.open().getSettings().showWindowOnAutostart).toBe(true);
      f.open().setSettings({ windowCloseBehavior: 'tray' });
      expect(f.open().getSettings().showWindowOnAutostart).toBe(true);
      f.open().setSettings({ showWindowOnAutostart: false });
      expect(f.open().getSettings().showWindowOnAutostart).toBe(false);
      expect(f.open().getSettings().windowCloseBehavior).toBe('tray');
    });
    it('通用设置备份包含该偏好，旧备份缺字段仍有效，拒绝非布尔值', () => {
      const f = fixture();
      f.open().setSettings({ showWindowOnAutostart: true });
      const snapshot = snapshotWeqSettings(f.open().getSettings());
      expect(snapshot.showWindowOnAutostart).toBe(true);
      expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
      const { showWindowOnAutostart: _show, ...legacy } = snapshot;
      expect(() => validateWeqAppSettings(legacy)).not.toThrow();
      for (const value of ['true', 1, null])
        expect(() => validateWeqAppSettings({ showWindowOnAutostart: value })).toThrow('字段无效');
      const restored = fixture();
      restored.open().setSettings(snapshot);
      expect(restored.open().getSettings().showWindowOnAutostart).toBe(true);
    });
  });
});

describe('关闭窗口与退出提醒', () => {
  it('关闭按钮默认最小化到托盘；旧配置里写过的值保持不变', () => {
    expect(DEFAULT_APP_SETTINGS.windowCloseBehavior).toBe('tray');
    expect(fixture().service.getSettings().windowCloseBehavior).toBe('tray');
    // 从没写过该字段的旧配置跟着新默认走，这正是想要的效果。
    const legacy = fixture({ settings: { preferCdn: true } }).service.getSettings();
    expect(legacy.windowCloseBehavior).toBe('tray');
    // 明确选过「每次询问」的用户不该被新默认覆盖。
    const explicit = fixture({ settings: { windowCloseBehavior: 'ask' } }).service.getSettings();
    expect(explicit.windowCloseBehavior).toBe('ask');
    // 非法值回落到默认。
    expect(
      fixture({ settings: { windowCloseBehavior: 'hide' as never } }).service.getSettings()
        .windowCloseBehavior,
    ).toBe('tray');
  });

  it.each([undefined, false, true])('退出提醒旧字段只接受输入，不再输出或保存：%s', (value) => {
    const f = fixture({ settings: { quitConfirmSuppressed: value, preferCdn: true } });
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('quitConfirmSuppressed');
    expect(f.service.getSettings()).not.toHaveProperty('quitConfirmSuppressed');
    const legacy = { quitConfirmSuppressed: value, showMessageTime: true };
    if (value !== undefined) expect(() => validateWeqAppSettings(legacy)).not.toThrow();
    f.service.setSettings(legacy);
    const reloaded = new UserConfigService(f.platform).getSettings();
    expect(reloaded).not.toHaveProperty('quitConfirmSuppressed');
    expect(reloaded.preferCdn).toBe(true);
    expect(reloaded.showMessageTime).toBe(true);
    expect(
      JSON.parse(readFileSync(join(f.root, 'config.json'), 'utf8')).settings,
    ).not.toHaveProperty('quitConfirmSuppressed');
    const snapshot = snapshotWeqSettings(reloaded);
    expect(snapshot).not.toHaveProperty('quitConfirmSuppressed');
    expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
    for (const invalid of ['true', 1, null])
      expect(() => validateWeqAppSettings({ quitConfirmSuppressed: invalid })).toThrow('字段无效');
    expect(() => validateWeqAppSettings({ unrecognizedRetiredFlag: true })).toThrow('字段无效');
  });
});

describe('导出保存策略', () => {
  it('旧目录字段不自动改成无人值守保存，非法模式不启用自动落盘', () => {
    const old = fixture({
      settings: { defaultExportDir: '/old', preferCdn: true },
    }).service.getSettings();
    expect(old.exportSaveMode).toBe(DEFAULT_APP_SETTINGS.exportSaveMode);
    expect(old.defaultExportDir).toBe('/old');
    expect(old.preferCdn).toBe(true);
    expect(
      fixture({ settings: { exportSaveMode: 'invalid' } }).service.getSettings().exportSaveMode,
    ).toBe(DEFAULT_APP_SETTINGS.exportSaveMode);
  });

  it('首次使用和旧稍后保存偏好均回到开始前询问，保留已有目录', () => {
    expect(DEFAULT_APP_SETTINGS.exportSaveMode).toBe('before');
    expect(fixture().service.getSettings().exportSaveMode).toBe(
      DEFAULT_APP_SETTINGS.exportSaveMode,
    );
    expect(
      fixture({
        settings: { exportSaveMode: 'after', defaultExportDir: '/legacy' },
      }).service.getSettings(),
    ).toMatchObject({ exportSaveMode: 'before', defaultExportDir: '/legacy' });
  });

  it('两种默认策略均持久化，修改无关设置不丢失保存策略和目录', () => {
    const f = fixture();
    for (const mode of ['preset', 'before'] as const) {
      f.service.setSettings({ exportSaveMode: mode, defaultExportDir: '/fixture' });
      f.service.setSettings({ showMessageTime: true });
      const reloaded = new UserConfigService(f.platform).getSettings();
      expect(reloaded.exportSaveMode).toBe(mode);
      expect(reloaded.defaultExportDir).toBe('/fixture');
      expect(reloaded.showMessageTime).toBe(true);
    }
  });
});
