// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { DbRepairTarget } from '@weq/service';
import type { NtHelperBinding, BadPageScanResult } from '@weq/native';
import { DatabaseCheckupTasks, runDatabaseCheckup } from '../src/main/db_checkup';
import { inspectDatabase } from '../src/main/db_checkup_core';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-checkup-'));
  roots.push(root);
  const target: DbRepairTarget = {
    uin: 'synthetic',
    dataDir: null,
    dbDir: root,
    dbName: 'hang.db',
    dbPath: join(root, 'pid'),
    key: 'synthetic-secret',
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' },
  };
  const options = {
    executable: process.execPath,
    workerPath: fileURLToPath(new URL('./fixtures/db-checkup-worker.mjs', import.meta.url)),
    nativeRoot: '/synthetic/native',
  };
  return { target, options };
}

it('已确认的明文来源执行完整只读结构检查，不把加密参数不适用诊断成损坏', async () => {
  const { target } = fixture();
  const executeSql = vi.fn(async () => [['ok']]);
  const health = vi.fn();
  const nt = { executeSql, checkDatabaseHealth: health } as unknown as NtHelperBinding;
  const result = await inspectDatabase(nt, { ...target, key: '' }, () => {}, 'deep');
  expect(result.integrity).toEqual({
    ran: true,
    healthy: true,
    corruptedTables: [],
    complete: true,
    unverifiedTables: [],
  });
  expect(executeSql).toHaveBeenCalledWith(target.dbPath, 'PRAGMA main.integrity_check');
  expect(health).not.toHaveBeenCalled();
});

it('停止正在运行的扫描后，等实际子进程退出才释放任务，随后可以重新体检', async () => {
  const { target, options } = fixture();
  const tasks = new DatabaseCheckupTasks((request, signal) =>
    runDatabaseCheckup(request, signal, options),
  );
  const pending = tasks.start(target.uin, 'first', target);
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
    message: '数据库体检已停止。',
  });
  try {
    await vi.waitFor(() => expect(existsSync(target.dbPath)).toBe(true), { timeout: 15_000 });
    const pid = Number(readFileSync(target.dbPath, 'utf8'));
    expect(await tasks.cancel('other-account', 'first')).toEqual({ cancelled: false });
    expect(process.kill(pid, 0)).toBe(true);
    expect(await tasks.cancel(target.uin, 'first')).toEqual({ cancelled: true });
    expect(() => process.kill(pid, 0)).toThrow();
    await rejected;
    expect(await tasks.cancel(target.uin, 'first')).toEqual({ cancelled: false });
    const result = await tasks.start(target.uin, 'first', { ...target, dbName: 'ready.db' });
    expect(result.summary).toBe('synthetic result');
  } finally {
    await tasks.cancel(target.uin, 'first');
  }
});

it('请求开始后立即停止也能取消，重复任务不会覆盖正在运行的扫描', async () => {
  const { target, options } = fixture();
  const run = vi.fn((request: DbRepairTarget, signal: AbortSignal) =>
    runDatabaseCheckup(request, signal, options),
  );
  const tasks = new DatabaseCheckupTasks(run);
  const pending = tasks.start(target.uin, 'first', target);
  const rejected = expect(pending).rejects.toThrow('已停止');
  expect(() => tasks.start(target.uin, 'first', target)).toThrow('已经在运行');
  await tasks.cancel(target.uin, 'first');
  await rejected;
  expect(existsSync(target.dbPath)).toBe(false);
});

it('隔离后的检查仍分别收集结构错误和坏页，不把损坏或未校验误判为健康', async () => {
  const { target } = fixture();
  const scan: BadPageScanResult = {
    pageSize: 4096,
    pageCount: 2,
    badPages: [],
    zeroPages: [],
    plaintext: false,
    trailingBytes: 0,
    usedHmac: true,
    headerOffset: 1024,
    fileSize: 9216,
    scannedAt: 0,
  };
  const health = vi.fn(async () => ({ healthy: true, corruptedTables: [] as string[] }));
  const pages = vi.fn(async () => scan);
  const nt = { checkDatabaseHealth: health, scanBadPages: pages } as unknown as NtHelperBinding;
  expect((await inspectDatabase(nt, target)).verdict).toBe('healthy');
  health.mockRejectedValueOnce(new Error('database disk image is malformed'));
  expect((await inspectDatabase(nt, target)).verdict).toBe('corrupted');
  expect(pages).toHaveBeenCalledTimes(2);
  pages.mockRejectedValueOnce(new Error('synthetic scan failed'));
  const partial = await inspectDatabase(nt, target);
  expect(partial.verdict).toBe('healthy-unverified');
  expect(partial.pages).toEqual({ ran: false, error: 'synthetic scan failed' });
});

it('应用退出取消全部在途体检，并等待各任务释放', async () => {
  const { target, options } = fixture();
  const tasks = new DatabaseCheckupTasks((request, signal) =>
    runDatabaseCheckup(request, signal, options),
  );
  const pending = tasks.start(target.uin, 'first', target);
  const rejected = expect(pending).rejects.toThrow('已停止');
  await tasks.cancelAll();
  await rejected;
  expect(await tasks.cancel(target.uin, 'first')).toEqual({ cancelled: false });
});

it('体检持续回报真实页数，并分别保留结构与页检查的结束状态', async () => {
  const { target } = fixture();
  const events: import('@weq/service').DatabaseWorkProgress[] = [];
  const nt = {
    checkDatabaseHealth: vi.fn(async (_path, _key, _algo, callback) => {
      callback(null, { step: 'integrity', message: '整体检查' });
      callback(null, {
        step: 'integrity-pages',
        message: '检查页结构与引用',
        completed: 2,
        total: 4,
        unit: 'pages',
      });
      callback(null, {
        step: 'integrity-records-2',
        message: '检查记录与索引对应',
        completed: 500,
        total: 2000,
        unit: 'records',
        objectName: 'synthetic_table',
      });
      callback(null, {
        step: 'integrity-index-3',
        message: '核对索引条目数量',
        objectName: 'unrelated_index_name',
      });
      callback(null, {
        step: 'integrity-records-4',
        message: '检查记录与索引对应',
        objectName: 'next_table',
      });
      callback(null, {
        step: 'integrity-index-5',
        message: '核对索引条目数量',
        objectName: 'synthetic_table_like_index',
      });
      return { healthy: true, corruptedTables: [] };
    }),
    scanBadPages: vi.fn(async (_path, _key, _algo, callback) => {
      callback(null, { step: 'pages', message: '页检查', completed: 2, total: 4, unit: 'pages' });
      return { pageCount: 4, pageSize: 4096, badPages: [], zeroPages: [], usedHmac: true };
    }),
  } as unknown as NtHelperBinding;
  await inspectDatabase(nt, target, (tick) => events.push(tick));
  expect(events).toContainEqual(expect.objectContaining({ completed: 2, total: 4 }));
  expect(events).toContainEqual(
    expect.objectContaining({
      step: 'integrity-records-2',
      completed: 500,
      total: 2000,
      unit: 'records',
      objectName: 'synthetic_table',
    }),
  );
  expect(
    events
      .filter((event) => event.tableName)
      .map(({ objectName, tableName }) => [objectName, tableName]),
  ).toEqual([
    ['unrelated_index_name', 'synthetic_table'],
    ['synthetic_table_like_index', 'next_table'],
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({ step: 'pages', completed: 4, total: 4, status: 'completed' }),
  );
  expect(events.at(-1)).toMatchObject({ step: 'mapping', status: 'skipped' });
});

it('独立体检进程支持分段 UTF-8 进度流，结果返回前已收到进度', async () => {
  const { target, options } = fixture();
  const events: import('@weq/service').DatabaseWorkProgress[] = [];
  const result = await runDatabaseCheckup(
    { ...target, dbName: 'stream.db' },
    new AbortController().signal,
    { ...options, onProgress: (tick) => events.push(tick) },
  );
  expect(events).toEqual([
    { step: 'pages', message: '页检查', completed: 2, total: 4, unit: 'pages' },
  ]);
  expect(result.summary).toBe('synthetic result');
});

it.each([
  { healthy: true, usedHmac: true, badPages: [], integrity: 'normal', pages: 'normal' },
  { healthy: false, usedHmac: true, badPages: [3], integrity: 'abnormal', pages: 'abnormal' },
  { healthy: true, usedHmac: false, badPages: [], integrity: 'normal', pages: 'unverified' },
])('体检进度分别传递结构与页签名的真实结果：%j', async (sample) => {
  const { target } = fixture();
  const events: import('@weq/service').DatabaseWorkProgress[] = [];
  const nt = {
    checkDatabaseHealth: vi.fn(async (_path, _key, _algo, callback) => {
      if (!sample.healthy)
        callback(null, {
          step: 'integrity-tables',
          message: '逐表定位结构异常',
          completed: 0,
          total: 1,
        });
      return { healthy: sample.healthy, corruptedTables: sample.healthy ? [] : ['synthetic'] };
    }),
    scanBadPages: vi.fn(async () => ({
      pageCount: 4,
      pageSize: 4096,
      badPages: sample.badPages,
      zeroPages: [],
      usedHmac: sample.usedHmac,
    })),
    executeSqlWithKey: vi.fn(async () => []),
  } as unknown as NtHelperBinding;
  await inspectDatabase(nt, target, (tick) => events.push(tick));
  expect(events).toContainEqual(
    expect.objectContaining({
      step: 'integrity',
      status: 'completed',
      outcome: sample.integrity,
    }),
  );
  expect(events).toContainEqual(expect.objectContaining({ step: 'pages', outcome: sample.pages }));
  if (!sample.healthy)
    expect(events).toContainEqual(
      expect.objectContaining({
        step: 'integrity-tables',
        outcome: 'abnormal',
      }),
    );
  if (sample.badPages.length)
    expect(events.at(-1)).toMatchObject({
      step: 'mapping',
      outcome: 'unverified',
    });
});

it('结构检查抛错时区分已确认损坏与未判定，并继续页签名检查', async () => {
  const { target } = fixture();
  for (const [message, outcome] of [
    ['database disk image is malformed', 'abnormal'],
    ['synthetic failure', 'unverified'],
  ]) {
    const events: import('@weq/service').DatabaseWorkProgress[] = [];
    const nt = {
      checkDatabaseHealth: vi.fn(async () => {
        throw new Error(message);
      }),
      scanBadPages: vi.fn(async () => {
        throw new Error('page failure');
      }),
    } as unknown as NtHelperBinding;
    await inspectDatabase(nt, target, (tick) => events.push(tick));
    expect(events).toContainEqual(
      expect.objectContaining({
        step: 'integrity',
        status: 'failed',
        outcome,
        detail: message,
      }),
    );
    expect(events.at(-1)).toMatchObject({ step: 'pages', status: 'failed', outcome: 'unverified' });
  }
});

it('可用表回退检查的过程和完成消息不被误判为结构异常', async () => {
  const { target } = fixture();
  const events: import('@weq/service').DatabaseWorkProgress[] = [];
  const nt = {
    checkDatabaseHealth: vi.fn(async (_path, _key, _algo, callback) => {
      callback(null, {
        step: 'integrity-tables',
        message: '检查可用表结构',
        completed: 0,
        total: 1,
      });
      callback(null, { step: 'integrity-tables', message: '逐表检查完成', completed: 1, total: 1 });
      return { healthy: true, corruptedTables: [] };
    }),
    scanBadPages: vi.fn(async () => ({
      pageCount: 4,
      badPages: [],
      zeroPages: [],
      usedHmac: true,
    })),
  } as unknown as NtHelperBinding;
  await inspectDatabase(nt, target, (tick) => events.push(tick));
  expect(events.some((tick) => tick.outcome === 'abnormal')).toBe(false);
});

it('页扫描发现坏页后失败仍保留已确认的异常，不退回未判定', async () => {
  const { target } = fixture();
  const events: import('@weq/service').DatabaseWorkProgress[] = [];
  const nt = {
    checkDatabaseHealth: vi.fn(async () => ({ healthy: true, corruptedTables: [] })),
    scanBadPages: vi.fn(async (_path, _key, _algo, callback) => {
      callback(null, { step: 'pages', message: '检查页签名', completed: 2, total: 4, badPages: 1 });
      throw new Error('synthetic scan failed');
    }),
  } as unknown as NtHelperBinding;
  await inspectDatabase(nt, target, (tick) => events.push(tick));
  expect(events.at(-1)).toMatchObject({ step: 'pages', status: 'failed', outcome: 'abnormal' });
});
