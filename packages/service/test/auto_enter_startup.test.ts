import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
function setup(cleanExit?: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'weq-auto-enter-'));
  roots.push(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ cleanExit }));
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

it.each([undefined, false, true])('退出标记为 %s 时，重新启动始终遵循启动页面偏好', (cleanExit) => {
  const restart = setup(cleanExit);
  const config = restart();
  for (const page of ['home', 'messages', 'last'] as const) {
    config.setSettings({ startupPage: page });
    const next = restart();
    expect(next.getSettings().startupPage).toBe(page);
    expect(next.getStartupPage()).toBe(page);
    expect(next.getStartupPage()).toBe(page);
    // 不写退出标记，模拟异常终止后的连续启动。
    expect(restart().getStartupPage()).toBe(page);
  }
});

it('未设置启动页面时首次启动及再次启动均默认进入主页', () => {
  const restart = setup();
  const config = restart();
  expect(config.getSettings().startupPage).toBe('home');
  expect(config.getStartupPage()).toBe('home');
  expect(restart().getStartupPage()).toBe('home');
});

it('同次启动保持最初选择，修改偏好在下次启动生效', () => {
  const restart = setup();
  const config = restart();
  config.setSettings({ startupPage: 'home' });
  expect(config.getStartupPage()).toBe('home');
  config.setSettings({ startupPage: 'messages' });
  expect(config.getStartupPage()).toBe('home');
  expect(restart().getStartupPage()).toBe('messages');
});

it('启动偏好可备份，拒绝无效值', () => {
  const restart = setup();
  const config = restart();
  config.setSettings({ startupPage: 'messages' });
  const snapshot = snapshotWeqSettings(config.getSettings());
  expect(snapshot.startupPage).toBe('messages');
  expect(() => validateWeqAppSettings(snapshot)).not.toThrow();
  for (const startupPage of ['other', true, null]) {
    expect(() => validateWeqAppSettings({ startupPage })).toThrow('字段无效');
  }
});
