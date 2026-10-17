import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
function config(raw?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'weq-export-save-settings-'));
  roots.push(root);
  if (raw) writeFileSync(join(root, 'config.json'), JSON.stringify(raw));
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  return { platform, service: new UserConfigService(platform) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('旧目录字段不自动改成无人值守保存，非法模式不启用自动落盘', () => {
  const old = config({
    settings: { defaultExportDir: '/old', preferCdn: true },
  }).service.getSettings();
  expect(old.exportSaveMode).toBe('after');
  expect(old.defaultExportDir).toBe('/old');
  expect(old.preferCdn).toBe(true);
  expect(
    config({ settings: { exportSaveMode: 'invalid' } }).service.getSettings().exportSaveMode,
  ).toBe('after');
});

it('三种默认策略均持久化，修改无关设置不丢失保存策略和目录', () => {
  const f = config();
  for (const mode of ['preset', 'before', 'after'] as const) {
    f.service.setSettings({ exportSaveMode: mode, defaultExportDir: '/fixture' });
    f.service.setSettings({ showMessageTime: true });
    const reloaded = new UserConfigService(f.platform).getSettings();
    expect(reloaded.exportSaveMode).toBe(mode);
    expect(reloaded.defaultExportDir).toBe('/fixture');
    expect(reloaded.showMessageTime).toBe(true);
  }
});
