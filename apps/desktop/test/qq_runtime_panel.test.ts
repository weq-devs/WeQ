import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QQRuntimeSnapshot } from '@weq/service';
import { ManagedQQPanel } from '../src/renderer/src/views/bootstrap/ManagedQQPanel';

type Status = {
  supported: boolean;
  enabled: boolean;
  state: QQRuntimeSnapshot;
  openedUin: string | null;
  openedInstanceId: string | null;
};
const mock = vi.hoisted(() => ({
  data: null as Status | null,
  start: vi.fn<(input: unknown) => Promise<QQRuntimeSnapshot>>(),
  stop: vi.fn(async (_input: unknown) => {}),
  refresh: vi.fn(async (_input: unknown) => {}),
  enable: vi.fn(async (_input: unknown) => {}),
  official: vi.fn(async (_input: unknown) => {}),
  refetch: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { qqRuntime: { stop: { mutate: mock.stop } } },
  trpc: {
    bootstrap: {
      setAutoAttachQq: { useMutation: () => ({ mutateAsync: mock.enable, isLoading: false }) },
    },
    qqRuntime: {
      status: { useQuery: () => ({ data: mock.data, error: null, refetch: mock.refetch }) },
      start: { useMutation: () => ({ mutateAsync: mock.start, isLoading: false }) },
      stop: { useMutation: () => ({ mutateAsync: mock.stop, isLoading: false }) },
      refreshQr: { useMutation: () => ({ mutateAsync: mock.refresh, isLoading: false }) },
      openOfficial: { useMutation: () => ({ mutateAsync: mock.official, isLoading: false }) },
    },
  },
}));
const cleanup: Array<() => void> = [];
const stopped = (): QQRuntimeSnapshot => ({
  instanceId: null,
  mode: null,
  pid: null,
  owned: false,
  phase: 'stopped',
  account: null,
  capabilities: { login: false, sso: false, database: false, push: false },
  qr: null,
  error: null,
  restarts: 0,
});
function fixture(expectedUin?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    entered = vi.fn();
  let closed = false;
  const render = () =>
    act(() => root.render(h(ManagedQQPanel, { expectedUin, onEntered: entered })));
  const close = () => {
    if (!closed) {
      closed = true;
      act(() => root.unmount());
      host.remove();
    }
  };
  cleanup.push(close);
  render();
  return { host, entered, render, close };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mock.data = {
    supported: true,
    enabled: true,
    state: stopped(),
    openedUin: null,
    openedInstanceId: null,
  };
  mock.start.mockResolvedValue({
    ...stopped(),
    instanceId: 'instance-a',
    mode: 'managed',
    pid: 123,
    owned: true,
    phase: 'awaiting-login',
  });
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
});
describe('托管 QQ 登录入口', () => {
  it('首登可明确开启在线开关，但不会随之自动启动 QQ', async () => {
    mock.data!.enabled = false;
    const f = fixture();
    await act(async () =>
      f.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(mock.enable).toHaveBeenCalledWith({ enabled: true });
    expect(mock.start).not.toHaveBeenCalled();
  });
  it('不自动启动 QQ，明确点击后按当前实例和选定账号启动', async () => {
    const f = fixture('10001');
    expect(mock.start).not.toHaveBeenCalled();
    await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-action-primary')!.click());
    expect(mock.start).toHaveBeenCalledWith({ expectedInstanceId: null, uin: '10001' });
    f.close();
    expect(mock.stop).toHaveBeenCalledWith({
      expectedInstanceId: 'instance-a',
      closeAccount: true,
    });
  });
  it('只有本实例账号与数据库均就绪才进入，进入后不随面板卸载停止 QQ', () => {
    const f = fixture('10001');
    mock.data!.state = {
      ...stopped(),
      instanceId: 'instance-a',
      mode: 'managed',
      pid: 123,
      owned: true,
      phase: 'initializing-session',
      account: { uin: '10001', uid: 'u_self' },
      capabilities: { login: true, sso: true, database: false, push: false },
    };
    f.render();
    expect(f.entered).not.toHaveBeenCalled();
    mock.data!.state = {
      ...mock.data!.state,
      phase: 'online',
      capabilities: { login: true, sso: true, database: true, push: true },
    };
    mock.data!.openedUin = '10001';
    mock.data!.openedInstanceId = 'other-instance';
    f.render();
    expect(f.entered).not.toHaveBeenCalled();
    mock.data = { ...mock.data!, openedInstanceId: 'instance-a' };
    f.render();
    expect(f.entered).toHaveBeenCalledWith('10001');
    f.close();
    expect(mock.stop).not.toHaveBeenCalled();
  });
  it('启动期间面板关闭，迟到创建的本实例会被清理', async () => {
    let finish: (value: QQRuntimeSnapshot) => void = () => {};
    mock.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-action-primary')!.click());
    f.close();
    await act(async () => {
      finish({ ...stopped(), instanceId: 'late-instance', mode: 'managed', pid: 123, owned: true });
    });
    expect(mock.stop).toHaveBeenCalledWith({
      expectedInstanceId: 'late-instance',
      closeAccount: true,
    });
    expect(f.entered).not.toHaveBeenCalled();
  });
  it('完全离线模式不允许启动，也不自动领取其他面板的运行时所有权', () => {
    mock.data!.enabled = false;
    const f = fixture();
    expect(f.host.querySelector<HTMLButtonElement>('.weq-action-primary')!.disabled).toBe(true);
    f.close();
    expect(mock.stop).not.toHaveBeenCalled();
  });
});
