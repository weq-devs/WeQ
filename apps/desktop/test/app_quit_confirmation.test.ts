// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  registerAppQuitConfirmation,
  skipNextQuitConfirmation,
  type QuitChoice,
} from '../src/main/app_quit_confirmation';
import { registerAppQuitCleanup, registerAppQuitPreparation } from '../src/main/app_quit_lifecycle';

class FakeApp extends EventEmitter {
  exits = 0;
  quit() {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.emit('before-quit', event);
    if (event.defaultPrevented) return;
    this.emit('will-quit', event);
    if (!event.defaultPrevented) this.exits += 1;
  }
}
function fixture() {
  const app = new FakeApp();
  const updater = new EventEmitter();
  const prepare = vi.fn();
  const cleanup = vi.fn(async () => {});
  const failed = vi.fn();
  let choose = (_choice: QuitChoice) => {};
  const showDialog = vi.fn(
    () =>
      new Promise<QuitChoice>((resolve) => {
        choose = resolve;
      }),
  );
  const hideWindow = vi.fn();
  let enabled = true;
  let updating = false;
  registerAppQuitPreparation(app, updater, prepare);
  registerAppQuitCleanup(app, cleanup, failed, updater);
  registerAppQuitConfirmation(app, updater, {
    needsConfirmation: () => enabled,
    bypass: () => updating,
    showDialog,
    hideWindow,
    failed,
  });
  return {
    app,
    updater,
    prepare,
    cleanup,
    showDialog,
    hideWindow,
    failed,
    choose: (choice: QuitChoice) => choose(choice),
    disable: () => {
      enabled = false;
    },
    update: () => {
      updating = true;
    },
  };
}
describe('助手开启时的退出确认', () => {
  it.each(['cancel', 'window'] as const)(
    '%s 不触发退出准备或资源清理，下一次仍可正常询问',
    async (choice) => {
      const f = fixture();
      f.app.quit();
      f.app.quit();
      expect(f.showDialog).toHaveBeenCalledOnce();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.cleanup).not.toHaveBeenCalled();
      f.choose(choice);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.app.exits).toBe(0);
      expect(f.hideWindow).toHaveBeenCalledTimes(choice === 'window' ? 1 : 0);
      f.app.quit();
      expect(f.showDialog).toHaveBeenCalledTimes(2);
      f.choose('cancel');
    },
  );
  it('确认退出后只问一次，准备与清理正常执行', async () => {
    const f = fixture();
    f.app.quit();
    f.choose('quit');
    await vi.waitFor(() => expect(f.app.exits).toBe(1));
    expect(f.showDialog).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });
  it('助手未启用时不询问', async () => {
    const f = fixture();
    f.disable();
    f.app.quit();
    await vi.waitFor(() => expect(f.app.exits).toBe(1));
    expect(f.showDialog).not.toHaveBeenCalled();
  });
  it.each(['native', 'installing', 'restart'] as const)(
    '%s 退出保留原流程，不被助手提示拦截',
    async (kind) => {
      const f = fixture();
      if (kind === 'native') f.updater.emit('before-quit-for-update');
      if (kind === 'installing') f.update();
      if (kind === 'restart') skipNextQuitConfirmation();
      f.app.quit();
      await vi.waitFor(() => expect(f.app.exits).toBe(1));
      expect(f.showDialog).not.toHaveBeenCalled();
    },
  );
  it('询问期间开始原生更新，迟到的只关窗口选择不会隐藏重开的窗口', async () => {
    const f = fixture();
    f.app.quit();
    f.updater.emit('before-quit-for-update');
    f.app.quit();
    f.choose('window');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.app.exits).toBe(1);
    expect(f.hideWindow).not.toHaveBeenCalled();
  });
});
