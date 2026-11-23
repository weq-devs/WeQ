import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { DEFAULT_APP_SETTINGS } from '@weq/service';
import { BackupStartupGate } from '../src/renderer/src/components/BackupStartupGate';
import { WebStartupCache, hydrateWebStartupCache } from '../src/renderer/src/lib/webStartupCache';
import {
  readRemoteWorkspace,
  saveRemoteWorkspace,
  useRemoteImagePreference,
  type RemoteStartupSnapshot,
} from '../src/renderer/src/lib/remoteWebStartup';
import { setRemoteWorkspaceCheckPending } from '../src/renderer/src/lib/remoteWorkspaceCheck';
import { useViewState } from '../src/renderer/src/state/view';
import { trpc } from '../src/renderer/src/trpc/client';

const startup = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/lib/target.shared', async (load) => ({
  ...(await load<typeof import('../src/renderer/src/lib/target.shared')>()),
  IS_WEB: true,
}));
vi.mock('../src/renderer/src/trpc/client', async (load) => ({
  ...(await load<typeof import('../src/renderer/src/trpc/client')>()),
  client: {
    startup: { snapshot: { query: startup } },
    bootstrap: { onRuntimeFilesChanged: { subscribe: () => ({ unsubscribe() {} }) } },
  },
}));

it.each(['home', 'messages', 'last'] as const)(
  '快照复用当前 %s 启动设置，工作区挂载不重复读取配置',
  async (startupPage) => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: 30000 } } });
    try {
      hydrateWebStartupCache(cache, {
        native: null,
        current: { uin: '10001' },
        settings: { ...DEFAULT_APP_SETTINGS, startupPage },
        config: null,
        home: null,
      });
      const fetch = vi.fn(async () => ({ uin: 'wrong' }));
      const current = await cache.fetchQuery(
        getQueryKey(trpc.bootstrap.currentAccount, undefined, 'query'),
        fetch,
      );
      expect(current).toEqual({ uin: '10001' });
      const fetchSettings = vi.fn(async () => DEFAULT_APP_SETTINGS);
      const settings = await cache.fetchQuery(
        getQueryKey(trpc.bootstrap.getSettings, undefined, 'query'),
        fetchSettings,
      );
      expect(settings.startupPage).toBe(startupPage);
      expect(fetchSettings).not.toHaveBeenCalled();
      expect(
        cache.getQueryData(getQueryKey(trpc.account.getAccountConfig, undefined, 'query')),
      ).toBeNull();
    } finally {
      cache.clear();
    }
  },
);

it('Remote 离线恢复直取设置，重连收到关闭后更新当前页面和下次启动缓存', async () => {
  const config: RemoteStartupSnapshot['config'] = {
    uin: '10001',
    configId: 'offline-avatar-test',
    static: false,
    mobile: false,
    qzoneStagedImageUpload: undefined,
    dbKey: '',
    a1: null,
    guid: null,
    session: null,
    algos: {},
    dataDir: null,
    qqOnline: false,
    qqPid: null,
    rkeys: [],
    rkeyUpdatedAt: null,
    clientKey: null,
  };
  const cache = new QueryClient();
  const host = document.createElement('div');
  const root = createRoot(host);
  const previousView = useViewState.getState();
  const key = getQueryKey(trpc.bootstrap.getSettings, undefined, 'query');
  function Preference() {
    const { data } = useQuery({
      queryKey: key,
      queryFn: async () => DEFAULT_APP_SETTINGS,
      enabled: false,
    });
    const direct = useRemoteImagePreference(data?.preferRemoteCdn);
    return createElement('output', null, String(direct));
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('sessionStorage', new Storage());
  vi.stubGlobal('location', { hostname: '127.0.0.1' });
  vi.stubGlobal('weqRemoteShell', { openMenu() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  startup.mockRejectedValue(new Error('电脑不可达'));
  try {
    saveRemoteWorkspace(config, { ...DEFAULT_APP_SETTINGS, preferRemoteCdn: true }, false);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(
            WebStartupCache.Provider,
            { value: cache },
            createElement(BackupStartupGate, null, createElement(Preference)),
          ),
        ),
      );
    });
    const output = host.querySelector('output');
    expect(output?.textContent).toBe('true');
    expect(cache.getQueryData(key)).toBeUndefined();

    startup.mockResolvedValue({
      backup: { ok: true, error: null, result: null },
      snapshot: {
        native: null,
        current: { uin: config.uin },
        settings: { ...DEFAULT_APP_SETTINGS, preferRemoteCdn: false },
        config,
        home: null,
      } satisfies RemoteStartupSnapshot,
    });
    await act(async () => {
      window.dispatchEvent(new Event('weq-remote-connection'));
    });
    expect(host.querySelector('output')).toBe(output);
    expect(output?.textContent).toBe('false');
    expect(readRemoteWorkspace()?.preferRemoteCdn).toBe(false);
  } finally {
    act(() => root.unmount());
    cache.clear();
    useViewState.setState(previousView);
    setRemoteWorkspaceCheckPending(false);
    startup.mockReset();
    hidden.mockRestore();
    vi.unstubAllGlobals();
  }
});
