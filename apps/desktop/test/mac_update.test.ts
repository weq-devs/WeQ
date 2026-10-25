// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishMacUpdate, installMacUpdate, prepareMacUpdate } from '../src/main/update/mac';
import type { MacUpdatePlan } from '../src/main/update/mac_install';

const fixture = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0',
    getPath: vi.fn(),
    quit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
  run: vi.fn(),
  fork: vi.fn(),
  fetch: vi.fn(),
  verifyArchive: vi.fn(),
  verifyBundle: vi.fn(),
  bundle: '',
  version: '1.0.0',
  showErrorBox: vi.fn(),
}));
vi.mock('electron', () => ({ app: fixture.app, dialog: { showErrorBox: fixture.showErrorBox } }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: fixture.run }),
    fork: fixture.fork,
  };
});
vi.mock('../src/main/update/mac_install', async (original) => ({
  ...(await original<typeof import('../src/main/update/mac_install')>()),
  macAppBundle: () => fixture.bundle,
  verifyMacArchive: fixture.verifyArchive,
  verifyMacBundle: fixture.verifyBundle,
}));
vi.mock('../src/main/worker_path', () => ({
  resolveChildWorkerPath: () => '/synthetic/macUpdateWorker.mjs',
}));

let root: string;
let app: EventEmitter;
let child: ReturnType<typeof childFixture>;
function childFixture() {
  return Object.assign(new EventEmitter(), {
    send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null)),
    kill: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(join(tmpdir(), 'weq-mac-host-')));
  fixture.bundle = join(root, 'weQ.app');
  await mkdir(fixture.bundle);
  fixture.app.getPath.mockReturnValue(root);
  fixture.app.getVersion = () => fixture.version;
  fixture.version = '1.0.0';
  fixture.verifyArchive.mockResolvedValue(undefined);
  fixture.verifyBundle.mockResolvedValue(undefined);
  fixture.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      tag_name: 'v1.1.0',
      draft: false,
      prerelease: false,
      assets: [
        {
          name: 'weQ-1.1.0-mac-arm64.zip',
          state: 'uploaded',
          digest: `sha256:${'a'.repeat(64)}`,
          size: 3,
        },
      ],
    }),
  });
  fixture.run.mockImplementation(async (command, args) => {
    if (command === '/usr/bin/ditto') await mkdir(join(args.at(-1), 'weQ.app'));
    return { stdout: '', stderr: 'Signature=adhoc\n' };
  });
  vi.stubGlobal('fetch', fixture.fetch);
  app = new EventEmitter();
  fixture.app.once.mockImplementation(app.once.bind(app));
  fixture.app.removeListener.mockImplementation(app.removeListener.bind(app));
  fixture.app.quit.mockImplementation(() => app.emit('will-quit', { preventDefault: vi.fn() }));
  child = childFixture();
  fixture.fork.mockReturnValue(child);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
async function plan() {
  return prepareMacUpdate('/synthetic/weQ-1.1.0-mac-arm64.zip', '1.1.0');
}

describe('macOS 更新准备', () => {
  it('只向固定官方 API 取哈希，校验归档后才解压和发布安装计划', async () => {
    const result = await plan();
    expect(fixture.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/weq-devs/WeQ/releases/tags/v1.1.0',
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(fixture.verifyArchive.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.run.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fixture.run).toHaveBeenCalledWith(
      '/usr/bin/ditto',
      ['-x', '-k', '/synthetic/weQ-1.1.0-mac-arm64.zip', result.staging],
      { timeout: 120_000 },
    );
    expect(fixture.app.quit).not.toHaveBeenCalled();
  });
  it('官方不可达、缺哈希或版本回退均停止，不拿镜像提供的哈希降级', async () => {
    fixture.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(plan()).rejects.toThrow('官方 Release');
    fixture.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tag_name: 'v1.1.0', draft: false, prerelease: false, assets: [] }),
    });
    await expect(plan()).rejects.toThrow('SHA-256');
    await expect(prepareMacUpdate('/synthetic/archive.zip', '1.0.0')).rejects.toThrow('不高于');
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.app.quit).not.toHaveBeenCalled();
  });
  it('归档校验失败不解压，也不退出应用', async () => {
    fixture.verifyArchive.mockRejectedValueOnce(new Error('官方哈希不匹配'));
    await expect(plan()).rejects.toThrow('官方哈希');
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.app.quit).not.toHaveBeenCalled();
  });
});

describe('macOS 安装退出握手', () => {
  it('先等助手就绪，再等待 will-quit 提交确认；没有提前退出或在进程内替换', async () => {
    const prepared = await plan();
    const task = installMacUpdate(prepared);
    expect(fixture.app.quit).not.toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledWith(
      { type: 'prepare', parentPid: process.pid, plan: prepared },
      expect.any(Function),
    );
    const preventDefault = vi.fn();
    fixture.app.quit.mockImplementationOnce(() => app.emit('will-quit', { preventDefault }));
    child.emit('message', { type: 'ready' });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(child.send).toHaveBeenLastCalledWith({ type: 'commit' }, expect.any(Function));
    expect(child.disconnect).not.toHaveBeenCalled();
    child.emit('message', { type: 'committed' });
    await task;
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(fixture.app.quit).toHaveBeenCalledTimes(2);
    expect(app.listenerCount('will-quit')).toBe(0);
  });
  it('助手启动失败时保留应用，清理本次助手和退出监听', async () => {
    const task = installMacUpdate(await plan());
    child.emit('error', new Error('合成启动失败'));
    await expect(task).rejects.toThrow('启动失败');
    expect(child.kill).toHaveBeenCalledOnce();
    expect(fixture.app.quit).not.toHaveBeenCalled();
    expect(app.listenerCount('will-quit')).toBe(0);
  });
  it('退出提交发送失败时不强制退出，解除监听', async () => {
    const task = installMacUpdate(await plan());
    child.send.mockImplementationOnce((_message, callback) =>
      callback?.(new Error('合成 IPC 失败')),
    );
    child.emit('message', { type: 'ready' });
    await expect(task).rejects.toThrow('IPC');
    expect(fixture.app.quit).toHaveBeenCalledOnce();
    expect(child.disconnect).not.toHaveBeenCalled();
    expect(app.listenerCount('will-quit')).toBe(0);
  });
});

describe.runIf(process.platform === 'darwin')('macOS 更新回执', () => {
  it('重新准备更新时回收上一次未安装的暂存，不累积整份应用副本', async () => {
    const first = await plan();
    const next = await plan();
    expect(next.staging).not.toBe(first.staging);
    await expect(realpath(first.staging)).rejects.toThrow();
    await expect(realpath(next.staging)).resolves.toBe(next.staging);
  });
  it('下载后未安装便退出，下次启动回收本次暂存，不误报安装失败', async () => {
    const prepared = await plan();
    await finishMacUpdate();
    await expect(realpath(prepared.staging)).rejects.toThrow();
    expect(fixture.showErrorBox).not.toHaveBeenCalled();
  });
  it('新版本确认启动后才清理本次副本及成功回执', async () => {
    const prepared = await plan();
    await writeFile(prepared.report, JSON.stringify({ phase: 'installed', plan: prepared }));
    fixture.version = prepared.version;
    await finishMacUpdate();
    await expect(realpath(prepared.staging)).rejects.toThrow();
    expect(fixture.showErrorBox).not.toHaveBeenCalled();
  });
  it('旧版本运行不能清理恢复副本', async () => {
    const prepared: MacUpdatePlan = await plan();
    await writeFile(prepared.report, JSON.stringify({ phase: 'installed', plan: prepared }));
    await finishMacUpdate();
    expect(fixture.showErrorBox).toHaveBeenCalledWith(
      '上次更新未完成',
      expect.stringContaining(prepared.staging),
    );
    expect(await readFile(prepared.report, 'utf8').catch(() => null)).toBeNull();
    await expect(realpath(prepared.staging)).resolves.toBe(prepared.staging);
  });
});
