import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restrictionReasons, type OnlineAccess } from '../src/renderer/src/lib/restrictedMode';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';
import {
  RestrictedModeHost,
  RestrictedModeIndicator,
} from '../src/renderer/src/components/RestrictedMode';
import { useViewState } from '../src/renderer/src/state/view';
import { useToast } from '../src/renderer/src/components/Toast';

const ready: OnlineAccess = {
  qqOnline: true,
  attachEnabled: true,
  hasA2: true,
  hasD2: true,
  hasD2Key: true,
  hasGuid: true,
};
const mock = vi.hoisted(() => ({
  access: undefined as OnlineAccess | undefined,
  failed: false,
  sip: null as boolean | null,
  refetch: vi.fn(async () => ({})),
  send: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  credentialsReady: undefined as undefined | (() => void),
  unsubscribe: vi.fn(),
  invalidateAccess: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      onOnlineCredentialsReady: {
        subscribe: (_input: undefined, handlers: { onData: () => void }) => {
          mock.credentialsReady = handlers.onData;
          return { unsubscribe: mock.unsubscribe };
        },
      },
    },
  },
  trpc: {
    useUtils: () => utils,
    account: {
      getGroupAlbumAccessState: {
        useQuery: () => ({ data: mock.access, isError: mock.failed, refetch: mock.refetch }),
      },
    },
    bootstrap: {
      sipEnabled: { useQuery: () => ({ data: mock.sip, refetch: mock.refetch }) },
      probeOnline: {
        useQuery: () => ({ data: { count: 1 }, isError: false, refetch: mock.refetch }),
      },
    },
  },
}));
const utils = { account: { getGroupAlbumAccessState: { invalidate: mock.invalidateAccess } } };

describe('受限原因按实际能力判定', () => {
  it('macOS SIP 开启但凭据可用时不误判；Linux / Windows 无 SIP 原因', () => {
    expect(restrictionReasons({ access: ready, sipEnabled: true })).toEqual([]);
    for (const sipEnabled of [false, null, undefined])
      expect(
        restrictionReasons({ access: { ...ready, hasD2: false }, sipEnabled }).map((r) => r.code),
      ).toEqual(['credentials']);
    expect(
      restrictionReasons({ access: { ...ready, hasD2: false }, sipEnabled: true }).map(
        (r) => r.code,
      ),
    ).toEqual(['sip']);
  });
  it('离线、主动禁用可以并存，不凭缺少物料猜测需要密码', () => {
    expect(
      restrictionReasons({
        access: { ...ready, qqOnline: false, attachEnabled: false, hasD2: false },
        sipEnabled: true,
      }).map((r) => r.code),
    ).toEqual(['offline', 'disabled']);
    expect(restrictionReasons({})).toEqual([]);
    expect(restrictionReasons({ failed: true })[0]?.code).toBe('checking');
    expect(restrictionReasons({ access: ready, failed: true })[0]?.code).toBe('checking');
  });
});

let cleanup = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      ipcRenderer: {
        send: mock.send,
        on: (channel: string, fn: (...args: unknown[]) => void) => {
          mock.listeners.set(channel, fn);
          return () => mock.listeners.delete(channel);
        },
      },
    },
  });
  mock.access = { ...ready };
  mock.failed = false;
  mock.sip = null;
  mock.send.mockClear();
  mock.listeners.clear();
  mock.credentialsReady = undefined;
  mock.unsubscribe.mockClear();
  mock.invalidateAccess.mockReset();
  useViewState.setState({ view: 'main', openedUin: '10001' });
  useRestrictedMode.setState({ reasons: [], requests: [], open: false });
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() => root.render(h('div', null, h(RestrictedModeIndicator), h(RestrictedModeHost))));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  render();
  return { host, render };
}
function event(channel: string, payload: unknown) {
  act(() => mock.listeners.get(channel)?.({}, payload));
}

describe('非阻塞提权入口', () => {
  it('提交授权不冒充成功，凭据就绪后立即刷新共享状态并恢复，无需手动刷新', async () => {
    mock.access = { ...ready, hasD2Key: false };
    const f = fixture();
    event('elev:request-password', { token: 41 });
    event('elev:cancel-password', { token: 41 });
    expect(f.host.textContent).toContain('受限模式');
    expect(mock.invalidateAccess).not.toHaveBeenCalled();
    expect(useToast.getState().toasts.some((t) => t.tone === 'success')).toBe(false);
    mock.invalidateAccess.mockImplementation(async () => {
      mock.access = { ...ready };
      f.render();
    });
    await act(async () => mock.credentialsReady?.());
    expect(mock.invalidateAccess).toHaveBeenCalledOnce();
    expect(f.host.querySelector('.weq-restricted-indicator')).toBeNull();
    expect(useToast.getState().toasts.filter((t) => t.tone === 'success')).toHaveLength(1);
  });
  it('就绪信号只触发实际状态重查，不掩盖凭据缺失或未结束的授权', async () => {
    mock.access = { ...ready, hasD2Key: false };
    const f = fixture();
    await act(async () => mock.credentialsReady?.());
    expect(mock.invalidateAccess).toHaveBeenCalledOnce();
    expect(f.host.textContent).toContain('受限模式');
    expect(useToast.getState().toasts.some((t) => t.tone === 'success')).toBe(false);
    event('elev:request-password', { token: 41 });
    mock.access = { ...ready };
    f.render();
    await act(async () => mock.credentialsReady?.());
    expect(f.host.textContent).toContain('受限模式');
    expect(useToast.getState().toasts.some((t) => t.tone === 'success')).toBe(false);
  });
  it('退出账号时清理就绪订阅，启动页不订阅账号凭据', () => {
    const f = fixture();
    expect(mock.credentialsReady).toBeTypeOf('function');
    act(() => useViewState.setState({ view: 'startup', openedUin: null }));
    f.render();
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });
  it.each([undefined, ready])('启动即为完整模式及后续重复检查均不发成功通知：%j', (initial) => {
    mock.access = initial;
    const f = fixture();
    mock.access = { ...ready };
    f.render();
    f.render();
    expect(useToast.getState().toasts).toHaveLength(0);
  });
  it('启动受限时发横幅但不自动遮罩；点击横幅打开详情，恢复完整后消失', () => {
    mock.access = { ...ready, qqOnline: false };
    const f = fixture();
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toContain('受限模式');
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    expect(useToast.getState().toasts).toHaveLength(1);
    f.render();
    expect(useToast.getState().toasts).toHaveLength(1);
    act(() => useToast.getState().toasts[0]!.action!.run());
    expect(f.host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('false');
    expect(f.host.textContent).toContain('QQ 不在线');
    mock.access = { ...ready };
    f.render();
    expect(f.host.querySelector('.weq-restricted-indicator')).toBeNull();
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    expect(useToast.getState().toasts.at(-1)).toMatchObject({
      tone: 'success',
      title: '已恢复完整模式',
      durationKind: 'success',
    });
    f.render();
    expect(useToast.getState().toasts).toHaveLength(2);
    mock.access = { ...ready, qqOnline: false };
    f.render();
    expect(useToast.getState().toasts).toHaveLength(3);
    mock.access = { ...ready };
    f.render();
    expect(useToast.getState().toasts.filter((toast) => toast.tone === 'success')).toHaveLength(2);
  });
  it('部分限制解除或状态未知不报成功，确认全部恢复后仅提示一次', () => {
    mock.access = { ...ready, qqOnline: false, attachEnabled: false };
    const f = fixture();
    mock.access = { ...ready, attachEnabled: false };
    f.render();
    expect(useToast.getState().toasts.some((toast) => toast.tone === 'success')).toBe(false);
    mock.access = undefined;
    f.render();
    expect(useToast.getState().toasts.some((toast) => toast.tone === 'success')).toBe(false);
    mock.access = { ...ready };
    f.render();
    f.render();
    expect(useToast.getState().toasts.filter((toast) => toast.tone === 'success')).toHaveLength(1);
  });
  it('仍有待处理授权时不报恢复，最后一个限制解除才通知', () => {
    mock.access = { ...ready, qqOnline: false };
    const f = fixture();
    event('elev:request-password', { token: 41 });
    mock.access = { ...ready };
    f.render();
    expect(useToast.getState().toasts.some((toast) => toast.tone === 'success')).toBe(false);
    event('elev:cancel-password', { token: 41 });
    f.render();
    expect(useToast.getState().toasts.filter((toast) => toast.tone === 'success')).toHaveLength(1);
  });
  it('待提权密码在详情内填写，正确回传 token，关闭详情不取消后台请求', () => {
    const f = fixture();
    event('elev:request-password', { token: 23, title: '读取 QQ 内存', message: '管理员授权' });
    expect(f.host.querySelector('input')).toBeNull();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-restricted-indicator')!.click());
    expect(f.host.querySelector('input')?.type).toBe('password');
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click());
    expect(mock.send).not.toHaveBeenCalled();
    expect(useRestrictedMode.getState().requests).toHaveLength(1);
    event('elev:cancel-password', { token: 22 });
    expect(useRestrictedMode.getState().requests).toHaveLength(1);
    act(() => useRestrictedMode.getState().setOpen(true));
    const input = f.host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'test-password',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(mock.send).toHaveBeenCalledWith('elev:respond-password', {
      token: 23,
      password: 'test-password',
    });
    expect(f.host.querySelector('input')).toBeNull();
    expect(useRestrictedMode.getState().requests).toHaveLength(0);
  });
  it('Linux ptrace 请求提供免密重试；超时与取消只移除对应请求且清理密码', () => {
    const f = fixture();
    event('attach:confirm-hint', { token: 4 });
    event('elev:request-password', { token: 8 });
    act(() => useRestrictedMode.getState().setOpen(true));
    expect(f.host.textContent).toContain('Linux 的 ptrace');
    event('elev:cancel-password', { token: 8 });
    expect(f.host.querySelectorAll('input')).toHaveLength(1);
    act(() =>
      [...f.host.querySelectorAll('button')].find((b) => b.textContent === '重试免密读取')!.click(),
    );
    expect(mock.send).toHaveBeenCalledWith('attach:respond-hint', {
      token: 4,
      choice: 'retry',
      password: '',
    });
    event('elev:request-password', { token: 9 });
    act(() => useRestrictedMode.getState().setOpen(true));
    expect(f.host.querySelector('input')?.value).toBe('');
    event('elev:cancel-password', { token: 9 });
    expect(f.host.querySelector('input')).toBeNull();
  });
});
