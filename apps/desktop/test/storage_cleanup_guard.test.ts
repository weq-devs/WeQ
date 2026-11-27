// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    getPath: vi.fn(),
    exit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
  identify: vi.fn(),
  sharedRoot: vi.fn(),
}));
vi.mock('electron', () => ({ app: mocks.app, dialog: mocks.dialog }));
vi.mock('@weq/platform', async (original) => ({
  ...(await original<typeof import('@weq/platform')>()),
  weqAppDataRoot: mocks.sharedRoot,
}));
vi.mock('../src/main/storage_cleanup_process', () => ({
  isStorageCleanupWorkerProcess: mocks.identify,
}));

import { guardStorageCleanupStartup } from '../src/main/storage_cleanup';

let root: string;
let lockPath: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'weq-cleanup-identity-'));
  lockPath = join(root, 'storage-maintenance', 'running.json');
  mkdirSync(join(root, 'storage-maintenance'), { recursive: true });
  mocks.app.getPath.mockReturnValue(join(root, 'desktop-instance'));
  mocks.sharedRoot.mockReturnValue(root);
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, worker: join(root, 'storageCleanupWorker.mjs') }),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('PID 仍存活但实际是其他进程时清除过期锁，并允许启动', () => {
  mocks.identify.mockReturnValue(false);
  guardStorageCleanupStartup();
  expect(mocks.identify).toHaveBeenCalledWith(process.pid, join(root, 'storageCleanupWorker.mjs'));
  expect(existsSync(lockPath)).toBe(false);
  expect(mocks.dialog.showErrorBox).not.toHaveBeenCalled();
  expect(mocks.app.exit).not.toHaveBeenCalled();
});

it('确认真实清理助手还在运行时保留锁，并阻止启动', () => {
  mocks.identify.mockReturnValue(true);
  guardStorageCleanupStartup();
  expect(existsSync(lockPath)).toBe(true);
  expect(mocks.dialog.showErrorBox).toHaveBeenCalledWith('存储清除仍在进行', expect.any(String));
  expect(mocks.app.exit).toHaveBeenCalledWith(0);
});

it('无法识别进程身份时保留锁并明确报错，不会误放行清理过程', () => {
  mocks.identify.mockImplementation(() => {
    throw new Error('Get-CimInstance denied');
  });
  guardStorageCleanupStartup();
  expect(existsSync(lockPath)).toBe(true);
  expect(mocks.dialog.showErrorBox).toHaveBeenCalledWith('无法核对清除状态', expect.any(String));
  expect(mocks.app.exit).toHaveBeenCalledWith(1);
});

it('PID 属于无权发信号的进程时仍核对身份，不是清理助手就清除过期锁', () => {
  // PID 复用后可能命中系统进程：process.kill 抛 EPERM，但命令行仍可读取。
  const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: number) => {
    if (pid === process.pid && signal === 0) {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    }
    return true;
  }) as typeof process.kill);
  try {
    mocks.identify.mockReturnValue(false);
    guardStorageCleanupStartup();
    expect(mocks.identify).toHaveBeenCalledWith(
      process.pid,
      join(root, 'storageCleanupWorker.mjs'),
    );
    expect(existsSync(lockPath)).toBe(false);
    expect(mocks.app.exit).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

it('PID 不存在时清除过期锁并允许启动', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  }) as typeof process.kill);
  try {
    guardStorageCleanupStartup();
    expect(mocks.identify).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
    expect(mocks.app.exit).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});
