import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteRequests } from '../src/renderer/src/components/RemoteRequests';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import type { RemoteAccountAccessRequest } from '../src/shared/remote_account_switch';

const fixture = vi.hoisted(() => ({
  pending: [] as { id: string; name: string; code: string; scope: string }[],
  accountRequests: [] as RemoteAccountAccessRequest[],
  accountData: {
    currentConfigId: 'live-101',
    accounts: [
      { configId: 'backup-101', displayName: '备份账号', uin: '101', static: true },
      { configId: 'live-101', displayName: '当前使用', uin: '101', static: false },
      { configId: 'live-202', displayName: '其他账号', uin: '202', static: false },
    ],
  },
  decide: vi.fn(),
  decideAccountAccess: vi.fn(),
  dismissBanner: vi.fn(async () => {}),
  emitDismissed: undefined as ((ids: string[]) => void) | undefined,
  refetch: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: { notifyConfiguredEvent: { mutate: async () => false } },
    remote: {
      pairingBannersChanged: {
        subscribe: (_: unknown, handler: { onData(ids: string[]): void }) => {
          fixture.emitDismissed = handler.onData;
          handler.onData([]);
          return { unsubscribe() {} };
        },
      },
      dismissPairingBanner: { mutate: fixture.dismissBanner },
    },
  },
  trpc: {
    remote: {
      status: {
        useQuery: () => ({
          data: { pending: fixture.pending, accountRequests: fixture.accountRequests },
          refetch: fixture.refetch,
        }),
      },
      pairingAccounts: {
        useQuery: () => ({ data: fixture.accountData, isFetchedAfterMount: true }),
      },
      decide: { useMutation: () => ({ mutateAsync: fixture.decide }) },
      decideAccountAccess: { useMutation: () => ({ mutateAsync: fixture.decideAccountAccess }) },
    },
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  useDialog.getState().close();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  fixture.accountRequests = [];
  fixture.pending = [
    { id: 'fixture-request', name: '测试手机', code: '123456', scope: 'web:access' },
  ];
  fixture.decide.mockImplementation(async () => {
    fixture.pending = [];
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    useDialog.getState().close();
  });
  container.remove();
});

function visibleDialog() {
  return document.querySelector<HTMLElement>('.weq-dialog-layer:not([hidden]) [role="dialog"]');
}

it('登录窗口显示连接请求横幅，关闭同步到各窗口，连接申请仍能处理', async () => {
  useToast.getState().setAccount(null);
  try {
    await act(async () => root.render(createElement(RemoteRequests)));
    const banner = useToast.getState().toasts[0]!;
    expect(banner.appWide).toBe(true);
    act(() => useToast.getState().dismiss(banner.id, 'manual'));
    expect(fixture.dismissBanner).toHaveBeenCalledWith('fixture-request');
    act(() => useToast.getState().remove(banner.id));
    await act(async () => fixture.emitDismissed!(['fixture-request']));
    expect(useToast.getState().toasts).toHaveLength(0);
    expect(visibleDialog()).not.toBeNull();
    expect(fixture.decide).not.toHaveBeenCalled();
  } finally {
    useToast.setState({ account: undefined });
  }
});

it('默认仅选当前数据源，可取消并多选其他账号，批准时一次提交勾选结果', async () => {
  await act(async () => root.render(createElement(RemoteRequests)));
  const dialog = visibleDialog()!;
  expect(dialog.textContent).toContain('手机请求连接 WeQ');
  expect(dialog.textContent).toContain('123456');
  const checkboxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const approve = dialog.querySelector<HTMLButtonElement>('[data-weq-dialog-confirm]')!;
  expect(checkboxes.map(({ checked }) => checked)).toEqual([false, true, false]);
  expect(fixture.decide).not.toHaveBeenCalled();
  await act(async () => checkboxes[1]!.click());
  expect(approve.disabled).toBe(true);
  await act(async () => checkboxes[0]!.click());
  await act(async () => checkboxes[2]!.click());
  await act(async () => approve.click());
  expect(fixture.decide).toHaveBeenCalledOnce();
  expect(fixture.decide).toHaveBeenCalledWith({
    id: 'fixture-request',
    approve: true,
    configIds: ['backup-101', 'live-202'],
  });
});

it('不覆盖已有确认窗，关闭后再呈现连接请求', async () => {
  useDialog.getState().showInfo('已有窗口', '内容');
  await act(async () => root.render(createElement(RemoteRequests)));
  expect(visibleDialog()).toBeNull();
  await act(async () => useDialog.getState().close());
  const reject = [...visibleDialog()!.querySelectorAll('button')].find(
    (button) => button.textContent === '拒绝',
  )!;
  await act(async () => reject.click());
  expect(fixture.decide).toHaveBeenCalledOnce();
  expect(fixture.decide).toHaveBeenCalledWith({ id: 'fixture-request', approve: false });
});

it('账号访问弹窗展示申请的设备及具体数据源，展开详情后仅批准这条申请', async () => {
  fixture.pending = [];
  fixture.accountRequests = [
    {
      id: 'access-request',
      account: fixture.accountData.accounts[0]!,
      device: {
        id: 'device-1',
        name: '测试平板',
        lastSeenAt: null,
        deviceInfo: {
          platform: 'ios',
          model: 'iPad1,1',
          osVersion: '17.0',
          appVersion: '1.2.3',
          appBuild: '5',
        },
      },
    },
  ];
  await act(async () => root.render(createElement(RemoteRequests)));
  const dialog = visibleDialog()!;
  expect(dialog.textContent).toContain('是否允许 测试平板 访问 备份账号');
  expect(dialog.textContent).toContain('静态备份');
  const details = dialog.querySelector('details')!;
  expect(details.open).toBe(false);
  await act(async () => details.querySelector('summary')!.click());
  expect(details.open).toBe(true);
  expect(details.textContent).toContain('iPad1,1');
  expect(fixture.decideAccountAccess).not.toHaveBeenCalled();
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('[data-weq-dialog-confirm]')!.click(),
  );
  expect(fixture.decideAccountAccess).toHaveBeenCalledOnce();
  expect(fixture.decideAccountAccess).toHaveBeenCalledWith({
    id: 'access-request',
    approve: true,
  });
});
