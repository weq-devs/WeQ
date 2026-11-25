import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountBasicsSection } from '../src/renderer/src/components/settings/AccountBasicsSection';
import { QqStatusReminderSettings } from '../src/renderer/src/components/settings/QqStatusReminderSettings';
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
    qqStatusIndicatorEnabled: true,
    qqClientSyncEnabled: false,
  },
  proxyStatus: undefined as ReturnType<typeof waitingProxy> | undefined,
  access: undefined as OnlineAccess | undefined,
  failed: false,
  queryOptions: vi.fn(),
  save: vi.fn(),
  saveProxyEnabled: vi.fn(),
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
            mutate: (input?: { enabled: boolean } | { newInstance: boolean }) => {
              const method = path.at(-1);
              if (input && 'enabled' in input) {
                if (method === 'setQqProxyEnabled') mock.saveProxyEnabled(input);
              }
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
    qqStatusIndicatorEnabled: true,
    qqClientSyncEnabled: false,
  };
  mock.proxyStatus = undefined;
  mock.access = { ...ready };
  mock.failed = false;
  mock.queryOptions.mockClear();
  mock.save.mockReset().mockImplementation(async ({ enabled }: { enabled: boolean }) => {
    mock.settings = { ...mock.settings, qqStatusIndicatorEnabled: enabled };
  });
  mock.error.mockClear();
  mock.saveProxyEnabled.mockReset().mockImplementation(({ enabled }) => {
    mock.proxyStatus = { ...waitingProxy(), enabled, running: enabled };
  });
  useViewState.setState({ openedUin: '10001' });
  useRestrictedMode.setState({
    requests: [],
    reasons: [],
    enteringSince: null,
    open: false,
    settingsSection: null,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(page: 'account' | 'qq-proxy' | 'reminders' = 'account') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        h(
          'div',
          null,
          page === 'reminders' ? h(QqStatusReminderSettings) : h(AccountBasicsSection, { page }),
        ),
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
    badge: () =>
      host.querySelector<HTMLElement>(
        '[data-setting-id="full-features"] .weq-set-card-head :is([role="status"], button[aria-label^="QQ 在线能力："])',
      )!,
  };
}
it('关闭统一提示后，代理设置仍可打开共用详情并查看待同步任务', async () => {
  mock.settings.qqStatusIndicatorEnabled = false;
  mock.settings.qqClientSyncEnabled = true;
  mock.proxyStatus = waitingProxy();
  const f = mount('qq-proxy');
  const card = f.host.querySelector<HTMLElement>('[data-setting-id="qq-proxy-connection"]')!;
  const syncCard = f.host
    .querySelector('[data-setting-id="qq-client-sync"]')!
    .closest('.weq-set-card')!;
  const badge = () => card.querySelector<HTMLButtonElement>('button[aria-label^="QQ 代理连接："]')!;
  expect(badge().textContent).toBe('等待 QQ 连接');
  expect(syncCard.textContent).toContain('待同步 7 项');
  act(() => badge().click());
  expect(useRestrictedMode.getState().settingsSection).toBe('proxy');
  act(() => badge().click());
  expect(useRestrictedMode.getState().open).toBe(false);

  mock.proxyStatus = { ...waitingProxy(), connecting: true };
  f.render();
  expect(badge().textContent).toBe('正在确认连接');
  expect(syncCard.textContent).toContain('待同步 7 项');
  mock.proxyStatus = { ...waitingProxy(), connected: true };
  f.render();
  expect(badge().textContent).toBe('已连接');

  const master = card.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="启用 QQ 代理"]',
  )!;
  await act(async () => master.click());
  f.render();
  expect(mock.saveProxyEnabled).toHaveBeenCalledWith({ enabled: false });
  expect(master.getAttribute('aria-checked')).toBe('false');
  expect(badge().textContent).toBe('已关闭');
  expect(syncCard.textContent).toContain('待同步 7 项');
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
    '在线能力',
  );
});
it('等待授权与启用中优先显示，待授权时可打开状态详情', () => {
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
it('状态提醒页一个开关同时控制窗口提示，保存失败还原', async () => {
  const f = mount('reminders');
  const toggle = () =>
    f.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="显示 QQ 功能状态提示"]')!;
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
