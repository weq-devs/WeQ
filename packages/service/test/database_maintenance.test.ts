import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DatabaseMaintenance,
  type DatabaseMaintenanceDeps,
} from '../src/account/db_repair/maintenance';
import { DatabaseMaintenanceReports } from '../src/account/db_repair/maintenance_reports';
import { renderDatabaseMaintenanceReport } from '../src/account/db_repair/maintenance_reports';
import type { BadPageScanReport } from '../src/account/bad_pages';
import type { DbRepairTarget, DbRepairRecord } from '../src/account/db_repair/types';
import type { DbRepairCheckupIntegrity } from '../src/account/db_repair/checkup';
import { DbRepairError, DbRepairRollbackError } from '../src/account/db_repair/service';
import type { DatabaseWorkProgress } from '../src/account/db_repair/progress';
import type { DatabasePageLocation } from '../src/account/db_repair/maintenance_types';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(scanConcurrency = () => 1) {
  const root = mkdtempSync(join(tmpdir(), 'weq-maintenance-'));
  roots.push(root);
  const targets = ['msg.db', 'profile.db', 'unsupported.db'].map(
    (dbName): DbRepairTarget => ({
      dbName,
      dbPath: join(root, dbName),
      dbDir: root,
      key: 'synthetic',
      uin: '10001',
      dataDir: root,
      algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
    }),
  );
  const scan = vi.fn(
    async (
      target: DbRepairTarget,
      _signal: AbortSignal,
      _progress: (tick: DatabaseWorkProgress) => void,
      _resume?: Parameters<DatabaseMaintenanceDeps['scan']>[3],
    ): Promise<BadPageScanReport> => ({
      dbName: target.dbName,
      dbPath: target.dbPath,
      pageSize: 4096,
      pageCount: 2,
      badPages: [2],
      zeroPages: [],
      plaintext: target.dbName === 'unsupported.db',
      trailingBytes: 0,
      usedHmac: true,
      headerOffset: 1024,
      fileSize: 9216,
      scannedAt: 1,
      affected: [{ name: 'msg', pagetype: 'leaf', badPageCount: 1, samplePages: [2] }],
    }),
  );
  const release = vi.fn();
  const lease = new AbortController();
  const repair = vi.fn<DatabaseMaintenanceDeps['repair']>(
    async (target: DbRepairTarget, _scan: BadPageScanReport, _signal: AbortSignal) =>
      ({
        id: `record-${target.dbName}`,
        dbName: target.dbName,
        state: 'applied',
      }) as DbRepairRecord,
  );
  const reports = new DatabaseMaintenanceReports(join(root, 'reports'));
  const deep = vi.fn(
    async (_target: DbRepairTarget, _signal: AbortSignal): Promise<DbRepairCheckupIntegrity> => ({
      ran: true as const,
      healthy: false,
      corruptedTables: ['broken'],
    }),
  );
  const locate = vi.fn(
    async (_target: DbRepairTarget, _scan: BadPageScanReport): Promise<DatabasePageLocation> => ({
      affected: [],
    }),
  );
  const changed = vi.fn();
  const sourceIdentity = vi.fn((_target: DbRepairTarget) => 'original');
  const acquireMore = vi.fn(async (_targets: DbRepairTarget[], _signal: AbortSignal) => {});
  const acquire = vi.fn(async () => ({
    id: 'held-lock',
    release,
    acquireMore,
    signal: lease.signal,
  }));
  const maintenance = new DatabaseMaintenance({
    scanConcurrency,
    sourceIdentity,
    acquire,
    scan,
    locate,
    deep,
    repair,
    reports: () => reports,
    changed,
  });
  return {
    maintenance,
    acquire,
    acquireMore,
    sourceIdentity,
    targets,
    scan,
    locate,
    deep,
    repair,
    release,
    reports,
    lease,
    changed,
  };
}
const scope = { uin: '10001', configId: 'source-a' };

it('页扫描和结构检查各自限制并行数量，空出位置即开始下一库', async () => {
  const h = fixture(() => 2);
  const [first, second, third] = h.targets;
  const firstScan = Promise.withResolvers<void>();
  const holdPages = Promise.withResolvers<void>();
  const firstCheck = Promise.withResolvers<void>();
  const holdStructure = Promise.withResolvers<void>();
  const scan = h.scan.getMockImplementation()!;
  const deep = h.deep.getMockImplementation()!;
  h.scan.mockImplementation(async (...args) => {
    await (args[0] === first ? firstScan : holdPages).promise;
    return scan(...args);
  });
  h.deep.mockImplementation(async (...args) => {
    await (args[0].dbName === first!.dbName ? firstCheck : holdStructure).promise;
    return deep(...args);
  });
  const run = h.maintenance.scan(scope, h.targets, 'checkup');
  await vi.waitFor(() => expect(h.scan).toHaveBeenCalledTimes(2));
  firstScan.resolve();
  // 首库完成后第三库接替，第二库仍在运行。
  await vi.waitFor(() => expect(h.scan).toHaveBeenCalledTimes(3));
  expect(h.maintenance.current(scope)?.databases.map((row) => row.scanStatus)).toEqual([
    'completed',
    'running',
    'running',
  ]);
  expect(h.maintenance.current(scope)?.progress?.dbName).toBe(second!.dbName);
  expect(h.deep).not.toHaveBeenCalled();
  holdPages.resolve();
  await vi.waitFor(() => expect(h.deep).toHaveBeenCalledTimes(2));
  firstCheck.resolve();
  await vi.waitFor(() => expect(h.deep).toHaveBeenCalledTimes(3));
  expect(h.maintenance.current(scope)?.databases.map((row) => row.deepStatus)).toEqual([
    'completed',
    'running',
    'running',
  ]);
  expect(h.maintenance.current(scope)?.databases[2]?.progress?.dbName).toBe(third!.dbName);
  holdStructure.resolve();
  expect((await run).operation).toMatchObject({ status: 'completed', completedDatabases: 3 });
  await h.maintenance.end(scope);
});

it('暂停等待每个并行检查退出，续检按新上限和各库检查点恢复', async () => {
  let concurrency = 2;
  const h = fixture(() => concurrency);
  const firstExited = Promise.withResolvers<void>();
  const secondExited = Promise.withResolvers<void>();
  const scan = h.scan.getMockImplementation()!;
  for (const [index, exit] of [firstExited, secondExited].entries()) {
    h.scan.mockImplementationOnce(async (_target, signal, _progress, resume) => {
      resume!.onCheckpoint({
        firstPage: 1,
        nextPage: index + 3,
        badPages: [index + 2],
        zeroPages: [],
      });
      await exit.promise;
      signal.throwIfAborted();
      throw new Error('预期操作已经暂停');
    });
  }
  const run = h.maintenance.scan(scope, h.targets, 'scan');
  await vi.waitFor(() => expect(h.scan).toHaveBeenCalledTimes(2));
  const stopping = h.maintenance.stop(scope);
  expect(h.scan.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
  firstExited.resolve();
  await vi.waitFor(() =>
    expect(h.maintenance.current(scope)?.databases[0]?.scanStatus).toBe('pending'),
  );
  expect(h.maintenance.current(scope)?.operation).toMatchObject({
    status: 'running',
    stopping: true,
  });
  secondExited.resolve();
  await stopping;
  expect(await run).toMatchObject({ locked: true, operation: { status: 'cancelled' } });
  expect(h.scan).toHaveBeenCalledTimes(2);
  expect(h.release).not.toHaveBeenCalled();

  concurrency = 1;
  h.scan.mockClear();
  const resumeFirst = Promise.withResolvers<void>();
  h.scan.mockImplementationOnce(async (...args) => {
    await resumeFirst.promise;
    return { ...(await scan(...args)), pageCount: 6, badPages: [5] };
  });
  h.scan.mockImplementationOnce(async (...args) => ({
    ...(await scan(...args)),
    pageCount: 6,
    badPages: [6],
  }));
  const resumed = h.maintenance.scan(
    scope,
    [],
    'scan',
    h.targets.map(({ dbName }) => dbName),
  );
  await vi.waitFor(() => expect(h.scan).toHaveBeenCalledTimes(1));
  resumeFirst.resolve();
  const finished = await resumed;
  expect(h.scan.mock.calls.map(([, , , checkpoint]) => checkpoint?.firstPage)).toEqual([3, 4, 1]);
  expect(finished.databases.slice(0, 2).map((row) => row.scan?.badPages)).toEqual([
    [2, 5],
    [3, 6],
  ]);
  await h.maintenance.end(scope);
});

it('并行结构检查发现源库变化时，中止其余检查并在退出后解锁', async () => {
  const h = fixture(() => 2);
  const firstDb = h.targets[0]!.dbName;
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const deep = h.deep.getMockImplementation()!;
  h.deep.mockImplementation(async (...args) => {
    await (args[0].dbName === firstDb ? first : second).promise;
    args[1].throwIfAborted();
    return deep(...args);
  });
  const run = h.maintenance.scan(scope, h.targets, 'checkup');
  await vi.waitFor(() => expect(h.deep).toHaveBeenCalledTimes(2));
  h.sourceIdentity.mockImplementation(({ dbName }) =>
    dbName === firstDb ? 'changed' : 'original',
  );
  first.resolve();
  await vi.waitFor(() => expect(h.deep.mock.calls[1]?.[1].aborted).toBe(true));
  expect(h.release).not.toHaveBeenCalled();
  second.resolve();
  expect(await run).toMatchObject({
    locked: false,
    operation: { status: 'failed' },
    maintenanceError: '补充检查期间原库发生变化，请重新核对数据库。',
  });
  expect(h.deep).toHaveBeenCalledTimes(2);
  expect(h.release).toHaveBeenCalledOnce();
});

it('高频进度每秒只复制和推送最新完整快照，每两秒保存报告，停止立即发布且不残留回调', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const h = fixture();
  const save = vi.spyOn(h.reports, 'save');
  let emit!: (tick: DatabaseWorkProgress) => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const scan = h.scan.getMockImplementation()!;
  const zeroPages = Array.from({ length: 60_000 }, (_, index) => index + 10);
  h.scan.mockImplementationOnce(async (...args) => ({ ...(await scan(...args)), zeroPages }));
  h.scan.mockImplementationOnce(
    (_target, signal, progress) =>
      new Promise((_done, reject) => {
        emit = progress;
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const run = h.maintenance.scan(scope, h.targets, 'scan');
  await started;
  const id = h.maintenance.current(scope)!.operation!.id;
  await save.mock.results.at(-1)?.value;
  expect((await h.reports.get(id))?.databases[0]?.scanStatus).toBe('completed');
  save.mockClear();
  h.changed.mockClear();
  const clone = vi.spyOn(globalThis, 'structuredClone');
  const tick = (completed: number) => {
    emit({ step: 'pages', message: 'scan', completed, total: 10, unit: 'pages' });
  };
  for (let count = 0; count < 1000; count++) tick(count);
  expect(clone).not.toHaveBeenCalled();
  expect(h.changed).not.toHaveBeenCalled();
  expect(h.maintenance.current(scope)?.progress?.current.completed).toBe(999);
  await vi.advanceTimersByTimeAsync(999);
  expect(save).not.toHaveBeenCalled();
  expect(h.changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.changed).toHaveBeenCalledOnce();
  const published = h.changed.mock.calls[0]![0];
  expect(published.progress.current.completed).toBe(999);
  expect(published.databases[0].scan.zeroPageCount).toBe(zeroPages.length);
  expect(published.databases[0].scan).not.toHaveProperty('zeroPages');
  expect(JSON.stringify(published).length).toBeLessThan(16_384);
  expect(h.maintenance.status(scope)?.databases[0]).toMatchObject({
    scan: { zeroPageCount: zeroPages.length },
  });
  expect(h.maintenance.current(scope)?.databases[0]?.scan?.zeroPages).toEqual(zeroPages);
  expect(save).not.toHaveBeenCalled();
  tick(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(save).toHaveBeenCalledOnce();
  await save.mock.results[0]?.value;
  expect((await h.reports.get(id))?.databases[1]?.progress?.current.completed).toBe(3);
  expect(published.progress.current.completed).toBe(999);
  tick(4);
  expect(save).toHaveBeenCalledOnce();
  await h.maintenance.stop(scope);
  await run;
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ operation: expect.objectContaining({ stopping: true }) }),
  );
  expect((await h.reports.get(id))?.operation.status).toBe('cancelled');
  await h.maintenance.end(scope);
  expect(h.changed.mock.lastCall![0]).toMatchObject({ state: 'ended', locked: false });
  const publishedCount = h.changed.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.changed).toHaveBeenCalledTimes(publishedCount);
});

it('未提交的可恢复问题返回查看结果，锁与扫描保留，重试不重复处理已成功库', async () => {
  const h = fixture();
  expect(h.maintenance.leaseId(scope)).toBeUndefined();
  await h.maintenance.scan(scope, h.targets, 'scan');
  expect(h.maintenance.leaseId(scope)).toBe('held-lock');
  h.repair.mockImplementationOnce(
    async (target) =>
      ({ id: 'applied', dbName: target.dbName, state: 'applied' }) as DbRepairRecord,
  );
  const failure = new DbRepairError('insufficient-space', 'synthetic disk full');
  failure.sourceUnchanged = true;
  h.repair.mockRejectedValueOnce(failure);
  const result = await h.maintenance.repair(scope, ['msg.db', 'profile.db']);
  expect(result).toMatchObject({
    state: 'waiting',
    locked: true,
    operation: { status: 'waiting', completedDatabases: 1 },
  });
  expect(result.databases[1]?.repair?.status).toBe('waiting');
  expect(h.maintenance.leaseId(scope)).toBe('held-lock');
  expect(h.maintenance.leaseId({ ...scope, configId: 'another-source' })).toBeUndefined();
  expect(h.release).not.toHaveBeenCalled();
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('支持修复');
  const retried = await h.maintenance.repair(scope, ['profile.db']);
  expect(retried).toMatchObject({
    state: 'ended',
    operation: { status: 'completed', totalDatabases: 1, completedDatabases: 1 },
  });
  expect(retried.databases[0]?.repair?.record?.id).toBe('applied');
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.repair.mock.calls.map(([target]) => target.dbName)).toEqual([
    'msg.db',
    'profile.db',
    'profile.db',
  ]);
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.maintenance.leaseId(scope)).toBeUndefined();
});

it('报告写满磁盘不打断维护，空间恢复后补存原报告', async () => {
  const h = fixture();
  const save = vi.spyOn(h.reports, 'save').mockImplementation(() => {
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  });
  const result = await h.maintenance.scan(scope, h.targets, 'scan');
  expect(result).toMatchObject({
    state: 'waiting',
    locked: true,
    operation: { status: 'completed' },
    reportError: expect.stringContaining('ENOSPC'),
  });
  expect((await h.maintenance.reports(scope))[0]?.operation.id).toBe(result.operation!.id);
  expect(h.release).not.toHaveBeenCalled();
  save.mockRestore();
  await h.maintenance.reports(scope);
  await vi.waitFor(async () => {
    expect((await h.reports.get(result.operation!.id))?.operation.status).toBe('completed');
    expect(h.maintenance.current(scope)?.reportError).toBeUndefined();
  });
  await h.maintenance.end(scope);
});

it('报告写入挂起时仍广播进度，完成后磁盘保留最终报告', async () => {
  const h = fixture();
  const persist = h.reports.save.bind(h.reports);
  let release!: () => void;
  const writing = new Promise<void>((done) => {
    release = done;
  });
  const save = vi.spyOn(h.reports, 'save').mockImplementationOnce(async (report) => {
    await writing;
    await persist(report);
  });
  const run = h.maintenance.scan(scope, h.targets, 'scan');
  try {
    await vi.waitFor(() =>
      expect(h.maintenance.status(scope)?.operation?.status).toBe('completed'),
    );
    expect(h.changed.mock.lastCall?.[0].operation.status).toBe('completed');
    expect(save).toHaveBeenCalledOnce();
    const id = h.maintenance.status(scope)!.operation!.id;
    expect(await h.reports.get(id)).toBeNull();
    expect((await h.maintenance.report(scope, id))?.operation.status).toBe('completed');
    release();
    await run;
    expect(save).toHaveBeenCalledTimes(2);
    expect((await h.reports.get(id))?.operation.status).toBe('completed');
  } finally {
    release();
    await run;
    await h.maintenance.end(scope);
  }
});

it('结束维护和启动修复不能交错，重复结束等待同一次统一解锁', async () => {
  const h = fixture();
  await h.maintenance.scan(scope, h.targets, 'scan');
  let release!: () => void;
  h.release.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const ending = h.maintenance.end(scope);
  for (let count = 0; count < 10 && !release; count++) await Promise.resolve();
  expect(h.maintenance.current(scope)?.state).toBe('ending');
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('结束');
  expect(() => h.maintenance.scan(scope, h.targets, 'scan')).toThrow('结束');
  const again = h.maintenance.end(scope);
  expect(h.release).toHaveBeenCalledOnce();
  release();
  await Promise.all([ending, again]);
  expect(h.maintenance.current(scope)).toMatchObject({ state: 'ended', locked: false });
});

it.each([false, true])('替换确认期间保留维护锁，确认撤销只作用于当前库（%s）', async (confirm) => {
  const h = fixture();
  await h.maintenance.scan(scope, h.targets, 'scan');
  const firstRepair = h.repair.getMockImplementation()!;
  const entered = Promise.withResolvers<void>();
  const finishVerification = Promise.withResolvers<void>();
  const awaitingDecision = Promise.withResolvers<void>();
  h.repair.mockImplementationOnce(firstRepair);
  h.repair.mockImplementationOnce(async (...args) => {
    const { replacement } = args[4];
    await replacement.begin();
    entered.resolve();
    await finishVerification.promise;
    awaitingDecision.resolve();
    await replacement.waitForDecision();
    replacement.signal.throwIfAborted();
    return firstRepair(...args);
  });
  const run = h.maintenance.repair(scope, ['msg.db', 'profile.db']);
  await entered.promise;
  const sessionId = h.maintenance.current(scope)!.id;
  const decision = h.maintenance.prepareEnd(scope, sessionId)!;
  expect(decision.preview.replacing).toBe('profile.db');
  finishVerification.resolve();
  await awaitingDecision.promise;
  expect(h.release).not.toHaveBeenCalled();
  if (confirm) await h.maintenance.end(scope, decision.preview.id);
  else decision.dismiss();
  const result = await run;
  expect(h.maintenance.current(scope)?.locked).toBe(false);
  expect(h.release).toHaveBeenCalledOnce();
  expect(result.databases.map((row) => row.repair?.status)).toEqual([
    'completed',
    confirm ? 'cancelled' : 'completed',
    undefined,
  ]);
});

it('替换开始前发起结束维护，可在确认后阻止当前库进入替换', async () => {
  const h = fixture();
  await h.maintenance.scan(scope, h.targets, 'scan');
  const rebuilding = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const tryingToReplace = Promise.withResolvers<void>();
  const replace = vi.fn();
  h.repair.mockImplementationOnce(async (_target, _scan, _signal, _progress, { replacement }) => {
    rebuilding.resolve();
    await ready.promise;
    tryingToReplace.resolve();
    await replacement.begin();
    replace();
    return { state: 'applied' } as DbRepairRecord;
  });
  const run = h.maintenance.repair(scope, ['msg.db']);
  await rebuilding.promise;
  const decision = h.maintenance.prepareEnd(scope, h.maintenance.current(scope)!.id)!;
  expect(decision.preview.replacing).toBeUndefined();
  ready.resolve();
  await tryingToReplace.promise;
  expect(replace).not.toHaveBeenCalled();
  await h.maintenance.end(scope, decision.preview.id);
  expect(replace).not.toHaveBeenCalled();
  expect((await run).operation?.status).toBe('cancelled');
  expect(h.release).toHaveBeenCalledOnce();
});

it('撤销失败时解锁请求失败，重试恢复通过后才释放维护锁', async () => {
  const h = fixture();
  await h.maintenance.scan(scope, h.targets, 'scan');
  const replacing = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const retry = vi.fn(async () => {});
  const failure = new DbRepairRollbackError('无法恢复原库', retry);
  h.repair.mockImplementationOnce(async (_target, _scan, _signal, _progress, { replacement }) => {
    await replacement.begin();
    replacing.resolve();
    await ready.promise;
    await replacement.waitForDecision();
    if (replacement.signal.aborted) throw failure;
    return { state: 'applied' } as DbRepairRecord;
  });
  const run = h.maintenance.repair(scope, ['msg.db']);
  await replacing.promise;
  const sessionId = h.maintenance.current(scope)!.id;
  const decision = h.maintenance.prepareEnd(scope, sessionId)!;
  const ending = h.maintenance.end(scope, decision.preview.id);
  ready.resolve();
  await expect(ending).rejects.toBe(failure);
  await run;
  expect(h.release).not.toHaveBeenCalled();
  expect(h.maintenance.current(scope)).toMatchObject({ state: 'waiting', locked: true });
  const recover = h.maintenance.prepareEnd(scope, sessionId)!;
  expect(recover.preview.restoring).toBe('msg.db');
  await h.maintenance.end(scope, recover.preview.id);
  expect(retry).toHaveBeenCalledOnce();
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.maintenance.current(scope)).toMatchObject({ state: 'ended', locked: false });
});

it('未核验的 QQ 专用表标为深度部分完成，不冒称全部正常，常规扫描仍能用于修复', async () => {
  const h = fixture();
  h.deep.mockResolvedValue({
    ran: true,
    healthy: true,
    corruptedTables: [],
    complete: false,
    unverifiedTables: ['qq_fts'],
  });
  const result = await h.maintenance.scan(scope, h.targets, 'checkup');
  expect(result.operation?.status).toBe('partial');
  expect(result.databases[0]).toMatchObject({
    scanStatus: 'completed',
    deepStatus: 'partial',
    integrity: { complete: false, unverifiedTables: ['qq_fts'] },
  });
  expect(h.release).not.toHaveBeenCalled();
  await h.maintenance.repair(scope, ['msg.db']);
  expect(h.repair).toHaveBeenCalledOnce();
});

it('持锁进程意外退出会结束维护，旧报告保留，旧结果不能再用于修复', async () => {
  const h = fixture();
  await h.maintenance.scan(scope, h.targets, 'scan');
  h.lease.abort(new Error('synthetic lock process exited'));
  expect(() => h.maintenance.scan(scope, h.targets, 'checkup')).toThrow('持续维护锁已中断');
  for (let count = 0; count < 10; count++) await Promise.resolve();
  expect(h.maintenance.current(scope)).toMatchObject({
    state: 'ended',
    locked: false,
    maintenanceError: expect.any(String),
  });
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('体检');
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.deep).not.toHaveBeenCalled();
  expect(await h.reports.list()).toHaveLength(1);
});

it('历史报告三种格式使用同一份完整结果，HTML 转义来源文本', async () => {
  const h = fixture();
  h.targets[0]!.dbName = '<script>.db';
  const result = await h.maintenance.scan(scope, h.targets, 'scan');
  const report = (await h.reports.get(result.operation!.id))!;
  expect(JSON.parse(renderDatabaseMaintenanceReport(report, 'json'))).toEqual(report);
  expect(renderDatabaseMaintenanceReport(report, 'md')).toContain('WeQ 不支持修复');
  const html = renderDatabaseMaintenanceReport(report, 'html');
  expect(html).toContain('&lt;script&gt;.db');
  expect(html).not.toContain('<script>');
  await h.maintenance.end(scope);
  expect(await h.reports.get(result.operation!.id)).toEqual(report);
});

it('HTML／Markdown 直接导出已有修复指标、耗时和自检结果，不额外读取数据库', async () => {
  const h = fixture();
  const record: DbRepairRecord = {
    id: 'repair-detail',
    at: '2026-11-18T00:00:00+08:00',
    uin: scope.uin,
    dataDir: null,
    dbName: 'msg.db',
    dbPath: h.targets[0]!.dbPath,
    state: 'applied',
    backupPath: null,
    backupBytes: null,
    beforeSha: 'before',
    beforeBytes: 12345,
    afterSha: 'after',
    afterBytes: 9876,
    badPages: [7, 11],
    zeroPages: [13],
    pageSize: 4096,
    headerOffset: 1024,
    strictPages: false,
    sourcePages: 20,
    outputPages: 18,
    scannedCells: 31,
    phases: [
      { phase: 'Decrypt', ms: 1234 },
      { phase: 'Repair', ms: 4321 },
    ],
    verification: {
      healthy: true,
      complete: false,
      unverifiedTables: ['qq_fts<script>'],
      corruptedTables: [],
      badPages: [],
      tables: 17,
      indexes: 23,
      ms: 456,
    },
    pendingWalBytes: 0,
    walMerged: false,
    durationMs: 12345,
    reportPath: null,
  };
  h.repair.mockResolvedValueOnce(record);
  await h.maintenance.scan(scope, h.targets, 'scan');
  const result = await h.maintenance.repair(scope, ['msg.db']);
  const report = (await h.reports.get(result.operation!.id))!;
  expect(JSON.parse(renderDatabaseMaintenanceReport(report, 'json'))).toEqual(report);
  for (const format of ['md', 'html'] as const) {
    const output = renderDatabaseMaintenanceReport(report, format);
    for (const value of [
      '12345 字节',
      '9876 字节',
      '7、11',
      '13',
      '1.234 秒',
      '4.321 秒',
      '12.345 秒',
      '17 / 23',
      '未核验项',
    ])
      expect(output).toContain(value);
  }
  const html = renderDatabaseMaintenanceReport(report, 'html');
  expect(html).toContain('qq_fts&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.deep).not.toHaveBeenCalled();
  expect(h.repair).toHaveBeenCalledOnce();
  report.databases[0]!.repair!.record = { ...record, afterBytes: null, verification: null };
  const unknown = renderDatabaseMaintenanceReport(report, 'md');
  expect(unknown).toContain('12345 字节 → 未知');
  expect(unknown).toContain('没有自检结果');
});

it('打开状态不扫描；全账号先锁定，扫描结果在等待和继续深度体检时保留', async () => {
  const h = fixture();
  expect(h.maintenance.current(scope)).toBeNull();
  expect(h.scan).not.toHaveBeenCalled();
  const quick = await h.maintenance.scan(scope, h.targets, 'scan');
  expect(quick).toMatchObject({ state: 'waiting', locked: true });
  expect(h.release).not.toHaveBeenCalled();
  expect(h.scan).toHaveBeenCalledTimes(3);
  const deep = await h.maintenance.scan(scope, h.targets, 'checkup');
  expect(deep).toMatchObject({ id: quick.id, state: 'waiting', locked: true });
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.deep).toHaveBeenCalledTimes(3);
  expect(h.release).not.toHaveBeenCalled();
  expect(await h.reports.list()).toHaveLength(2);
  expect((await h.reports.get(quick.operation!.id))?.databases[0]?.integrity).toBeUndefined();
  await h.maintenance.end(scope);
  expect(h.release).toHaveBeenCalledOnce();
  expect(await h.reports.list()).toHaveLength(2);
});

it('不能独立修复或选中未完整扫描及不支持的库；单库失败不中断批次，结束后统一解锁', async () => {
  const h = fixture();
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('体检');
  h.scan.mockImplementationOnce(async () => {
    throw new Error('synthetic scan failed');
  });
  await h.maintenance.scan(scope, h.targets, 'scan');
  expect(h.maintenance.current(scope)?.operation?.status).toBe('partial');
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('完整的页检查结果');
  expect(() => h.maintenance.repair(scope, ['unsupported.db'])).toThrow('支持修复');
  await h.maintenance.scan(scope, h.targets, 'scan');
  h.repair.mockRejectedValueOnce(new Error('synthetic rebuild failed'));
  const result = await h.maintenance.repair(scope, ['msg.db', 'profile.db']);
  expect(h.repair.mock.calls.map(([target]) => target.dbName)).toEqual(['msg.db', 'profile.db']);
  expect(result).toMatchObject({ state: 'ended', locked: false, operation: { status: 'partial' } });
  expect(result.databases[0]?.repair?.status).toBe('failed');
  expect(result.databases[1]?.repair?.status).toBe('completed');
  expect(h.release).toHaveBeenCalledOnce();
});

it('停止扫描保留锁和就绪结果；停止额外检查不撤销常规扫描结果', async () => {
  const h = fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.scan.mockImplementationOnce(async (target) => {
    return {
      ...(await fixture().scan(target, new AbortController().signal, () => {})),
      plaintext: false,
    };
  });
  h.scan.mockImplementationOnce(
    (_target, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const run = h.maintenance.scan(scope, h.targets, 'scan');
  await started;
  await h.maintenance.stop(scope);
  await run;
  expect(h.maintenance.current(scope)?.databases[0]?.scanStatus).toBe('completed');
  expect(h.release).not.toHaveBeenCalled();
  await h.maintenance.end(scope);
});

it('停止修复中断临时重建、不启动后续库，保留已经成功的记录和正式报告', async () => {
  const h = fixture();
  const scan = h.scan.getMockImplementation()!;
  h.scan.mockImplementation(async (...args) => ({ ...(await scan(...args)), plaintext: false }));
  const checkup = await h.maintenance.scan(scope, h.targets, 'scan');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.repair.mockImplementationOnce(
    async (target) =>
      ({ id: 'already-applied', dbName: target.dbName, state: 'applied' }) as DbRepairRecord,
  );
  h.repair.mockImplementationOnce(
    (_target, _scan, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const run = h.maintenance.repair(scope, ['msg.db', 'profile.db', 'unsupported.db']);
  await started;
  expect(await h.maintenance.stop(scope, checkup.operation!.id)).toBeNull();
  expect(h.maintenance.current(scope)?.operation?.stopping).toBeFalsy();
  await h.maintenance.stop(scope, h.maintenance.current(scope)!.operation!.id);
  const result = await run;
  expect(h.repair).toHaveBeenCalledTimes(2);
  expect(result.operation?.status).toBe('cancelled');
  expect(result.databases[0]?.repair).toMatchObject({
    status: 'completed',
    record: { id: 'already-applied' },
  });
  expect(result.databases[2]?.repair?.status).toBe('cancelled');
  expect(h.release).toHaveBeenCalledOnce();
  expect((await h.reports.get(result.operation!.id))?.operation.status).toBe('cancelled');
});

it('停止额外的深度体检不撤销已完成的常规扫描，可直接修复就绪库', async () => {
  const h = fixture();
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  h.deep.mockImplementationOnce(
    (_target, signal) =>
      new Promise((_done, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const pending = h.maintenance.scan(scope, h.targets, 'checkup');
  await started;
  await h.maintenance.stop(scope);
  await pending;
  expect(h.maintenance.current(scope)).toMatchObject({ locked: true, state: 'waiting' });
  expect(
    h.maintenance.current(scope)?.databases.every((row) => row.scanStatus === 'completed'),
  ).toBe(true);
  expect(h.scan).toHaveBeenCalledTimes(3);
  await h.maintenance.repair(scope, ['msg.db']);
  expect(h.repair).toHaveBeenCalledOnce();
  expect(h.release).toHaveBeenCalledOnce();
});

it('深度检查暂停后可切到快速再继续深度，已完成的结构检查和页扫描不重复', async () => {
  const h = fixture();
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  h.deep.mockImplementationOnce(async () => ({ ran: true, healthy: true, corruptedTables: [] }));
  h.deep.mockImplementationOnce(
    (_target, signal) =>
      new Promise((_done, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const run = h.maintenance.scan(scope, h.targets, 'checkup');
  await started;
  expect(() => h.maintenance.scan(scope, h.targets, 'scan')).toThrow('正在执行');
  await h.maintenance.stop(scope);
  await run;
  expect(h.maintenance.current(scope)?.databases[0]?.deepStatus).toBe('completed');
  await h.maintenance.scan(scope, h.targets, 'scan');
  await h.maintenance.scan(scope, h.targets, 'checkup');
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.deep.mock.calls.map(([target]) => target.dbName)).toEqual([
    'msg.db',
    'profile.db',
    'profile.db',
    'unsupported.db',
  ]);
  expect(h.release).not.toHaveBeenCalled();
  await h.maintenance.end(scope);
});

it('删除报告拒绝执行中的报告，结束后只删指定报告且不会被解锁或下一轮恢复', async () => {
  const h = fixture();
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  h.scan.mockImplementationOnce(h.scan.getMockImplementation()!);
  h.scan.mockImplementationOnce(
    (_target, signal) =>
      new Promise((_done, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const run = h.maintenance.scan(scope, h.targets, 'scan');
  await started;
  const id = h.maintenance.current(scope)!.operation!.id;
  await expect(h.maintenance.deleteReport(scope, id)).rejects.toThrow('仍在更新');
  await h.maintenance.stop(scope);
  await run;
  expect(await h.maintenance.deleteReport(scope, id)).toBe(true);
  expect(h.maintenance.current(scope)?.locked).toBe(true);
  expect(await h.reports.get(id)).toBeNull();
  await expect(h.reports.remove('../outside')).rejects.toThrow('标识无效');
  await h.maintenance.scan(scope, h.targets, 'scan');
  await h.maintenance.end(scope);
  expect(await h.reports.get(id)).toBeNull();
  expect(await h.reports.list()).toHaveLength(1);
});

it('首库页检查未完成就暂停时保留锁，续检复用同一维护会话', async () => {
  const h = fixture();
  const target = h.targets[0]!;
  const started = Promise.withResolvers<void>();
  h.scan.mockImplementationOnce(
    (_target, signal) =>
      new Promise((_done, reject) => {
        started.resolve();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const run = h.maintenance.scan(scope, [target], 'scan');
  await started.promise;
  await h.maintenance.stop(scope);
  const paused = await run;
  expect(paused).toMatchObject({
    state: 'waiting',
    locked: true,
    operation: { status: 'cancelled', completedDatabases: 0 },
  });
  expect(h.release).not.toHaveBeenCalled();
  expect(await h.maintenance.reports(scope)).toEqual([]);
  expect(() => h.maintenance.repair(scope, [target.dbName])).toThrow('完整的页检查结果');

  const resumed = await h.maintenance.scan(scope, [], 'scan', [target.dbName]);
  expect(resumed).toMatchObject({
    id: paused.id,
    locked: true,
    operation: { status: 'completed', completedDatabases: 1 },
  });
  expect(h.acquire).toHaveBeenCalledOnce();
  expect(h.scan).toHaveBeenCalledTimes(2);
  await h.maintenance.end(scope);
  expect(h.release).toHaveBeenCalledOnce();
});

it.each([false, true])('页检查从保存的位置续作，原库变化时拒绝复用（%s）', async (changed) => {
  const h = fixture();
  const target = h.targets[0]!;
  const saved = Promise.withResolvers<void>();
  const scan = h.scan.getMockImplementation()!;
  h.scan.mockImplementationOnce(async (_target, signal, _progress, resume) => {
    expect(resume?.firstPage).toBe(1);
    resume?.onCheckpoint({ firstPage: 1, nextPage: 4, badPages: [2], zeroPages: [3] });
    // 缺了页 4 的完整批次时，较晚的批次不能推进已连续扫过的位置。
    resume?.onCheckpoint({ firstPage: 5, nextPage: 6, badPages: [5], zeroPages: [] });
    saved.resolve();
    return new Promise((_done, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const run = h.maintenance.scan(scope, [target], 'scan');
  await saved.promise;
  await h.maintenance.stop(scope);
  const paused = await run;
  expect(paused.databases[0]?.scan).toBeUndefined();
  expect(await h.maintenance.reports(scope)).toEqual([]);

  if (changed) h.sourceIdentity.mockReturnValue('different');
  h.scan.mockImplementationOnce(async (...args) => {
    const [, , progress, resume] = args;
    expect(resume?.firstPage).toBe(4);
    resume?.onCheckpoint({ firstPage: 4, nextPage: 6, badPages: [5], zeroPages: [4] });
    progress({
      step: 'pages',
      message: '检查完成',
      completed: 5,
      total: 5,
      badPages: 1,
      zeroPages: 1,
    });
    return { ...(await scan(...args)), pageCount: 5, badPages: [5], zeroPages: [4] };
  });
  const resumed = await h.maintenance.scan(scope, [], 'scan', [target.dbName]);
  if (changed) {
    expect(h.scan).toHaveBeenCalledOnce();
    expect(resumed).toMatchObject({
      state: 'ended',
      locked: false,
      maintenanceError: '暂停期间原库发生变化，请重新开始体检。',
    });
    expect(resumed.databases[0]?.scan).toBeUndefined();
    return;
  }
  expect(resumed).toMatchObject({
    id: paused.id,
    locked: true,
    operation: { status: 'completed' },
  });
  expect(resumed.databases[0]?.scan).toMatchObject({
    pageCount: 5,
    badPages: [2, 5],
    zeroPages: [3, 4],
  });
  expect(resumed.databases[0]?.scanProgress?.current).toMatchObject({
    completed: 5,
    badPages: 2,
    zeroPages: 2,
  });
  expect(h.acquire).toHaveBeenCalledOnce();
});

it('补充检查保留初始范围，复用页扫描，快速失败后只为尚未修复的库启动深度修复', async () => {
  const h = fixture();
  const base = h.scan.getMockImplementation()!;
  h.scan.mockImplementation((...args) =>
    base(...args).then((value) => ({ ...value, affected: [] })),
  );
  h.locate.mockResolvedValue({
    affected: [{ name: '空闲叶页', pagetype: 'freelist-leaf', badPageCount: 1, samplePages: [2] }],
    quickBudgetBytes: 32 * 1024 * 1024,
  });
  const initial = await h.maintenance.scan(scope, h.targets.slice(0, 2), 'scan');
  expect(initial.databases.map((row) => row.dbName)).toEqual(['msg.db', 'profile.db']);
  await h.maintenance.scan(scope, h.targets, 'checkup');
  expect(h.scan).toHaveBeenCalledTimes(2);
  expect(h.locate).toHaveBeenCalledTimes(2);
  h.repair.mockImplementationOnce(async () => ({ id: 'done' }) as DbRepairRecord);
  const failure = new DbRepairError('verify-failed', '复核失败');
  failure.sourceUnchanged = true;
  h.repair.mockRejectedValueOnce(failure);
  const waiting = await h.maintenance.repair(scope, ['msg.db', 'profile.db']);
  expect(waiting).toMatchObject({ id: initial.id, locked: true });
  expect(waiting.databases[0]?.repair).toMatchObject({ status: 'completed', method: 'quick' });
  expect(h.locate).toHaveBeenCalledTimes(2);
  expect(waiting.databases[1]?.repair).toMatchObject({
    status: 'waiting',
    method: 'quick',
    nextAction: 'view-deep',
  });
  expect(() =>
    h.maintenance.repair(scope, ['profile.db'], { methods: { 'profile.db': 'quick' } }),
  ).toThrow('快速修复方案');
  const done = await h.maintenance.repair(scope, ['profile.db'], {
    methods: { 'profile.db': 'deep' },
  });
  expect(done.databases[1]?.repair).toMatchObject({ status: 'completed', method: 'deep' });
  expect(h.repair.mock.calls.map(([target]) => target.dbName)).toEqual([
    'msg.db',
    'profile.db',
    'profile.db',
  ]);
  expect(h.release).toHaveBeenCalledOnce();
});

it('追加扫描为新库取锁，失败可重试，本轮已完成的库不用重扫', async () => {
  const h = fixture();
  const first = h.targets[0]!;
  const second = h.targets[1]!;
  const initial = await h.maintenance.scan(scope, [first], 'scan');
  h.acquireMore.mockRejectedValueOnce(new Error('新库无法加锁'));
  const failed = await h.maintenance.scan(scope, [second], 'scan', [second.dbName]);
  expect(failed).toMatchObject({
    id: initial.id,
    locked: true,
    operation: { status: 'failed', error: '新库无法加锁' },
  });
  expect(failed.databases).toEqual(initial.databases);
  expect(h.release).not.toHaveBeenCalled();
  const finished = await h.maintenance.scan(scope, [second], 'scan', [second.dbName]);
  expect(finished).toMatchObject({
    id: initial.id,
    locked: true,
    operation: { status: 'completed', totalDatabases: 1, databaseNames: [second.dbName] },
  });
  expect(h.acquireMore.mock.calls.map(([targets]) => targets)).toEqual([[second], [second]]);
  expect(h.scan.mock.calls.map(([target]) => target.dbName)).toEqual([first.dbName, second.dbName]);
  expect(finished.databases[0]).toEqual(initial.databases[0]);
  const saved = await h.maintenance.report(scope, initial.operation!.id);
  expect(saved?.databases.map((row) => row.scan)).toEqual(initial.databases.map((row) => row.scan));
  const checked = await h.maintenance.scan(scope, [], 'checkup', [first.dbName]);
  expect(checked.operation).toMatchObject({ status: 'completed', databaseNames: [first.dbName] });
  expect(h.deep.mock.calls.map(([target]) => target.dbName)).toEqual([first.dbName]);
  expect(h.scan).toHaveBeenCalledTimes(2);
  expect(checked.databases[1]?.deepStatus).toBeUndefined();
  await h.maintenance.end(scope);
  expect(h.release).toHaveBeenCalledOnce();
});

it('深度体检正在检查结构时可以追加库，锁与报告沿用同一轮', async () => {
  const h = fixture();
  const first = h.targets[0]!;
  const added = h.targets[1]!;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const deep = h.deep.getMockImplementation()!;
  h.deep.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return deep(...args);
  });
  const run = h.maintenance.scan(scope, [first], 'checkup');
  await entered.promise;
  const operationId = h.maintenance.current(scope)!.operation!.id;
  h.maintenance.appendScan(scope, operationId, [added], [added.dbName]);
  h.maintenance.appendScan(scope, operationId, [added], [added.dbName]);
  expect(h.acquireMore).not.toHaveBeenCalled();
  expect(h.maintenance.current(scope)?.operation?.totalDatabases).toBe(2);
  expect(() => h.maintenance.scan({ ...scope, configId: 'other' }, [added], 'scan')).toThrow(
    '此账号的数据源已经在维护中',
  );

  resume.resolve();
  const finished = await run;
  expect(h.acquireMore.mock.calls).toEqual([[[added], expect.any(AbortSignal)]]);
  expect(h.deep.mock.calls.map(([target]) => target.dbName)).toEqual([first.dbName, added.dbName]);
  expect(finished.operation).toMatchObject({
    id: operationId,
    status: 'completed',
    completedDatabases: 2,
  });
  expect((await h.maintenance.report(scope, operationId))?.databases).toHaveLength(2);
});

it('快速体检可给已选库排队深度体检，完成后复用页检查与维护锁', async () => {
  const h = fixture();
  const [first, current, last] = h.targets;
  const entered = Promise.withResolvers<void>();
  const finishQuick = Promise.withResolvers<void>();
  const scan = h.scan.getMockImplementation()!;
  h.scan.mockImplementationOnce(scan).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await finishQuick.promise;
    return scan(...args);
  });
  const run = h.maintenance.scan(scope, h.targets, 'scan');
  await entered.promise;
  const operationId = h.maintenance.current(scope)!.operation!.id;
  h.maintenance.appendScan(scope, operationId, [], [first!.dbName], 'checkup');
  h.maintenance.appendScan(scope, operationId, [], [first!.dbName], 'checkup');
  expect(h.maintenance.current(scope)?.operation).toMatchObject({
    status: 'running',
    totalDatabases: 3,
    databaseScanKinds: { [first!.dbName]: 'checkup' },
  });
  expect(h.deep).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();

  finishQuick.resolve();
  const finished = await run;
  expect(h.acquireMore).not.toHaveBeenCalled();
  expect(h.scan.mock.calls.map(([target]) => target.dbName)).toEqual([
    first!.dbName,
    current!.dbName,
    last!.dbName,
  ]);
  expect(h.deep.mock.calls.map(([target]) => target.dbName)).toEqual([first!.dbName]);
  expect(finished.operation).toMatchObject({
    id: operationId,
    status: 'completed',
    completedDatabases: 3,
    totalDatabases: 3,
  });
  expect((await h.maintenance.report(scope, operationId))?.databases[0]).toMatchObject({
    scanStatus: 'completed',
    deepStatus: 'completed',
  });
});

it('深度体检可追加快速体检，后续只检查该库的页签名', async () => {
  const h = fixture();
  const first = h.targets[0]!;
  const added = h.targets[1]!;
  const entered = Promise.withResolvers<void>();
  const finishDeep = Promise.withResolvers<void>();
  const deep = h.deep.getMockImplementation()!;
  h.deep.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await finishDeep.promise;
    return deep(...args);
  });
  const run = h.maintenance.scan(scope, [first], 'checkup');
  await entered.promise;
  const operationId = h.maintenance.current(scope)!.operation!.id;
  h.maintenance.appendScan(scope, operationId, [added], [added.dbName], 'scan');
  expect(h.acquireMore).not.toHaveBeenCalled();

  finishDeep.resolve();
  const finished = await run;
  expect(h.acquireMore).toHaveBeenCalledOnce();
  expect(h.deep.mock.calls.map(([target]) => target.dbName)).toEqual([first.dbName]);
  expect(finished.operation).toMatchObject({
    id: operationId,
    status: 'completed',
    completedDatabases: 2,
    databaseScanKinds: { [added.dbName]: 'scan' },
  });
  expect(finished.databases[1]?.scanStatus).toBe('completed');
  expect(finished.databases[1]?.deepStatus).toBeUndefined();
});

it('暂停时保留已排队的库和深度检查，续检时才为尚未开始的库取锁', async () => {
  const h = fixture();
  const first = h.targets[0]!;
  const current = h.targets[1]!;
  const added = h.targets[2]!;
  const entered = Promise.withResolvers<void>();
  const scan = h.scan.getMockImplementation()!;
  h.scan.mockImplementationOnce(scan).mockImplementationOnce(async (_target, signal) => {
    entered.resolve();
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const run = h.maintenance.scan(scope, [first, current], 'scan');
  await entered.promise;
  const operationId = h.maintenance.current(scope)!.operation!.id;
  h.maintenance.appendScan(scope, operationId, [added], [added.dbName]);
  h.maintenance.appendScan(scope, operationId, [], [first.dbName], 'checkup');
  await h.maintenance.stop(scope);
  const paused = await run;
  expect(paused.operation).toMatchObject({
    status: 'cancelled',
    databaseNames: [first.dbName, current.dbName, added.dbName],
    databaseScanKinds: { [first.dbName]: 'checkup' },
  });
  expect(paused.locked).toBe(true);
  expect(h.acquireMore).not.toHaveBeenCalled();
  expect(() => h.maintenance.appendScan(scope, operationId, [added], [added.dbName])).toThrow(
    '本次体检已停止或完成',
  );
  await h.maintenance.scan(scope, [added], 'scan', [first.dbName, current.dbName, added.dbName]);
  expect(h.acquireMore.mock.calls).toEqual([[[added], expect.any(AbortSignal)]]);
  expect(h.scan.mock.calls.map(([target]) => target.dbName)).toEqual([
    first.dbName,
    current.dbName,
    current.dbName,
    added.dbName,
  ]);
  expect(h.deep.mock.calls.map(([target]) => target.dbName)).toEqual([first.dbName]);
});

it('结束已暂停的维护后重新开始快速体检，不继承前一轮排队的深度体检', async () => {
  const h = fixture();
  const first = h.targets[0]!;
  const selected = h.targets[1]!;
  const entered = Promise.withResolvers<void>();
  const scan = h.scan.getMockImplementation()!;
  h.scan.mockImplementationOnce(scan).mockImplementationOnce(async (_target, signal) => {
    entered.resolve();
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const run = h.maintenance.scan(scope, [first, selected], 'scan');
  await entered.promise;
  const operationId = h.maintenance.current(scope)!.operation!.id;
  h.maintenance.appendScan(scope, operationId, [], [selected.dbName], 'checkup');
  await h.maintenance.stop(scope);
  const paused = await run;
  expect(paused.operation?.databaseScanKinds).toEqual({ [selected.dbName]: 'checkup' });
  await h.maintenance.end(scope);

  const restarted = await h.maintenance.scan(scope, [selected], 'scan');
  expect(restarted.id).not.toBe(paused.id);
  expect(restarted.operation).toMatchObject({ kind: 'scan', status: 'completed' });
  expect(restarted.operation?.databaseScanKinds).toBeUndefined();
  expect(restarted.databases.map(({ dbName }) => dbName)).toEqual([selected.dbName]);
  expect(restarted.databases[0]?.scanStatus).toBe('completed');
  expect(h.deep).not.toHaveBeenCalled();
});

it('有效页扫描发现尚未定位的坏页时，仍可直接选择深度修复', async () => {
  const h = fixture();
  const base = h.scan.getMockImplementation()!;
  h.scan.mockImplementation((...args) =>
    base(...args).then((value) => ({ ...value, affected: [] })),
  );
  await h.maintenance.scan(scope, h.targets.slice(0, 1), 'scan');
  const repaired = await h.maintenance.repair(scope, ['msg.db'], {
    methods: { 'msg.db': 'deep' },
  });
  expect(h.locate).not.toHaveBeenCalled();
  expect(h.deep).not.toHaveBeenCalled();
  expect(repaired.databases[0]?.repair).toMatchObject({ method: 'deep', status: 'completed' });
});

it.each(['eligible', 'unverified', 'source-changed'] as const)(
  '快速修复先用现有页号核验条件（%s）',
  async (outcome) => {
    const h = fixture();
    const base = h.scan.getMockImplementation()!;
    h.scan.mockImplementation((...args) =>
      base(...args).then((value) => ({ ...value, affected: [] })),
    );
    const initial = await h.maintenance.scan(scope, h.targets.slice(0, 1), 'scan');
    expect(h.locate).not.toHaveBeenCalled();
    const singleByteCorrection = { page: 2, offset: 99, originalByte: 11, replacementByte: 36 };
    h.locate.mockImplementationOnce(async () => {
      expect(h.repair).not.toHaveBeenCalled();
      if (outcome === 'source-changed') h.sourceIdentity.mockReturnValue('changed');
      return {
        affected: [
          { name: '空闲叶页', pagetype: 'freelist-leaf', badPageCount: 1, samplePages: [2] },
        ],
        quickBudgetBytes: outcome === 'unverified' ? undefined : 32 * 1024 * 1024,
        singleByteCorrection: outcome === 'eligible' ? singleByteCorrection : undefined,
      };
    });
    const result = await h.maintenance.repair(scope, ['msg.db'], {
      methods: { 'msg.db': 'quick' },
    });
    expect(h.scan).toHaveBeenCalledOnce();
    expect(h.deep).not.toHaveBeenCalled();
    expect(h.locate).toHaveBeenCalledOnce();
    expect(h.locate).toHaveBeenCalledWith(
      h.targets[0],
      expect.objectContaining({ badPages: [2], dbPath: h.targets[0]!.dbPath }),
      expect.any(AbortSignal),
      expect.any(Function),
      true,
    );
    if (outcome === 'eligible') {
      expect(result.databases[0]?.repair).toMatchObject({ method: 'quick', status: 'completed' });
      expect(h.repair).toHaveBeenCalledOnce();
      expect(h.repair.mock.calls[0]?.[4]).toMatchObject({ singleByteCorrection });
      expect(result.databases[0]).not.toHaveProperty('singleByteCorrection');
    } else {
      expect(h.repair).not.toHaveBeenCalled();
      if (outcome === 'unverified') {
        expect(result).toMatchObject({ id: initial.id, locked: true, state: 'waiting' });
        expect(result.databases[0]?.repair).toMatchObject({
          status: 'waiting',
          nextAction: 'view-deep',
        });
        await h.maintenance.repair(scope, ['msg.db'], { methods: { 'msg.db': 'deep' } });
        expect(h.scan).toHaveBeenCalledOnce();
        expect(h.repair).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({ state: 'ended', locked: false });
        expect(result.databases[0]?.repair).toMatchObject({
          status: 'failed',
          nextAction: 'check-source',
        });
      }
    }
  },
);

it('原库变化后停止修复批次并要求核对，旧扫描不能继续提交', async () => {
  const h = fixture();
  await h.maintenance.scan(scope, h.targets, 'scan');
  h.sourceIdentity.mockReturnValue('changed');
  const result = await h.maintenance.repair(scope, ['msg.db', 'profile.db']);
  expect(result).toMatchObject({ state: 'ended', locked: false, operation: { status: 'failed' } });
  expect(result.databases[0]?.repair).toMatchObject({
    status: 'failed',
    nextAction: 'check-source',
  });
  expect(result.databases[1]?.repair?.status).toBe('cancelled');
  expect(h.repair).not.toHaveBeenCalled();
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('体检');
});
