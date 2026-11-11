import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BootstrapView } from '../src/renderer/src/views/BootstrapView';
import { useViewState } from '../src/renderer/src/state/view';
import { QueryClient } from '@tanstack/react-query';
import { WebStartupCache, WEB_STARTUP_CACHE_KEY } from '../src/renderer/src/lib/webStartupCache';

const api = vi.hoisted(() => ({
  web: true,
  current: { uin: '10002' } as { uin: string } | null,
  currentError: false,
  startupPage: 'home' as 'home' | 'messages' | 'last',
  mutate: vi.fn(async () => ({ success: true })),
  warmup: vi.fn(async () => {}),
  remoteWarmup: vi.fn(async () => {}),
  error: vi.fn(),
  utils: {
    account: {
      getAccountConfig: {
        fetch: vi.fn(async () => ({})),
        getData: vi.fn(() => undefined as unknown),
      },
    },
  },
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return api.web;
  },
  IS_MAC: true,
  DesktopOnly: () => null,
  shellBridge: () => undefined,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => api.error,
}));
vi.mock('../src/renderer/src/lib/windowLayout', () => ({ setWindowLayout: vi.fn() }));
vi.mock('../src/renderer/src/lib/accountWarmup', () => ({
  runAccountWarmup: api.warmup,
  runRemoteIdentityWarmup: api.remoteWarmup,
}));
vi.mock('../src/renderer/src/views/bootstrap/SelectScreen', () => ({ SelectScreen: () => null }));
vi.mock('../src/renderer/src/components/settings/BackupSection', () => ({
  BackupSection: () => null,
}));
vi.mock('../src/renderer/src/components/NativeExpiredDialog', () => ({
  NativeExpiredDialog: () => null,
}));
vi.mock('../src/renderer/src/components/WarmupSplash', () => ({ WarmupSplash: () => null }));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (key === 'useUtils') return () => api.utils;
        if (key === 'mutate') return api.mutate;
        if (key === 'useQuery')
          return (_input: unknown, opts?: { enabled?: boolean }) => ({
            data: path.endsWith('currentAccount')
              ? api.current
              : path.endsWith('getAutoEnter')
                ? { configId: 'other-account' }
                : path.endsWith('listAccountConfigs')
                  ? [{ configId: 'other-account', uin: '10001', dbKey: 'synthetic' }]
                  : path.endsWith('describeInstall')
                    ? { hasQqExe: true, hasWrapper: true }
                    : path.endsWith('getStartupPage')
                      ? api.startupPage
                      : null,
            isSuccess: !(path.endsWith('currentAccount') && api.currentError),
            isError: path.endsWith('currentAccount') && api.currentError,
            isFetched: opts?.enabled !== false,
            isLoading: false,
            error: api.currentError ? new Error('合成会话读取失败') : null,
          });
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.web = true;
  api.current = { uin: '10002' };
  api.currentError = false;
  api.startupPage = 'home';
  vi.clearAllMocks();
  api.remoteWarmup.mockReset().mockResolvedValue(undefined);
  api.utils.account.getAccountConfig.fetch.mockReset().mockResolvedValue({});
  api.utils.account.getAccountConfig.getData.mockReset().mockReturnValue(undefined);
  useViewState.setState({
    view: 'bootstrap',
    openedUin: null,
    homeStage: 'booting',
    startupPage: null,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    root.render(createElement(BootstrapView));
  });
}

it('Web 复用实际已打开账号，只读必要配置，不等待身份或目录预热', async () => {
  await render();
  expect(useViewState.getState()).toMatchObject({
    view: 'main',
    openedUin: '10002',
    homeStage: 'home',
  });
  expect(api.mutate).not.toHaveBeenCalled();
  expect(api.warmup).not.toHaveBeenCalled();
  expect(api.remoteWarmup).not.toHaveBeenCalled();
  expect(api.utils.account.getAccountConfig.fetch).toHaveBeenCalledOnce();
});
it('Remote 必要账号配置尚未就绪时不能先挂载工作区', async () => {
  let finish!: () => void;
  api.utils.account.getAccountConfig.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({});
      }),
  );
  await render();
  expect(api.remoteWarmup).not.toHaveBeenCalled();
  expect(useViewState.getState()).toMatchObject({ view: 'bootstrap', openedUin: null });
  await act(async () => finish());
  expect(useViewState.getState()).toMatchObject({
    view: 'main',
    openedUin: '10002',
    startupPage: null,
  });
});
it.each(['home', 'messages', 'last'] as const)(
  '桌面重新启动将 %s 偏好传入工作区，只有上次页面保留现场',
  async (page) => {
    api.web = false;
    api.current = null;
    api.startupPage = page;
    await render();
    expect(useViewState.getState()).toMatchObject({
      view: 'main',
      openedUin: '10001',
      startupPage: page === 'last' ? null : page,
    });
  },
);
it('启动快照已提供配置时直接接回工作区，不追加一次配置读取', async () => {
  const cache = new QueryClient();
  cache.setQueryData(WEB_STARTUP_CACHE_KEY, true);
  api.utils.account.getAccountConfig.getData.mockReturnValue({
    configId: 'synthetic',
    uin: '10002',
  });
  await act(async () =>
    root.render(
      createElement(WebStartupCache.Provider, { value: cache }, createElement(BootstrapView)),
    ),
  );
  expect(api.utils.account.getAccountConfig.fetch).not.toHaveBeenCalled();
  expect(useViewState.getState().view).toBe('main');
  expect(cache.getQueryData(WEB_STARTUP_CACHE_KEY)).toBeUndefined();
  cache.clear();
});
it('当前会话读取失败时不擅自重开账号', async () => {
  api.currentError = true;
  await render();
  expect(api.mutate).not.toHaveBeenCalled();
  expect(api.error).toHaveBeenCalled();
  expect(useViewState.getState().view).toBe('bootstrap');
});
it('桌面重载接回后台实际账号，预热但不验密钥、不重开库或切到自动进入目标', async () => {
  api.web = false;
  await render();
  expect(api.mutate).not.toHaveBeenCalled();
  expect(api.warmup).toHaveBeenCalledOnce();
  expect(api.remoteWarmup).not.toHaveBeenCalled();
  expect(useViewState.getState()).toMatchObject({
    view: 'main',
    openedUin: '10002',
    startupPage: null,
  });
});
it.each([true, false])('没有后台账号时保留原自动进入流程：web=%s', async (web) => {
  api.web = web;
  api.current = null;
  await render();
  expect(api.mutate).toHaveBeenCalledTimes(2);
  expect(api.warmup).toHaveBeenCalledTimes(web ? 0 : 1);
  expect(useViewState.getState()).toMatchObject({ view: 'main', openedUin: '10001' });
});
