import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-autostart-window-'));
  roots.push(root);
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  return { root, open: () => new UserConfigService(platform) };
}

describe('自启显示窗口偏好', () => {
  it('新配置及缺少字段的旧配置默认关闭', () => {
    const f = fixture();
    expect(f.open().getSettings().showWindowOnAutostart).toBe(false);
    writeFileSync(join(f.root, 'config.json'), JSON.stringify({ settings: { preferCdn: true } }));
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
