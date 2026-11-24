import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  realpathSync,
  lstatSync,
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

it('配置独立管理，桌面缓存归空间清理，小型运行状态不开放清理', async () => {
  const f = fixture();
  for (const path of [
    'config/accounts/settings.json',
    'config.json',
    'remote-network/state.json',
    'profile/Local Storage/data',
    'profile/Cache/data',
    'profile/Code Cache/data',
    'profile/GPUCache/data',
    'profile/Preferences',
    'profile/Cookies',
    'cache/flash/file',
  ])
    f.write(join(f.root, path), '{}');
  const items = await f.service.listStorageUsage([
    { path: join(f.root, 'profile'), label: '桌面运行数据', clearableAfterExit: true },
  ]);
  for (const name of ['config', 'config.json'])
    expect(items.find((item) => item.path === join(f.root, name))).toMatchObject({
      management: 'backup',
      action: 'data',
    });
  for (const name of ['remote-network', 'Local Storage', 'Preferences', 'Cookies']) {
    const item = items.find(
      (item) => item.path === join(f.root, name === 'remote-network' ? name : `profile/${name}`),
    )!;
    expect(item).toMatchObject({ management: 'runtime', clearable: false, action: 'none' });
    expect(() => selectStorageCleanupTargets(items, [item.id])).toThrow();
  }
  for (const name of ['Cache', 'Code Cache', 'GPUCache'])
    expect(items.find((item) => item.path === join(f.root, 'profile', name))).toMatchObject({
      management: 'cleanup',
      category: 'cache',
      action: 'cache',
      clearable: true,
    });
  expect(items.find((item) => item.id === 'flash')).toMatchObject({
    management: 'downloads',
    clearable: false,
  });
  expect(() => selectStorageCleanupTargets(items, ['flash'])).toThrow();
});

it('数据库验证分项独立清理，保留未选副本、链接和嵌套宿主根', async () => {
  const f = fixture();
  const run = join(f.root, 'DatabaseValidation', '20261117-180455');
  const backup = f.write(join(run, 'backup', 'sample.db'), 'backup');
  const working = f.write(join(run, 'working', 'sample.db'), 'working');
  const embedded = f.write(join(run, 'working', 'embedded', 'file'), 'host');
  const candidate = f.write(join(run, 'candidates', 'sample.db'), 'candidate');
  const notes = f.write(join(run, 'notes.txt'), 'notes');
  f.write(join(f.root, 'DatabaseValidation', 'unknown.txt'), 'unknown');
  const link = join(run, 'reports');
  symlinkSync(join(run, 'backup'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const linkBytes = lstatSync(link).size;
  const items = await f.service.listStorageUsage([
    { path: join(run, 'working', 'embedded'), label: '宿主资源', category: 'app-resources' },
  ]);
  const parts = items.filter((item) => item.category === 'database-validation');
  expect(parts.map(({ path, bytes }) => [path, bytes])).toEqual(
    expect.arrayContaining([
      [dirname(backup), 6],
      [join(run, 'working'), 7],
      [join(run, 'candidates'), 9],
      [run, 5],
      [dirname(run), 7],
      [link, linkBytes],
    ]),
  );
  expect(parts.reduce((sum, item) => sum + item.bytes, 0)).toBe(34 + linkBytes);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  expect(
    items.find((item) => item.path === join(run, 'working', 'embedded', 'file')),
  ).toMatchObject({
    category: 'app-resources',
    bytes: 4,
  });
  expect(() => selectStorageCleanupTargets(items, [`storage:${link}`])).toThrow();
  const targets = selectStorageCleanupTargets(items, [
    `storage:${run}`,
    `storage:${dirname(working)}`,
  ]);
  const result = await executeStorageCleanup({
    targets,
    protectedPaths: [embedded],
    reportPath: f.reportPath,
    busyPaths: [],
  });
  expect(result.failed).toEqual([]);
  expect(result.freedBytes).toBe(12);
  expect([working, notes].some(existsSync)).toBe(false);
  expect([backup, embedded, candidate, link].every(existsSync)).toBe(true);
});

it('已知功能按所在数据根归类，保留原清理资格与未知文件', async () => {
  const f = fixture();
  const profile = join('instances', 'a'.repeat(24));
  const expected = [
    ['enhancements/engines', 'component', 'app-resources', true],
    ['enhancements/market-emoji', 'sticker', 'app-resources', true],
    [join(profile, 'data'), 'legacy', 'desktop-data', true],
    [join(profile, 'electron'), 'state', 'desktop-data', true],
    [join(profile, 'electron', 'Cache'), 'page', 'desktop-data', true],
    [join(profile, 'data', 'cache', 'contacts'), 'history', 'desktop-data', true],
    ['cache/contacts', 'history', 'account-data', true],
    ['cache/conversation-calendar', 'checkpoint', 'account-data', true],
    ['cache/gift', 'image', 'media', true],
    ['cache/favorite-emoji', 'sticker', 'dress', true],
    ['cache/feedback-2026-11-24-123456', 'report.md', 'diagnostics', false],
    ['performance-monitor', 'history.sqlite', 'diagnostics', true],
    ['logs', 'main.log', 'diagnostics', true],
    ['recordings', 'call.wav', 'media', false],
    ['updates', 'feed.json', 'updates', false],
    ['cache/updates', 'unknown.json', 'unknown', false],
    ['unrecognized', 'personal.txt', 'unknown', false],
  ] as const;
  for (const [dir, file] of expected) f.write(join(f.root, dir, file), 'data');
  f.service.setCacheDirOverride(join(f.root, 'custom'));
  f.write(join(f.root, 'custom', 'contacts', 'history'), 'data');
  f.write(join(f.root, 'custom', 'media', 'still-local.jpg'), 'data');
  const embedded = join(f.root, 'custom', 'media', 'embedded');
  f.write(join(embedded, 'file'), 'host');
  const feedback = join(f.root, 'custom', 'db-damage-feedback-8123456-20261124-123456');
  f.write(join(feedback, 'report.md'), 'data');
  f.write(join(f.root, 'custom', 'feedback-not-a-generated-name', 'file'), 'data');
  const items = await f.service.listStorageUsage([
    { path: embedded, label: '宿主资源', category: 'app-resources' },
  ]);
  for (const [dir, , category, clearable] of expected) {
    expect(items.find((item) => item.path === join(f.root, dir))).toMatchObject({
      category,
      bytes: 4,
      clearable,
    });
  }
  expect(items.find((item) => item.id === 'contacts')).toMatchObject({
    category: 'account-data',
    bytes: 4,
    clearable: true,
  });
  expect(items.find((item) => item.id === 'media')).toMatchObject({
    label: '图片与视频缓存',
    category: 'media',
    bytes: 4,
    clearable: false,
  });
  expect(items.find((item) => item.path === feedback)).toMatchObject({
    label: '数据库故障反馈包',
    category: 'diagnostics',
    clearable: false,
  });
  expect(items.find((item) => item.id === 'feedback-not-a-generated-name')).toMatchObject({
    category: 'unknown',
    clearable: false,
  });
  expect(
    items.find((item) => item.path === join(f.root, profile, 'electron', 'Cache'))?.label,
  ).toBe('独立窗口缓存');
  expect(
    items.find((item) => item.path === join(f.root, profile, 'data', 'cache', 'contacts'))?.label,
  ).toBe('旧版联系人信息缓存');
  const engine = join(f.root, 'enhancements', 'engines');
  const targets = selectStorageCleanupTargets(items, [`storage:${engine}`]);
  const plan = { targets, protectedPaths: [], reportPath: f.reportPath };
  const direct = await executeStorageCleanup({ ...plan, busyPaths: [] });
  expect(direct.failed[0]?.retryAfterRestart).toBe(true);
  expect(existsSync(engine)).toBe(true);
  const exited = await executeStorageCleanup(plan);
  expect(exited.failed).toEqual([]);
  expect(existsSync(engine)).toBe(false);
  expect(existsSync(join(f.root, 'enhancements', 'market-emoji'))).toBe(true);
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
