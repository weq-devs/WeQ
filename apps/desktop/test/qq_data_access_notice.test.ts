import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { QqDataAccessNotice } from '../src/renderer/src/views/bootstrap/QqDataAccessNotice';

const api = vi.hoisted(() => ({
  data: {
    status: 'denied',
    applicationPath: '/Applications/weQ.app',
    launchApplicationPath: '/System/Applications/Utilities/Terminal.app',
    issues: [{ path: '/fixture/QQ/login.db', code: 'EPERM' }],
  },
  refetch: vi.fn(),
  invalidate: vi.fn(),
  settings: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_MAC: true }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      qqDataAccess: {
        useQuery: () => ({ data: api.data, isFetching: false, refetch: api.refetch }),
      },
    },
    useUtils: () => ({
      bootstrap: {
        listAccounts: { invalidate: api.invalidate },
        listAccountConfigs: { invalidate: api.invalidate },
        describeInstall: { invalidate: api.invalidate },
      },
    }),
  },
  client: { bootstrap: { openQqDataAccessSettings: { mutate: api.settings } } },
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  api.data.status = 'denied';
  api.settings.mockResolvedValue(true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(QqDataAccessNotice)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!;

test('显示真实应用与受限路径，仅用户点击才打开系统设置', async () => {
  expect(host.textContent).toContain('/Applications/weQ.app');
  expect(host.textContent).toContain('/fixture/QQ/login.db');
  expect(host.textContent).toContain('/System/Applications/Utilities/Terminal.app');
  expect(host.textContent).toContain('仅授权 Electron 可能不够');
  expect(api.settings).not.toHaveBeenCalled();
  await act(async () => button('打开系统设置').click());
  expect(api.settings).toHaveBeenCalledOnce();
});
test('拒绝仍在时提示彻底退出，不刷新账号或假报成功', async () => {
  api.refetch.mockResolvedValue({ data: api.data });
  await act(async () => button('重新检测').click());
  expect(host.textContent).toContain('彻底退出 WeQ');
  expect(api.invalidate).not.toHaveBeenCalled();
});
test('真实探测恢复后重新加载账号与安装状态，收起授权提示', async () => {
  api.refetch.mockImplementation(async () => {
    api.data.status = 'readable';
    return { data: api.data };
  });
  await act(async () => button('重新检测').click());
  expect(api.invalidate).toHaveBeenCalledTimes(3);
  expect(host.textContent).toBe('');
});
test('非权限 I/O 不显示授权按钮；设置跳转失败原样展示', async () => {
  api.settings.mockRejectedValue(new Error('无法打开系统设置'));
  await act(async () => button('打开系统设置').click());
  expect(host.textContent).toContain('无法打开系统设置');
  api.data.status = 'error';
  act(() => root.render(createElement(QqDataAccessNotice)));
  expect(host.textContent).toContain('尚不能确认为授权问题');
  expect(button('打开系统设置')).toBeUndefined();
});
