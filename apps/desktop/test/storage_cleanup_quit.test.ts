// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearStorageAfterExit } from '../src/main/storage_cleanup';

const fixture = vi.hoisted(() => ({
  app: {
    getPath: vi.fn(),
    getAppPath: () => '/synthetic/WeQ.app',
    on: vi.fn(),
    removeListener: vi.fn(),
    quit: vi.fn(),
  },
  fork: vi.fn(),
}));
vi.mock('electron', () => ({ app: fixture.app, dialog: { showErrorBox: vi.fn() } }));
vi.mock('node:child_process', () => ({ fork: fixture.fork, execFileSync: vi.fn() }));
vi.mock('../src/main/app_quit_confirmation', () => ({ skipNextQuitConfirmation: vi.fn() }));
vi.mock('../src/main/worker_path', () => ({
  resolveChildWorkerPath: () => '/synthetic/storageCleanupWorker.mjs',
}));

let root: string | undefined;
let child: EventEmitter | undefined;
afterEach(async () => {
  child?.emit('exit');
  vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true });
});

it('退出后清除等待可提交的 will-quit，不在后台清理暂缓期间提交', async () => {
  vi.useFakeTimers();
  root = await mkdtemp(join(tmpdir(), 'weq-cleanup-quit-'));
  fixture.app.getPath.mockReturnValue(root);
  const app = new EventEmitter();
  fixture.app.on.mockImplementation(app.on.bind(app));
  fixture.app.removeListener.mockImplementation(app.removeListener.bind(app));
  fixture.app.quit.mockImplementation(() =>
    app.emit('will-quit', { defaultPrevented: true, preventDefault: vi.fn() }),
  );
  const helper = Object.assign(new EventEmitter(), {
    pid: 42,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn((message: { type: string }, callback?: (error: Error | null) => void) => {
      if (message.type === 'prepare') helper.emit('message', { type: 'ready' });
      else callback?.(null);
    }),
    disconnect: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  });
  child = helper;
  fixture.fork.mockReturnValue(helper);
  await clearStorageAfterExit([]);
  await vi.advanceTimersByTimeAsync(200);
  expect(helper.send).toHaveBeenCalledTimes(1);
  expect(helper.disconnect).not.toHaveBeenCalled();
  expect(app.listenerCount('will-quit')).toBe(1);
  app.emit('will-quit', { defaultPrevented: false, preventDefault: vi.fn() });
  expect(helper.send).toHaveBeenLastCalledWith({ type: 'commit' }, expect.any(Function));
  expect(helper.disconnect).toHaveBeenCalledOnce();
  expect(helper.unref).toHaveBeenCalledOnce();
});
