import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BootstrapView } from '../src/renderer/src/views/BootstrapView';
import { useViewState } from '../src/renderer/src/state/view';

const api = vi.hoisted(() => ({
  web: true,
  current: { uin: '10002' } as { uin: string } | null,
  currentError: false,
  mutate: vi.fn(async () => ({ success: true })),
  warmup: vi.fn(async () => {}),
  error: vi.fn(),
  utils: {},
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
vi.mock('../src/renderer/src/lib/accountWarmup', () => ({ runAccountWarmup: api.warmup }));
vi.mock('../src/renderer/src/views/bootstrap/HomeScreen', () => ({ HomeScreen: () => null }));
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
  vi.clearAllMocks();
  useViewState.setState({ view: 'bootstrap', openedUin: null, homeStage: 'booting' });
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

it('Web 复用实际已打开账号，不切回自动进入目标，也不验密钥、重开库或等待预热', async () => {
  await render();
  expect(useViewState.getState()).toMatchObject({
    view: 'main',
    openedUin: '10002',
    homeStage: 'home',
  });
  expect(api.mutate).not.toHaveBeenCalled();
  expect(api.warmup).not.toHaveBeenCalled();
});
it('当前会话读取失败时不擅自重开账号', async () => {
  api.currentError = true;
  await render();
  expect(api.mutate).not.toHaveBeenCalled();
  expect(api.error).toHaveBeenCalled();
  expect(useViewState.getState().view).toBe('bootstrap');
});
it.each([true, false])('无已打开会话或桌面模式仍保留原自动进入流程：web=%s', async (web) => {
  api.web = web;
  if (web) api.current = null;
  await render();
  expect(api.mutate).toHaveBeenCalledTimes(2);
  expect(api.warmup).toHaveBeenCalledOnce();
  expect(useViewState.getState()).toMatchObject({ view: 'main', openedUin: '10001' });
});
