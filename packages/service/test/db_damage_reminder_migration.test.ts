/**
 * 「数据库损坏弹窗不再提醒」的一次性清理（配置策略迁移）单测。
 *
 * 这段逻辑的代价很实在 —— 它会**改写用户的 config.json**（用户的选择被我们翻掉一次），
 * 所以不能只靠"跑一遍看看"：三个边界都要钉住 ——
 *
 *   1. 旧版本里勾过「不再提醒」的，升级后要被清掉（否则新版的「尝试修复」入口没有机会
 *      被看到，这正是这次清理的全部意义）；
 *   2. 清掉之后在新版本里再勾一次，**不能被再次清掉**（否则这个开关永远关不严）；
 *   3. 其它偏好一个都不能被顺手弄丢（`write` 是浅合并，`settings` 必须整份带过去）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import {
  DB_DAMAGE_REMINDER_POLICY_VERSION,
  UserConfigService,
  planDbDamageReminderPolicyReset,
  type UserConfig,
} from '../src/bootstrap/user_config';

const tmpRoots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-cfg-migrate-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

/** 迁移只碰 `appDataRoot()`，其余字段用不到（`getSettings` 只读 `kind`）。 */
function fakePlatform(root: string): Platform {
  return { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
}

function writeConfig(root: string, config: UserConfig): void {
  writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function readConfig(root: string): UserConfig {
  return JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8')) as UserConfig;
}

describe('planDbDamageReminderPolicyReset', () => {
  it('旧配置（没有版本号）勾过不再提醒 → 清掉 + 记版本', () => {
    const patch = planDbDamageReminderPolicyReset({
      settings: { suppressDbDamageReminder: true, preferCdn: true },
    });
    expect(patch).not.toBeNull();
    expect(patch?.dbDamageReminderPolicyVersion).toBe(DB_DAMAGE_REMINDER_POLICY_VERSION);
    expect(patch?.settings?.suppressDbDamageReminder).toBe(false);
    // 其它偏好原样带过去（浅合并下 settings 必须整份给）。
    expect(patch?.settings?.preferCdn).toBe(true);
  });

  it('旧配置没勾过 → 只记版本，不写 settings', () => {
    const patch = planDbDamageReminderPolicyReset({ settings: { preferCdn: true } });
    expect(patch).toEqual({ dbDamageReminderPolicyVersion: DB_DAMAGE_REMINDER_POLICY_VERSION });
  });

  it('已经迁移过 → null（不再动用户的选择）', () => {
    expect(
      planDbDamageReminderPolicyReset({
        dbDamageReminderPolicyVersion: DB_DAMAGE_REMINDER_POLICY_VERSION,
        settings: { suppressDbDamageReminder: true },
      }),
    ).toBeNull();
  });
});

describe('UserConfigService 启动时的迁移', () => {
  it('勾过「不再提醒」的旧配置：启动后开关被清掉，之后再打开也不会再被清', () => {
    const dir = tmpDir();
    writeConfig(dir, { settings: { suppressDbDamageReminder: true, preferCdn: true } });

    let service = new UserConfigService(fakePlatform(dir));
    expect(service.getSettings().suppressDbDamageReminder).toBe(false);
    expect(service.getSettings().preferCdn).toBe(true); // 相邻偏好没被弄丢
    expect(readConfig(dir).dbDamageReminderPolicyVersion).toBe(DB_DAMAGE_REMINDER_POLICY_VERSION);

    // 用户在新版里又主动关掉提醒（走设置页 / 弹窗）→ 下一次启动必须尊重它。
    service = new UserConfigService(fakePlatform(dir));
    service.setSettings({ suppressDbDamageReminder: true });
    const restarted = new UserConfigService(fakePlatform(dir));
    expect(restarted.getSettings().suppressDbDamageReminder).toBe(true);
  });

  it('全新安装（没有 config.json）：清一次只是记版本，默认值仍是"提醒"', () => {
    const dir = tmpDir();
    const service = new UserConfigService(fakePlatform(dir));
    expect(service.getSettings().suppressDbDamageReminder).toBe(false);
    expect(readConfig(dir).dbDamageReminderPolicyVersion).toBe(DB_DAMAGE_REMINDER_POLICY_VERSION);
  });

  it('config.json 损坏也不会让启动出事（迁移失败只是"下次再试"）', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'config.json'), '{not json', 'utf-8');
    expect(() => new UserConfigService(fakePlatform(dir))).not.toThrow();
    expect(readConfig(dir).dbDamageReminderPolicyVersion).toBe(DB_DAMAGE_REMINDER_POLICY_VERSION);
  });
});
