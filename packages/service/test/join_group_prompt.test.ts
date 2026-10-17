/**
 * 「加入交流群」引导的**只弹一次**语义单测。
 *
 * 引导本身的判据是 `joinGroupPromptVersion >= JOIN_GROUP_PROMPT_VERSION`。这里钉住
 * 四个边界：全新配置未确认、确认后不再弹、抬版本号会重新弹、以及确认是**幂等**的
 * （点两次不炸、不会把版本号写坏）。
 *
 * 与欢迎框的区别也顺手测了：加群引导**不参与 settings 迁移**，只写顶层版本号。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { JOIN_GROUP_PROMPT_VERSION, UserConfigService } from '../src/bootstrap/user_config';

const tmpRoots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-cfg-join-group-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

function fakePlatform(root: string): Platform {
  return { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
}

describe('加入交流群引导：只弹一次', () => {
  it('全新配置视为未确认', () => {
    const svc = new UserConfigService(fakePlatform(tmpDir()));
    expect(svc.isJoinGroupPromptAcknowledged()).toBe(false);
  });

  it('确认后落盘版本号，重启（重新读盘）仍为已确认', () => {
    const dir = tmpDir();
    new UserConfigService(fakePlatform(dir)).acknowledgeJoinGroupPrompt();

    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as {
      joinGroupPromptVersion?: number;
    };
    expect(raw.joinGroupPromptVersion).toBe(JOIN_GROUP_PROMPT_VERSION);

    // 新实例 = 重启后重新读盘，不该再弹。
    expect(new UserConfigService(fakePlatform(dir)).isJoinGroupPromptAcknowledged()).toBe(true);
  });

  it('确认是幂等的（连点两次不炸、版本号不变）', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    svc.acknowledgeJoinGroupPrompt();
    svc.acknowledgeJoinGroupPrompt();
    expect(svc.isJoinGroupPromptAcknowledged()).toBe(true);
  });

  it('低版本配置视为未确认（抬版本号后会重新弹一次）', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    svc.acknowledgeJoinGroupPrompt();
    // 模拟「上一次确认的是更早的版本」。
    svc.write({ joinGroupPromptVersion: JOIN_GROUP_PROMPT_VERSION - 1 });
    expect(svc.isJoinGroupPromptAcknowledged()).toBe(false);
  });

  it('只写顶层版本号，不碰 settings（与欢迎框的策略迁移区分开）', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    const before = svc.getSettings();
    svc.acknowledgeJoinGroupPrompt();
    expect(svc.getSettings()).toEqual(before);
  });
});
