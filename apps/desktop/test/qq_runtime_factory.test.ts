// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Platform } from '@weq/platform';
import type { QQKernelSessionHooks } from '../src/main/qq_runtime/process_backend';
import { createDesktopQQRuntime } from '../src/main/qq_runtime/factory';
import { accountConfigId, type QQRuntimeBackendEvent } from '@weq/service';

const captured = vi.hoisted(() => ({ hooks: null as QQKernelSessionHooks | null }));
vi.mock('@weq/native', async (original) => ({
  ...(await original<typeof import('@weq/native')>()),
  resolveNtHelperPath: () => '/fixture/nt_helper.node',
}));
vi.mock('../src/main/qq_runtime/installation', () => ({
  discoverManagedQQInstallation: async () => ({
    wrapperPath: '/fixture/wrapper.node',
    majorPath: '/fixture/major.node',
    client: { appId: '12345', version: 'fixture-1', qua: 'fixture' },
  }),
}));
vi.mock('../src/main/qq_runtime/process_backend', () => ({
  createQQKernelProcessBackend: async (
    _options: unknown,
    _path: unknown,
    _exec: unknown,
    _signal: unknown,
    hooks: QQKernelSessionHooks,
  ) => {
    captured.hooks = hooks;
    let running = true;
    const listeners = new Set<(event: QQRuntimeBackendEvent) => void>();
    return {
      pid: 123,
      owned: true,
      isRunning: () => running,
      subscribe: (listener: (event: QQRuntimeBackendEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      initialize: async () => {},
      login: async () => {},
      refreshQr: async () => {},
      health: async () => {},
      close: async () => {
        if (!running) return;
        await hooks.release();
        running = false;
        for (const listener of listeners) listener({ type: 'exit', code: 0, signal: null });
      },
    };
  },
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(binding?: 'same' | 'other') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-runtime-factory-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nt_db'));
  const dbPath = join(root, 'nt_db', 'nt_msg.db');
  await writeFile(dbPath, Buffer.alloc(4096));
  await writeFile(join(root, 'qqKernelWorker.mjs'), 'fixture');
  const nt = {
    setSsoSession: vi.fn(async () => {}),
    clearSsoSession: vi.fn(async () => true),
    hasSsoSession: vi.fn(async () => true),
    resolveAppidFromMajor: vi.fn(),
    testDatabaseKey: vi.fn(async () => ({
      success: true,
      pageHmacAlgorithm: 'fixture-page',
      kdfHmacAlgorithm: 'fixture-kdf',
    })),
  };
  const open = vi.fn(async () => ({ database: true, push: false }));
  let target =
    binding === 'same'
      ? accountConfigId('10001', root)
      : binding === 'other'
        ? 'other-config'
        : null;
  const runtime = createDesktopQQRuntime({
    platform: { native: { ntHelper: nt } } as unknown as Platform,
    dataRoot: root,
    moduleDir: root,
    inspectExternal: async () => null,
    openAccount: open,
    expectedConfigId: () => target,
  });
  cleanup.push(async () => {
    await runtime.stop();
  });
  await runtime.startManaged('10001');
  const hooks = captured.hooks!;
  const identity = { pid: 123, uin: '10001', uid: 'u_self', guid: 'ab'.repeat(16) };
  const signal = new AbortController().signal;
  await hooks.accept(
    { ...identity, material: { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) } },
    signal,
  );
  return {
    root,
    dbPath,
    nt,
    open,
    runtime,
    hooks,
    identity,
    signal,
    setTarget: (value: string) => {
      target = value;
    },
  };
}
describe('桌面托管工厂的数据库交接', () => {
  it('同 QQ 号的其他配置不能冒充选定数据源', async () => {
    const f = await fixture('other');
    await expect(
      f.hooks.openDatabase!(
        { ...f.identity, dbPath: f.dbPath, dbKey: 'FixtureKey123456' },
        f.signal,
      ),
    ).rejects.toThrow(/选定配置/);
    expect(f.nt.testDatabaseKey).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
  it('实例保存创建时的目标快照，不被后续启动偏好改写', async () => {
    const f = await fixture('same');
    f.setTarget('new-target');
    expect(
      await f.hooks.openDatabase!(
        { ...f.identity, dbPath: f.dbPath, dbKey: 'FixtureKey123456' },
        f.signal,
      ),
    ).toEqual({ database: true, push: false });
  });
  it('使用原口令复验后才交给账号打开流程，公开运行时不带密钥', async () => {
    const f = await fixture();
    expect(
      await f.hooks.openDatabase!(
        { ...f.identity, dbPath: f.dbPath, dbKey: 'FixtureKey123456' },
        f.signal,
      ),
    ).toEqual({ database: true, push: false });
    expect(f.nt.testDatabaseKey).toHaveBeenCalledWith(f.dbPath, 'FixtureKey123456');
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({
        ...f.identity,
        dbPath: f.dbPath,
        dbKey: 'FixtureKey123456',
        algo: { pageHmacAlgorithm: 'fixture-page', kdfHmacAlgorithm: 'fixture-kdf' },
      }),
    );
    expect(JSON.stringify(f.runtime.snapshot())).not.toContain('FixtureKey123456');
  });
  it('外部路径和未通过验证的密钥都不打开账号', async () => {
    const f = await fixture(),
      outside = await fixture();
    await expect(
      f.hooks.openDatabase!(
        { ...f.identity, dbPath: outside.dbPath, dbKey: 'FixtureKey123456' },
        f.signal,
      ),
    ).rejects.toThrow(/归属/);
    expect(f.nt.testDatabaseKey).not.toHaveBeenCalled();
    f.nt.testDatabaseKey.mockResolvedValueOnce({
      success: false,
      pageHmacAlgorithm: '',
      kdfHmacAlgorithm: '',
    });
    await expect(
      f.hooks.openDatabase!(
        { ...f.identity, dbPath: f.dbPath, dbKey: 'FixtureKey123456' },
        f.signal,
      ),
    ).rejects.toThrow(/验证失败/);
    expect(f.open).not.toHaveBeenCalled();
  });
});
