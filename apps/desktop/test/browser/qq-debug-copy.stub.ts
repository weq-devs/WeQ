import { useSyncExternalStore } from 'react';
import type { QqDebugCopyAction, QqDebugCopyStatus } from '../../src/shared/qq_debug_copy';
import { trpc as baseTrpc, client as baseClient } from './qq-data-access-trpc.stub';
import type { OnlineAccess } from '../../src/renderer/src/lib/restrictedMode';

const offline = new URLSearchParams(location.search).has('offline');
const recovery = new URLSearchParams(location.search).has('recovery');
let onlineAccess: OnlineAccess = {
  source: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' },
  qqOnline: !offline,
  attachEnabled: true,
  hasA2: true,
  hasD2: false,
  hasD2Key: true,
  hasGuid: true,
};
let accessUpdatedAt = Date.now();
let data: QqDebugCopyStatus = {
  supported: true,
  phase: 'idle',
  state: 'missing',
  sourcePath: '/Applications/QQ.app',
  sourceVersion: '7.0.1-1',
  path: `/Users/synthetic ${'long directory/'.repeat(8)}Applications/QQ-WeQ.app`,
  version: null,
  readerReady: true,
  runningPids: [],
  sourceRunningPids: [],
  message: '尚未创建 QQ 调试副本。',
};
const listeners = new Set<() => void>();
export function setFixture(patch: Partial<QqDebugCopyStatus>) {
  data = { ...data, ...patch };
  for (const listener of listeners) listener();
}
export function setOnlineFixture(patch: Partial<OnlineAccess>) {
  onlineAccess = { ...onlineAccess, ...patch };
  accessUpdatedAt = Math.max(Date.now(), accessUpdatedAt + 1);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const debugTrpc = {
  account: {
    getGroupAlbumAccessState: {
      useQuery: () => ({
        data: useSyncExternalStore(subscribe, () => onlineAccess),
        dataUpdatedAt: accessUpdatedAt,
        refetch: async () => ({ data: onlineAccess }),
      }),
    },
  },
  bootstrap: {
    ...(offline || recovery
      ? {
          qqDataAccess: {
            useQuery: () => ({
              data: { status: 'readable', applicationPath: '/fixture/WeQ.app', issues: [] },
              refetch: async () => ({}),
            }),
          },
        }
      : {}),
    probeOnline: {
      useQuery: () => ({ data: { count: offline ? 0 : 1 }, refetch: async () => ({}) }),
    },
    sipEnabled: { useQuery: () => ({ data: true, refetch: async () => ({ data: true }) }) },
    qqDebugCopyStatus: {
      useQuery: () => ({
        data: useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          () => data,
        ),
        refetch: async () => ({ data }),
        error: null,
      }),
    },
  },
};
const debugClient = {
  account: {
    requestFullMode: {
      mutate: async () => {
        setOnlineFixture({ attachEnabled: true });
        return { requested: true };
      },
    },
    refreshRkeys: {
      mutate: async () => {
        setOnlineFixture({ hasD2: true, ssoReady: true });
        return true;
      },
    },
  },
  bootstrap: {
    qqDebugCopyPermission: { mutate: async () => true },
    qqDebugCopyAction: {
      mutate: async ({ action }: { action: QqDebugCopyAction }) => {
        if (
          action === 'prepare' ||
          (['open', 'switch'].includes(action) && ['missing', 'invalid'].includes(data.state))
        )
          setFixture({
            state: 'ready',
            version: data.sourceVersion,
            message: '副本签名与调试权限已就绪；启动并登录后检查在线凭据。',
          });
        if (action === 'launch' || action === 'open') setFixture({ runningPids: [42] });
        if (action === 'switch') setFixture({ sourceRunningPids: [], runningPids: [42] });
        if (action === 'remove') setFixture({ state: 'missing', version: null, runningPids: [] });
        return data;
      },
    },
  },
};

function withDebugBootstrap(base: object, debug: Record<string, object>) {
  return new Proxy(base, {
    get(target, key) {
      const override = Reflect.get(debug, key);
      if (!override) return Reflect.get(target, key);
      return new Proxy(Reflect.get(target, key), {
        get(bootstrap, key) {
          return Reflect.get(override, key) ?? Reflect.get(bootstrap, key);
        },
      });
    },
  });
}
export const trpc = withDebugBootstrap(baseTrpc as object, debugTrpc);
export const client = withDebugBootstrap(baseClient as object, debugClient);
