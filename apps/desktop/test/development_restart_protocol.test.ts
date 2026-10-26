// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareDevelopmentRestart } from '../src/main/development_restart';
import { MANUAL_RESTART_ARG } from '../src/main/startup_window';

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: mocks.fork }));
vi.mock('node:fs/promises', () => ({ access: vi.fn(async () => {}) }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    send: vi.fn(),
  });
  mocks.fork.mockReturnValue(child);
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const preparing = prepareDevelopmentRestart(app, {
    appPath: '/fixture/apps/desktop',
    argv: ['electron', '.', '--user-data-dir=fixture'],
    logPath: '/fixture/log',
    nodePath: '/fixture/node',
  });
  await Promise.resolve();
  await Promise.resolve();
  return { child, app, preparing };
}

it('助手就绪才注册提交，已被退出清理阻止的 will-quit 不提交，收到提交回执后继续正常退出', async () => {
  const { child, app, preparing } = await fixture();
  child.emit('message', { type: 'ready' });
  await preparing;
  const plan = JSON.parse(mocks.fork.mock.calls[0][1][0]);
  expect(plan.args).toEqual(['--user-data-dir=fixture', MANUAL_RESTART_ARG]);
  expect(app.quit).not.toHaveBeenCalled();
  app.emit('will-quit', { defaultPrevented: true, preventDefault: vi.fn() });
  expect(child.send).not.toHaveBeenCalled();
  const event = { defaultPrevented: false, preventDefault: vi.fn() };
  app.emit('will-quit', event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(child.send).toHaveBeenCalledWith({ type: 'commit' }, expect.any(Function));
  expect(app.quit).not.toHaveBeenCalled();
  child.emit('message', { type: 'committed' });
  expect(app.quit).toHaveBeenCalledOnce();
  expect(child.disconnect).toHaveBeenCalledOnce();
  expect(child.unref).toHaveBeenCalledOnce();
  expect(app.listenerCount('will-quit')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('助手启动错误在退出前返回，并释放子进程与监听', async () => {
  const { child, app, preparing } = await fixture();
  const failed = expect(preparing).rejects.toThrow('合成启动失败');
  child.emit('error', new Error('合成启动失败'));
  await failed;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(app.quit).not.toHaveBeenCalled();
  expect(app.listenerCount('will-quit')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
