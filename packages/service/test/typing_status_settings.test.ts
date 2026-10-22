import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';

it('输入状态兼容旧配置，特例独立于默认值并按账号、数据源与会话持久保存', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-typing-status-'));
  try {
    const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ settings: { preferCdn: true } }));
    const config = new UserConfigService(platform);
    expect(config.getSettings().typingStatus).toEqual({ defaultEnabled: false, overrides: [] });
    const target = {
      accountUin: '10001',
      accountConfigId: 'source-a',
      uid: 'u_friend',
      name: '好友',
    };
    config.setTypingStatusOverride(target, true);
    config.setTypingStatusOverride({ ...target, uid: 'u_other' }, false);
    config.setTypingStatusOverride({ ...target, accountUin: '10002' }, false);
    config.setTypingStatusOverride({ ...target, accountConfigId: 'source-b' }, false);
    config.setSettings({ typingStatus: { defaultEnabled: true } });
    const reopened = new UserConfigService(platform);
    expect(reopened.getSettings().typingStatus).toEqual({
      defaultEnabled: true,
      overrides: [
        { ...target, enabled: true },
        { ...target, uid: 'u_other', enabled: false },
        { ...target, accountUin: '10002', enabled: false },
        { ...target, accountConfigId: 'source-b', enabled: false },
      ],
    });
    reopened.setTypingStatusOverride(target, false);
    expect(reopened.getSettings().typingStatus.overrides).toHaveLength(4);
    reopened.setTypingStatusOverride(target, null);
    reopened.setSettings({ showMessageTime: true });
    const final = new UserConfigService(platform).getSettings();
    expect(final.typingStatus.overrides).toHaveLength(3);
    expect(final.preferCdn).toBe(true);
    expect(final.typingStatus.defaultEnabled).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('损坏或未知输入状态配置不会开启广播', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-typing-invalid-'));
  try {
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        settings: {
          typingStatus: { defaultEnabled: 'true', overrides: [null, {}, { enabled: 'false' }] },
        },
      }),
    );
    const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
    expect(new UserConfigService(platform).getSettings().typingStatus).toEqual({
      defaultEnabled: false,
      overrides: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
