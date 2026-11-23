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
import { PageSnapshots, PageSnapshotScope } from '../src/renderer/src/components/PageSnapshots';
import { PageScrollSnapshot } from '../src/renderer/src/components/PageScrollSnapshot';
import { usePageState } from '../src/renderer/src/components/PageSnapshots.shared';
import { pageSnapshots, pageValue } from '../src/renderer/src/lib/pageSnapshots';
import { useViewState } from '../src/renderer/src/state/view';
import { trpc } from '../src/renderer/src/trpc/client';

const startup = vi.hoisted(() => vi.fn());
const config: RemoteStartupSnapshot['config'] = {
  uin: '10001',
  configId: 'cached-remote-account',
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

it.each(['启动', '已交互', '断网后恢复', '保留上次页面'] as const)(
  'Remote %s收到电脑的当前启动设置',
  async (phase) => {
    const cache = new QueryClient();
    const host = document.createElement('div');
    const root = createRoot(host);
    const previousView = useViewState.getState();
    const scope = JSON.stringify([config.uin, config.configId]);
    const space = JSON.stringify([scope, 'qzone']);
    const scrollKey = JSON.stringify([space, 'scroll']);
    const draftKey = JSON.stringify([space, 'draft']);
    function Space() {
      const [draft] = usePageState('draft', '', pageValue.string, true);
      return createElement(
        'output',
        {
          ref: (node: HTMLOutputElement | null) => {
            if (node)
              Object.defineProperties(node, {
                clientHeight: { value: 600, configurable: true },
                scrollHeight: { value: 3000, configurable: true },
              });
          },
        },
        draft,
      );
    }
    function Workspace() {
      const startupPage = useViewState((state) => state.startupPage);
      const navigationRevision = useViewState((state) => state.startupNavigationRevision);
      return createElement(
        PageSnapshots,
        { scope, key: navigationRevision, resetOnMount: startupPage !== null },
        createElement(
          PageSnapshotScope,
          { name: 'qzone' },
          createElement(PageScrollSnapshot, null, createElement(Space)),
        ),
      );
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
    const result = {
      backup: { ok: true, error: null, result: null },
      snapshot: {
        native: null,
        current: { uin: config.uin },
        settings: {
          ...DEFAULT_APP_SETTINGS,
          startupPage: phase === '保留上次页面' ? 'last' : 'home',
        },
        config,
        home: null,
      } satisfies RemoteStartupSnapshot,
    };
    let verify!: (value: typeof result) => void;
    if (phase === '断网后恢复') startup.mockRejectedValueOnce(new Error('电脑不可达'));
    else
      startup.mockImplementationOnce(
        () =>
          new Promise<typeof result>((resolve) => {
            verify = resolve;
          }),
      );
    startup.mockResolvedValue(result);
    try {
      saveRemoteWorkspace(config, { ...DEFAULT_APP_SETTINGS, startupPage: 'last' }, false);
      pageSnapshots.write(scrollKey, [{ path: [0], top: 900, left: 0 }]);
      pageSnapshots.write(draftKey, '未发送草稿', true);
      await act(async () => {
        root.render(
          createElement(
            WebStartupCache.Provider,
            { value: cache },
            createElement(BackupStartupGate, null, createElement(Workspace)),
          ),
        );
      });
      expect(host.querySelector('output')?.scrollTop).toBe(900);
      await act(async () => {
        if (phase === '断网后恢复') window.dispatchEvent(new Event('weq-remote-connection'));
        else {
          if (phase === '已交互') document.dispatchEvent(new Event('pointerdown'));
          verify(result);
        }
      });
      expect(readRemoteWorkspace()?.page).toBe(phase === '保留上次页面' ? null : 'home');
      expect(useViewState.getState().startupPage).toBe(phase === '启动' ? 'home' : null);
      expect(host.querySelector('output')?.scrollTop).toBe(phase === '启动' ? 0 : 900);
      expect(host.textContent).toBe('未发送草稿');
    } finally {
      act(() => root.unmount());
      cache.clear();
      useViewState.setState(previousView);
      setRemoteWorkspaceCheckPending(false);
      startup.mockReset();
      hidden.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);
