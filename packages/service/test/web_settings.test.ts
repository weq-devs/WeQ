import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';
import { getHost, setHost, withHost, type HostBridge } from '../src/common/host';

it('Web 自动启动默认关闭，持久化后不被无关设置覆盖，非法旧值不启用服务', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-web-settings-'));
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  try {
    const config = new UserConfigService(platform);
    expect(config.getSettings().webServiceAutoStart).toBe(false);
    config.setSettings({ webServiceAutoStart: true });
    config.setSettings({ showMessageTime: true });
    expect(new UserConfigService(platform).getSettings().webServiceAutoStart).toBe(true);
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ settings: { webServiceAutoStart: 'true' } }),
    );
    expect(new UserConfigService(platform).getSettings().webServiceAutoStart).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('并行 Web 与桌面调用的宿主能力不互相覆盖', async () => {
  const desktop = { canReveal: true } as HostBridge;
  const web = { canReveal: false } as HostBridge;
  setHost(desktop);
  await Promise.all([
    withHost(web, async () => {
      await Promise.resolve();
      expect(getHost()).toBe(web);
    }),
    (async () => {
      await Promise.resolve();
      expect(getHost()).toBe(desktop);
    })(),
  ]);
  expect(getHost()).toBe(desktop);
});
