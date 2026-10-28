// @vitest-environment node
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  commandRunsCleanupWorker,
  isStorageCleanupWorkerProcess,
} from '../src/main/storage_cleanup_process';

const winWorker = 'C:\\Program Files\\WeQ\\resources\\out\\main\\storageCleanupWorker.mjs';
const linuxWorker = '/opt/weq/out/main/storageCleanupWorker.mjs';

describe('存储清理助手的进程身份', () => {
  it.skipIf(process.platform !== 'win32')(
    'Windows 实际查询能识别独立运行的合成 worker，避免误放行清理',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'weq-中文路径-'));
      const worker = join(root, 'storageCleanupWorker.mjs');
      writeFileSync(worker, 'setInterval(() => {}, 1000);');
      const child = fork(worker, [], { execPath: process.execPath, stdio: 'ignore' });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        expect(isStorageCleanupWorkerProcess(child.pid!, worker, 'win32')).toBe(true);
      } finally {
        child.kill();
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('Windows 正在运行原 worker 才能继续阻止启动（忽略路径大小写差异）', () => {
    const runner = vi.fn(
      () =>
        `"C:\\Program Files\\WeQ\\WeQ.exe" "c:\\program files\\weq\\resources\\out\\main\\storageCleanupWorker.mjs"`,
    );
    expect(isStorageCleanupWorkerProcess(321, winWorker, 'win32', runner)).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
      expect.objectContaining({ encoding: 'utf8', windowsHide: true, timeout: 5000 }),
    );
    expect(runner.mock.calls[0]?.[1]?.[3]).toContain('ProcessId = 321');
  });

  it('Windows PID 已被无关进程复用时应删除旧锁，而不是误报清理仍在执行', () => {
    const runner = vi.fn(() => '"C:\\Windows\\System32\\notepad.exe"');
    expect(isStorageCleanupWorkerProcess(321, winWorker, 'win32', runner)).toBe(false);
    expect(
      commandRunsCleanupWorker(`"C:\\WeQ.exe" "${winWorker}.backup"`, winWorker, 'win32'),
    ).toBe(false);
  });

  it('Windows 进程检查时已经退出应视为旧锁', () => {
    expect(
      isStorageCleanupWorkerProcess(
        321,
        winWorker,
        'win32',
        () => '__WEQ_CLEANUP_PROCESS_NOT_FOUND__',
      ),
    ).toBe(false);
  });

  it('进程身份无法读取时拒绝猜测，保留锁等待安全处理', () => {
    expect(() => isStorageCleanupWorkerProcess(321, winWorker, 'win32', () => '')).toThrow(
      '进程命令行',
    );
    expect(() =>
      isStorageCleanupWorkerProcess(321, winWorker, 'win32', () => {
        throw new Error('CIM access denied');
      }),
    ).toThrow('CIM access denied');
  });

  it('非 Windows 原有 ps 路径继续正确区分真实 worker 和 PID 复用', () => {
    expect(
      isStorageCleanupWorkerProcess(
        123,
        linuxWorker,
        'linux',
        () => `/usr/bin/node ${linuxWorker} --task 1`,
      ),
    ).toBe(true);
    expect(
      isStorageCleanupWorkerProcess(
        123,
        linuxWorker,
        'linux',
        () => '/usr/bin/node /tmp/other.mjs',
      ),
    ).toBe(false);
  });

  it('损坏或非清理助手的锁文件身份不能冒充有效进程', () => {
    expect(() => isStorageCleanupWorkerProcess(0, winWorker, 'win32', () => '')).toThrow('无效');
    expect(() =>
      isStorageCleanupWorkerProcess(123, 'storageCleanupWorker.mjs', 'win32', () => ''),
    ).toThrow('无效');
    expect(() =>
      isStorageCleanupWorkerProcess(123, 'C:\\Windows\\notepad.exe', 'win32', () => ''),
    ).toThrow('无效');
  });
});
