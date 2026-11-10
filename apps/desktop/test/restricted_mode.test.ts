import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restrictionReasons,
  startupRestrictionReasons,
  type OnlineAccess,
} from '../src/renderer/src/lib/restrictedMode';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';
import {
  RestrictedModeHost,
  RestrictedModeIndicator,
  AuthorizationForm,
} from '../src/renderer/src/components/RestrictedMode';
import { useViewState } from '../src/renderer/src/state/view';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';
import type { QqDataAccess } from '../src/main/qq_data_access';
import type { QqDebugCopyStatus } from '../src/shared/qq_debug_copy';
vi.mock('../src/renderer/src/lib/target', () => ({ IS_MAC: true, IS_WEB: false }));

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
  updatedAt: 0,
  failed: false,
  sip: null as boolean | null,
  onlineCount: 1 as number | null,
  runningCount: null as number | null,
  dataAccess: { status: 'unsupported', applicationPath: '', issues: [] } as QqDataAccess,
  dataRefetch: vi.fn(),
  invalidateBootstrap: vi.fn(async () => {}),
  openSettings: vi.fn(async () => true),
  onlineFailed: false,
  banner: true,
  settingsLoading: false,
  launchQq: vi.fn(async () => true),
  debugAction: vi.fn(async () => ({})),
  requestFull: vi.fn(),
  refreshRkeys: vi.fn(),
  refetch: vi.fn(async () => ({})),
  send: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  credentialsReady: undefined as undefined | (() => void),
  unsubscribe: vi.fn(),
  invalidateAccess: vi.fn(async () => {}),
  invalidateDebug: vi.fn(async () => {}),
  debugState: 'missing' as QqDebugCopyStatus['state'],
  debugPids: [] as number[],
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      launchQq: { mutate: mock.launchQq },
      qqDebugCopyAction: { mutate: mock.debugAction },
      openQqDataAccessSettings: { mutate: mock.openSettings },
    },
    account: {
      requestFullMode: { mutate: mock.requestFull },
      refreshRkeys: { mutate: mock.refreshRkeys },
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
        useQuery: () => ({
          data: mock.access,
          dataUpdatedAt: mock.updatedAt,
          isError: mock.failed,
          refetch: mock.refetch,
        }),
      },
    },
    bootstrap: {
      qqDebugCopyStatus: {
        useQuery: () => ({
          data: {
            phase: 'idle',
            state: mock.debugState,
            sourceVersion: '7.0.1-1',
            path: '/synthetic/QQ-WeQ.app',
            readerReady: false,
            runningPids: mock.debugPids,
            message: '合成副本状态',
          },
          refetch: mock.refetch,
        }),
      },
      qqDataAccess: {
        useQuery: () => ({
          data: mock.dataAccess,
          isFetching: false,
          isError: false,
          refetch: mock.dataRefetch,
        }),
      },
      getSettings: {
        useQuery: () => ({
          data: { restrictedModeBannerEnabled: mock.banner },
          isLoading: mock.settingsLoading,
        }),
      },
      sipEnabled: { useQuery: () => ({ data: mock.sip, refetch: mock.refetch }) },
      signerStatus: { useQuery: () => ({ data: undefined }) },
      probeOnline: {
        useQuery: () => ({
          data: { count: mock.onlineCount, runningCount: mock.runningCount },
          isError: mock.onlineFailed,
          refetch: mock.refetch,
        }),
      },
    },
  },
}));
const utils = {
  account: { getGroupAlbumAccessState: { invalidate: mock.invalidateAccess } },
  bootstrap: {
    listAccounts: { invalidate: mock.invalidateBootstrap },
    listAccountConfigs: { invalidate: mock.invalidateBootstrap },
    describeInstall: { invalidate: mock.invalidateBootstrap },
    qqDebugCopyStatus: { invalidate: mock.invalidateDebug },
  },
};

describe('受限原因按实际能力判定', () => {
  it.each([true, false, null, undefined])('离线登录引导跟随 SIP 状态：%s', (sipEnabled) => {
    const inputs = [
      startupRestrictionReasons({ probe: { count: 0 }, sipEnabled }),
      restrictionReasons({ access: { ...ready, qqOnline: false }, sipEnabled }),
    ];
    for (const reasons of inputs) {
      expect(reasons.map((reason) => reason.code)).toEqual(['offline']);
      expect(reasons[0]?.guidance.includes('QQ 调试副本')).toBe(sipEnabled === true);
    }
  });
  it('启动状态文件未知但 QQ 进程存在时，不显示不在线；数据读取受限独立列出', () => {
    const reasons = startupRestrictionReasons({
      probe: { count: null, runningCount: 1 },
      dataStatus: 'denied',
    });
    expect(reasons.map((reason) => reason.code)).toContain('data-access');
    expect(reasons.map((reason) => reason.code)).not.toContain('offline');
    expect(reasons.find((reason) => reason.code === 'checking')?.guidance).toContain('QQ 正在运行');
    expect(startupRestrictionReasons({ probe: { count: 0 } })[0]?.code).toBe('offline');
  });
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
  it('SIP 开启但后台正在读取时显示进入进度，不误报调试读取未就绪', () => {
    mock.sip = true;
    mock.access = { ...ready, hasD2Key: false, credentialsPending: true };
    const f = fixture();
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('正在启用完整功能');
    expect(useRestrictedMode.getState().reasons.map((reason) => reason.code)).not.toContain('sip');
    mock.access = { ...ready, credentialsPending: false };
    mock.updatedAt = Date.now() + 1;
    f.render();
    expect(f.host.querySelector('.weq-restricted-indicator')).toBeNull();
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
  it.each([{ hasUid: false }, { needsMemoryRead: true }, { ssoReady: false }])(
    '三项旧凭据非空也不冒充完整模式，仍需当前会话与账号身份可用：%j',
    (state) => {
      expect(
        restrictionReasons({ access: { ...ready, ...state }, sipEnabled: false }).map(
          (r) => r.code,
        ),
      ).toEqual(['credentials']);
    },
  );
});

let cleanup = () => {};
beforeEach(() => {
  Object.defineProperty(window, 'weq', { configurable: true, value: undefined });
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
  mock.updatedAt = Date.now();
  mock.failed = false;
  mock.sip = null;
  mock.onlineCount = 1;
  mock.runningCount = null;
  mock.dataAccess = { status: 'unsupported', applicationPath: '', issues: [] };
  mock.dataRefetch.mockReset().mockImplementation(async () => ({ data: mock.dataAccess }));
  mock.invalidateBootstrap.mockClear();
  mock.openSettings.mockClear();
  mock.onlineFailed = false;
  mock.banner = true;
  mock.settingsLoading = false;
  mock.launchQq.mockReset().mockResolvedValue(true);
  mock.debugAction.mockReset().mockResolvedValue({});
  mock.requestFull.mockReset().mockResolvedValue({ requested: true });
  mock.refreshRkeys.mockReset().mockResolvedValue(false);
  mock.refetch.mockClear();
  mock.send.mockClear();
  mock.listeners.clear();
  mock.credentialsReady = undefined;
  mock.unsubscribe.mockClear();
  mock.invalidateAccess.mockReset();
  mock.invalidateDebug.mockReset().mockResolvedValue(undefined);
  mock.debugState = 'missing';
  mock.debugPids = [];
  useViewState.setState({ view: 'main', openedUin: '10001' });
  useRestrictedMode.setState({
    reasons: [],
    reasonSource: null,
    requests: [],
    open: false,
    enteringSince: null,
  });
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(showToasts = false, showDialogs = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let revision = 0;
  const render = () =>
    act(() =>
      root.render(
        h(
          'div',
          null,
          h(RestrictedModeIndicator),
          h(RestrictedModeHost, { key: revision }),
          showToasts ? h(ToastHost) : null,
          showDialogs ? h(DialogHost) : null,
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
    remount: () => {
      revision += 1;
      render();
    },
  };
}
function event(channel: string, payload: unknown) {
  act(() => mock.listeners.get(channel)?.({}, payload));
}

it.each(['取消', 'Escape', '移除副本'])(
  '受限详情上的移除确认框处理 %s，不关闭底层详情',
  async (action) => {
    mock.access = { ...ready, attachEnabled: false };
    const f = fixture(false, true);
    act(() => useRestrictedMode.getState().setOpen(true));
    const panel = f.host.querySelector<HTMLElement>('.weq-restricted-panel')!;
    let result: Promise<boolean> | undefined;
    act(() => {
      result = useDialog
        .getState()
        .confirm('移除 QQ 调试副本', '合成确认', { okLabel: '移除副本' });
    });
    const dialog = document.querySelector<HTMLElement>('.weq-message-modal')!;
    expect(Number(dialog.closest<HTMLElement>('.weq-dialog-layer')!.style.zIndex)).toBeGreaterThan(
      Number(panel.style.zIndex),
    );
    await act(async () => {
      if (action === 'Escape')
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      else {
        const button = [...dialog.querySelectorAll('button')].find(
          (item) => item.textContent === action,
        )!;
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        button.click();
      }
    });
    expect(await result).toBe(action === '移除副本');
    expect(useRestrictedMode.getState().open).toBe(true);
    expect(f.host.contains(panel)).toBe(true);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(useRestrictedMode.getState().open).toBe(false);
  },
);

it('手动启用提交完整来源，不修改自动偏好；普通重新检查不升级为手动请求', async () => {
  const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-live' };
  mock.access = { ...ready, attachEnabled: false, source };
  const f = fixture();
  act(() => useRestrictedMode.getState().setOpen(true));
  await act(async () =>
    [...f.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '重新检查')!
      .click(),
  );
  expect(mock.requestFull).not.toHaveBeenCalled();
  expect(mock.refreshRkeys).not.toHaveBeenCalled();
  await act(async () =>
    [...f.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '启用完整功能')!
      .click(),
  );
  expect(mock.requestFull).toHaveBeenCalledOnce();
  expect(mock.requestFull).toHaveBeenCalledWith(source);
  expect(mock.refreshRkeys).toHaveBeenCalledOnce();
  expect(f.host.textContent).toContain('尚未恢复完整功能');
  expect(useToast.getState().toasts.some((toast) => toast.title === '已启用完整功能')).toBe(false);
});
it.each(['missing', 'ready', 'outdated', 'invalid', 'unmanaged'] as const)(
  'SIP 副本 %s 状态的嵌入面板只显示一个重新检查，点击同时刷新副本和在线状态',
  async (state) => {
    mock.sip = true;
    mock.debugState = state;
    mock.access = { ...ready, hasD2: false };
    const f = fixture();
    act(() => useRestrictedMode.getState().setOpen(true));
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === '重新检查',
    );
    expect(buttons).toHaveLength(1);
    await act(async () => buttons[0]!.click());
    expect(mock.invalidateDebug).toHaveBeenCalledOnce();
    expect(mock.refreshRkeys).toHaveBeenCalledOnce();
    expect(mock.requestFull).not.toHaveBeenCalled();
  },
);
it('副本、数据读取提示和多项授权同时出现时，通用检查及长期授权入口仍各只有一份', async () => {
  Object.defineProperty(window, 'weq', { configurable: true, value: { authorization: {} } });
  mock.sip = true;
  mock.access = { ...ready, hasD2: false };
  mock.dataAccess = { status: 'denied', applicationPath: '/synthetic/WeQ.app', issues: [] };
  const f = fixture();
  event('elev:request-password', { token: 41 });
  event('attach:confirm-hint', { token: 42 });
  act(() => useRestrictedMode.getState().setOpen(true));
  const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons.filter((button) => button.textContent === '重新检查')).toHaveLength(1);
  expect(buttons.filter((button) => button.textContent === '重新检测')).toHaveLength(0);
  expect(buttons.filter((button) => button.textContent === '管理长期授权')).toHaveLength(1);
  await act(async () => buttons.find((button) => button.textContent === '重新检查')!.click());
  expect(mock.invalidateDebug).toHaveBeenCalledOnce();
  expect(mock.dataRefetch).toHaveBeenCalledOnce();
  expect(mock.send).not.toHaveBeenCalled();
  expect(useRestrictedMode.getState().requests).toHaveLength(2);
});
it('等待副本刷新时切换来源，不把旧来源检查继续应用到新账号', async () => {
  mock.sip = true;
  mock.access = {
    ...ready,
    hasD2: false,
    source: { expectedAccountUin: '10001', expectedAccountConfigId: 'old' },
  };
  let finish = () => {};
  mock.invalidateDebug.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture();
  act(() => useRestrictedMode.getState().setOpen(true));
  await act(async () =>
    [...f.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '重新检查')!
      .click(),
  );
  mock.access = {
    ...mock.access,
    source: { expectedAccountUin: '10001', expectedAccountConfigId: 'new' },
  };
  f.render();
  await act(async () => finish());
  expect(mock.refreshRkeys).not.toHaveBeenCalled();
});
it('同号切源丢弃手动请求的迟到结果，不在新来源继续采集', async () => {
  const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-live' };
  mock.access = { ...ready, attachEnabled: false, source };
  let finish!: (value: { requested: boolean }) => void;
  mock.requestFull.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture();
  act(() => useRestrictedMode.getState().setOpen(true));
  await act(async () =>
    [...f.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '启用完整功能')!
      .click(),
  );
  mock.access = {
    ...mock.access,
    source: { ...source, expectedAccountConfigId: 'synthetic-backup' },
  };
  f.render();
  await act(async () => finish({ requested: true }));
  expect(mock.refreshRkeys).not.toHaveBeenCalled();
  expect(f.host.textContent).not.toContain('尚未恢复完整功能');
});

it('启动数据授权只在受限模式详情显示，运行中的 QQ 不显示为离线', async () => {
  useViewState.setState({ view: 'startup', openedUin: null });
  mock.onlineCount = null;
  mock.runningCount = 1;
  mock.dataAccess = {
    status: 'denied',
    applicationPath: '/fixture/Electron.app',
    launchApplicationPath: '/System/Applications/Utilities/Terminal.app',
    issues: [{ path: '/fixture/QQ', code: 'EPERM' }],
  };
  const f = fixture();
  expect(f.host.querySelector('.weq-qq-data-access')).toBeNull();
  expect(useRestrictedMode.getState().reasons.map((r) => r.code)).toEqual([
    'data-access',
    'checking',
  ]);
  act(() => useRestrictedMode.getState().setOpen(true));
  expect(f.host.querySelector('[role="dialog"] .weq-qq-data-access')).not.toBeNull();
  expect(f.host.textContent).toContain('QQ 正在运行');
  expect(f.host.textContent).not.toContain('QQ 不在线');
  expect(f.host.textContent).toContain('/System/Applications/Utilities/Terminal.app');
  expect(
    [...f.host.querySelectorAll('button')].filter((b) => b.textContent === '重新检查'),
  ).toHaveLength(1);
  await act(async () =>
    [...f.host.querySelectorAll('button')].find((b) => b.textContent === '打开系统设置')!.click(),
  );
  expect(mock.openSettings).toHaveBeenCalledOnce();
});

it('受限模式统一重试在数据恢复后刷新账号并收起提示，不虚报完整功能', async () => {
  useViewState.setState({ view: 'startup', openedUin: null });
  mock.onlineCount = null;
  mock.dataAccess = { status: 'denied', applicationPath: '/fixture/Electron.app', issues: [] };
  mock.dataRefetch.mockImplementation(async () => {
    mock.dataAccess = { ...mock.dataAccess, status: 'readable' };
    mock.onlineCount = 1;
    return { data: mock.dataAccess };
  });
  const f = fixture(true);
  act(() => useRestrictedMode.getState().setOpen(true));
  await act(async () =>
    [...f.host.querySelectorAll('button')].find((b) => b.textContent === '重新检查')!.click(),
  );
  expect(mock.invalidateBootstrap).toHaveBeenCalledTimes(3);
  expect(useRestrictedMode.getState().reasons).toEqual([]);
  expect(f.host.querySelector('[role="dialog"]')).toBeNull();
  expect(useToast.getState().toasts.some((toast) => toast.title === '已启用完整功能')).toBe(false);
});
it('切到已完整的新来源不继承旧来源的恢复成功通知', () => {
  const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-a' };
  mock.access = { ...ready, attachEnabled: false, source };
  const f = fixture(true);
  mock.access = { ...ready, source: { ...source, expectedAccountConfigId: 'synthetic-b' } };
  f.render();
  expect(useToast.getState().toasts.some((toast) => toast.title === '已启用完整功能')).toBe(false);
});
it('启动页仅检测 QQ 在线不能冒称已启用完整功能', () => {
  useViewState.setState({ view: 'bootstrap', openedUin: null });
  mock.onlineCount = 0;
  const f = fixture(true);
  mock.onlineCount = 1;
  f.render();
  expect(useToast.getState().toasts.some((toast) => toast.title === '已启用完整功能')).toBe(false);
});
it('启动 QQ 的旧来源迟到错误不显示到同号新来源', async () => {
  const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-a' };
  mock.access = { ...ready, qqOnline: false, source };
  let fail!: (error: Error) => void;
  mock.launchQq.mockImplementationOnce(
    () =>
      new Promise<boolean>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const f = fixture();
  act(() => useRestrictedMode.getState().setOpen(true));
  act(() =>
    [...f.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '启动 QQ')!
      .click(),
  );
  mock.access = { ...mock.access, source: { ...source, expectedAccountConfigId: 'synthetic-b' } };
  f.render();
  await act(async () => fail(new Error('合成旧来源启动失败')));
  act(() => useRestrictedMode.getState().setOpen(true));
  expect(f.host.textContent).not.toContain('合成旧来源启动失败');
});
it('失效授权表单不转发旧 token 或把新来源标记成进入中', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() =>
    root.render(
      h(AuthorizationForm, {
        request: { kind: 'password', token: 999, title: '合成过期授权', message: '合成请求' },
      }),
    ),
  );
  act(() => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'synthetic-password',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(mock.send).not.toHaveBeenCalled();
  expect(useRestrictedMode.getState().enteringSince).toBeNull();
});

it('关闭被动提醒仍保留状态入口，更新去重基线，重新开启不补发旧事件', () => {
  mock.banner = false;
  mock.access = { ...ready, attachEnabled: false };
  const f = fixture(true);
  expect(f.host.querySelector('.weq-restricted-indicator')).not.toBeNull();
  expect(useToast.getState().toasts).toHaveLength(0);
  mock.access = { ...ready, qqOnline: false, attachEnabled: false };
  f.render();
  expect(useToast.getState().toasts).toHaveLength(0);
  mock.banner = true;
  f.render();
  expect(useToast.getState().toasts).toHaveLength(0);
  mock.access = { ...ready, attachEnabled: false };
  f.render();
  expect(useToast.getState().toasts.some((toast) => toast.key === 'restricted-mode')).toBe(true);
  mock.banner = false;
  f.render();
  const state = useToast.getState();
  expect(
    state.toasts.some(
      (toast) => toast.key === 'restricted-mode' && !state.leaving.includes(toast.id),
    ),
  ).toBe(false);
});
it('关闭被动提醒不隐藏真实授权、进入进度或恢复成功回执', () => {
  mock.banner = false;
  mock.access = { ...ready, hasD2: false };
  const f = fixture(true);
  event('elev:request-password', { token: 91, title: '合成授权' });
  expect(useToast.getState().toasts.some((toast) => toast.title.includes('待提权'))).toBe(true);
  act(() => {
    useRestrictedMode.getState().remove('password', 91);
    useRestrictedMode.getState().beginEntering();
  });
  expect(useToast.getState().toasts.some((toast) => toast.title === '正在启用完整功能')).toBe(true);
  mock.access = { ...ready };
  mock.updatedAt = Date.now() + 1000;
  f.render();
  expect(useToast.getState().toasts.some((toast) => toast.title === '已启用完整功能')).toBe(true);
});
it('偏好还在读取时也不隐藏真实授权提醒', () => {
  mock.settingsLoading = true;
  fixture(true);
  event('elev:request-password', { token: 101, title: '合成真实请求' });
  expect(useToast.getState().toasts.some((toast) => toast.title.includes('待提权'))).toBe(true);
});
function submitAuthorization(form: HTMLFormElement) {
  act(() => {
    const input = form.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'test-password',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('受限模式启动 QQ', () => {
  function launchButton(host: HTMLElement) {
    return [...host.querySelectorAll('button')].find((button) => button.textContent === '启动 QQ');
  }
  it.each([
    ['main', 'missing'],
    ['main', 'ready'],
    ['startup', 'missing'],
    ['startup', 'ready'],
  ] as const)('%s 页 SIP 开启且离线时使用 %s 调试副本入口', async (view, state) => {
    mock.sip = true;
    mock.access = { ...ready, qqOnline: false };
    mock.onlineCount = 0;
    mock.debugState = state;
    useViewState.setState({ view, openedUin: view === 'main' ? '10001' : null });
    const f = fixture();
    act(() => useRestrictedMode.getState().setOpen(true));
    expect(launchButton(f.host)).toBeUndefined();
    expect(f.host.textContent).toContain('QQ 调试副本');
    const button = [...f.host.querySelectorAll('button')].find(
      (item) => item.textContent === (state === 'missing' ? '准备并打开 QQ' : '打开 QQ'),
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button!.click());
    expect(mock.debugAction).toHaveBeenCalledWith({
      action: 'open',
    });
    expect(mock.launchQq).not.toHaveBeenCalled();
    expect(f.host.textContent).toContain('QQ 不在线');
    expect(useRestrictedMode.getState().enteringSince).toBeNull();
  });
  it('其他账号已有副本进程时仍只显示一个主操作，可继续打开新实例', async () => {
    mock.sip = true;
    mock.access = { ...ready, qqOnline: false };
    mock.debugState = 'ready';
    mock.debugPids = [42];
    const f = fixture();
    act(() => useRestrictedMode.getState().setOpen(true));
    const panel = f.host.querySelector('.weq-restricted-panel')!;
    expect(panel.querySelector('.weq-qq-debug-checks')).toBeNull();
    expect(panel.querySelector('.weq-qq-debug-details')).toBeNull();
    expect(
      panel.querySelectorAll('.weq-restricted-qq > .weq-restricted-actions > button'),
    ).toHaveLength(1);
    const launch = [...panel.querySelectorAll('button')].find(
      (item) => item.textContent === '登录其他账号',
    )!;
    expect(launch.disabled).toBe(false);
    await act(async () => launch.click());
    expect(mock.debugAction).toHaveBeenCalledWith({ action: 'open' });
    expect(panel.textContent).toContain('登录后会自动继续');
    expect(useRestrictedMode.getState().enteringSince).toBeNull();
    expect(mock.refreshRkeys).not.toHaveBeenCalled();
  });
  it('打开后仅在当前账号上线时继续启用，重复查询不重复请求', async () => {
    mock.sip = true;
    mock.access = {
      ...ready,
      qqOnline: false,
      attachEnabled: false,
      source: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    };
    mock.debugState = 'ready';
    const f = fixture();
    act(() => useRestrictedMode.getState().setOpen(true));
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((item) => item.textContent === '打开 QQ')!
        .click(),
    );
    expect(mock.requestFull).toHaveBeenCalledWith(mock.access.source);
    expect(mock.refreshRkeys).not.toHaveBeenCalled();
    mock.access = { ...mock.access, qqOnline: true };
    await act(async () => f.render());
    expect(mock.refreshRkeys).toHaveBeenCalledOnce();
    await act(async () => f.render());
    expect(mock.refreshRkeys).toHaveBeenCalledOnce();
  });
  it('打开后切换同号来源不会把继续启用请求带到新来源', async () => {
    mock.sip = true;
    mock.access = {
      ...ready,
      qqOnline: false,
      source: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    };
    const f = fixture();
    act(() => useRestrictedMode.getState().setOpen(true));
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((item) => item.textContent === '准备并打开 QQ')!
        .click(),
    );
    mock.access = {
      ...mock.access,
      qqOnline: true,
      source: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-b' },
    };
    await act(async () => f.render());
    expect(mock.refreshRkeys).not.toHaveBeenCalled();
  });
  it('当前账号在线但禁用完整功能时，主操作直接启用，不启动 QQ', async () => {
    mock.sip = true;
    mock.access = {
      ...ready,
      attachEnabled: false,
      source: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    };
    const f = fixture();
    act(() => useRestrictedMode.getState().setOpen(true));
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((item) => item.textContent === '启用完整功能')!
        .click(),
    );
    expect(mock.requestFull).toHaveBeenCalledWith(mock.access.source);
    expect(mock.debugAction).not.toHaveBeenCalled();
  });
  it.each(['main', 'startup'] as const)(
    '%s 页确认 QQ 离线时可启动，启动不冒充登录成功',
    async (view) => {
      mock.access = { ...ready, qqOnline: false };
      mock.onlineCount = 0;
      useViewState.setState({ view, openedUin: view === 'main' ? '10001' : null });
      const f = fixture();
      act(() => useRestrictedMode.getState().setOpen(true));
      expect(launchButton(f.host)).toBeDefined();
      await act(async () => launchButton(f.host)!.click());
      expect(mock.launchQq).toHaveBeenCalledOnce();
      expect(mock.launchQq).toHaveBeenCalledWith();
      expect(mock.refetch).toHaveBeenCalled();
      expect(f.host.textContent).toContain('QQ 不在线');
      expect(useRestrictedMode.getState().enteringSince).toBeNull();
      expect(useToast.getState().toasts.some((toast) => toast.tone === 'success')).toBe(false);
    },
  );
  it.each([{ ...ready, attachEnabled: false }, { ...ready, hasD2: false }, undefined])(
    '其他限制或状态未知不显示启动按钮：%j',
    (access) => {
      mock.access = access;
      mock.failed = access === undefined;
      const f = fixture();
      act(() => useRestrictedMode.getState().setOpen(true));
      expect(launchButton(f.host)).toBeUndefined();
      expect(mock.launchQq).not.toHaveBeenCalled();
    },
  );
  it('启动期间禁用操作，失败后显示原因并允许重试', async () => {
    mock.access = { ...ready, qqOnline: false, attachEnabled: false };
    let fail = (_error: Error) => {};
    mock.launchQq.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const f = fixture();
    act(() => useRestrictedMode.getState().setOpen(true));
    act(() => launchButton(f.host)!.click());
    const launching = [...f.host.querySelectorAll('button')].find(
      (button) => button.textContent === '正在启动 QQ',
    );
    expect(launching?.disabled).toBe(true);
    expect(
      [...f.host.querySelectorAll('.weq-restricted-actions button')].every(
        (button) => (button as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    act(() => launching!.click());
    expect(mock.launchQq).toHaveBeenCalledOnce();
    await act(async () => fail(new Error('未检测到 QQ 安装，请先安装 QQ。')));
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('未检测到 QQ 安装');
    expect(launchButton(f.host)?.disabled).toBe(false);
    await act(async () => launchButton(f.host)!.click());
    expect(mock.launchQq).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    mock.access = { ...ready, attachEnabled: false };
    f.render();
    expect(launchButton(f.host)).toBeUndefined();
    expect(f.host.textContent).toContain('本次运行未启用完整功能');
  });
});

describe('非阻塞提权入口', () => {
  it('重新检查与提权共用一行操作区，多项授权时只显示一次且不提交表单', async () => {
    Object.defineProperty(window, 'weq', { configurable: true, value: { authorization: {} } });
    const f = fixture();
    event('elev:request-password', { token: 41 });
    event('attach:confirm-hint', { token: 42 });
    act(() => useRestrictedMode.getState().setOpen(true));
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === '重新检查',
    );
    expect(buttons).toHaveLength(1);
    expect(
      [...f.host.querySelectorAll('button')].filter(
        (button) => button.textContent === '管理长期授权',
      ),
    ).toHaveLength(1);
    const row = buttons[0]!.closest('.weq-restricted-actions')!;
    expect(row.querySelector('[type="submit"]')?.textContent).toBe('提权');
    expect(row.closest('form')).not.toBeNull();
    await act(async () => buttons[0]!.click());
    expect(mock.refetch).toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
    expect(useRestrictedMode.getState().requests).toHaveLength(2);
  });
  it.each(['elev:request-password', 'attach:confirm-hint'])(
    '授权表单不显示取消按钮，仍可提交密码或免密重试：%s',
    (channel) => {
      const f = fixture();
      event(channel, { token: 41 });
      act(() => useRestrictedMode.getState().setOpen(true));
      const form = f.host.querySelector('form')!;
      const buttons = [...form.querySelectorAll('button')];
      expect(buttons.some((button) => button.textContent === '取消本次授权')).toBe(false);
      expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
      expect(buttons.some((button) => button.textContent === '重试免密读取')).toBe(
        channel === 'attach:confirm-hint',
      );
      expect(useRestrictedMode.getState().requests).toHaveLength(1);
      expect(mock.send).not.toHaveBeenCalled();
    },
  );
  it.each(['elev:request-password', 'attach:confirm-hint'])(
    '右下角已解决横幅在宿主重建后也自动消失，不清理其他错误：%s',
    async (channel) => {
      vi.useFakeTimers();
      try {
        useToast.getState().setDurations({ successSeconds: 3, failureSeconds: -1 });
        mock.access = { ...ready, hasD2Key: false };
        const f = fixture(true);
        event(channel, { token: 41 });
        let unrelated = 0;
        act(() => {
          unrelated = useToast.getState().push({ tone: 'error', title: '另一个未解决错误' });
        });
        f.remount();
        expect(f.host.querySelectorAll('.weq-toast-warning')).toHaveLength(1);
        act(() => useRestrictedMode.getState().setOpen(true));
        submitAuthorization(f.host.querySelector('form')!);
        expect(f.host.querySelector('.weq-toast-title')?.textContent).toBe('正在启用完整功能');
        mock.access = { ...ready };
        mock.updatedAt = Date.now() + 1;
        f.render();
        await act(async () => vi.advanceTimersByTimeAsync(500));
        expect(f.host.querySelector('.weq-toast-warning')).toBeNull();
        expect(f.host.textContent).not.toContain('待提权');
        expect(f.host.textContent).not.toContain('正在启用完整功能');
        expect(f.host.textContent).toContain('已启用完整功能');
        expect(useToast.getState().leaving).not.toContain(unrelated);
        await act(async () => vi.advanceTimersByTimeAsync(3500));
        expect(f.host.querySelectorAll('.weq-toast')).toHaveLength(1);
        expect(f.host.textContent).toContain('另一个未解决错误');
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(['elev:request-password', 'attach:confirm-hint'])(
    '未完成授权优先于后台准备状态，所有状态入口均不同时显示进入中：%s',
    (channel) => {
      mock.access = { ...ready, hasD2Key: false, ssoReady: false, credentialsPending: true };
      const f = fixture();
      const notice = useToast.getState().toasts.at(-1)!.id;
      expect(f.host.textContent).toContain('正在启用完整功能');
      event(channel, { token: 41, title: '读取 QQ 内存' });
      act(() => useRestrictedMode.getState().setOpen(true));
      expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('待提权');
      expect(f.host.querySelector('.weq-restricted-indicator')?.getAttribute('aria-busy')).toBe(
        'false',
      );
      expect(f.host.querySelector('[role="dialog"] h2')?.textContent).toBe('待提权');
      expect(f.host.textContent).toContain('管理员密码');
      expect(f.host.textContent).not.toContain('正在启用完整功能');
      expect(f.host.querySelector('[role="status"]')).toBeNull();
      expect(f.host.querySelector('.weq-restricted-progress-icon')).toBeNull();
      expect(f.host.querySelector('.weq-restricted-reason')).toBeNull();
      expect(useToast.getState().toasts).toHaveLength(1);
      expect(useToast.getState().toasts[0]).toMatchObject({
        id: notice,
        tone: 'warning',
        loading: false,
      });
      expect(useToast.getState().toasts[0]!.title).toContain('待提权');
      expect(useToast.getState().leaving).not.toContain(notice);
    },
  );
  it('提交最后一项授权后才恢复进入中，新的授权请求到来时再次暂停进度', () => {
    mock.access = { ...ready, ssoReady: false, credentialsPending: true };
    const f = fixture();
    event('attach:confirm-hint', { token: 4 });
    event('elev:request-password', { token: 8 });
    act(() => useRestrictedMode.getState().setOpen(true));
    submitAuthorization(f.host.querySelector('form')!);
    expect(mock.send).toHaveBeenCalledWith('attach:respond-hint', {
      token: 4,
      choice: 'skip',
      password: 'test-password',
    });
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('待提权');
    expect(f.host.textContent).not.toContain('正在启用完整功能');
    submitAuthorization(f.host.querySelector('form')!);
    expect(mock.send).toHaveBeenCalledWith('elev:respond-password', {
      token: 8,
      password: 'test-password',
    });
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('正在启用完整功能');
    expect(f.host.querySelector('form')).toBeNull();
    expect(useToast.getState().toasts.at(-1)!.loading).toBe(true);
    event('elev:request-password', { token: 9 });
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('待提权');
    expect(f.host.textContent).not.toContain('正在启用完整功能');
    expect(useToast.getState().toasts.at(-1)!.loading).toBe(false);
  });
  it('已关闭的进入中横幅在退场时也切换为待授权，不留下相反的进度文案', () => {
    mock.access = { ...ready, ssoReady: false, credentialsPending: true };
    fixture();
    const notice = useToast.getState().toasts.at(-1)!.id;
    act(() => useToast.getState().dismiss(notice));
    event('elev:request-password', { token: 41 });
    expect(useToast.getState().toasts.some((item) => item.title === '正在启用完整功能')).toBe(
      false,
    );
    expect(useToast.getState().toasts.every((item) => item.loading === false)).toBe(true);
    expect(useToast.getState().toasts.at(-1)!.title).toContain('待提权');
  });
  it('部分凭据和原生登记等待期间始终保留进入中状态，真正就绪后才结束', async () => {
    mock.access = { ...ready, ssoReady: false, credentialsPending: true };
    const f = fixture();
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('正在启用完整功能');
    expect(f.host.querySelector('.weq-restricted-indicator')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(useToast.getState().toasts.at(-1)).toMatchObject({
      title: '正在启用完整功能',
      loading: true,
      ttl: 0,
    });
    mock.access = { ...ready, hasD2Key: false, ssoReady: false, credentialsPending: true };
    mock.updatedAt = Date.now() + 1;
    f.render();
    expect(f.host.textContent).toContain('正在启用完整功能');
    expect(useToast.getState().toasts.some((t) => t.tone === 'success')).toBe(false);
    mock.access = { ...ready, ssoReady: true, credentialsPending: false };
    mock.updatedAt += 1;
    f.render();
    expect(f.host.querySelector('.weq-restricted-indicator')).toBeNull();
    expect(useToast.getState().toasts.filter((t) => t.tone === 'success')).toHaveLength(1);
  });
  it('进入中不能被旧的完整模式缓存提前清掉，失败或取消后可重新检查', () => {
    const f = fixture();
    act(() => useRestrictedMode.getState().beginEntering());
    expect(f.host.textContent).toContain('正在启用完整功能');
    expect(useToast.getState().toasts.some((t) => t.tone === 'success')).toBe(false);
    mock.access = { ...ready, ssoReady: false, credentialsPending: false };
    mock.updatedAt = Date.now() + 1;
    f.render();
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('受限模式');
    expect(useRestrictedMode.getState().enteringSince).toBeNull();
    expect(useToast.getState().toasts.some((t) => t.tone === 'success')).toBe(false);
  });
  it.each([{ hasD2Key: false }, { ssoReady: false }])(
    '提交授权不冒充成功，凭据就绪后立即刷新共享状态并恢复：%j',
    async (pending) => {
      mock.access = { ...ready, ...pending };
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
    },
  );
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
    expect(f.host.querySelector('.weq-restricted-indicator')?.textContent).toBe('待提权');
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
      title: '已启用完整功能',
      durationKind: 'success',
    });
    f.render();
    expect(useToast.getState().toasts).toHaveLength(2);
    mock.access = { ...ready, qqOnline: false };
    f.render();
    expect(useToast.getState().toasts).toHaveLength(2);
    expect(useToast.getState().toasts[0]!.title).toContain('QQ 不在线');
    expect(useToast.getState().leaving).not.toContain(useToast.getState().toasts[0]!.id);
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
    expect(f.host.textContent).toContain('正在启用完整功能');
    mock.access = { ...ready, ssoReady: true };
    mock.updatedAt = Date.now() + 1;
    f.render();
    expect(f.host.querySelector('.weq-restricted-indicator')).toBeNull();
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
