import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UserConfigService } from '../src/bootstrap/user_config';
import {
  executeStorageCleanup,
  selectStorageCleanupTargets,
} from '../src/bootstrap/storage_cleanup';
import { DbRepairHistory } from '../src/account/db_repair/history';
import { dbRepairPaths } from '../src/account/db_repair/paths';

const roots: string[] = [];
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'weq-storage-inventory-')));
  roots.push(root);
  const service = new UserConfigService({ appDataRoot: () => root });
  const write = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return path;
  };
  const backup = (rootPath = join(root, 'cache'), stamp = 'first') => {
    const accountRoot = join(rootPath, 'db_repair', 'synthetic');
    const directory = join(accountRoot, 'backups', stamp);
    const path = write(join(directory, 'nt_msg.db'), 'synthetic database');
    write(
      join(directory, 'meta.json'),
      JSON.stringify({
        uin: 'synthetic',
        dbName: 'nt_msg.db',
        at: '2026-11-05T00:00:00Z',
        source: join(root, 'qq-original', 'nt_msg.db'),
      }),
    );
    return { accountRoot, directory, path };
  };
  const record = (path: string) => ({
    id: 'record',
    uin: 'synthetic',
    dbName: 'nt_msg.db',
    at: '2026-11-05T00:00:00Z',
    dbPath: join(root, 'qq-original', 'nt_msg.db'),
    backupPath: path,
  });
  const history = (path: string, backupPath: string) =>
    write(
      join(path, 'history.json'),
      JSON.stringify({ version: 1, records: [record(backupPath)] }),
    );
  return {
    root,
    service,
    write,
    backup,
    history,
    reportPath: join(root, 'storage-maintenance', 'result.json'),
  };
}

it('数据库备份、修复记录与临时文件分别统计，旧工作区 ID 不再可清除', async () => {
  const f = fixture();
  const b = f.backup();
  f.history(b.accountRoot, b.path);
  f.write(join(b.accountRoot, 'reports', 'report.md'), 'report');
  f.write(join(b.accountRoot, 'work', 'temporary'), 'work');
  const items = await f.service.listStorageUsage();
  expect(items.find((item) => item.path === b.directory)).toMatchObject({
    category: 'db-backups',
    backup: { status: 'linked', recordId: 'record' },
  });
  expect(items.filter((item) => item.category === 'repair-history')).toHaveLength(2);
  expect(items.find((item) => item.category === 'repair-work')).toMatchObject({ clearable: true });
  expect(() => selectStorageCleanupTargets(items, ['db_repair'])).toThrow();
  const result = await executeStorageCleanup({
    targets: items.filter((item) => item.category === 'db-backups'),
    protectedPaths: [],
    reportPath: f.reportPath,
  });
  expect(result.failed).toEqual([]);
  expect(existsSync(b.path)).toBe(false);
  expect(existsSync(join(b.accountRoot, 'reports', 'report.md'))).toBe(true);
  expect(new DbRepairHistory(dbRepairPaths(b.accountRoot)).find('record')?.purgedAt).toBeTruthy();
});

it('自定义工作盘与原历史正确关联，嵌套根统计不重复，删除只更新关联记录', async () => {
  const f = fixture();
  const scratch = join(f.root, 'cache', 'scratch');
  const b = f.backup(scratch);
  const accountRoot = join(f.root, 'cache', 'db_repair', 'synthetic');
  f.history(accountRoot, b.path);
  f.service.setDbRepairCacheDir(scratch);
  const items = await f.service.listStorageUsage();
  const backups = items.filter((item) => item.category === 'db-backups');
  expect(backups).toHaveLength(1);
  expect(backups[0]?.backup?.historyPath).toBe(join(accountRoot, 'history.json'));
  const result = await executeStorageCleanup({
    targets: backups,
    protectedPaths: [],
    reportPath: f.reportPath,
  });
  expect(result.failed).toEqual([]);
  expect(new DbRepairHistory(dbRepairPaths(accountRoot)).find('record')?.purgedAt).toBeTruthy();
});

it('元数据可确认的无记录备份可单独删除，缺失和未知备份不误开放清理', async () => {
  const f = fixture();
  const orphan = f.backup();
  f.history(orphan.accountRoot, join(orphan.accountRoot, 'backups', 'missing', 'nt_msg.db'));
  f.write(join(orphan.accountRoot, 'backups', 'unknown', 'old.db'), 'unknown');
  const items = await f.service.listStorageUsage();
  expect(items.find((item) => item.path === orphan.directory)).toMatchObject({
    clearable: true,
    backup: { status: 'orphan' },
  });
  expect(items.find((item) => item.path.endsWith('unknown'))).toMatchObject({
    clearable: false,
    backup: { status: 'unrecognized' },
  });
  expect(items.some((item) => item.path.endsWith('missing'))).toBe(false);
});

it('备份删除失败不标记 purgedAt，原始数据库不受影响', async () => {
  const f = fixture();
  const b = f.backup();
  const historyPath = f.history(b.accountRoot, b.path);
  const original = f.write(join(f.root, 'qq-original', 'nt_msg.db'), 'original');
  const items = await f.service.listStorageUsage();
  vi.mocked(rmSync).mockImplementationOnce(() => {
    throw new Error('synthetic deletion failure');
  });
  const result = await executeStorageCleanup({
    targets: items.filter((item) => item.category === 'db-backups'),
    protectedPaths: [],
    reportPath: f.reportPath,
  });
  expect(result.failed[0]?.error).toContain('synthetic deletion failure');
  expect(readFileSync(historyPath, 'utf8')).not.toContain('purgedAt');
  expect(readFileSync(original, 'utf8')).toBe('original');
});

it('配置与桌面运行状态归备份页，闪传成果不可通过旧 ID 删除', async () => {
  const f = fixture();
  for (const path of [
    'config/accounts/settings.json',
    'config.json',
    'remote-network/state.json',
    'Local Storage/data',
    'cache/flash/file',
  ])
    f.write(join(f.root, path), '{}');
  const items = await f.service.listStorageUsage([
    { path: f.root, label: '桌面运行数据', clearableAfterExit: true },
  ]);
  for (const name of ['config', 'config.json', 'remote-network', 'Local Storage'])
    expect(items.find((item) => item.path === join(f.root, name))?.management).toBe('backup');
  expect(items.find((item) => item.id === 'flash')).toMatchObject({
    management: 'downloads',
    clearable: false,
  });
  expect(() => selectStorageCleanupTargets(items, ['flash'])).toThrow();
});

it('程序修补备份识别清单而不是只看目录名，符号链接不跟随', async () => {
  const f = fixture();
  const directory = join(f.root, 'repair-backups', 'synthetic');
  const old = f.write(join(directory, '0-native.node'), 'old binary');
  f.write(
    join(directory, 'before.json'),
    JSON.stringify({ capturedAt: '2026-10-25T00:00:00Z', files: [{ backup: old }] }),
  );
  f.write(join(f.root, 'repair-backups', 'unknown', 'unrelated'), 'keep');
  const linked = join(f.root, 'cache', 'db_repair', 'linked');
  mkdirSync(dirname(linked), { recursive: true });
  symlinkSync(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const items = await f.service.listStorageUsage();
  expect(items.find((item) => item.path === directory)).toMatchObject({
    category: 'program-backups',
    clearable: true,
  });
  expect(items.find((item) => item.path.endsWith('/unknown'))?.clearable).toBe(false);
  expect(items.find((item) => item.path === linked)?.clearable).toBe(false);
});
