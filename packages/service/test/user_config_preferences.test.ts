import { describe, expect, it } from 'vitest';
import { UserConfigService, DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';
import { configFixture as fixture } from './support/user_config';

describe('聊天阅读偏好', () => {
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
  describe('已读上报偏好', () => {
    it.each([
      [false, false],
      [true, true],
      [true, false],
      [false, true],
    ])('旧组合 %s/%s 读取与备份往返不自动统一，显式总开关一次保存两字段', (automatic, manual) => {
      const f = fixture({
        settings: { reportReadEnabled: automatic, manualReadReportEnabled: manual },
      });
      const snapshot = snapshotWeqSettings(f.service.getSettings());
      expect(snapshot).toMatchObject({
        reportReadEnabled: automatic,
        manualReadReportEnabled: manual,
      });
      expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
      f.service.setSettings(snapshot);
      expect(f.open().getSettings()).toMatchObject({
        reportReadEnabled: automatic,
        manualReadReportEnabled: manual,
      });
      f.service.setSettings({ reportReadEnabled: false, manualReadReportEnabled: false });
      expect(f.open().getSettings()).toMatchObject({
        reportReadEnabled: false,
        manualReadReportEnabled: false,
      });
    });
    it('默认关闭，保存和重开后保留，与在线模式及其它设置独立', () => {
      const { platform, service } = fixture();
      expect(service.getSettings().reportReadEnabled).toBe(false);
      expect(service.getSettings().manualReadReportEnabled).toBe(false);
      service.setSettings({ reportReadEnabled: true });
      expect(new UserConfigService(platform).getSettings().reportReadEnabled).toBe(true);
      expect(new UserConfigService(platform).getSettings().manualReadReportEnabled).toBe(false);
      service.setSettings({ manualReadReportEnabled: true });
      expect(new UserConfigService(platform).getSettings().manualReadReportEnabled).toBe(true);
      service.setSettings({ autoAttachQq: false, realtimeEnabled: false });
      expect(service.getSettings().reportReadEnabled).toBe(true);
      service.setSettings({ reportReadEnabled: false });
      const saved = new UserConfigService(platform).getSettings();
      expect(saved.reportReadEnabled).toBe(false);
      expect(saved.manualReadReportEnabled).toBe(true);
      expect(saved.realtimeEnabled).toBe(false);
      expect(saved.autoAttachQq).toBe(false);
    });
  });
});

describe('消息汇总红点', () => {
  it('联系人未读数默认关闭，独立持久保存，不改变原有红点和已读上报设置', () => {
    const { platform, service } = fixture({ settings: { reportReadEnabled: false } });
    expect(service.getSettings().showContactUnreadCount).toBe(
      DEFAULT_APP_SETTINGS.showContactUnreadCount,
    );
    expect(DEFAULT_APP_SETTINGS.showContactUnreadCount).toBe(false);
    service.setSettings({ showContactUnreadCount: true });
    expect(new UserConfigService(platform).getSettings()).toMatchObject({
      showContactUnreadCount: true,
      showMessageUnreadBadge: true,
      reportReadEnabled: false,
    });
    service.setSettings({ showContactUnreadCount: false });
    expect(new UserConfigService(platform).getSettings().showContactUnreadCount).toBe(false);
  });
  it('汇总红点默认开启，旧配置兼容，关闭后重启保留且不改变未读同步或实时监听', () => {
    const { platform, service } = fixture({
      settings: { realtimeEnabled: true, reportReadEnabled: false },
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
      reportReadEnabled: false,
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
      jumpToLatestAfterSend: true,
      sendWithQqFont: true,
      showGroupAssistantMessageCount: false,
    };
    expect(DEFAULT_APP_SETTINGS).toMatchObject(defaults);
    expect(config.getSettings()).toMatchObject({ ...defaults, showMessageTime: true });
    config.setSettings({ readFromFirstUnread: true });
    config.setSettings({ jumpToLatestAfterSend: false });
    config.setSettings({ sendWithQqFont: false });
    config.setSettings({ showGroupAssistantMessageCount: true });
    config.setSettings({ showMessageTime: false });
    expect(new UserConfigService(platform).getSettings()).toMatchObject({
      readFromFirstUnread: true,
      jumpToLatestAfterSend: false,
      sendWithQqFont: false,
      showGroupAssistantMessageCount: true,
      showMessageTime: false,
    });
    config.setSettings(defaults);
    expect(new UserConfigService(platform).getSettings()).toMatchObject(defaults);
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
