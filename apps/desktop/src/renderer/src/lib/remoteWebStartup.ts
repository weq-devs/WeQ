import { getQueryKey } from '@trpc/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { trpc } from '../trpc/client';
import { scheduleBackgroundLoad } from './backgroundLoad';
import { useViewState } from '../state/view';
import { isRemoteClient } from './remoteClient';
import {
  remoteWorkspaceCheckPending,
  setRemoteWorkspaceCheckPending,
} from './remoteWorkspaceCheck';

const startupKey = 'weq.remote-web-startup.v1';
const updatingKey = 'weq.remote-web-updating';
export const remoteReleasePath = '/_weq-remote-local/release';
type Config = NonNullable<inferRouterOutputs<AppRouter>['account']['getAccountConfig']>;
export type RemoteStartupSnapshot = NonNullable<
  inferRouterOutputs<AppRouter>['startup']['snapshot']['snapshot']
>;

type CachedWorkspace = Pick<Config, 'uin' | 'configId' | 'static' | 'mobile'> & {
  page: 'home' | 'messages' | null;
};

export function readRemoteWorkspace(): CachedWorkspace | undefined {
  if (!isRemoteClient() || location.hostname !== '127.0.0.1') return;
  try {
    const raw = localStorage.getItem(startupKey);
    if (!raw) return;
    const value = JSON.parse(raw) as Partial<CachedWorkspace>;
    if (
      typeof value.uin === 'string' &&
      /^\d+$/.test(value.uin) &&
      typeof value.configId === 'string' &&
      value.configId.length > 0 &&
      value.configId.length <= 512 &&
      typeof value.static === 'boolean' &&
      typeof value.mobile === 'boolean'
    )
      return {
        uin: value.uin,
        configId: value.configId,
        static: value.static,
        mobile: value.mobile,
        page: value.page === 'messages' || value.page === 'home' ? value.page : null,
      };
  } catch {}
}

export function saveRemoteWorkspace(
  config: RemoteStartupSnapshot['config'],
  settings: RemoteStartupSnapshot['settings'],
  privateMode: boolean,
) {
  if (!isRemoteClient() || location.hostname !== '127.0.0.1') return;
  try {
    if (!config || settings.appLock?.enabled || privateMode) {
      localStorage.removeItem(startupKey);
      return;
    }
    const { uin, configId, static: staticMode, mobile } = config;
    const page = settings.startupPage;
    const value: CachedWorkspace = {
      uin,
      configId,
      static: staticMode,
      mobile,
      page: page === 'messages' || page === 'home' ? page : null,
    };
    localStorage.setItem(startupKey, JSON.stringify(value));
  } catch {}
}

export function clearRemoteWorkspace() {
  if (!isRemoteClient()) return;
  try {
    localStorage.removeItem(startupKey);
  } catch {}
}

export function openRemoteWorkspace(cache: QueryClient, cached: CachedWorkspace) {
  setRemoteWorkspaceCheckPending(true);
  const { page, ...identity } = cached;
  let updating = false;
  try {
    updating = sessionStorage.getItem(updatingKey) === '1';
    sessionStorage.removeItem(updatingKey);
  } catch {}
  const config: Config = {
    ...identity,
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
  cache.setQueryData(getQueryKey(trpc.bootstrap.nativeStatus, undefined, 'query'), null);
  cache.setQueryData(getQueryKey(trpc.account.getAccountConfig, undefined, 'query'), config);
  useViewState.setState({
    openedUin: cached.uin,
    startupPage: updating ? null : page,
    view: 'main',
    homeStage: 'home',
  });
}

export function watchRemoteRelease() {
  if (!isRemoteClient() || location.hostname !== '127.0.0.1') return;
  let version = document.querySelector<HTMLMetaElement>(
    'meta[name="weq-local-web-release"]',
  )?.content;
  let supported = true;
  let canWait = false;
  let request: AbortController | undefined;
  let timer: number | undefined;
  let cancelReload: (() => void) | undefined;
  let stopped = false;
  const canCheck = () =>
    supported &&
    !stopped &&
    !document.hidden &&
    useViewState.getState().view === 'main' &&
    !remoteWorkspaceCheckPending();
  const check = async () => {
    if (!canCheck() || request || cancelReload) return;
    const controller = new AbortController();
    request = controller;
    let delay = 5_000;
    try {
      const params = new URLSearchParams({ workspace: '1' });
      if (canWait) params.set('since', version ?? '');
      const response = await fetch(`${remoteReleasePath}?${params}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return;
      if (response.headers.get('X-WeQ-Local-Release') !== '1') {
        supported = false;
        return;
      }
      const available = await response.text();
      if (controller.signal.aborted || !canCheck()) return;
      canWait = response.headers.get('X-WeQ-Local-Release-Wait') === '1';
      if (canWait) delay = 0;
      if (!/^[a-f0-9]{64}$/.test(available)) return;
      if (!version) version = available;
      else if (available !== version) {
        cancelReload = scheduleBackgroundLoad(() => {
          cancelReload = undefined;
          if (!canCheck()) return;
          try {
            sessionStorage.setItem(updatingKey, '1');
          } catch {}
          location.reload();
        }, 1_000);
      }
    } catch {
      // The current workspace stays open while the computer or update is unavailable.
    } finally {
      request = undefined;
      if (canCheck() && !cancelReload)
        timer = window.setTimeout(() => void check(), controller.signal.aborted ? 0 : delay);
    }
  };
  const refresh = () => {
    window.clearTimeout(timer);
    if (canCheck()) void check();
    else {
      request?.abort();
      cancelReload?.();
      cancelReload = undefined;
    }
  };
  const stopView = useViewState.subscribe((state, previous) => {
    if (state.view !== previous.view) refresh();
  });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('weq-remote-connection', refresh);
  refresh();
  return () => {
    stopped = true;
    stopView();
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('weq-remote-connection', refresh);
    refresh();
  };
}
