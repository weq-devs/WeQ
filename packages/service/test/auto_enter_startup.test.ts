import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import { afterEach, expect, it } from 'vitest';
import { UserConfigService } from '../src/bootstrap/user_config';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weq-auto-enter-'));
  roots.push(root);
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  return () => new UserConfigService(platform);
}
it('登录页退出只跳过下次自动进入，不修改目标，同次启动重复读取也跳过', () => {
  const restart = setup();
  const config = restart();
  const target = { configId: 'synthetic', uin: '10001' };
  config.setAutoEnter(target);
  config.setSkipAutoEnterOnce(true);
  const next = restart();
  expect(next.getStartupAutoEnter()).toBeNull();
  expect(next.getAutoEnter()).toEqual(target);
  expect(next.getStartupAutoEnter()).toBeNull();
  expect(restart().getStartupAutoEnter()).toEqual(target);
});
it('账号内退出及旧配置仍按自动进入偏好启动', () => {
  const restart = setup();
  const config = restart();
  const target = { uin: '10001' };
  config.setAutoEnter(target);
  expect(restart().getStartupAutoEnter()).toEqual(target);
  config.setSkipAutoEnterOnce(true);
  config.setSkipAutoEnterOnce(false);
  expect(restart().getStartupAutoEnter()).toEqual(target);
});

it.each(['home', 'messages', 'last'] as const)(
  '正常退出后使用 %s，异常启动固定恢复现场',
  (page) => {
    const restart = setup();
    const config = restart();
    config.setSettings({ startupPage: page });
    expect(restart().getSettings().startupPage).toBe(page);
    expect(restart().getStartupPage()).toBe('last');
    config.markCleanExit();
    const next = restart();
    expect(next.getStartupPage()).toBe(page);
    expect(next.getStartupPage()).toBe(page);
    // 本轮未正常退出，即使上次正常退出过，也不能再次使用启动偏好。
    expect(restart().getStartupPage()).toBe('last');
  },
);

it('旧配置默认保留现场；启动偏好可备份，拒绝无效值', () => {
  const restart = setup();
  const config = restart();
  expect(config.getSettings().startupPage).toBe('last');
  config.setSettings({ startupPage: 'messages' });
  const snapshot = snapshotWeqSettings(config.getSettings());
  expect(snapshot.startupPage).toBe('messages');
  expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
  for (const startupPage of ['other', true, null]) {
    expect(() => validateWeqAppSettings({ startupPage })).toThrow('字段无效');
  }
});
