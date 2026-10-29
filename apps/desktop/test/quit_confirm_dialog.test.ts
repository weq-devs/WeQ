import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuitConfirmDialog } from '../src/renderer/src/components/QuitConfirmDialog';

/**
 * 渲染层与主进程的 `choice` 词汇必须一致。
 *
 * 回归用例：按钮一度发的是 `'tray'`，而主进程只认 `'window'`，非法值被归一成
 * `cancel` —— 用户点「最小化到托盘」什么都不发生，窗口既不隐藏也不退出。
 * 这里直接断言渲染层真正发出去的字符串。
 */

const ipc = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    listeners,
    sent: [] as Array<{ channel: string; payload: unknown }>,
  };
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ipc.listeners.clear();
  ipc.sent = [];
  vi.stubGlobal('electron', {
    ipcRenderer: {
      on: (channel: string, cb: (...args: unknown[]) => void) => {
        ipc.listeners.set(channel, cb);
        return () => ipc.listeners.delete(channel);
      },
      send: (channel: string, payload: unknown) => {
        ipc.sent.push({ channel, payload });
      },
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** 模拟主进程发来的退出确认请求。 */
function ask(services: string[], token = 7): void {
  act(() => {
    root.render(createElement(QuitConfirmDialog));
  });
  act(() => {
    ipc.listeners.get('quit:confirm')?.({}, { token, services });
  });
}

function click(label: string): void {
  const button = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) throw new Error(`找不到按钮：${label}`);
  act(() => button.click());
}

describe('退出确认框', () => {
  it('列出主进程给的服务名', () => {
    ask(['MCP 服务器', 'OneBot 服务']);
    const items = [...document.querySelectorAll('.weq-quit-services li')].map((n) => n.textContent);
    expect(items).toEqual(['MCP 服务器', 'OneBot 服务']);
  });

  it('「最小化到托盘」发出 window —— 主进程只认这个词', () => {
    ask(['MCP 服务器']);
    click('最小化到托盘');
    expect(ipc.sent).toContainEqual({
      channel: 'quit:respond',
      payload: { token: 7, choice: 'window', remember: false },
    });
  });

  it('「完全退出」发出 quit', () => {
    ask(['MCP 服务器']);
    click('完全退出');
    expect(ipc.sent).toContainEqual({
      channel: 'quit:respond',
      payload: { token: 7, choice: 'quit', remember: false },
    });
  });

  it('取消发出 cancel', () => {
    ask(['MCP 服务器']);
    click('取消');
    expect(ipc.sent).toContainEqual({
      channel: 'quit:respond',
      payload: { token: 7, choice: 'cancel', remember: false },
    });
  });

  it('勾了不再询问时随选择一起带上，取消则不带', () => {
    ask(['MCP 服务器']);
    const box = document.querySelector<HTMLInputElement>('.weq-close-remember input')!;
    act(() => box.click());
    click('完全退出');
    expect(ipc.sent.at(-1)).toEqual({
      channel: 'quit:respond',
      payload: { token: 7, choice: 'quit', remember: true },
    });

    ipc.sent = [];
    ask(['MCP 服务器'], 8);
    const box2 = document.querySelector<HTMLInputElement>('.weq-close-remember input')!;
    act(() => box2.click());
    click('取消');
    expect(ipc.sent.at(-1)).toEqual({
      channel: 'quit:respond',
      payload: { token: 8, choice: 'cancel', remember: false },
    });
  });

  it('主进程放弃等待时收起，不留下死框', () => {
    ask(['MCP 服务器']);
    expect(document.querySelector('.weq-quit')).not.toBeNull();
    act(() => {
      ipc.listeners.get('quit:cancel-confirm')?.({}, { token: 7 });
    });
    expect(document.querySelector('.weq-quit')).toBeNull();
  });

  it('token 不匹配的取消通知不会收起当前框', () => {
    ask(['MCP 服务器']);
    act(() => {
      ipc.listeners.get('quit:cancel-confirm')?.({}, { token: 999 });
    });
    expect(document.querySelector('.weq-quit')).not.toBeNull();
  });
});
