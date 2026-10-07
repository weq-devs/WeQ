/**
 * uid 落盘进账号记录。
 *
 * uid 是账号身份的一部分（linux 的账号目录 `nt_qq_<md5(md5(uid)+"nt_kernel")>`
 * 由它派生），但解析出它的地方（login.db）通常早于账号真正打开 —— 那时还没有
 * 会话级的 `AccountConfigService`。以前它只进内存映射，重启就丢。这一层保证：
 *   - 会话内 `setUid` 能写进记录；
 *   - 会话外 `UserConfigService.setAccountUid` 能按 uin 补写到已有记录（含多条
 *     数据目录记录），且不动别的账号。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { AccountConfigService, accountConfigId } from '../src/account/user_config';
import { UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-uid-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function fakePlatform(root: string): Platform {
  return { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
}

describe('AccountConfigService.setUid', () => {
  function svc(): { s: AccountConfigService; dir: string } {
    const dir = tmpDir();
    const session = {
      context: { uin: '1707889225', dbKey: 'k', algos: {} },
    } as unknown as ConstructorParameters<typeof AccountConfigService>[0];
    const s = new AccountConfigService(session, dir);
    // save() 先 seed 出记录，后续 patch 才有落点。
    s.save({ dataDir: '/tmp/data-1707889225' });
    return { s, dir };
  }

  it('setUid 写进账号配置，且真在磁盘上（重启后仍在）', () => {
    const { s, dir } = svc();
    s.setUid('u_abc123');
    expect(s.getRecord()?.uid).toBe('u_abc123');

    // 记录文件名是 (uin, dataDir) id —— 直接验磁盘内容，重启后就是这个文件。
    const file = join(
      dir,
      'config',
      'accounts',
      `${accountConfigId('1707889225', '/tmp/data-1707889225')}.json`,
    );
    expect(JSON.parse(readFileSync(file, 'utf-8')).uid).toBe('u_abc123');
  });

  it('空串不写（没解析出 uid 时不该落一个空值）', () => {
    const { s } = svc();
    s.setUid('');
    expect(s.getRecord()?.uid).toBeUndefined();
  });

  it('重复值不重写（保留原记录）', () => {
    const { s } = svc();
    s.setUid('u_same');
    const first = s.getRecord();
    s.setUid('u_same');
    expect(s.getRecord()).toEqual(first);
  });
});

describe('UserConfigService.setAccountUid', () => {
  /** 直接写一份账号记录文件（模拟上一次登录留下的记录）。 */
  function writeRecord(root: string, uin: string, dataDir: string, uid?: string): string {
    const dir = join(root, 'config', 'accounts');
    mkdirSync(dir, { recursive: true });
    const configId = accountConfigId(uin, dataDir);
    const file = join(dir, `${configId}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        configId,
        uin,
        dbKey: 'k',
        algos: {},
        dataDir,
        lastLoginAt: 1,
        ...(uid ? { uid } : {}),
      }),
      'utf-8',
    );
    return file;
  }

  it('按 uin 补写 uid 到所有该账号的记录（同 uin 多目录 = 多条记录）', () => {
    const root = tmpDir();
    const f1 = writeRecord(root, '1707889225', '/tmp/a');
    const f2 = writeRecord(root, '1707889225', '/tmp/b', 'u_old');
    const other = writeRecord(root, '3433285587', '/tmp/c');

    new UserConfigService(fakePlatform(root)).setAccountUid('1707889225', 'u_new');

    expect(JSON.parse(readFileSync(f1, 'utf-8')).uid).toBe('u_new');
    expect(JSON.parse(readFileSync(f2, 'utf-8')).uid).toBe('u_new');
    // 别的账号一个字节都不动。
    expect(JSON.parse(readFileSync(other, 'utf-8')).uid).toBeUndefined();
  });

  it('已经是对的 uid 时不重写（保留文件原样）', () => {
    const root = tmpDir();
    const file = writeRecord(root, '1707889225', '/tmp/a', 'u_same');
    const before = readFileSync(file, 'utf-8');
    new UserConfigService(fakePlatform(root)).setAccountUid('1707889225', 'u_same');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('记录目录不存在 / 参数为空都不抛（best-effort）', () => {
    const root = tmpDir();
    const svc = new UserConfigService(fakePlatform(root));
    expect(() => svc.setAccountUid('1707889225', 'u_x')).not.toThrow();
    expect(() => svc.setAccountUid('', 'u_x')).not.toThrow();
    expect(() => svc.setAccountUid('1707889225', '')).not.toThrow();
  });
});
