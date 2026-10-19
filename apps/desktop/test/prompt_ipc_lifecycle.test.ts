import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAttachHintPrompt } from '../src/main/attach_hint';
import { registerAttachHintIpc } from '../src/main/attach_hint_ipc';
import { registerElevationIpc } from '../src/main/elevation_ipc';
import { requestSudoPassword } from '../src/main/sudo_prompt';

const fixture = vi.hoisted(() => ({
  win: null as PromptWindow | null,
  handlers: new Map<string, (event: { sender: unknown }, payload: unknown) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (event: { sender: unknown }, payload: unknown) => void) => {
      fixture.handlers.set(channel, handler);
    },
  },
}));
vi.mock('@weq/service', async () => ({
  ...(await import('../../../packages/service/src/common/shared_prompt')),
  getLogger: () => ({ child: () => ({ info: vi.fn() }) }),
}));
vi.mock('../src/main/main_window', () => ({ getMainWindow: () => fixture.win }));

class PromptWindow extends EventEmitter {
  destroyed = false;
  contentsDestroyed = false;
  readonly contents = {
    isDestroyed: () => this.contentsDestroyed,
    send: vi.fn(),
  };

  isDestroyed(): boolean {
    return this.destroyed;
  }

  get webContents(): typeof this.contents {
    // Electron 在窗口销毁后读取此属性就会抛错，尚未调用 isDestroyed()。
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return this.contents;
  }

  close(): void {
    this.destroyed = true;
    this.contentsDestroyed = true;
    this.emit('closed');
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.win = new PromptWindow();
  fixture.handlers.clear();
  registerElevationIpc();
  registerAttachHintIpc();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe.each([
  {
    name: '管理员密码',
    request: (signal?: AbortSignal) => requestSudoPassword('测试标题', '测试说明', signal),
    cancelled: null,
    requestChannel: 'elev:request-password',
    cancelChannel: 'elev:cancel-password',
    responseChannel: 'elev:respond-password',
    response: { password: 'fixture-password' },
    answer: 'fixture-password',
  },
  {
    name: '附加确认',
    request: (signal?: AbortSignal) => getAttachHintPrompt()!(signal),
    cancelled: { choice: 'cancel', password: '' },
    requestChannel: 'attach:confirm-hint',
    cancelChannel: 'attach:cancel-hint',
    responseChannel: 'attach:respond-hint',
    response: { choice: 'retry', password: 'fixture-password' },
    answer: { choice: 'retry', password: 'fixture-password' },
  },
])('$name提示生命周期', (dialog) => {
  it('窗口销毁后关闭提示不抛异常，并取消所有等待者', async () => {
    const win = fixture.win!;
    const first = dialog.request();
    const second = dialog.request();
    expect(win.contents.send).toHaveBeenCalledOnce();
    expect(() => win.close()).not.toThrow();
    await expect(first).resolves.toEqual(dialog.cancelled);
    await expect(second).resolves.toEqual(dialog.cancelled);
    expect(win.contents.send).toHaveBeenCalledOnce();
    expect(win.listenerCount('closed')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('窗口存活时取消或超时仍通知渲染层并清理监听', async () => {
    const win = fixture.win!;
    const controller = new AbortController();
    const aborted = dialog.request(controller.signal);
    controller.abort();
    await expect(aborted).resolves.toEqual(dialog.cancelled);
    expect(win.contents.send).toHaveBeenLastCalledWith(dialog.cancelChannel, {
      token: expect.any(Number),
    });

    const timedOut = dialog.request();
    vi.runAllTimers();
    await expect(timedOut).resolves.toEqual(dialog.cancelled);
    expect(win.contents.send).toHaveBeenLastCalledWith(dialog.cancelChannel, {
      token: expect.any(Number),
    });
    expect(win.listenerCount('closed')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('渲染进程已销毁时取消不再发送 IPC', async () => {
    const win = fixture.win!;
    const controller = new AbortController();
    const result = dialog.request(controller.signal);
    win.contentsDestroyed = true;
    controller.abort();
    await expect(result).resolves.toEqual(dialog.cancelled);
    expect(win.contents.send).toHaveBeenCalledOnce();
    expect(win.listenerCount('closed')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('正常响应后可再次打开提示，旧窗口关闭不影响新窗口', async () => {
    const win = fixture.win!;
    const result = dialog.request();
    const request = win.contents.send.mock.calls[0];
    expect(request[0]).toBe(dialog.requestChannel);
    fixture.handlers.get(dialog.responseChannel)!(
      { sender: win.contents },
      {
        ...dialog.response,
        token: request[1].token,
      },
    );
    await expect(result).resolves.toEqual(dialog.answer);
    fixture.win = new PromptWindow();
    const next = dialog.request();
    expect(() => win.close()).not.toThrow();
    expect(fixture.win.contents.send).toHaveBeenCalledOnce();
    expect(() => fixture.win!.close()).not.toThrow();
    await expect(next).resolves.toEqual(dialog.cancelled);
  });
});
