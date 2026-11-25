import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DbRepairService } from '@weq/service';
import { dbRepairRouter, databaseMaintenance } from '../src/main/ipc/routers/db_repair';
import { backgroundTasks } from '../src/main/background_tasks';
import { databaseMaintenanceNotification } from '../src/renderer/src/lib/databaseMaintenanceNotification';

const fixture = vi.hoisted(() => ({
  root: '',
  bad: false,
  healthy: true,
  fail: false,
  run: vi.fn(),
  begin: vi.fn(),
  end: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  requireBootstrap: () => ({
    userConfig: {
      listAccountConfigs: () => [
        {
          uin: '10001',
          configId: 'source',
          dataDir: fixture.root,
          dbKey: 'fixture',
          algos: { 'nt_msg.db': { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } },
        },
      ],
      cacheDir: (path: string) => join(fixture.root, 'cache', path),
      getDbRepairCacheDir: () => null,
      getSetting: () => 2,
    },
  }),
  requirePlatform: () => ({
    resolveQqPid: () => null,
    native: {
      ntHelper: {
        beginDatabaseMaintenance: fixture.begin,
        endDatabaseMaintenance: fixture.end,
        setDatabaseMaintenanceWriteBarrier: vi.fn(),
        protectDatabaseMaintenanceProduct: vi.fn(),
        closeDb: vi.fn(),
      },
    },
  }),
  getAppContext: () => ({}),
  closeSalvageConnections: vi.fn(),
  clearVerifiedDbDamage: vi.fn(),
}));
vi.mock('../src/main/db_maintenance_worker_client', () => ({
  runDatabaseMaintenanceWorker: fixture.run,
}));
vi.mock('../src/main/db_maintenance_lock', () => ({
  DatabaseMaintenanceLock: class {
    signal = new AbortController().signal;
    begin = fixture.begin;
    end = fixture.end;
    protect = vi.fn();
    terminate = vi.fn();
  },
}));
vi.mock('../src/main/ipc/trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.create();
  return { procedure: t.procedure, router: t.router };
});

const input = { uin: '10001', configId: 'source' };
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'weq-checkup-notification-'));
  writeFileSync(join(fixture.root, 'nt_msg.db'), Buffer.alloc(9216));
  fixture.bad = false;
  fixture.healthy = true;
  fixture.fail = false;
  fixture.begin.mockReset().mockResolvedValue([{ dbPath: join(fixture.root, 'nt_msg.db') }]);
  fixture.end.mockReset().mockReturnValue(true);
  fixture.run.mockReset().mockImplementation(async (request) => {
    if (fixture.fail) throw new Error('合成 worker 退出');
    if (request.kind === 'deep')
      return {
        ran: true,
        healthy: fixture.healthy,
        corruptedTables: fixture.healthy ? [] : ['synthetic'],
      };
    return {
      dbName: 'nt_msg.db',
      dbPath: join(fixture.root, 'nt_msg.db'),
      pageSize: 4096,
      pageCount: 2,
      badPages: fixture.bad ? [2] : [],
      zeroPages: [],
      plaintext: false,
      trailingBytes: 0,
      usedHmac: true,
      headerOffset: 1024,
      fileSize: 9216,
      scannedAt: 0,
      affected: [],
    };
  });
});
afterEach(async () => {
  await databaseMaintenance.shutdown();
  for (const task of [...backgroundTasks.snapshot()]) backgroundTasks.remove(task.id);
  vi.restoreAllMocks();
  rmSync(fixture.root, { recursive: true, force: true });
});

it('打开和查看结果只读取状态；扫描正常完成及结束维护静默，历史结果不被查看覆盖', async () => {
  const caller = dbRepairRouter.createCaller({});
  await caller.status(input);
  await caller.maintenance(input);
  await caller.reports(input);
  expect(fixture.run).not.toHaveBeenCalled();
  const result = await caller.scanAccount({ ...input, kind: 'scan' });
  expect(databaseMaintenanceNotification(result)).toBeNull();
  expect(backgroundTasks.snapshot()).toEqual([]);
  const saved = await caller.report({ ...input, reportId: result.operation!.id });
  await caller.endMaintenance(input);
  expect(await caller.report({ ...input, reportId: result.operation!.id })).toEqual(saved);
  expect(fixture.run).toHaveBeenCalledOnce();
  expect(fixture.end).toHaveBeenCalledOnce();
  expect(databaseMaintenanceNotification((await caller.maintenance(input))!)).toBeNull();
});

it.each(['pages', 'structure'] as const)(
  '成功执行且发现 %s 异常，不创建列表任务，通知指向本次体检结果',
  async (part) => {
    fixture.bad = part === 'pages';
    fixture.healthy = part !== 'structure';
    const result = await dbRepairRouter.createCaller({}).scanAccount({ ...input, kind: 'checkup' });
    expect(result.operation?.status).toBe('completed');
    expect(backgroundTasks.snapshot()).toEqual([]);
    expect(databaseMaintenanceNotification(result)).toMatchObject({
      event: 'databaseDamage',
      title: '深度体检已完成，发现数据库异常',
      account: { ...input, reportId: undefined, checkupResult: result },
    });
    expect(fixture.run.mock.calls.filter(([request]) => request.kind === 'scan')).toHaveLength(1);
  },
);

it('实际扫描失败留部分完成报告及失败提醒，不添加会覆盖旧结果的重试动作', async () => {
  fixture.fail = true;
  const result = await dbRepairRouter.createCaller({}).scanAccount({ ...input, kind: 'scan' });
  expect(result.operation?.status).toBe('partial');
  expect(result.databases[0]).toMatchObject({
    scanStatus: 'failed',
    scanError: '合成 worker 退出',
  });
  expect(backgroundTasks.snapshot()).toEqual([]);
  expect(databaseMaintenanceNotification(result)).toMatchObject({
    event: 'databaseDamage',
    tone: 'error',
    account: { ...input, reportId: undefined, checkupResult: result },
  });
});

it('修复执行及失败只更新维护进度和报告，不创建列表任务', async () => {
  const caller = dbRepairRouter.createCaller({});
  await caller.scanAccount({ ...input, kind: 'scan' });
  vi.spyOn(DbRepairService.prototype, 'repair').mockImplementationOnce(async () => {
    expect(databaseMaintenance.current(input)?.state).toBe('repairing');
    expect(backgroundTasks.snapshot()).toEqual([]);
    throw new Error('合成修复失败');
  });
  const { snapshot } = await caller.repairSelected({ ...input, dbNames: ['nt_msg.db'] });
  expect(snapshot).toMatchObject({
    locked: false,
    operation: { kind: 'repair', status: 'failed' },
    databases: [{ repair: { status: 'failed', error: '合成修复失败' } }],
  });
  expect(backgroundTasks.snapshot()).toEqual([]);
  expect(await caller.report({ ...input, reportId: snapshot.operation!.id })).toMatchObject({
    operation: { id: snapshot.operation!.id, kind: 'repair', status: 'failed' },
    databases: [{ repair: { status: 'failed', error: '合成修复失败' } }],
  });
});
