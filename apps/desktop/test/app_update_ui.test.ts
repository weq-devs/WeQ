import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateEvent } from '../src/main/update/state';
import { UpdateCard } from '../src/renderer/src/components/settings/UpdateCard';
import { NativeExpiredDialog } from '../src/renderer/src/components/NativeExpiredDialog';

const fixture = vi.hoisted(() => ({
  event: null as ((event: UpdateEvent) => void) | null,
  install: vi.fn(async () => true),
  check: vi.fn(),
  download: vi.fn(),
  showError: vi.fn(),
  state: {
    current: '1.0.0',
    latest: '1.1.0',
    hasUpdate: true,
    base: 'https://synthetic.invalid',
    ranked: [],
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: { getVersionInfo: { useQuery: () => ({ data: { app: '1.0.0', isDev: false } }) } },
    update: {
      getState: { useQuery: () => ({ data: fixture.state }) },
      install: { useMutation: () => ({ mutateAsync: fixture.install }) },
      check: { useMutation: () => ({ mutateAsync: fixture.check }) },
      download: { useMutation: () => ({ mutateAsync: fixture.download }) },
    },
  },
  client: {
    update: {
      onEvent: {
        subscribe: (_input: unknown, callbacks: { onData(event: UpdateEvent): void }) => {
          fixture.event = callbacks.onData;
          return {
            unsubscribe: () => {
              fixture.event = null;
            },
          };
        },
      },
      onProgress: { subscribe: () => ({ unsubscribe: () => {} }) },
    },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => fixture.showError,
  Modal: ({ children }: { children: ReactNode }) => children,
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.install.mockReset().mockResolvedValue(true);
  fixture.showError.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function installButton() {
  return [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('重启并安装'),
  )!;
}
async function downloaded(kind: 'settings' | 'expired') {
  await act(async () =>
    root.render(
      kind === 'settings' ? createElement(UpdateCard) : createElement(NativeExpiredDialog),
    ),
  );
  await act(async () => fixture.event?.({ kind: 'downloaded', latest: '1.1.0' }));
}

describe('重启并安装反馈', () => {
  it.each(['settings', 'expired'] as const)('%s 点击安装进入在途状态，不重复提交', async (kind) => {
    await downloaded(kind);
    const button = installButton();
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
      button.click();
    });
    expect(fixture.install).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('正在重启');
    expect(document.querySelector<HTMLButtonElement>('[aria-busy="true"]')?.disabled).toBe(true);
  });

  it('异步安装错误显示原因并恢复安装入口，不退回重新下载', async () => {
    await downloaded('settings');
    await act(async () => installButton().click());
    await act(async () => fixture.event?.({ kind: 'error', message: '合成安装失败' }));
    expect(fixture.showError).toHaveBeenCalledWith('更新失败', '合成安装失败');
    expect(installButton()?.disabled).toBe(false);
    await act(async () => installButton().click());
    expect(fixture.install).toHaveBeenCalledTimes(2);
  });

  it('安装 RPC 失败同样恢复入口并显示错误', async () => {
    fixture.install.mockRejectedValueOnce(new Error('合成安装拒绝'));
    await downloaded('expired');
    await act(async () => installButton().click());
    expect(fixture.showError).toHaveBeenCalledWith('安装失败', '合成安装拒绝');
    expect(installButton()?.disabled).toBe(false);
  });

  it('安装事件已反馈同步错误时，RPC 拒绝不再弹第二次', async () => {
    fixture.install.mockImplementationOnce(async () => {
      fixture.event?.({ kind: 'error', message: '合成同步安装失败' });
      throw new Error('合成同步安装失败');
    });
    await downloaded('settings');
    await act(async () => installButton().click());
    expect(fixture.showError).toHaveBeenCalledOnce();
    expect(installButton()?.disabled).toBe(false);
  });
});
