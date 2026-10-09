/**
 * v2.0.0 首次运行引导改版的离线单测（tmp 目录，不碰真实配置）。
 *
 * 这一版做两件事，都直接改用户配置，代价实在，不能只靠"跑一遍看看"：
 *   1. 把「扫描 QQ 内存」默认关掉，让欢迎框重新征得同意；
 *   2. 把所有人的欢迎框重新弹一次（旧配置被视为"未确认"当前策略版本）。
 *
 * 这里钉住迁移的边界（旧配置认、当前版本不动、没 settings 不写）、版本门，以及
 * `acknowledgeWelcome` 把用户选择落到 autoAttachQq 且重启后不再被重置。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import {
  planWelcomePolicyMigration,
  UserConfigService,
  WELCOME_POLICY_VERSION,
} from '../src/bootstrap/user_config';

const tmpRoots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-cfg-welcome-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

/** `getSettings` 只读 `kind`，落盘目录用 `appDataRoot()`。 */
function fakePlatform(root: string): Platform {
  return { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
}

/** 直接写磁盘上的 config.json。 */
function writeRaw(root: string, config: unknown): void {
  writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

describe('planWelcomePolicyMigration', () => {
  it('旧配置里开过扫描内存 → 重置为关闭，其余偏好原样保留', () => {
    const patch = planWelcomePolicyMigration({
      welcomeAcknowledged: true,
      settings: { autoAttachQq: true, preferCdn: true },
    });
    expect(patch).not.toBeNull();
    expect(patch?.settings?.autoAttachQq).toBe(false);
    expect(patch?.settings?.preferCdn).toBe(true); // 相邻偏好没被弄丢
    expect(patch?.welcomePolicyVersion).toBeUndefined(); // 版本号留给确认时写
  });

  it('旧配置有 settings 但没动过这个开关 → 也补成关闭', () => {
    const patch = planWelcomePolicyMigration({ settings: { preferCdn: true } });
    expect(patch?.settings?.autoAttachQq).toBe(false);
  });

  it('已经是当前策略版本 → 不动（不重弹、不重置）', () => {
    expect(
      planWelcomePolicyMigration({
        welcomeAcknowledged: true,
        welcomePolicyVersion: WELCOME_POLICY_VERSION,
        settings: { autoAttachQq: true },
      }),
    ).toBeNull();
  });

  it('没有 settings（全新安装）→ 默认值本身就是关的，无需写', () => {
    expect(planWelcomePolicyMigration({})).toBeNull();
  });

  it('已经关了的旧配置 → 不重复写', () => {
    expect(planWelcomePolicyMigration({ settings: { autoAttachQq: false } })).toBeNull();
  });
});

describe('UserConfigService 欢迎框版本门 + 扫描内存同意', () => {
  it('旧配置（确认过 v1、开着扫描内存）→ 迁移重置为关、视为未确认', () => {
    const dir = tmpDir();
    writeRaw(dir, {
      welcomeAcknowledged: true,
      settings: { autoAttachQq: true },
    });

    const svc = new UserConfigService(fakePlatform(dir));
    expect(svc.getSettings().autoAttachQq).toBe(false);
    expect(svc.isWelcomeAcknowledged()).toBe(false); // 会重新弹一次
  });

  it('全新安装 → 默认关闭且未确认', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    expect(svc.getSettings().autoAttachQq).toBe(false);
    expect(svc.isWelcomeAcknowledged()).toBe(false);
  });

  it('确认时选择「允许」→ autoAttachQq 落 true，重启后不再被重置', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    svc.acknowledgeWelcome({ allowMemoryScan: true });
    expect(svc.getSettings().autoAttachQq).toBe(true);
    expect(svc.isWelcomeAcknowledged()).toBe(true);

    // 重启：迁移看到当前版本号就撒手，不把用户的选择盖掉。
    const restarted = new UserConfigService(fakePlatform(dir));
    expect(restarted.getSettings().autoAttachQq).toBe(true);
    expect(restarted.isWelcomeAcknowledged()).toBe(true);
  });

  it('确认时选择「保持离线」→ autoAttachQq 落 false，重启后仍是 false', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    svc.acknowledgeWelcome({ allowMemoryScan: false });

    const restarted = new UserConfigService(fakePlatform(dir));
    expect(restarted.getSettings().autoAttachQq).toBe(false);
    expect(restarted.isWelcomeAcknowledged()).toBe(true);
  });
});
