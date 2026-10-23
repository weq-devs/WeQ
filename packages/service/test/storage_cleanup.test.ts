import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  executeStorageCleanup,
  readStorageCleanupResult,
  selectStorageCleanupTargets,
} from '../src/bootstrap/storage_cleanup';
import { UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'weq-storage-exit-')));
  roots.push(root);
  const service = new UserConfigService({ appDataRoot: () => root });
  const file = (name: string) => {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'synthetic');
    return path;
  };
  return { root, service, file, reportPath: join(root, 'storage-maintenance/result.json') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('持久类型均有风险说明，缓存接口不接管；退出助手仅删除明确选择项并留下回执', async () => {
  const f = fixture();
  const originals = f.file('qq-original/nt_msg.db');
  const selected = [
    'ocr',
    'agentlab',
    'roam-msg',
    'export',
    'db_repair',
    'intent_sense',
    'api_usage',
    'flash',
    'collection-history',
    'roaming-jobs',
    'deleted',
    'anti_recall',
    'db_tolerance',
    'weq-assistant',
    'dbfix',
    'dbfix2',
  ];
  for (const name of selected) f.file(`cache/${name}/data`);
  f.file('models/model');
  f.file('config/accounts/synthetic.json');
  const items = await f.service.listStorageUsage();
  const targets = items.filter(
    (item) => selected.includes(item.id) || ['models', 'config'].includes(item.label),
  );
  expect(targets).toHaveLength(selected.length);
  for (const item of targets)
    expect(item).toMatchObject({
      clearable: true,
      requiresExit: true,
      confirmation: expect.any(String),
    });
  await f.service.clearCache(targets.map((item) => item.id));
  for (const name of selected) expect(existsSync(join(f.root, 'cache', name, 'data'))).toBe(true);
  const result = await executeStorageCleanup({
    targets,
    protectedPaths: [],
    reportPath: f.reportPath,
  });
  expect(result.failed).toEqual([]);
  expect(result.cleared).toHaveLength(selected.length);
  for (const name of selected) expect(existsSync(join(f.root, 'cache', name))).toBe(false);
  expect(existsSync(originals)).toBe(true);
  expect(existsSync(join(f.root, 'models/model'))).toBe(true);
  expect(await readStorageCleanupResult(f.reportPath)).toEqual(result);
});

it('未知 ID、空选择、只读和不完整项目不能进入退出清除计划', async () => {
  const f = fixture();
  f.file('cache/ocr/data');
  f.file('unknown.bin');
  const items = await f.service.listStorageUsage();
  expect(() => selectStorageCleanupTargets(items, [])).toThrow();
  expect(() => selectStorageCleanupTargets(items, ['../config'])).toThrow();
  expect(() =>
    selectStorageCleanupTargets(items, [items.find((item) => item.label === 'unknown.bin')!.id]),
  ).toThrow();
  expect(() =>
    selectStorageCleanupTargets(
      items.map((item) => ({ ...item, incomplete: true })),
      ['ocr'],
    ),
  ).toThrow();
  expect(selectStorageCleanupTargets(items, ['ocr', 'ocr'])).toHaveLength(1);
});

it('配置文件、模型和诊断也可明确选择清除，未选原件保留', async () => {
  const f = fixture();
  const selected = [
    f.file('config.json'),
    f.file('models/model.bin'),
    f.file('config/accounts/key.json'),
    f.file('diagnostics/report.json'),
  ];
  const original = f.file('personal-original.bin');
  const items = await f.service.listStorageUsage();
  const targets = items.filter((item) =>
    selected.some((path) => path === item.path || path.startsWith(`${item.path}/`)),
  );
  expect(targets).toHaveLength(4);
  expect(targets.every((item) => item.requiresExit && item.confirmation)).toBe(true);
  const result = await executeStorageCleanup({
    targets,
    protectedPaths: [],
    reportPath: f.reportPath,
  });
  expect(result.failed).toEqual([]);
  for (const path of selected) expect(existsSync(path)).toBe(false);
  expect(existsSync(original)).toBe(true);
});

it('装扮旧配置与预览可独立清除，大小统计不重复', async () => {
  const f = fixture();
  const preview = f.file(`cache/dress/${'a'.repeat(40)}.png`);
  const config = f.file('cache/dress/account/background.png');
  const items = await f.service.listStorageUsage();
  const target = items.find((item) => item.cleanupKind === 'dress-data')!;
  const result = await executeStorageCleanup({
    targets: [target],
    protectedPaths: [],
    reportPath: f.reportPath,
  });
  expect(result.failed).toEqual([]);
  expect(result.freedBytes).toBe(9);
  expect(existsSync(preview)).toBe(true);
  expect(existsSync(config)).toBe(false);
});

it('保护安装资源、维护回执及被换成符号链接的目标，其他项目仍可清除', async () => {
  const f = fixture();
  const other = fixture();
  const original = other.file('original');
  f.file('cache/ocr/data');
  f.file('models/model');
  f.file('logs/log');
  const items = await f.service.listStorageUsage();
  const ocr = items.find((item) => item.id === 'ocr')!;
  rmSync(ocr.path, { recursive: true });
  symlinkSync(other.root, ocr.path, 'dir');
  const model = items.find((item) => item.label === '本地模型')!;
  const log = items.find((item) => item.label === '运行日志')!;
  const result = await executeStorageCleanup({
    targets: [ocr, model, log],
    protectedPaths: [join(model.path, 'model')],
    reportPath: f.reportPath,
  });
  expect(result.failed).toHaveLength(2);
  expect(result.cleared).toEqual([log.label]);
  expect(existsSync(original)).toBe(true);
  expect(existsSync(join(model.path, 'model'))).toBe(true);
});

it('宿主运行目录可退出后清除，应用安装根及维护状态始终只读', async () => {
  const f = fixture();
  f.file('profile/Cookies');
  f.file('install/config/a');
  f.file('storage-maintenance/result.json');
  const items = await f.service.listStorageUsage([
    { path: join(f.root, 'profile'), label: '桌面运行数据', clearableAfterExit: true },
    { path: join(f.root, 'install'), label: '应用安装资源', protected: true },
  ]);
  expect(items.find((item) => item.path === join(f.root, 'profile/Cookies'))).toMatchObject({
    clearable: true,
    requiresExit: true,
  });
  expect(items.find((item) => item.path === join(f.root, 'install/config'))?.clearable).toBe(false);
  expect(items.find((item) => item.path === join(f.root, 'storage-maintenance'))?.clearable).toBe(
    false,
  );
});

it('宿主目录与业务根重合时仍保护未知业务原件，托管 QQ 风险说明包含本地数据库', async () => {
  const f = fixture();
  f.file('personal-original.bin');
  f.file('Cookies');
  f.file('managed-qq/nt_db/synthetic.db');
  const items = await f.service.listStorageUsage([
    { path: f.root, label: '桌面运行数据', clearableAfterExit: true },
  ]);
  expect(items.find((item) => item.label === 'personal-original.bin')?.clearable).toBe(false);
  expect(items.find((item) => item.label === 'Cookies')).toMatchObject({
    clearable: true,
    requiresExit: true,
  });
  expect(items.find((item) => item.path === join(f.root, 'managed-qq'))?.confirmation).toContain(
    '本地聊天数据库',
  );
});
