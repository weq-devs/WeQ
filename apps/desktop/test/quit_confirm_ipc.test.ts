// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 退出确认的 IPC 桥。只验证协议本身：窗口不可用直接放行、token 不匹配忽略、
 * 隐藏窗口先唤出、超时兜底、并发请求合并。真正的 Electron 事件顺序由
 * `app_quit_confirmation.test.ts` 覆盖。
 */

class FakeWebContents extends EventEmitter {
  sent: Array<{ channel: string; payload: unknown }> = [];
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

class FakeWindow extends EventEmitter {
  webContents = new FakeWebContents();
  visible = true;
  destroyed = false;
  shown = 0;
  focused = 0;
  isVisible(): boolean {
    return this.visible;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  show(): void {
    this.visible = true;
    this.shown += 1;
  }
  focus(): void {
    this.focused += 1;
  }
}

const harness = vi.hoisted(() => ({
  window: null as FakeWindow | null,
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      harness.listeners.set(channel, listener);
    },
    removeListener: (channel: string) => {
      harness.listeners.delete(channel);
    },
  },
}));
vi.mock('../src/main/main_window', () => ({ getMainWindow: () => harness.window }));

const { registerQuitConfirmIpc, promptQuitConfirm } = await import('../src/main/quit_confirm_ipc');

function respond(window: FakeWindow, payload: unknown): void {
  const listener = harness.listeners.get('quit:respond');
  if (!listener) throw new Error('quit:respond 未注册');
  listener({ sender: window.webContents }, payload);
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.window = new FakeWindow();
  harness.listeners.clear();
  registerQuitConfirmIpc();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('退出确认 IPC', () => {
  it('窗口不可用时直接放行退出，不卡住 before-quit', async () => {
    harness.window = null;
    await expect(promptQuitConfirm(['MCP 服务器'])).resolves.toEqual({
      choice: 'quit',
      remember: false,
    });
  });

  it('窗口在托盘里时先唤出再发确认', async () => {
    const win = harness.window!;
    win.visible = false;
    const pending = promptQuitConfirm(['MCP 服务器', 'OneBot 服务']);
    expect(win.shown).toBe(1);
    expect(win.focused).toBe(1);
    expect(win.webContents.sent).toHaveLength(1);
    const sent = win.webContents.sent[0]!;
    expect(sent.channel).toBe('quit:confirm');
    expect(sent.payload).toMatchObject({ services: ['MCP 服务器', 'OneBot 服务'] });
    respond(win, {
      token: (sent.payload as { token: number }).token,
      choice: 'window',
      remember: true,
    });
    await expect(pending).resolves.toEqual({ choice: 'window', remember: true });
  });

  it('token 不匹配的应答被忽略', async () => {
    const win = harness.window!;
    const pending = promptQuitConfirm(['SSE 消息推送']);
    respond(win, { token: 9999, choice: 'quit', remember: false });
    // 还没结束：换成正确的 token 才收尾。
    respond(win, {
      token: (win.webContents.sent[0]!.payload as { token: number }).token,
      choice: 'cancel',
      remember: false,
    });
    await expect(pending).resolves.toEqual({ choice: 'cancel', remember: false });
  });

  it('其他窗口的应答被忽略', async () => {
    const win = harness.window!;
    const pending = promptQuitConfirm(['WeQ Remote']);
    const stranger = new FakeWindow();
    respond(stranger, {
      token: (win.webContents.sent[0]!.payload as { token: number }).token,
      choice: 'quit',
      remember: false,
    });
    respond(win, {
      token: (win.webContents.sent[0]!.payload as { token: number }).token,
      choice: 'quit',
      remember: false,
    });
    await expect(pending).resolves.toEqual({ choice: 'quit', remember: false });
  });

  it('渲染层发的「最小化到托盘」用 window 这个词，主进程认得', async () => {
    // 回归：曾把渲染层的按钮发成 'tray'，而主进程只认 'window'，结果归一成
    // cancel —— 用户点「最小化到托盘」什么都不发生，窗口既不隐藏也不退出。
    const win = harness.window!;
    const pending = promptQuitConfirm(['MCP 服务器']);
    respond(win, {
      token: (win.webContents.sent[0]!.payload as { token: number }).token,
      choice: 'window',
      remember: false,
    });
    await expect(pending).resolves.toEqual({ choice: 'window', remember: false });
  });

  it('未知 choice 归一成 cancel', async () => {
    const win = harness.window!;
    const pending = promptQuitConfirm(['MCP 服务器']);
    respond(win, {
      token: (win.webContents.sent[0]!.payload as { token: number }).token,
      choice: 'drop-database',
      remember: true,
    });
    await expect(pending).resolves.toEqual({ choice: 'cancel', remember: false });
  });

  it('超时后按取消处理，并通知渲染层收起', async () => {
    const win = harness.window!;
    const pending = promptQuitConfirm(['MCP 服务器']);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toEqual({ choice: 'cancel', remember: false });
    expect(win.webContents.sent.map((s) => s.channel)).toContain('quit:cancel-confirm');
  });

  it('并发请求合并到同一个确认框', async () => {
    const win = harness.window!;
    const first = promptQuitConfirm(['MCP 服务器']);
    const second = promptQuitConfirm(['MCP 服务器']);
    expect(win.webContents.sent).toHaveLength(1);
    respond(win, {
      token: (win.webContents.sent[0]!.payload as { token: number }).token,
      choice: 'quit',
      remember: false,
    });
    await expect(first).resolves.toEqual({ choice: 'quit', remember: false });
    await expect(second).resolves.toEqual({ choice: 'quit', remember: false });
  });
});
