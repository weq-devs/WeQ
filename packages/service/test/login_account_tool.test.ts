/**
 * 「QQ 登录账号管理」的写侧服务。
 *
 * 用 `@weq/testkit` 的 `createSqliteStub()` 对一个**明文 SQLite 夹具**跑真实的
 * `login_table` SQL：不碰真 QQ 库、不联网。夹具表结构照 `login.db` 抄（列名就是
 * 字段号），只放工具真正会读的那几列。
 *
 * 锁三件事：
 *   1. `list()` 按 uin 合并多处 login.db，并正确标出「有 a1 = 快登账号」；
 *   2. 移除快登只清 `[1004]`、真删账号删整行 —— 且**都只动命中的那一行**；
 *   3. 写完之后 WeQ 自己的同步钩子被调用（guid / a1 / 账号配置的联动）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import {
  LoginAccountToolService,
  resolveLoginAccountDir,
  type LoginAccountSyncHooks,
} from '../src/account/login_account_tool';
import { linuxAccountDirName, type Platform } from '@weq/platform';

/** 夹具的列定义，与 login.db 的 `login_table` 对齐（只留用到的列）。 */
const SCHEMA = `CREATE TABLE login_table(
  [1000] INTEGER PRIMARY KEY,
  [1001] TEXT,
  [1002] TEXT,
  [1004] BLOB,
  [1007] TEXT,
  [1008] INTEGER
)`;

interface FixtureAccount {
  uin: number;
  uid: string;
  name: string;
  a1?: Buffer;
  avatar?: string;
  lastLoginAt?: number;
}

function seed(dbPath: string, accounts: FixtureAccount[]): void {
  const db = fixtureDb(dbPath);
  db.exec(SCHEMA);
  const stmt = db.prepare(
    'INSERT INTO login_table ([1000],[1001],[1002],[1004],[1007],[1008]) VALUES (?,?,?,?,?,?)',
  );
  for (const a of accounts) {
    stmt.run(
      BigInt(a.uin),
      a.uid,
      a.avatar ?? null,
      a.a1 ?? null,
      a.name,
      BigInt(a.lastLoginAt ?? 0),
    );
  }
}

/** sqlite stub + 一个恒成功的 `testDatabaseKey`（夹具是明文，算法随便给）。 */
function stubWithProbe(): NtHelperBinding {
  const base = createSqliteStub();
  return {
    ...base,
    testDatabaseKey: async () => ({
      success: true,
      pageHmacAlgorithm: 'SHA1',
      kdfHmacAlgorithm: 'SHA512',
    }),
    readDeviceGuid: () => 'ab'.repeat(16),
    writeDeviceGuid: () => 'cd'.repeat(16),
  } as NtHelperBinding;
}

let dir: string;
let primary: string;
let secondary: string;
let sync: LoginAccountSyncHooks;
let service: LoginAccountToolService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-login-accounts-'));
  primary = join(dir, 'login.db');
  secondary = join(dir, 'login-2.db');
  seed(primary, [
    { uin: 111, uid: 'u_aaa', name: '甲', a1: Buffer.from('aa'.repeat(8)), lastLoginAt: 100 },
    { uin: 222, uid: 'u_bbb', name: '乙', lastLoginAt: 50 },
  ]);
  seed(secondary, [{ uin: 111, uid: 'u_aaa', name: '甲', a1: Buffer.from('aa'.repeat(8)) }]);
  sync = {
    onGuidRotated: vi.fn(),
    onA1Removed: vi.fn(),
    onAccountRemoved: vi.fn(),
  };
  service = new LoginAccountToolService({
    nt: stubWithProbe(),
    loginDbPaths: [primary, secondary],
    dataRoot: '/tmp/qq-root',
    accountDir: (uin, uid) =>
      uid === 'u_aaa' ? '/tmp/qq-root/nt_qq_111' : uin === '222' ? null : null,
    sync,
  });
});

afterEach(() => {
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

describe('list', () => {
  it('merges rows across login.db files and flags quick-login (a1) accounts', async () => {
    const rows = await service.list();
    expect(rows.map((r) => r.uin)).toEqual(['111', '222']);
    const first = rows[0];
    expect(first.userName).toBe('甲');
    expect(first.hasA1).toBe(true);
    expect(first.a1Bytes).toBe(16);
    // 两处 login.db 都含这个号 —— 记下来，方便界面说明"删了它要从两个库都删掉"。
    expect(first.dbPaths).toEqual([primary, secondary]);
    expect(first.dataDir).toBe('/tmp/qq-root/nt_qq_111');
    // 没有 a1 的号 = 只登录过、不是快登账号。
    expect(rows[1].hasA1).toBe(false);
    expect(rows[1].dataDir).toBeNull();
  });
});

describe('removeQuickLogin', () => {
  it('clears only the a1 of the target account, in every login.db', async () => {
    const result = await service.removeQuickLogin('111');
    expect(result.changedRows).toBeGreaterThan(0);
    expect(result.changedFiles).toBe(2);

    const rows = await service.list();
    expect(rows.find((r) => r.uin === '111')?.hasA1).toBe(false);
    // 账号行还在（只是不再快登），别的号一个字没动。
    expect(rows.map((r) => r.uin)).toEqual(['111', '222']);
    expect(sync.onA1Removed).toHaveBeenCalledWith('111');
    expect(sync.onAccountRemoved).not.toHaveBeenCalled();
  });

  it('is a no-op (and does not fire the hook) for an unknown uin', async () => {
    const result = await service.removeQuickLogin('999');
    expect(result.changedRows).toBe(0);
    expect(sync.onA1Removed).not.toHaveBeenCalled();
  });
});

describe('deleteAccount', () => {
  it('deletes the row entirely and leaves other accounts untouched', async () => {
    const result = await service.deleteAccount('111');
    expect(result.changedRows).toBe(2); // 两个库里各一行
    const rows = await service.list();
    expect(rows.map((r) => r.uin)).toEqual(['222']);
    expect(sync.onAccountRemoved).toHaveBeenCalledWith('111');

    // 另一个库里的 111 也不在了。
    const left = fixtureDb(secondary).prepare('SELECT COUNT(*) AS n FROM login_table').get() as {
      n: number;
    };
    expect(left.n).toBe(0);
  });
});

describe('rotateGuid', () => {
  it('returns the native guid and syncs WeQ config', async () => {
    const guid = await service.rotateGuid();
    expect(guid).toBe('cd'.repeat(16));
    expect(sync.onGuidRotated).toHaveBeenCalledWith('cd'.repeat(16));
  });

  it('reports a missing QQ data root instead of silently doing nothing', async () => {
    const noRoot = new LoginAccountToolService({
      nt: stubWithProbe(),
      loginDbPaths: [primary],
      dataRoot: null,
    });
    await expect(noRoot.rotateGuid()).rejects.toThrow(/数据根/);
  });

  it('reports old native artifacts that lack the capability', async () => {
    const nt = stubWithProbe();
    delete (nt as { writeDeviceGuid?: unknown }).writeDeviceGuid;
    const old = new LoginAccountToolService({
      nt,
      loginDbPaths: [primary],
      dataRoot: '/tmp/qq-root',
    });
    await expect(old.rotateGuid()).rejects.toThrow(/原生产物/);
  });
});

describe('resolveLoginAccountDir', () => {
  /** 造一个 linux 形状的假 Platform：只用到 kind / tencentFilesRoots / accountDir。 */
  function fakeLinux(root: string, fallback: string | null): Platform {
    return {
      kind: 'linux',
      tencentFilesRoots: () => [root],
      accountDir: () => fallback,
    } as unknown as Platform;
  }

  it('derives nt_qq_<hash> from the uid when the dir exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-login-dir-'));
    try {
      const dirName = linuxAccountDirName('u_aaa');
      mkdirSync(join(root, dirName));
      const platform = fakeLinux(root, null);
      // 平台层的 accountDir（按 uin 走已存配置）给不出目录 —— uid 现算能。
      expect(resolveLoginAccountDir(platform, '111', 'u_aaa')).toBe(join(root, dirName));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the platform resolver when the derived dir is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-login-dir-'));
    try {
      const platform = fakeLinux(root, '/elsewhere/222');
      expect(resolveLoginAccountDir(platform, '222', 'u_bbb')).toBe('/elsewhere/222');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not derive a dir without a uid, and skips derivation on win32', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-login-dir-'));
    try {
      expect(resolveLoginAccountDir(fakeLinux(root, '/win/111'), '111', '')).toBe('/win/111');
      const win32 = { kind: 'win32', accountDir: () => '/win/333' } as unknown as Platform;
      expect(resolveLoginAccountDir(win32, '333', 'u_ccc')).toBe('/win/333');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans every candidate root, so an override root is not the only place checked', () => {
    const override = mkdtempSync(join(tmpdir(), 'weq-login-dir-a-'));
    const fallback = mkdtempSync(join(tmpdir(), 'weq-login-dir-b-'));
    try {
      const dirName = linuxAccountDirName('u_ddd');
      // 只有第二个候选根里有目录（用户另选了 Tencent Files，真正的数据留在默认根）。
      mkdirSync(join(fallback, dirName));
      const platform = {
        kind: 'linux',
        tencentFilesRoots: () => [override, fallback],
        accountDir: () => null,
      } as unknown as Platform;
      expect(resolveLoginAccountDir(platform, '444', 'u_ddd')).toBe(join(fallback, dirName));
    } finally {
      rmSync(override, { recursive: true, force: true });
      rmSync(fallback, { recursive: true, force: true });
    }
  });
});
