import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloseConfirmDialog } from '../src/renderer/src/components/CloseConfirmDialog';

/**
 * 关闭确认框现在是唯一展示「退出会停止哪些后台服务」的地方 ——
 * 真正的退出动作（Dock / Cmd+Q / 托盘）已直通，不再弹框。
 *
 * 这里锁定两件事：主进程发来的服务名单要如实展示；渲染层回传的动作词
 * 必须和主进程 `window:respond-close` 的约定一致（tray / quit / cancel）。
 */

const ipc = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    listeners,
    sent: [] as Array<{ channel: string; payload: unknown }>,
  };
});

const trpcMock = vi.hoisted(() => ({
  mutateAsync: vi.fn(async (..._args: unknown[]) => undefined),
  invalidate: vi.fn(async () => undefined),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ bootstrap: { getSettings: { invalidate: trpcMock.invalidate } } }),
    bootstrap: {
      setWindowCloseBehavior: {
        useMutation: () => ({ mutateAsync: trpcMock.mutateAsync, isLoading: false }),
      },
    },
  },
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ipc.listeners.clear();
  ipc.sent = [];
  trpcMock.mutateAsync.mockClear();
  trpcMock.invalidate.mockClear();
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

/** 模拟主进程发来的关闭确认请求。 */
function ask(payload: { canMinimizeToTray?: boolean; services?: string[] }): void {
  act(() => {
    root.render(createElement(CloseConfirmDialog));
  });
  act(() => {
    ipc.listeners.get('window:confirm-close')?.({}, payload);
  });
}

function click(label: string): void {
  const button = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) throw new Error(`找不到按钮：${label}`);
  act(() => button.click());
}

describe('关闭确认框', () => {
  it('列出完全退出会停止的后台服务', () => {
    ask({ canMinimizeToTray: true, services: ['MCP 服务器', 'WeQ Web 服务'] });
    expect(document.querySelector('.weq-close-services-title')?.textContent).toContain(
      '完全退出将停止以下后台服务',
    );
    const items = [...document.querySelectorAll('.weq-close-services li')].map(
      (n) => n.textContent,
    );
    expect(items).toEqual(['MCP 服务器', 'WeQ Web 服务']);
  });

  it('没有后台服务时不渲染清单', () => {
    ask({ canMinimizeToTray: true, services: [] });
    expect(document.querySelector('.weq-close-services')).toBeNull();
  });

  it('托盘不可用时只提供完全退出', () => {
    ask({ canMinimizeToTray: false, services: ['MCP 服务器'] });
    const labels = [...document.querySelectorAll('.weq-close-opt strong')].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(['完全退出']);
  });

  it.each([
    ['最小化到系统托盘', 'tray'],
    ['完全退出', 'quit'],
    ['取消', 'cancel'],
  ] as const)('「%s」回传 %s', (label, action) => {
    ask({ canMinimizeToTray: true, services: ['MCP 服务器'] });
    click(label);
    expect(ipc.sent).toContainEqual({
      channel: 'window:respond-close',
      payload: action,
    });
  });

  it('勾选「不再询问」后先持久化本次选择，再回传动作', async () => {
    ask({ canMinimizeToTray: true, services: ['MCP 服务器'] });
    const checkbox = document.querySelector<HTMLButtonElement>(
      '.weq-close-remember [role="checkbox"]',
    );
    if (!checkbox) throw new Error('找不到「不再询问」勾选框');
    act(() => checkbox.click());
    click('完全退出');
    await vi.waitFor(() => expect(trpcMock.mutateAsync).toHaveBeenCalledWith({ behavior: 'quit' }));
    expect(trpcMock.invalidate).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(ipc.sent).toContainEqual({ channel: 'window:respond-close', payload: 'quit' }),
    );
  });

  it('取消不记忆关闭偏好', async () => {
    ask({ canMinimizeToTray: true, services: [] });
    const checkbox = document.querySelector<HTMLButtonElement>(
      '.weq-close-remember [role="checkbox"]',
    );
    if (!checkbox) throw new Error('找不到「不再询问」勾选框');
    act(() => checkbox.click());
    click('取消');
    expect(trpcMock.mutateAsync).not.toHaveBeenCalled();
    expect(ipc.sent).toContainEqual({ channel: 'window:respond-close', payload: 'cancel' });
  });
});
