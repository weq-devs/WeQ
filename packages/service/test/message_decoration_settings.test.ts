import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';

it.each([true, false])('旧消息装扮开关 %s 迁移为独立气泡、字体，头像挂件保持原值', (enabled) => {
  const root = mkdtempSync(join(tmpdir(), 'weq-message-decoration-'));
  try {
    const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ settings: { showMsgDecoration: enabled, showAvatarPendant: false } }),
    );
    const config = new UserConfigService(platform);
    expect(config.getSettings()).toMatchObject({
      showMessageBubble: enabled,
      showMessageFont: enabled,
      showAvatarPendant: false,
    });
    config.setSettings({ showMessageBubble: !enabled });
    expect(new UserConfigService(platform).getSettings()).toMatchObject({
      showMessageBubble: !enabled,
      showMessageFont: enabled,
      showAvatarPendant: false,
    });
    config.setSettings({ showMessageFont: !enabled, showAvatarPendant: true });
    expect(new UserConfigService(platform).getSettings()).toMatchObject({
      showMessageBubble: !enabled,
      showMessageFont: !enabled,
      showAvatarPendant: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
