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
  setInterval: vi.fn(async ({ minutes }: { minutes: number }) => minutes),
  setPrerelease: vi.fn(async ({ enabled }: { enabled: boolean }) => enabled),
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
    useContext: () => ({
      update: {
        getInterval: { setData: vi.fn() },
        getPrerelease: { setData: vi.fn() },
        getState: { setData: vi.fn() },
      },
    }),
    bootstrap: { getVersionInfo: { useQuery: () => ({ data: { app: '1.0.0', isDev: false } }) } },
    update: {
      getInterval: { useQuery: () => ({ data: 60 }) },
      setInterval: { useMutation: () => ({ mutateAsync: fixture.setInterval, isLoading: false }) },
      getPrerelease: { useQuery: () => ({ data: false }) },
      setPrerelease: {
        useMutation: () => ({ mutateAsync: fixture.setPrerelease, isLoading: false }),
      },
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
  fixture.state = {
    current: '1.0.0',
    latest: '1.1.0',
    hasUpdate: true,
    base: 'https://synthetic.invalid',
    ranked: [],
  };
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
  it('自动检查失败后恢复手动检查按钮，不弹出后台失败提示', async () => {
    fixture.state = { ...fixture.state, hasUpdate: false, latest: null };
    await act(async () => root.render(createElement(UpdateCard)));
    await act(async () => fixture.event?.({ kind: 'checking', mirrors: 3 }));
    expect(document.body.textContent).toContain('测速中');
    await act(async () => fixture.event?.({ kind: 'check-failed' }));
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === '检查更新',
    );
    expect(button?.disabled).toBe(false);
    expect(fixture.showError).not.toHaveBeenCalled();
  });
  it('频率默认 60，无上限，-1 可保存且零值不能提交', async () => {
    await act(async () => root.render(createElement(UpdateCard)));
    const input = document.querySelector<HTMLInputElement>('input[type="number"]')!;
    const save = document.querySelector<HTMLButtonElement>('[aria-label="保存自动检查更新频率"]')!;
    expect(input.value).toBe('60');
    expect(input.hasAttribute('max')).toBe(false);
    for (const value of ['-1', '100000', '0']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(save.disabled).toBe(value === '0');
      if (value !== '0') {
        await act(async () => save.click());
        expect(fixture.setInterval).toHaveBeenLastCalledWith({ minutes: Number(value) });
      }
    }
  });
  it('测试版开关独立保存，切换后清除旧检查结果', async () => {
    await act(async () => root.render(createElement(UpdateCard)));
    const toggle = document.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="检查测试版"]',
    )!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(fixture.setPrerelease).toHaveBeenCalledWith({ enabled: true });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain('检查更新');
  });
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

describe('包管理器（AUR）托管的副本', () => {
  function updateButton() {
    return [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('立即更新'),
    )!;
  }

  it.each(['settings', 'expired'] as const)('%s 禁用下载按钮并给出 paru 指引', async (kind) => {
    fixture.state = { ...fixture.state, managed: true };
    await act(async () =>
      root.render(
        kind === 'settings' ? createElement(UpdateCard) : createElement(NativeExpiredDialog),
      ),
    );
    await act(async () => fixture.event?.({ kind: 'available', latest: '1.1.0' }));
    const button = updateButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('paru -Syu');
    expect(document.body.textContent).toContain('paru -Syu');
  });

  it('托管时仍可检查更新', async () => {
    // 无可用更新时卡片回到「检查更新」，这是托管副本唯一保留的入口。
    fixture.state = { ...fixture.state, managed: true, hasUpdate: false, latest: null };
    await act(async () => root.render(createElement(UpdateCard)));
    const check = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('检查更新'),
    )!;
    expect(check.disabled).toBe(false);
  });

  it('普通安装版保持「立即更新」可用', async () => {
    await act(async () => root.render(createElement(UpdateCard)));
    await act(async () => fixture.event?.({ kind: 'available', latest: '1.1.0' }));
    expect(updateButton().disabled).toBe(false);
    expect(document.body.textContent).not.toContain('paru -Syu');
  });
});
