import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerAppQuitCleanup, registerAppQuitPreparation } from '../src/main/app_quit_lifecycle';

describe('彻底退出的异步清理', () => {
  it('原生更新退出交给安装器，不拦截或改成普通退出', () => {
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    const updater = new EventEmitter();
    const cleanup = vi.fn();
    registerAppQuitCleanup(app, cleanup, vi.fn(), updater);
    updater.emit('before-quit-for-update');
    const preventDefault = vi.fn();
    app.emit('before-quit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });
  it('Cmd+Q 发起退出后先等待后台停止，重复退出不会重复清理', async () => {
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    let finish = () => {};
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const failed = vi.fn();
    registerAppQuitCleanup(app, cleanup, failed);
    const preventDefault = vi.fn();
    app.emit('before-quit', { preventDefault });
    app.emit('before-quit', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    preventDefault.mockClear();
    app.emit('before-quit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('清理失败会记录原因并继续退出，不把 GUI 永久留在后台', async () => {
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    const error = new Error('合成停止失败');
    const failed = vi.fn();
    registerAppQuitCleanup(app, () => Promise.reject(error), failed);
    app.emit('before-quit', { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(failed).toHaveBeenCalledWith(error);
  });

  it('清理后仍尊重更新安装在 will-quit 的取消，不额外强制退出', async () => {
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    registerAppQuitCleanup(app, async () => {}, vi.fn());
    const commit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    app.once('will-quit', commit);
    app.quit.mockImplementation(() => {
      const event = { preventDefault: vi.fn() };
      app.emit('before-quit', event);
      if (!event.preventDefault.mock.calls.length) app.emit('will-quit', event);
    });
    app.quit();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(app.quit).toHaveBeenCalledTimes(2);
  });
});

describe('更新安装的退出顺序', () => {
  it.each(['ask', 'tray', 'quit'] as const)(
    '%s 关闭偏好下，更新先关窗口时已经进入退出状态',
    (behavior) => {
      const app = new EventEmitter();
      const updater = new EventEmitter();
      let quitting = false;
      const prepare = vi.fn(() => {
        quitting = true;
      });
      registerAppQuitPreparation(app, updater, prepare);
      // Electron 更新安装：专用退出事件 → 窗口 close → 普通 before-quit。
      updater.emit('before-quit-for-update');
      expect(quitting).toBe(true);
      const preventDefault = vi.fn();
      const hideToTray = vi.fn();
      if (!quitting && behavior !== 'quit') {
        preventDefault();
        if (behavior === 'tray') hideToTray();
      }
      expect(preventDefault).not.toHaveBeenCalled();
      expect(hideToTray).not.toHaveBeenCalled();
      app.emit('before-quit');
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it('普通退出仍准备；重复更新／退出事件不会重复保存或清理', () => {
    const app = new EventEmitter();
    const updater = new EventEmitter();
    const prepare = vi.fn();
    registerAppQuitPreparation(app, updater, prepare);
    expect(prepare).not.toHaveBeenCalled();
    app.emit('before-quit');
    updater.emit('before-quit-for-update');
    app.emit('before-quit');
    expect(prepare).toHaveBeenCalledOnce();
  });
});
