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

it('停止正在运行的扫描后，等实际子进程退出才释放任务，随后可以重新体检', async () => {
  const { target, options } = fixture();
  const tasks = new DatabaseCheckupTasks((request, signal) =>
    runDatabaseCheckup(request, signal, options),
  );
  const pending = tasks.start(target.uin, 'first', target);
  const rejected = expect(pending).rejects.toThrow('已停止');
  try {
    await vi.waitFor(() => expect(existsSync(target.dbPath)).toBe(true));
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
