// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { deriveAndroidDbKey } from '@weq/account';
import type { LoginAccount, NtHelperBinding } from '@weq/native';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const ALGO = { pageHmacAlgorithm: 'hmac-sha1', kdfHmacAlgorithm: 'pbkdf2-sha512' };
const UID = 'u_synthetic';
const UIN = '12345';
const RAND = 'ABCDEFGH';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-android-login-db-'));
  roots.push(root);
  return root;
}

/** 带 QQ 自定义头的加密库：1024 字节头里放魔数和 8 字节 rand。 */
function encryptedDb(dir: string) {
  mkdirSync(dir, { recursive: true });
  const header = Buffer.alloc(1024);
  header.write('QQ_NT DB', 0);
  header.write(RAND, 8);
  for (const name of ['nt_msg.db', 'profile_info.db', 'group_info.db'])
    writeFileSync(join(dir, name), header);
  return dir;
}

/** 只放一个占位文件：行数据由 `ntStub` 的 `decryptLoginDb` 提供。 */
function loginDb(dir: string) {
  const dbDir = join(dir, 'global', 'nt_db');
  mkdirSync(dbDir, { recursive: true });
  const path = join(dbDir, 'login.db');
  writeFileSync(path, 'synthetic');
  return path;
}

function accountRow(patch: Partial<LoginAccount> = {}): LoginAccount {
  return {
    uin: UIN,
    uid: UID,
    avatarUrl: '',
    userName: '',
    a1Key: '',
    lastLoginAt: 0,
    ...patch,
  };
}

function ntStub(options: { rows?: LoginAccount[]; loginFails?: boolean; decryptThrows?: boolean }) {
  const expected = md5(md5(UID) + RAND);
  const testDatabaseKey = vi.fn(async (dbPath: string, key: string) => {
    if (dbPath.endsWith('login.db')) {
      return options.loginFails ? { success: false } : { success: true, ...ALGO };
    }
    return { success: key === expected, ...(key === expected ? ALGO : {}) };
  });
  const decryptLoginDb = vi.fn((_dbPath: string) => {
    if (options.decryptThrows) throw new Error('synthetic login.db 解密失败');
    return options.rows ?? [accountRow()];
  });
  return { testDatabaseKey, decryptLoginDb } as unknown as NtHelperBinding;
}

it('有 gpro 库时仍走文件名取 uid，不去解 login.db', async () => {
  const dir = encryptedDb(join(fixture(), 'nt_db'));
  writeFileSync(join(dir, `gpro_v1-6_${UID}.db`), 'synthetic');
  const nt = ntStub({});
  expect(await deriveAndroidDbKey(nt, dir, { uin: UIN })).toMatchObject({
    dbKey: md5(md5(UID) + RAND),
  });
  const loginCalls = (nt.testDatabaseKey as unknown as { mock: { calls: string[][] } }).mock.calls;
  expect(loginCalls.some(([path]) => path.endsWith('login.db'))).toBe(false);
  expect(nt.decryptLoginDb).not.toHaveBeenCalled();
});

it('没有 gpro 库时退到备份自带的 login.db 取 uid 算出密钥', async () => {
  const root = fixture();
  const dir = encryptedDb(join(root, `nt_qq_${md5(md5(UID) + 'nt_kernel')}`, 'nt_db'));
  loginDb(root);
  expect(await deriveAndroidDbKey(ntStub({}), dir, { uin: UIN })).toMatchObject({
    dbKey: md5(md5(UID) + RAND),
  });
});

it('本机 login.db 也可作为回退来源', async () => {
  const dir = encryptedDb(join(fixture(), 'flat'));
  const local = loginDb(join(fixture(), 'qq-root'));
  const nt = ntStub({});
  expect(await deriveAndroidDbKey(nt, dir, { uin: UIN, loginDbPaths: [local] })).toMatchObject({
    dbKey: md5(md5(UID) + RAND),
  });
});

it('login.db 里只取 uin 匹配的那一行', async () => {
  const root = fixture();
  const dir = encryptedDb(join(root, 'backup'));
  loginDb(root);
  const rows = [
    accountRow({ uin: '99999', uid: 'u_other', lastLoginAt: 999 }),
    accountRow({ lastLoginAt: 1 }),
  ];
  expect(await deriveAndroidDbKey(ntStub({ rows }), dir, { uin: UIN })).toMatchObject({
    dbKey: md5(md5(UID) + RAND),
  });
  expect(await deriveAndroidDbKey(ntStub({ rows }), dir, { uin: '88888' })).toBeUndefined();
});

it('login.db 解不开、探测失败或抛错都静默回退，不向外报错', async () => {
  const root = fixture();
  const dir = encryptedDb(join(root, 'backup'));
  loginDb(root);
  await expect(
    deriveAndroidDbKey(ntStub({ decryptThrows: true }), dir, { uin: UIN }),
  ).resolves.toBe(undefined);
  await expect(deriveAndroidDbKey(ntStub({ loginFails: true }), dir, { uin: UIN })).resolves.toBe(
    undefined,
  );
  await expect(deriveAndroidDbKey(ntStub({ rows: [] }), dir, { uin: UIN })).resolves.toBe(
    undefined,
  );
});

it('非手机备份（头部读不出 rand）完全不碰 login.db', async () => {
  const root = fixture();
  const dir = join(root, 'backup');
  mkdirSync(dir, { recursive: true });
  for (const name of ['nt_msg.db', 'profile_info.db'])
    writeFileSync(join(dir, name), 'SQLite format 3\0');
  loginDb(root);
  const nt = ntStub({});
  expect(await deriveAndroidDbKey(nt, dir, { uin: UIN })).toBeUndefined();
  expect(nt.testDatabaseKey).not.toHaveBeenCalled();
  expect(nt.decryptLoginDb).not.toHaveBeenCalled();
});

it('目录名自校验不通过时不会把 login.db 的 uid 硬套上去', async () => {
  const root = fixture();
  const dir = encryptedDb(join(root, `nt_qq_${md5(md5('u_other') + 'nt_kernel')}`, 'nt_db'));
  loginDb(root);
  expect(await deriveAndroidDbKey(ntStub({}), dir, { uin: UIN })).toBeUndefined();
});
