import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountBasicsSection } from '../src/renderer/src/components/settings/AccountBasicsSection';
import { QqStatusReminderSettings } from '../src/renderer/src/components/settings/QqStatusReminderSettings';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';
import { useViewState } from '../src/renderer/src/state/view';
import type { QqCapabilityMode } from '@weq/service/qq-capability-mode';
import type { OnlineAccess } from '../src/renderer/src/lib/restrictedMode';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';

const ready: OnlineAccess = {
  source: { expectedAccountUin: '10001', expectedAccountConfigId: '10001' },
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
    accountConfigId: '10001',
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
    qqCapabilityMode: 'complete' as QqCapabilityMode,
  },
  proxyStatus: undefined as ReturnType<typeof waitingProxy> | undefined,
  access: undefined as OnlineAccess | undefined,
  failed: false,
  queryOptions: vi.fn(),
  save: vi.fn(),
  saveMode: vi.fn(),
  platform: 'linux',
  sip: false,
  hasQqExe: true,
  error: vi.fn(),
}));
vi.mock('../src/renderer/src/components/settings/LongTermAuthorizationSection', () => ({
  LongTermAuthorizationSection: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'invalidate') return async () => {};
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
                      : method === 'systemInfo'
                        ? { platformKind: mock.platform }
                        : method === 'sipEnabled'
                          ? mock.sip
                          : method === 'describeInstall'
                            ? { hasQqExe: mock.hasQqExe }
                            : undefined,
              isError: method === 'getGroupAlbumAccessState' && mock.failed,
              isLoading: false,
              refetch: async () => ({ data: mock.settings }),
            };
          };
        if (key === 'useMutation')
          return (options?: { onSuccess?: () => unknown; onSettled?: () => unknown }) => ({
            mutateAsync: path.at(-1) === 'setQqCapabilityMode' ? mock.saveMode : mock.save,
            reset: () => {},
            mutate: () => {
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
    qqCapabilityMode: 'complete' as QqCapabilityMode,
  };
  mock.proxyStatus = undefined;
  mock.access = { ...ready };
  mock.failed = false;
  mock.queryOptions.mockClear();
  mock.save.mockReset().mockImplementation(async ({ enabled }: { enabled: boolean }) => {
    mock.settings = { ...mock.settings, qqStatusIndicatorEnabled: enabled };
  });
  mock.error.mockClear();
  mock.saveMode.mockReset().mockImplementation(async ({ mode }: { mode: QqCapabilityMode }) => {
    mock.settings = { ...mock.settings, qqCapabilityMode: mode };
    return { status: 'saved', mode };
  });
  mock.platform = 'linux';
  mock.sip = false;
  mock.hasQqExe = true;
  useViewState.setState({ view: 'main', openedUin: '10001' });
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
function mount(page: 'account' | 'reminders' = 'account') {
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
  return { host, render };
}

it('完整模式等待连接保留选择，待同步任务在连接卡片上显示', async () => {
  mock.settings.qqStatusIndicatorEnabled = false;
  mock.proxyStatus = waitingProxy();
  const { host, render } = mount();
  const card = host.querySelector('[data-setting-id="qq-proxy-connection"]')!;
  expect(card.textContent).toContain('正在等待 QQ 代理连接');
  expect(card.textContent).toContain('待同步 7 项');
  mock.access = {
    ...ready,
    source: { expectedAccountUin: '10001', expectedAccountConfigId: 'other' },
  };
  render();
  expect(card.textContent).toContain('未连接');
  mock.access = ready;
  mock.proxyStatus = { ...waitingProxy(), connected: true };
  render();
  expect(card.textContent).toContain('已连接');
  expect(host.querySelector('[role="radio"][value="complete"]')?.getAttribute('aria-checked')).toBe(
    'true',
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[role="radio"][value="local"]')!.click(),
  );
  render();
  expect(mock.saveMode).toHaveBeenCalledWith({ mode: 'local' });
  expect(host.querySelector('[data-setting-id="qq-proxy-connection"]')).toBeNull();
});

it('选择在线档后按实际安装、登录及凭据要求显示操作', () => {
  mock.settings.qqCapabilityMode = 'online';
  mock.access = { ...ready, qqOnline: false };
  mock.hasQqExe = false;
  const { host, render } = mount();
  expect(host.querySelector('[data-setting-id="full-feature-routes"]')?.textContent).toContain(
    '未检测到 QQ 安装',
  );
  mock.hasQqExe = true;
  render();
  expect(host.textContent).toContain('登录当前账号');
  mock.access = { ...ready, hasD2Key: false, credentialsPending: true };
  render();
  expect(host.textContent).toContain('正在准备 QQ 在线能力');
  mock.access = ready;
  render();
  expect(host.textContent).toContain('当前账号的 QQ 在线能力已就绪');
});

it('SIP 已关闭时让 macOS 用户选择原版或副本', () => {
  mock.platform = 'darwin';
  mock.access = { ...ready, qqOnline: false };
  const { host } = mount();
  const prepare = host.querySelector('[data-setting-id="full-feature-routes"]');
  expect(prepare?.textContent).toContain('使用原版 QQ');
  expect(prepare?.textContent).toContain('使用调试副本');
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
