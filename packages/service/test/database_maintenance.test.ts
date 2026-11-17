import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseMaintenance } from '../src/account/db_repair/maintenance';
import { DatabaseMaintenanceReports } from '../src/account/db_repair/maintenance_reports';
import { renderDatabaseMaintenanceReport } from '../src/account/db_repair/maintenance_reports';
import type { BadPageScanReport } from '../src/account/bad_pages';
import type { DbRepairTarget, DbRepairRecord } from '../src/account/db_repair/types';
import type { DbRepairCheckupIntegrity } from '../src/account/db_repair/checkup';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
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
      _progress: (tick: never) => void,
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
      affected: [],
    }),
  );
  const release = vi.fn();
  const lease = new AbortController();
  const repair = vi.fn(
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
  const maintenance = new DatabaseMaintenance({
    acquire: vi.fn(async () => ({ release, signal: lease.signal })),
    scan,
    deep,
    repair,
    reports: () => reports,
  });
  return { maintenance, targets, scan, deep, repair, release, reports, lease };
}
const scope = { uin: '10001', configId: 'source-a' };

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
  for (let count = 0; count < 10; count++) await Promise.resolve();
  expect(h.maintenance.current(scope)).toMatchObject({
    state: 'ended',
    locked: false,
    maintenanceError: expect.any(String),
  });
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('扫描');
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.reports.list()).toHaveLength(1);
});

it('历史报告三种格式使用同一份完整结果，HTML 转义来源文本', async () => {
  const h = fixture();
  h.targets[0]!.dbName = '<script>.db';
  const result = await h.maintenance.scan(scope, h.targets, 'scan');
  const report = h.reports.get(result.operation!.id)!;
  expect(JSON.parse(renderDatabaseMaintenanceReport(report, 'json'))).toEqual(report);
  expect(renderDatabaseMaintenanceReport(report, 'md')).toContain('WeQ 不支持修复');
  const html = renderDatabaseMaintenanceReport(report, 'html');
  expect(html).toContain('&lt;script&gt;.db');
  expect(html).not.toContain('<script>');
  await h.maintenance.end(scope);
  expect(h.reports.get(result.operation!.id)).toEqual(report);
});

it('打开状态不扫描；全账号先锁定，扫描结果在等待和继续深度体检时保留', async () => {
  const h = fixture();
  expect(h.maintenance.current(scope)).toBeNull();
  expect(h.scan).not.toHaveBeenCalled();
  await h.maintenance.scan(scope, h.targets, 'scan');
  expect(h.maintenance.current(scope)).toMatchObject({ state: 'waiting', locked: true });
  expect(h.release).not.toHaveBeenCalled();
  expect(h.scan).toHaveBeenCalledTimes(3);
  await h.maintenance.scan(scope, h.targets, 'checkup');
  expect(h.scan).toHaveBeenCalledTimes(3);
  expect(h.reports.list()).toHaveLength(2);
  expect(
    h.reports.list().find((report) => report.operation.kind === 'scan')?.databases[0]?.integrity,
  ).toBeUndefined();
  await h.maintenance.end(scope);
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.reports.list()).toHaveLength(2);
});

it('不能独立修复或选中未完整扫描及不支持的库；单库失败不中断批次，结束后统一解锁', async () => {
  const h = fixture();
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('扫描');
  h.scan.mockImplementationOnce(async () => {
    throw new Error('synthetic scan failed');
  });
  await h.maintenance.scan(scope, h.targets, 'scan');
  expect(h.maintenance.current(scope)?.operation?.status).toBe('partial');
  expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('完整扫描');
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
  await h.maintenance.scan(scope, h.targets, 'scan');
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
  await h.maintenance.stop(scope);
  const result = await run;
  expect(h.repair).toHaveBeenCalledTimes(2);
  expect(result.operation?.status).toBe('cancelled');
  expect(result.databases[0]?.repair).toMatchObject({
    status: 'completed',
    record: { id: 'already-applied' },
  });
  expect(result.databases[2]?.repair?.status).toBe('cancelled');
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.reports.get(result.operation!.id)?.operation.status).toBe('cancelled');
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
  expect(() => h.maintenance.deleteReport(scope, id)).toThrow('仍在更新');
  await h.maintenance.stop(scope);
  await run;
  expect(h.maintenance.deleteReport(scope, id)).toBe(true);
  expect(h.maintenance.current(scope)?.locked).toBe(true);
  expect(h.reports.get(id)).toBeNull();
  expect(() => h.reports.remove('../outside')).toThrow('标识无效');
  await h.maintenance.scan(scope, h.targets, 'scan');
  await h.maintenance.end(scope);
  expect(h.reports.get(id)).toBeNull();
  expect(h.reports.list()).toHaveLength(1);
});

it.each([false, true])(
  '未完成任何数据库就停止扫描不生成报告，解锁失败可重试（首次失败：%s）',
  async (failRelease) => {
    const h = fixture();
    if (failRelease)
      h.release.mockImplementationOnce(() => {
        throw new Error('synthetic release failure');
      });
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    h.scan.mockImplementationOnce(
      (_target, signal) =>
        new Promise((_done, reject) => {
          entered();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const run = h.maintenance.scan(scope, h.targets, 'scan');
    await started;
    expect(h.reports.list()).toEqual([]);
    const result = await h.maintenance.stop(scope);
    await run;
    expect(result).toMatchObject({
      state: failRelease ? 'waiting' : 'ended',
      locked: failRelease,
      operation: { status: 'cancelled' },
    });
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.maintenance.reports(scope)).toEqual([]);
    if (failRelease) {
      expect(result?.maintenanceError).toContain('释放维护锁失败');
      await h.maintenance.end(scope);
      expect(h.maintenance.current(scope)).toMatchObject({ state: 'ended', locked: false });
      expect(h.maintenance.reports(scope)).toEqual([]);
    }
    expect(() => h.maintenance.repair(scope, ['msg.db'])).toThrow('扫描');
  },
);
