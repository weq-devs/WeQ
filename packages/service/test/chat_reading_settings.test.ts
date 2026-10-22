import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { DEFAULT_APP_SETTINGS, UserConfigService } from '../src/bootstrap/user_config';

it('阅读与群助手偏好兼容旧配置，独立保存并在重开后保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-chat-reading-'));
  try {
    const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ settings: { showMessageTime: true } }),
    );
    const config = new UserConfigService(platform);
    const defaults = {
      readFromFirstUnread: false,
      jumpToLatestAfterSend: true,
      showGroupAssistantMessageCount: false,
    };
    expect(DEFAULT_APP_SETTINGS).toMatchObject(defaults);
    expect(config.getSettings()).toMatchObject({ ...defaults, showMessageTime: true });
    config.setSettings({ readFromFirstUnread: true });
    config.setSettings({ jumpToLatestAfterSend: false });
    config.setSettings({ showGroupAssistantMessageCount: true });
    config.setSettings({ showMessageTime: false });
    expect(new UserConfigService(platform).getSettings()).toMatchObject({
      readFromFirstUnread: true,
      jumpToLatestAfterSend: false,
      showGroupAssistantMessageCount: true,
      showMessageTime: false,
    });
    config.setSettings(defaults);
    expect(new UserConfigService(platform).getSettings()).toMatchObject(defaults);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
