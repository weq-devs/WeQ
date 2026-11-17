import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountBasicsSection } from '../src/renderer/src/components/settings/AccountBasicsSection';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';
import { useViewState } from '../src/renderer/src/state/view';
import type { OnlineAccess } from '../src/renderer/src/lib/restrictedMode';

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
const mock = vi.hoisted(() => ({
  settings: { autoAttachQq: true, restrictedModeIndicatorEnabled: true },
  access: undefined as OnlineAccess | undefined,
  failed: false,
  queryOptions: vi.fn(),
  save: vi.fn(),
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
                  ? mock.settings
                  : method === 'getGroupAlbumAccessState'
                    ? mock.access
                    : undefined,
              isError: method === 'getGroupAlbumAccessState' && mock.failed,
              isLoading: false,
              refetch: async () => ({ data: mock.settings }),
            };
          };
        if (key === 'useMutation') return () => ({ mutateAsync: mock.save });
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
  mock.settings = { autoAttachQq: true, restrictedModeIndicatorEnabled: true };
  mock.access = { ...ready };
  mock.failed = false;
  mock.queryOptions.mockClear();
  mock.save.mockReset().mockImplementation(async ({ enabled }: { enabled: boolean }) => {
    mock.settings = { ...mock.settings, restrictedModeIndicatorEnabled: enabled };
  });
  mock.error.mockClear();
  useViewState.setState({ openedUin: '10001' });
  useRestrictedMode.setState({ requests: [], reasons: [], enteringSince: null, open: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(h(AccountBasicsSection)));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  render();
  return {
    host,
    render,
    badge: () => host.querySelector<HTMLButtonElement>('.weq-full-function-status')!,
  };
}
it.each([
  [ready, false, '已启用'],
  [{ ...ready, attachEnabled: false }, false, '未启用'],
  [{ ...ready, qqOnline: false }, false, '未启用'],
  [{ ...ready, hasD2Key: false }, false, '未启用'],
  [{ ...ready, hasUid: false }, false, '未启用'],
  [{ ...ready, ssoReady: false }, false, '未启用'],
  [undefined, false, '检测中'],
  [
    { ...ready, source: { expectedAccountUin: '20002', expectedAccountConfigId: 'old' } },
    false,
    '检测中',
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
  expect(f.badge().textContent).toBe('待提权');
  act(() => f.badge().click());
  expect(useRestrictedMode.getState().open).toBe(true);
});
it('未打开账号不显示已启用，也不发起账号能力查询', () => {
  useViewState.setState({ openedUin: null });
  const f = mount();
  expect(f.badge().textContent).toBe('未启用');
  expect(mock.queryOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
});
it('右上角标记开关位于通知之前，默认开启，保存失败还原且不修改自动策略', async () => {
  const f = mount();
  const toggle = () =>
    f.host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="在线能力受限时在窗口右上角显示"]',
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
