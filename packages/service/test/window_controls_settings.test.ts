import { expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import { validateWeqAppSettings, snapshotWeqSettings } from '../src/bootstrap/backup_settings';
import { configFixture } from './support/user_config';

it('新配置与旧配置默认关闭，显式开关可以持久化且不被其它设置覆盖', () => {
  expect(DEFAULT_APP_SETTINGS.windowsStyleControls).toBe(false);
  const f = configFixture({ settings: { windowCloseBehavior: 'tray' } });
  expect(f.open().getSettings().windowsStyleControls).toBe(false);
  f.service.setSettings({ windowsStyleControls: true });
  f.service.setSettings({ windowCloseBehavior: 'ask' });
  expect(f.open().getSettings().windowsStyleControls).toBe(true);
  f.service.setSettings({ windowsStyleControls: false });
  expect(f.open().getSettings().windowsStyleControls).toBe(false);
});

it('备份与恢复保留偏好，拒绝非布尔值，旧备份仍可读取', () => {
  expect(() => validateWeqAppSettings({})).not.toThrow();
  expect(() => validateWeqAppSettings({ windowsStyleControls: 'true' })).toThrow();
  const f = configFixture();
  f.service.setSettings({ windowsStyleControls: true });
  const snapshot = snapshotWeqSettings(f.open().getSettings());
  expect(snapshot.windowsStyleControls).toBe(true);
  expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
  const restored = configFixture();
  restored.service.setSettings(snapshot);
  expect(restored.open().getSettings().windowsStyleControls).toBe(true);
});
