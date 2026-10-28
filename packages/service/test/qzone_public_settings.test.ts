import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';
import {
  DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
  MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
  normalizeQzonePublicRefreshCooldown,
} from '../src/common/qzone_public_settings';

it('冷却期接受 0 与整数分钟，非法值保留原设置或默认值', () => {
  for (const value of [
    undefined,
    null,
    '',
    '60',
    -1,
    0.5,
    NaN,
    Infinity,
    MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES + 1,
  ]) {
    expect(normalizeQzonePublicRefreshCooldown(value)).toBe(
      DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
    );
    expect(normalizeQzonePublicRefreshCooldown(value, 30)).toBe(30);
  }
  for (const value of [0, 1, 120, MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES]) {
    expect(normalizeQzonePublicRefreshCooldown(value)).toBe(value);
  }
});

it('默认冷却期与修改值可持久化，无关设置或非法写入不覆盖已保存值', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-public-cooldown-'));
  try {
    const platform = { appDataRoot: () => root } as Platform;
    const config = new UserConfigService(platform);
    expect(config.getSettings().qzonePublicRefreshCooldownMinutes).toBe(
      DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
    );
    config.setSettings({ qzonePublicRefreshCooldownMinutes: 120 });
    config.setSettings({ qzoneForwardQuotePrevious: true });
    expect(new UserConfigService(platform).getSettings().qzonePublicRefreshCooldownMinutes).toBe(
      120,
    );
    expect(
      config.setSettings({ qzonePublicRefreshCooldownMinutes: -1 })
        .qzonePublicRefreshCooldownMinutes,
    ).toBe(120);
    config.setSettings({ qzonePublicRefreshCooldownMinutes: 0 });
    expect(new UserConfigService(platform).getSettings().qzonePublicRefreshCooldownMinutes).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
