import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerAppQuitPreparation } from '../src/main/app_quit_lifecycle';

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
