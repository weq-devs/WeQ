import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';
import { DEFAULT_HOME_SETTINGS, normalizeHomeSettings } from '../src/common/home_settings';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';
import { DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';

it('旧配置默认同时展示标签、问候语和一言，独立保存后重开保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-home-'));
  try {
    const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ settings: { preferCdn: true } }));
    const config = new UserConfigService(platform);
    expect(config.getSettings().home).toEqual(DEFAULT_HOME_SETTINGS);
    config.setSettings({
      home: {
        ...DEFAULT_HOME_SETTINGS,
        showTags: false,
        blockedWords: [' ABC ', 'abc', '', '剧透'],
      },
    });
    config.setSettings({ preferCdn: false });
    expect(new UserConfigService(platform).getSettings().home).toEqual({
      ...DEFAULT_HOME_SETTINGS,
      showTags: false,
      blockedWords: ['ABC', '剧透'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('损坏或缺少的字段回落默认值，不把 false 吞掉', () => {
  expect(
    normalizeHomeSettings({ showGreeting: false, showTags: 'false', blockedWords: [42, '  '] }),
  ).toEqual({
    ...DEFAULT_HOME_SETTINGS,
    showGreeting: false,
  });
});

it('主页偏好随全局设置备份，屏蔽词数组可校验并拒绝损坏数据', () => {
  const backup = snapshotWeqSettings({
    ...DEFAULT_APP_SETTINGS,
    home: { ...DEFAULT_HOME_SETTINGS, blockedWords: ['剧透'] },
  });
  expect(backup.home.blockedWords).toEqual(['剧透']);
  expect(() => validateWeqAppSettings(backup)).not.toThrow();
  for (const home of [
    { blockedWords: [42] },
    { showTags: 'false' },
    { blockedWords: ['x'.repeat(201)] },
  ])
    expect(() => validateWeqAppSettings({ home })).toThrow('settings.home');
});
