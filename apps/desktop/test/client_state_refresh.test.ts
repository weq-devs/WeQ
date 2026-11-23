import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientStateSync } from '../src/renderer/src/components/ClientStateSync';
import { setRemoteWorkspaceCheckPending } from '../src/renderer/src/lib/remoteWorkspaceCheck';

type SettingsListener = (event: {
  revision: number;
  section: 'preferences';
  settings?: { fields: string[]; groups: string[]; clientFields: string[] };
}) => void;

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  snapshot: vi.fn(),
  accountSnapshot: vi.fn(),
  invalidations: [] as string[],
  subscribe: vi.fn(
    (_input: undefined, _options: { onStarted: () => void; onData: SettingsListener }) => ({
      unsubscribe() {},
    }),
  ),
}));

vi.mock('../src/renderer/src/trpc/client', () => {
  const utils = (path = '') =>
    new Proxy(
      { invalidate: () => void mocks.invalidations.push(path) },
      {
        get: (target, key) =>
          key === 'invalidate'
            ? target.invalidate
            : utils([path, String(key)].filter(Boolean).join('.')),
      },
    );
  const stableUtils = utils();
  return {
    client: {
      clientState: {
        changed: { subscribe: mocks.subscribe },
        snapshot: { query: mocks.snapshot },
        accountSnapshot: { query: mocks.accountSnapshot },
        accountChanged: { subscribe: () => ({ unsubscribe() {} }) },
      },
    },
    trpc: {
      useUtils: () => stableUtils,
      bootstrap: { getSettings: { useQuery: () => ({}) } },
      account: {
        getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'fixture' } }) },
      },
    },
  };
});

vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  initializePreferences: mocks.initialize,
  acceptPreferences: vi.fn(),
  acceptAccountState: vi.fn(),
  bindAccountState: vi.fn(),
  migrateAccountState: vi.fn(),
  retryPreferences: vi.fn(),
  useClientPreferences: () => null,
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: () => '10001',
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setRemoteWorkspaceCheckPending(false);
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(initialize = async () => {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.subscribe.mockReturnValue({ unsubscribe() {} });
  mocks.initialize.mockImplementation(initialize);
  mocks.snapshot.mockResolvedValue({});
  mocks.accountSnapshot.mockResolvedValue({});
  const container = document.createElement('div');
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => root.render(createElement(ClientStateSync)));
  mocks.invalidations.length = 0;
  mocks.snapshot.mockClear();
  mocks.accountSnapshot.mockClear();
  return { event: mocks.subscribe.mock.calls[0]?.[1].onData, container };
}

it('单个普通页面设置变更只刷新全局设置，不访问其他业务或账号快照', async () => {
  const { event } = await fixture();
  await act(async () =>
    event!({
      revision: 1,
      section: 'preferences',
      settings: { fields: ['qzoneNamePriority'], groups: [], clientFields: [] },
    }),
  );
  expect(mocks.invalidations).toEqual(['bootstrap.getSettings']);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.accountSnapshot).not.toHaveBeenCalled();
});

it('装扮和省流量只刷新关联服务，旧事件仍触发完整校准', async () => {
  const { event } = await fixture();
  await act(async () =>
    event!({
      revision: 1,
      section: 'preferences',
      settings: { fields: [], groups: ['dress', 'client'], clientFields: ['dataSaverMode'] },
    }),
  );
  expect(mocks.invalidations).toEqual([
    'bootstrap.getSettings',
    'settings.dress.get',
    'account.dressup.getState',
    'settings.dataSaver.status',
    'settings.networkCost',
  ]);
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  mocks.invalidations.length = 0;
  await act(async () => event!({ revision: 2, section: 'preferences' }));
  expect(mocks.invalidations).toHaveLength(12);
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});

it('共享快照在途时合并后续通知，仍补读最后一次变化', async () => {
  const { event } = await fixture();
  let release!: () => void;
  mocks.snapshot.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const changedBackground = (revision: number) =>
    event!({
      revision,
      section: 'preferences',
      settings: { fields: [], groups: ['client'], clientFields: ['background'] },
    });
  await act(async () => {
    changedBackground(1);
    changedBackground(2);
    changedBackground(3);
  });
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  await act(async () => release());
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});

it('Remote 从缓存启动时等电脑验证完成再读取共享设置', async () => {
  setRemoteWorkspaceCheckPending(true);
  const { container } = await fixture();
  expect(mocks.initialize).not.toHaveBeenCalled();
  expect(mocks.subscribe).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => setRemoteWorkspaceCheckPending(false));
  expect(mocks.initialize).toHaveBeenCalledOnce();
  expect(mocks.subscribe).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('真正的读取失败可以关闭，重试成功也会收起提示', async () => {
  const fail = async () => {
    throw new Error('test failure');
  };
  const { container } = await fixture(fail);
  const status = () => container.querySelector('[role="status"]');
  expect(status()?.textContent).not.toContain('test failure');
  const [retry, dismiss] = status()!.querySelectorAll('button');
  await act(async () => retry!.click());
  expect(mocks.initialize).toHaveBeenCalledTimes(2);
  await act(async () => dismiss!.click());
  expect(status()).toBeNull();
  const refresh = mocks.subscribe.mock.calls[0]![1].onStarted;
  await act(async () => refresh());
  mocks.initialize.mockResolvedValue(undefined);
  await act(async () => status()!.querySelector('button')!.click());
  expect(status()).toBeNull();
});
