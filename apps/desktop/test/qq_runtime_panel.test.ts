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
  openedConfigId: string | null;
  closeBehavior?: 'ask' | 'tray' | 'quit';
};
const mock = vi.hoisted(() => ({
  data: null as Status | null,
  start: vi.fn<(input: unknown) => Promise<QQRuntimeSnapshot>>(),
  stop: vi.fn(async (_input: unknown) => {}),
  refresh: vi.fn(async (_input: unknown) => {}),
  enable: vi.fn(async (_input: unknown) => {}),
  preference: vi.fn(async (_input: unknown) => true),
  closeBehavior: vi.fn(async (_input: unknown) => true),
  invalidateSettings: vi.fn(async () => {}),
  invalidateAuto: vi.fn(async () => {}),
  official: vi.fn(async (_input: unknown) => {}),
  refetch: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { qqRuntime: { stop: { mutate: mock.stop } } },
  trpc: {
    useUtils: () => ({
      bootstrap: {
        getSettings: { invalidate: mock.invalidateSettings },
        getAutoEnter: { invalidate: mock.invalidateAuto },
      },
    }),
    bootstrap: {
      setAutoAttachQq: { useMutation: () => ({ mutateAsync: mock.enable, isLoading: false }) },
      setWindowCloseBehavior: {
        useMutation: () => ({ mutateAsync: mock.closeBehavior, isLoading: false }),
      },
    },
    qqRuntime: {
      status: { useQuery: () => ({ data: mock.data, error: null, refetch: mock.refetch }) },
      start: { useMutation: () => ({ mutateAsync: mock.start, isLoading: false }) },
      stop: { useMutation: () => ({ mutateAsync: mock.stop, isLoading: false }) },
      refreshQr: { useMutation: () => ({ mutateAsync: mock.refresh, isLoading: false }) },
      openOfficial: { useMutation: () => ({ mutateAsync: mock.official, isLoading: false }) },
      setAutoEnter: { useMutation: () => ({ mutateAsync: mock.preference, isLoading: false }) },
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
function fixture(
  expectedUin?: string,
  options: Partial<Parameters<typeof ManagedQQPanel>[0]> = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    entered = vi.fn();
  let closed = false;
  const render = () =>
    act(() => root.render(h(ManagedQQPanel, { expectedUin, onEntered: entered, ...options })));
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
    openedConfigId: null,
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
  it('新二维码滚入可见区域，相同图片的状态轮询不反复抢滚动位置', () => {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView'),
      scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
    try {
      mock.data = {
        ...mock.data!,
        state: {
          ...stopped(),
          phase: 'awaiting-login',
          mode: 'managed',
          qr: { pngBase64: 'fixture', url: '' },
        },
      };
      const f = fixture();
      expect(scroll).toHaveBeenCalledOnce();
      f.render();
      expect(scroll).toHaveBeenCalledOnce();
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
  it('关闭策略沿用全局设置，保存后刷新设置而不启动 QQ', async () => {
    const f = fixture(),
      select = f.host.querySelector<HTMLSelectElement>('[aria-label="关闭窗口时"]')!;
    await act(async () => {
      select.value = 'tray';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mock.closeBehavior).toHaveBeenCalledWith({ behavior: 'tray' });
    expect(mock.invalidateSettings).toHaveBeenCalledOnce();
    expect(mock.start).not.toHaveBeenCalled();
  });
  it('外部 QQ 或缺少自有进程标记的快照不进入托管账号', () => {
    mock.data = {
      ...mock.data!,
      openedUin: '10001',
      openedInstanceId: 'instance-a',
      state: {
        ...stopped(),
        instanceId: 'instance-a',
        mode: 'external',
        pid: 123,
        owned: false,
        phase: 'online',
        account: { uin: '10001', uid: 'u_self' },
        capabilities: { login: false, sso: true, database: true, push: false },
      },
    };
    const f = fixture('10001');
    expect(f.entered).not.toHaveBeenCalled();
  });
  it('显式自动进入目标只启动一次，并携带保存配置 ID', async () => {
    const consumed = vi.fn();
    const f = fixture('10001', {
      expectedConfigId: 'owned-config',
      autoStart: true,
      onAutoStartConsumed: consumed,
    });
    await act(async () => {});
    f.render();
    expect(consumed).toHaveBeenCalledOnce();
    expect(mock.start).toHaveBeenCalledOnce();
    expect(mock.start).toHaveBeenCalledWith({
      expectedInstanceId: null,
      uin: '10001',
      expectedAccountConfigId: 'owned-config',
    });
  });
  it('自动进入不会擅自开启在线功能，消费意图后不会延迟触发', () => {
    mock.data!.enabled = false;
    const consumed = vi.fn(),
      f = fixture('10001', { autoStart: true, onAutoStartConsumed: consumed });
    expect(consumed).toHaveBeenCalledOnce();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.enable).not.toHaveBeenCalled();
    mock.data = { ...mock.data!, enabled: true };
    f.render();
    expect(mock.start).not.toHaveBeenCalled();
  });
  it('自动进入偏好只在数据库就绪后按本实例保存', async () => {
    const f = fixture();
    act(() => f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
    expect(mock.preference).not.toHaveBeenCalled();
    mock.data = {
      ...mock.data!,
      openedUin: '10001',
      openedInstanceId: 'instance-a',
      openedConfigId: 'owned-config',
      state: {
        ...stopped(),
        instanceId: 'instance-a',
        mode: 'managed',
        pid: 123,
        owned: true,
        phase: 'online',
        account: { uin: '10001', uid: 'u_self' },
        capabilities: { login: true, sso: true, database: true, push: false },
      },
    };
    await act(async () => f.render());
    expect(mock.preference).toHaveBeenCalledWith({
      expectedInstanceId: 'instance-a',
      enabled: true,
    });
    expect(f.entered).toHaveBeenCalledWith('10001');
  });
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
