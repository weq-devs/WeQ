/**
 * `suppressPtraceHint` → `suppressAttachHint` 改名的旧配置兼容单测。
 *
 * 这个开关只静音 Linux 那条「关掉 ptrace 保护」引导弹窗，语义边界见
 * `bootstrap/attach_flow.ts`。改名本身不影响顺序，但**旧配置里存的还是旧键**：
 * 要是读的时候不认，勾过「不再提醒」的用户升级后会重新被弹一次 —— 这正是兼容读
 * 存在的全部理由，所以四个边界都钉住（旧键认、缺键走默认、新键优先、写回落新键）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService } from '../src/bootstrap/user_config';

const tmpRoots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-cfg-attach-hint-'));
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

/** 直接写磁盘上的 config.json：旧键不在 `AppSettings` 类型里，只能绕过类型写。 */
function writeRaw(root: string, config: unknown): void {
  writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

describe('suppressAttachHint 的旧键（suppressPtraceHint）兼容', () => {
  it('旧配置里勾过「不再提醒」→ 读到 true，不被静默重置', () => {
    const dir = tmpDir();
    writeRaw(dir, { settings: { suppressPtraceHint: true, preferCdn: true } });

    const settings = new UserConfigService(fakePlatform(dir)).getSettings();
    expect(settings.suppressAttachHint).toBe(true);
    expect(settings.preferCdn).toBe(true); // 相邻偏好没被弄丢
  });

  it('旧配置没勾过 → 默认仍是「会提醒」', () => {
    const dir = tmpDir();
    writeRaw(dir, { settings: { preferCdn: true } });
    expect(new UserConfigService(fakePlatform(dir)).getSettings().suppressAttachHint).toBe(false);
  });

  it('新旧键同时存在 → 新键优先', () => {
    const dir = tmpDir();
    writeRaw(dir, { settings: { suppressAttachHint: false, suppressPtraceHint: true } });
    expect(new UserConfigService(fakePlatform(dir)).getSettings().suppressAttachHint).toBe(false);
  });

  it('新版里写一次 → 落盘新键，重启后仍然生效', () => {
    const dir = tmpDir();
    new UserConfigService(fakePlatform(dir)).setSettings({ suppressAttachHint: true });
    expect(new UserConfigService(fakePlatform(dir)).getSettings().suppressAttachHint).toBe(true);
  });
});
