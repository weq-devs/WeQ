import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { DEFAULT_APP_SETTINGS, UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('汇总红点默认开启，旧配置兼容，关闭后重启保留且不改变未读同步或实时监听', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-message-badge-'));
  roots.push(root);
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ settings: { realtimeEnabled: true, reportReadEnabled: false } }),
  );
  const service = new UserConfigService(platform);
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
