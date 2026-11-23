import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountBasicsSection } from '../src/renderer/src/components/settings/AccountBasicsSection';
import { QqProxyIndicator } from '../src/renderer/src/components/QqProxyConnection';
import { onOpenSettingsRequest } from '../src/renderer/src/lib/callSettingsBridge';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';
import { useViewState } from '../src/renderer/src/state/view';
import type { OnlineAccess } from '../src/renderer/src/lib/restrictedMode';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';

const ready: OnlineAccess = {
  qqOnline: true,
  attachEnabled: true,
  hasA2: true,
  hasD2: true,
  hasD2Key: true,
  hasGuid: true,
  hasUid: true,
  ssoReady: true,
};
function waitingProxy() {
  return {
    enabled: true,
    accountUin: '10001',
    connectionExpected: true,
    connected: false,
    connecting: false,
    running: true,
    port: 19082,
    error: '',
    tasks: { pending: 7, error: '等待 QQ 通过代理连接' },
  };
}
const mock = vi.hoisted(() => ({
  settings: {
    autoAttachQq: true,
    restrictedModeIndicatorEnabled: true,
    qqProxyIndicatorEnabled: true,
    qqClientSyncEnabled: false,
  },
  proxyStatus: undefined as ReturnType<typeof waitingProxy> | undefined,
  qqRunning: null as boolean | null,
  access: undefined as OnlineAccess | undefined,
  failed: false,
  queryOptions: vi.fn(),
  save: vi.fn(),
  saveProxyEnabled: vi.fn(),
  saveProxyIndicator: vi.fn(),
  launchQq: vi.fn(),
  restartQq: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/renderer/src/components/settings/LongTermAuthorizationSection', () => ({
  LongTermAuthorizationSection: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useQuery')
          return (_input: unknown, options: unknown) => {
            const method = path.at(-1);
            if (method === 'getGroupAlbumAccessState') mock.queryOptions(options);
            return {
              data:
                method === 'getSettings'
                  ? { ...mock.settings, notificationEvents: normalizeNotificationEvents(undefined) }
                  : method === 'getGroupAlbumAccessState'
                    ? mock.access
                    : method === 'getQqClientSyncStatus'
                      ? mock.proxyStatus
                      : method === 'getQqProcessState'
                        ? {
                            running: mock.qqRunning,
                            canRestart: mock.qqRunning === true,
                            switchingToDebugCopy: mock.qqRunning === true,
                          }
                        : undefined,
              isError: method === 'getGroupAlbumAccessState' && mock.failed,
              isLoading: false,
              refetch: async () => ({ data: mock.settings }),
            };
          };
        if (key === 'useMutation')
          return (options?: { onSuccess?: () => unknown; onSettled?: () => unknown }) => ({
            mutateAsync: mock.save,
            reset: () => {},
            mutate: (input?: { enabled: boolean }) => {
              const method = path.at(-1);
              if (method === 'setQqProxyEnabled' && input) mock.saveProxyEnabled(input);
              if (method === 'setQqProxyIndicatorEnabled' && input) mock.saveProxyIndicator(input);
              if (method === 'launchQq') mock.launchQq();
              if (method === 'restartQq') mock.restartQq();
              void options?.onSuccess?.();
              void options?.onSettled?.();
            },
          });
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy() };
});
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select: (value: { showError: typeof mock.error; confirm: () => void }) => unknown) =>
    select({ showError: mock.error, confirm: () => {} }),
}));
vi.mock('../src/renderer/src/components/Dialog.shared', () => ({
  useDialog: (select: (value: { showError: typeof mock.error; confirm: () => void }) => unknown) =>
    select({ showError: mock.error, confirm: () => {} }),
}));
let cleanup = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.settings = {
    autoAttachQq: true,
    restrictedModeIndicatorEnabled: true,
    qqProxyIndicatorEnabled: true,
    qqClientSyncEnabled: false,
  };
  mock.proxyStatus = undefined;
  mock.qqRunning = null;
  mock.access = { ...ready };
  mock.failed = false;
  mock.queryOptions.mockClear();
  mock.save.mockReset().mockImplementation(async ({ enabled }: { enabled: boolean }) => {
    mock.settings = { ...mock.settings, restrictedModeIndicatorEnabled: enabled };
  });
  mock.error.mockClear();
  mock.launchQq.mockClear();
  mock.restartQq.mockClear();
  mock.saveProxyEnabled.mockReset().mockImplementation(({ enabled }) => {
    mock.proxyStatus = { ...waitingProxy(), enabled, running: enabled };
  });
  mock.saveProxyIndicator.mockReset().mockImplementation(({ enabled }) => {
    mock.settings.qqProxyIndicatorEnabled = enabled;
  });
  useViewState.setState({ openedUin: '10001' });
  useRestrictedMode.setState({ requests: [], reasons: [], enteringSince: null, open: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(showProxyIndicator = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        h('div', null, h(AccountBasicsSection), showProxyIndicator && h(QqProxyIndicator)),
      ),
    );
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  render();
  return {
    host,
    render,
    badge: () => host.querySelector<HTMLButtonElement>('button[aria-label^="QQ 在线能力："]')!,
  };
}
it('代理断开提示使用当前账号，指向代理卡片，关闭提示后仍可查看等待任务', async () => {
  mock.settings.qqClientSyncEnabled = true;
  mock.proxyStatus = waitingProxy();
  mock.qqRunning = true;
  const f = mount(true);
  const indicator = () =>
    f.host.querySelector<HTMLButtonElement>('button[aria-label="QQ 代理未连接"]');
  const card = f.host.querySelector<HTMLElement>('[data-setting-id="qq-proxy-connection"]')!;
  const status = () => card.querySelector('.weq-set-card-head [role="status"]')?.textContent;
  expect(status()).toBe('等待 QQ 连接');
  expect(card.textContent).toContain('待同步 7 项');
  act(() => indicator()?.click());
  const panel = document.querySelector<HTMLElement>('.weq-restricted-panel')!;
  mock.proxyStatus = { ...waitingProxy(), connecting: true };
  f.render();
  const progress = f.host.querySelector<HTMLButtonElement>(
    'button[aria-label="正在确认 QQ 代理连接"]',
  );
  expect(progress?.getAttribute('aria-busy')).toBe('true');
  expect(panel.querySelector('h2')?.textContent).toBe('正在确认 QQ 代理连接');
  expect(status()).toBe('正在确认连接');
  expect(card.textContent).toContain('待同步 7 项');
  mock.proxyStatus = waitingProxy();
  f.render();
  const action = (surface: HTMLElement, label: string) =>
    [...surface.querySelectorAll('button')].find((button) => button.textContent === label);
  for (const surface of [panel, card]) {
    expect(action(surface, '重新启动 QQ')).toBeDefined();
    expect(action(surface, '打开 QQ')).toBeUndefined();
    expect(surface.textContent).toContain('再打开调试副本');
  }
  act(() => action(panel, '重新启动 QQ')!.click());
  expect(mock.restartQq).toHaveBeenCalledOnce();
  expect(mock.launchQq).not.toHaveBeenCalled();
  mock.qqRunning = null;
  f.render();
  expect(action(panel, '打开 QQ')).toBeDefined();
  mock.qqRunning = false;
  f.render();
  expect(action(card, '打开 QQ')).toBeDefined();
  act(() => action(panel, '打开 QQ')!.click());
  expect(mock.launchQq).toHaveBeenCalledOnce();
  const openSettings = vi.fn();
  const unsubscribe = onOpenSettingsRequest(openSettings);
  try {
    act(() =>
      [...panel.querySelectorAll('button')].find((b) => b.textContent === '代理设置')?.click(),
    );
    expect(openSettings).toHaveBeenCalledWith('qqProxyConnection');
    expect(panel.isConnected).toBe(false);
  } finally {
    unsubscribe();
  }

  for (const proxy of [
    { ...waitingProxy(), accountUin: 'other' },
    { ...waitingProxy(), connected: true },
    { ...waitingProxy(), connectionExpected: false },
  ]) {
    mock.proxyStatus = proxy;
    f.render();
    expect(indicator()).toBeNull();
    if (proxy.connected) expect(status()).toBe('已连接');
  }
  mock.proxyStatus = waitingProxy();
  f.render();
  expect(indicator()).not.toBeNull();
  await act(async () => {
    card.querySelector<HTMLButtonElement>('[role="switch"][aria-label^="QQ 代理未连接"]')!.click();
  });
  f.render();
  expect(mock.saveProxyIndicator).toHaveBeenCalledWith({ enabled: false });
  expect(indicator()).toBeNull();
  expect(status()).toBe('等待 QQ 连接');
  expect(card.textContent).toContain('待同步 7 项');
  expect(mock.settings.restrictedModeIndicatorEnabled).toBe(true);
  expect(mock.settings.qqClientSyncEnabled).toBe(true);

  mock.settings.qqProxyIndicatorEnabled = true;
  f.render();
  const master = card.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="启用 QQ 代理"]',
  )!;
  await act(async () => master.click());
  f.render();
  expect(mock.saveProxyEnabled).toHaveBeenCalledWith({ enabled: false });
  expect(master.getAttribute('aria-checked')).toBe('false');
  expect(status()).toBe('已关闭');
  expect(card.textContent).toContain('待同步 7 项');
  expect(indicator()).toBeNull();
  expect(mock.settings.qqClientSyncEnabled).toBe(true);
});
it.each([
  [ready, false, '已就绪'],
  [{ ...ready, attachEnabled: false }, false, '已关闭'],
  [{ ...ready, qqOnline: false }, false, '在线能力受限'],
  [{ ...ready, hasD2Key: false }, false, '在线能力受限'],
  [{ ...ready, hasUid: false }, false, '在线能力受限'],
  [{ ...ready, ssoReady: false }, false, '在线能力受限'],
  [undefined, false, '检查中'],
  [
    { ...ready, source: { expectedAccountUin: '20002', expectedAccountConfigId: 'old' } },
    false,
    '检查中',
  ],
  [ready, true, '状态待确认'],
] as const)('标题标签依据真实能力而非自动启用偏好：%j / %s', (access, failed, label) => {
  mock.access = access;
  mock.failed = failed;
  const f = mount();
  expect(f.badge().textContent).toBe(label);
  expect(f.badge().parentElement?.querySelector('.weq-set-card-title')?.textContent).toBe(
    'QQ 在线能力',
  );
});
it('等待授权与启用中优先显示，标签始终可以打开统一状态详情', () => {
  const f = mount();
  act(() => useRestrictedMode.getState().beginEntering());
  expect(f.badge().textContent).toBe('正在启用');
  act(() =>
    useRestrictedMode
      .getState()
      .request({ kind: 'password', token: 1, title: '授权', message: '' }),
  );
  expect(f.badge().textContent).toBe('等待授权');
  act(() => f.badge().click());
  expect(useRestrictedMode.getState().open).toBe(true);
});
it('未打开账号时显示原因，也不发起账号能力查询', () => {
  useViewState.setState({ openedUin: null });
  const f = mount();
  expect(f.badge().textContent).toBe('未打开账号');
  expect(mock.queryOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
});
it('右上角标记开关位于通知之前，默认开启，保存失败还原且不修改自动策略', async () => {
  const f = mount();
  const toggle = () =>
    f.host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="在线能力受限时显示窗口提示"]',
    )!;
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  const row = toggle().closest('.weq-set-row')!;
  expect(row.nextElementSibling?.textContent).toContain('在线能力受限时通知');
  expect(f.host.textContent).not.toContain('在线能力受限时横幅提醒');
  await act(async () => toggle().click());
  expect(mock.save).toHaveBeenCalledWith({ enabled: false });
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(mock.settings.autoAttachQq).toBe(true);
  mock.save.mockRejectedValueOnce(new Error('合成写入失败'));
  await act(async () => toggle().click());
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect(mock.error).toHaveBeenCalledWith('保存失败', '合成写入失败');
});
