// @vitest-environment node
import { mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  appLogStorage,
  clearAppLogHistory,
  planLogRetention,
  runLogRetentionSweep,
} from '../src/main/log_retention';

const dirs = vi.hoisted(() => ({ app: '', native: '' }));
vi.mock('@weq/native', () => ({ getNativeLogRoot: () => dirs.native }));
vi.mock('@weq/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weq/service')>()),
  getLogDir: () => dirs.app,
}));

const MiB = 1024 * 1024;
beforeEach(() => {
  dirs.app = mkdtempSync(join(tmpdir(), 'weq-log-capacity-'));
  dirs.native = dirs.app;
});
afterEach(() => rmSync(dirs.app, { recursive: true, force: true }));

function log(name: string, sizeMiB: number, daysAgo = 0) {
  const path = join(dirs.app, name);
  writeFileSync(path, '');
  truncateSync(path, sizeMiB * MiB);
  const mtime = new Date(Date.now() - daysAgo * 86_400_000);
  utimesSync(path, mtime, mtime);
  return path;
}

it('容量预览从最旧的已封段应用日志开始清理，且预览不删除文件', () => {
  const expired = log('2020-01-01.log.gz', 40, 100);
  const oldest = log('2025-01-02.1.123456abcdef.0001.log.gz', 40, 2);
  const recent = log('2025-01-03.1.123456abcdef.0001.log.gz', 30, 1);
  const today = new Date().toISOString().slice(0, 10);
  const active = log(`${today}.${process.pid}.123456abcdef.0001.log`, 15);
  const native = log(`nt_helper_${today}.log`, 150);
  const policy = { logRetentionDays: 0, logCapacityMiB: 64 } as const;

  expect(appLogStorage()).toEqual({ bytes: 125 * MiB, files: 4, historyFiles: 3 });
  const result = planLogRetention(policy);
  expect(result.preview).toMatchObject({ expiredFiles: 0, capacityFiles: 2 });
  expect([...result.targets]).toEqual([expired, oldest]);
  expect(existsSync(expired)).toBe(true);
  expect(runLogRetentionSweep(policy, result)).toEqual({ removed: 2, failed: 0 });
  for (const path of [recent, active, native]) expect(existsSync(path)).toBe(true);
});

it('手动清空只删除已有的 WeQ 历史，保留其他实例正在写的分段、原生及其他文件', () => {
  const expired = log('2020-01-01.log', 1);
  const archived = log('2020-01-02.1.123456abcdef.0001.log.gz', 1);
  const otherInstance = log(`2020-01-03.${process.pid}.abcdef123456.0002.log`, 1);
  const native = log('nt_helper_2020-01-01.log', 1);
  const other = log('notes.log', 1);

  expect(clearAppLogHistory()).toEqual({ removed: 2, failed: 0 });
  for (const path of [archived, expired]) expect(existsSync(path)).toBe(false);
  for (const path of [otherInstance, native, other]) expect(existsSync(path)).toBe(true);
});
