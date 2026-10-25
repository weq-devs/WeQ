import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Platform } from '@weq/platform';
import type { AccountConfig } from '@weq/service';
import type { AttachHook } from '@weq/service';
import {
  backupMediaRoots,
  discoverBackups,
  matchingBackupConfigs,
  probeBackup,
} from '../src/main/static_backup';
import { inspectBackupDatabases } from '../src/main/backup_probe_core';

const f = vi.hoisted(() => ({
  peek: vi.fn(),
  derive: vi.fn(),
  other: vi.fn(),
  key: vi.fn(),
  pid: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@weq/db', async (original) => ({
  ...(await original<typeof import('@weq/db')>()),
  QqDb: class {
    query = f.query;
    close() {}
  },
}));
vi.mock('@weq/account', () => ({ peekStaticSelfUin: f.peek, deriveAndroidDbKey: f.derive }));
vi.mock('../src/main/backup_probe', () => ({
  runBackupProbe: (input: import('../src/main/backup_probe_protocol').BackupProbeInput) =>
    inspectBackupDatabases(platform.native.ntHelper, input),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  fetchOtherDeviceDatabaseKey: f.other,
}));
const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'weq-backup-scan-')));
  roots.push(root);
  return root;
}
function db(dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const file of ['nt_msg.db', 'profile_info.db', 'group_info.db'])
    writeFileSync(join(dir, file), 'synthetic');
  return dir;
}
const platform = {
  native: { ntHelper: { testDatabaseKey: f.key } },
  resolveQqPid: f.pid,
} as unknown as Platform;
const config = (patch: Partial<AccountConfig> = {}): AccountConfig => ({
  uin: '12345',
  dbKey: 'old',
  algos: {},
  lastLoginAt: 0,
  uid: 'u_synthetic',
  guid: 'a'.repeat(32),
  ...patch,
});
beforeEach(() => {
  vi.resetAllMocks();
  f.derive.mockResolvedValue(undefined);
  f.query.mockResolvedValue([]);
  f.peek.mockImplementation(async (_p, _dir, key) => {
    if (key !== 'valid') throw new Error('encrypted');
    return { uin: '12345', uid: 'u_synthetic', nick: '合成账号', avatarUrl: '' };
  });
  f.key.mockImplementation(async (_path, key) => ({ success: key === 'valid' }));
  f.pid.mockReturnValue(42);
  f.other.mockResolvedValue({ success: true, key: 'valid', pid: 42, uin: '12345' });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('识别 Tencent Files、Windows/Linux 账号目录和原有平铺备份并带上媒体信息', async () => {
  const root = fixture();
  const win = db(join(root, '12345', 'nt_qq', 'nt_db'));
  mkdirSync(join(root, '12345', 'nt_qq', 'nt_data', 'Pic'), { recursive: true });
  db(join(root, 'nt_qq_hash', 'nt_db'));
  expect((await discoverBackups(root)).candidates).toHaveLength(2);
  const result = await discoverBackups(join(root, '12345'));
  expect(result.candidates[0]).toMatchObject({
    dirPath: join(root, '12345'),
    dbDir: win,
    databaseCount: 3,
    mediaDir: join(root, '12345', 'nt_qq', 'nt_data'),
  });
  expect((await discoverBackups(win)).candidates).toHaveLength(1);
  const media = backupMediaRoots(result.candidates[0]!.mediaDir!);
  expect(media.picDir).toBe(join(root, '12345', 'nt_qq', 'nt_data', 'Pic'));
  expect(media.accountDir).toBe(join(root, '12345'));
});
it('深层账号需要手动递归，同路径不重复列出', async () => {
  const root = fixture();
  db(join(root, 'archive', 'snapshot', 'nt_db'));
  expect((await discoverBackups(root)).candidates).toHaveLength(0);
  expect((await discoverBackups(root, true)).candidates).toHaveLength(1);
});
it.each([
  { system: 'Windows', root: ['Documents', 'Tencent Files'], account: ['12345', 'nt_qq'] },
  { system: 'Linux', root: ['.config', 'QQ'], account: ['nt_qq_synthetic'] },
  {
    system: 'macOS',
    root: [
      'Library',
      'Containers',
      'com.tencent.qq',
      'Data',
      'Library',
      'Application Support',
      'QQ',
    ],
    account: ['nt_qq_synthetic'],
  },
])(
  '$system 的数据根、账号层、nt_db 和媒体目录均可独立选择',
  async ({ root: rootParts, account }) => {
    const home = fixture();
    const root = join(home, ...rootParts);
    const accountDir = join(root, ...account);
    const dbDir = db(join(accountDir, 'nt_db'));
    const mediaDir = join(accountDir, 'nt_data');
    mkdirSync(join(mediaDir, 'Pic'), { recursive: true });
    mkdirSync(join(root, 'global', 'nt_db'), { recursive: true });
    writeFileSync(join(root, 'global', 'nt_db', 'login.db'), 'synthetic global login');
    for (const selected of [root, accountDir, dbDir]) {
      const result = await discoverBackups(selected);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        dirPath: account[account.length - 1] === 'nt_qq' ? dirname(accountDir) : accountDir,
        dbDir,
        mediaDir,
      });
    }
    const media = backupMediaRoots(mediaDir);
    expect(media.picDir).toBe(join(mediaDir, 'Pic'));
    expect(media.pttDir).toBe(join(mediaDir, 'Ptt'));
    expect(media.videoDir).toBe(join(mediaDir, 'Video'));
    expect(media.fileDir).toBe(join(mediaDir, 'File'));
    expect(media.emojiResourceDir).toBe(
      join(mediaDir, 'Emoji', 'BaseEmojiSyastems', 'EmojiSystermResource'),
    );
    expect((await discoverBackups(home, true)).candidates).toHaveLength(1);
  },
);
it('平铺备份使用自身 nt_data，不误取无关的同级媒体目录', async () => {
  const root = fixture(),
    flat = db(join(root, 'flat'));
  mkdirSync(join(root, 'nt_data'));
  expect((await discoverBackups(flat)).candidates[0]!.mediaDir).toBeNull();
  mkdirSync(join(flat, 'nt_data'));
  expect((await discoverBackups(flat)).candidates[0]!.mediaDir).toBe(join(flat, 'nt_data'));
});
it('平铺文件夹即使叫 nt_db，也不会丢掉它自己携带的媒体', async () => {
  const root = fixture();
  const flat = db(join(root, 'nt_db'));
  mkdirSync(join(flat, 'nt_data'));
  mkdirSync(join(root, 'nt_data'));
  const location = (await discoverBackups(flat)).candidates[0]!;
  expect(location).toMatchObject({ dirPath: flat, dbDir: flat, mediaDir: join(flat, 'nt_data') });
  expect(backupMediaRoots(location.mediaDir!, location.dirPath).accountDir).toBe(flat);
});
it('UID 哈希目录匹配同账号的所有配置，不混入其他账号', () => {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const hash = md5(md5('u_synthetic') + 'nt_kernel');
  const configs = [
    config(),
    config({ static: true, dataDir: '/snapshot' }),
    config({ uin: '99999', uid: 'u_other' }),
  ];
  expect(matchingBackupConfigs(`/root/nt_qq_${hash}/nt_db`, configs)).toEqual(configs.slice(0, 2));
});
it('先验证已有密钥，失败再用同账号配置登记 SSO 并请求其他设备密钥', async () => {
  const dir = db(join(fixture(), '12345', 'nt_qq', 'nt_db'));
  const result = await probeBackup(platform, [config(), config({ uin: '99999' })], dir, {
    allowOnline: true,
  });
  expect(result).toMatchObject({
    ok: true,
    needKey: false,
    derivedKey: 'valid',
    keySource: 'other-device',
    preview: { uin: '12345' },
  });
  expect(f.other).toHaveBeenCalledOnce();
  expect(f.other.mock.calls[0]?.[3]).toBe(join(dir, 'nt_msg.db'));
  expect(f.other.mock.calls[0]?.[4]).toMatchObject({ expectedUin: '12345', enabled: true });
});
it('明文、已保存密钥、安卓推导成功时不请求网络，离线开关和失效物料也不请求', async () => {
  const dir = db(fixture());
  const plain = Buffer.alloc(1100);
  plain.write('SQLite format 3\0');
  for (const name of ['profile_info.db', 'nt_msg.db']) writeFileSync(join(dir, name), plain);
  f.peek.mockResolvedValueOnce({ uin: '12345', uid: '', nick: '', avatarUrl: '' });
  expect(await probeBackup(platform, [config()], dir, { allowOnline: true })).toMatchObject({
    needKey: false,
  });
  for (const name of ['profile_info.db', 'nt_msg.db'])
    writeFileSync(join(dir, name), 'synthetic encrypted');
  expect(
    await probeBackup(platform, [config({ dbKey: 'valid' })], dir, { allowOnline: true }),
  ).toMatchObject({ keySource: 'saved' });
  f.derive.mockResolvedValueOnce({ dbKey: 'valid' });
  expect(await probeBackup(platform, [], dir, { allowOnline: true })).toMatchObject({
    mobile: true,
  });
  expect(await probeBackup(platform, [config()], dir, { allowOnline: false })).toMatchObject({
    needKey: true,
  });
  expect(f.other).not.toHaveBeenCalled();
  f.other.mockResolvedValue({ success: false, error: '物料不可用' });
  expect(await probeBackup(platform, [config()], dir, { allowOnline: true })).toMatchObject({
    needKey: true,
  });
  expect(f.other).toHaveBeenCalledOnce();
});
it('密钥虽可解密但资料账号不同仍拒绝；显式错误密钥不自动替换', async () => {
  const dir = db(fixture());
  f.peek.mockImplementation(async (_p, _dir, key) => {
    if (!key) throw new Error('encrypted');
    return { uin: '99999', uid: '', nick: '', avatarUrl: '' };
  });
  expect(await probeBackup(platform, [config()], dir, { allowOnline: true })).toMatchObject({
    needKey: true,
  });
  expect(
    await probeBackup(platform, [config()], dir, { dbKey: 'wrong', allowOnline: true }),
  ).toMatchObject({ ok: false });
});
it('只有资料库明文、消息库仍加密时继续要求密钥', async () => {
  const dir = db(fixture());
  f.peek.mockResolvedValue({ uin: '12345', uid: '', nick: '', avatarUrl: '' });
  f.query.mockRejectedValue(new Error('encrypted message database'));
  expect(await probeBackup(platform, [], dir, { allowOnline: false })).toMatchObject({
    needKey: true,
  });
});
it('已有物料不可用时允许现有 attachHook 提权流程，完全离线不触发', async () => {
  const dir = db(fixture());
  const attachHook = {} as AttachHook;
  expect(
    await probeBackup(platform, [config()], dir, { allowOnline: true, attachHook }),
  ).toMatchObject({ keySource: 'other-device' });
  expect(f.other.mock.calls[0]?.[2]).toBe(attachHook);
  expect(f.other.mock.calls[0]?.[4]).toMatchObject({ enabled: true, expectedUin: '12345' });
  f.other.mockClear();
  expect(
    await probeBackup(platform, [config()], dir, { allowOnline: false, attachHook }),
  ).toMatchObject({ needKey: true });
  expect(f.other).not.toHaveBeenCalled();
});
it('明确的 Windows 账号目录没有同账号配置时，不给其他账号触发提权或请求', async () => {
  const dir = db(join(fixture(), '12345', 'nt_qq', 'nt_db'));
  expect(
    await probeBackup(platform, [config({ uin: '99999' })], dir, {
      allowOnline: true,
      attachHook: {} as AttachHook,
    }),
  ).toMatchObject({ needKey: true });
  expect(f.other).not.toHaveBeenCalled();
});
it('同批备份把会话上下文交给共享密钥流程，失败仍允许手动输入', async () => {
  const dir = db(fixture());
  const options = {
    allowOnline: true,
    attachHook: {} as AttachHook,
    keyContext: { attachAttempts: new Set<number>(), registered: new Map<number, string>() },
  };
  f.other.mockResolvedValue({ success: false, error: '用户取消读取' });
  for (let i = 0; i < 2; i++)
    expect(await probeBackup(platform, [config()], dir, options)).toMatchObject({ needKey: true });
  expect(f.other).toHaveBeenCalledTimes(2);
  expect(f.other.mock.calls[1]?.[4].context).toBe(options.keyContext);
});
it('QQ 包装的加密库带 WAL 时，不先执行无密钥资料查询', async () => {
  const dir = db(fixture());
  const header = Buffer.alloc(1100);
  header.write('QQ_NT DB', 32);
  for (const name of ['profile_info.db', 'nt_msg.db']) {
    writeFileSync(join(dir, name), header);
    writeFileSync(join(dir, `${name}-wal`), Buffer.alloc(32));
  }
  expect(await probeBackup(platform, [], dir, { allowOnline: false })).toMatchObject({
    needKey: true,
  });
  expect(f.peek).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it('Linux/macOS 哈希账号目录可用在线身份补齐旧配置缺失的 UID，再自动请求同账号密钥', async () => {
  const md5 = (value: string) => createHash('md5').update(value).digest('hex');
  const dir = db(join(fixture(), `nt_qq_${md5(md5('u_synthetic') + 'nt_kernel')}`, 'nt_db'));
  const saved = config({ uid: undefined });
  const resolveOnline = vi.fn(async () => [{ uin: '12345', uid: 'u_synthetic', pid: 42 }]);
  expect(
    await probeBackup(platform, [saved], dirname(dir), { allowOnline: true, resolveOnline }),
  ).toMatchObject({ keySource: 'other-device', needKey: false });
  expect(f.other.mock.calls[0]?.[4]).toMatchObject({ expectedUin: '12345' });
  expect(saved.uid).toBeUndefined();
});
