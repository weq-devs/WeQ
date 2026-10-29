import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { OneBotSection } from '../src/renderer/src/components/settings/OneBotSection';

const mocks = vi.hoisted(() => ({
  data: {
    enabled: false,
    port: 48766,
    token: 'synthetic',
    running: false,
    clients: 0,
    accountOpen: true,
    url: 'ws://127.0.0.1:48766',
  },
  mutate: vi.fn().mockResolvedValue({}),
  refetch: vi.fn(),
  error: vi.fn(),
  toast: vi.fn(),
  copy: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getOneBotStatus: { useQuery: () => ({ data: mocks.data, refetch: mocks.refetch }) },
      setOneBotConfig: { useMutation: () => ({ mutateAsync: mocks.mutate, isLoading: false }) },
    },
  },
}));
vi.mock('../src/renderer/src/components/RetainedTabs', () => ({ useTabActive: () => true }));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select: (store: unknown) => unknown) => select({ showError: mocks.error }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (select: (store: unknown) => unknown) => select({ push: mocks.toast }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('shows live status, persists the toggle, masks the token and copies the native QQ platform config', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.copy },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(OneBotSection)));
    const token = host.querySelector<HTMLInputElement>('[aria-label="OneBot 访问令牌"]')!;
    expect(token.type).toBe('password');
    expect(host.textContent).toContain('已停止');
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.mutate).toHaveBeenLastCalledWith({ enabled: true });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="显示令牌"]')!.click(),
    );
    expect(token.type).toBe('text');
    const copy = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('复制 cc-connect 配置'),
    )!;
    await act(async () => copy.click());
    expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining('type = "qq"'));
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringContaining('ws_url = "ws://127.0.0.1:48766"'),
    );
    expect(mocks.copy.mock.calls.at(-1)?.[0]).not.toContain('http_url');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="重新生成令牌"]')!.click(),
    );
    expect(mocks.mutate).toHaveBeenLastCalledWith({ regenerateToken: true });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('reports enable failures and refreshes the actual service state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.mutate.mockRejectedValueOnce(new Error('synthetic port in use'));
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(OneBotSection)));
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(mocks.error).toHaveBeenCalledWith('OneBot 配置失败', 'synthetic port in use');
    expect(mocks.refetch).toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
