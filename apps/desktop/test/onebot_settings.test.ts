import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { OneBotSection } from '../src/renderer/src/components/settings/OneBotSection';

const mocks = vi.hoisted(() => ({
  data: {
    enabled: true,
    running: true,
    clients: 1,
    accountOpen: true,
    url: 'ws://127.0.0.1:48766',
    servers: [
      {
        id: 'ws-main',
        type: 'ws' as const,
        name: '主 WebSocket',
        enabled: true,
        port: 48766,
        requestedPort: 48766,
        token: 'synthetic-ws',
        running: true,
        clients: 1,
        url: 'ws://127.0.0.1:48766',
      },
      {
        id: 'http-main',
        type: 'http' as const,
        name: 'HTTP 接口',
        enabled: false,
        port: 48767,
        requestedPort: 48767,
        token: 'synthetic-http',
        enableCors: true,
        running: false,
        clients: 0,
        url: 'http://127.0.0.1:48767',
      },
    ],
  },
  refetch: vi.fn(),
  error: vi.fn(),
  toast: vi.fn(),
  copy: vi.fn(),
  master: vi.fn().mockResolvedValue({}),
  save: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue({}),
  toggle: vi.fn().mockResolvedValue({}),
  regenerate: vi.fn().mockResolvedValue({}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getOneBotStatus: {
        useQuery: () => ({ data: mocks.data, refetch: mocks.refetch, error: null }),
      },
      setOneBotEnabled: {
        useMutation: () => ({ mutateAsync: mocks.master, isLoading: false }),
      },
      saveOneBotServer: {
        useMutation: () => ({ mutateAsync: mocks.save, isLoading: false }),
      },
      deleteOneBotServer: {
        useMutation: () => ({ mutateAsync: mocks.remove, isLoading: false }),
      },
      setOneBotServerEnabled: {
        useMutation: () => ({ mutateAsync: mocks.toggle, isLoading: false }),
      },
      regenerateOneBotServerToken: {
        useMutation: () => ({ mutateAsync: mocks.regenerate, isLoading: false }),
      },
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

it('renders independent WS and HTTP cards, toggles them and copies the selected WS config', async () => {
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
    const cards = [...host.querySelectorAll('.weq-set-card')];
    expect(cards.map((card) => card.querySelector('.weq-set-card-title')?.textContent)).toEqual([
      '总开关',
      '网络服务器',
      'cc-connect 配置',
    ]);
    expect(host.querySelectorAll('.weq-onebot-server-card')).toHaveLength(2);
    expect(host.textContent).toContain('主 WebSocket');
    expect(host.textContent).toContain('HTTP 接口');
    expect(host.textContent).toContain('运行中 · 1 个连接');

    const toggles = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    await act(async () => toggles[0]!.click());
    expect(mocks.master).toHaveBeenLastCalledWith({ enabled: false });
    await act(async () => toggles[1]!.click());
    expect(mocks.toggle).toHaveBeenLastCalledWith({
      id: 'ws-main',
      type: 'ws',
      enabled: false,
    });

    const copyConfig = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('复制配置'),
    )!;
    await act(async () => copyConfig.click());
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringContaining('ws_url = "ws://127.0.0.1:48766"'),
    );
    expect(mocks.copy.mock.calls.at(-1)?.[0]).not.toContain('http_url');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('creates an HTTP server from a compact card editor', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(OneBotSection)));
    const addHttp = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'HTTP',
    )!;
    await act(async () => addHttp.click());
    const name = host.querySelector<HTMLInputElement>('[aria-label="OneBot 服务器名称"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        '自动化 HTTP',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = host.querySelector<HTMLFormElement>('.weq-onebot-server-form')!;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true })));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'http',
        name: '自动化 HTTP',
        enabled: true,
        port: 48768,
        enableCors: true,
      }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('reports master switch failures and refreshes the actual service state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.master.mockRejectedValueOnce(new Error('synthetic port in use'));
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
