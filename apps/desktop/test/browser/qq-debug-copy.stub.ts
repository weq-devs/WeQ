import { useSyncExternalStore } from 'react';
import type { QqDebugCopyAction, QqDebugCopyStatus } from '../../src/shared/qq_debug_copy';
import { trpc as baseTrpc, client as baseClient } from './qq-data-access-trpc.stub';

const offline = new URLSearchParams(location.search).has('offline');
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
  message: '尚未创建 QQ 调试副本。',
};
const listeners = new Set<() => void>();
export function setFixture(patch: Partial<QqDebugCopyStatus>) {
  data = { ...data, ...patch };
  for (const listener of listeners) listener();
}
const debugTrpc = {
  account: {
    getGroupAlbumAccessState: {
      useQuery: () => ({
        data: {
          source: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' },
          qqOnline: !offline,
          attachEnabled: true,
          hasA2: true,
          hasD2: false,
          hasD2Key: true,
          hasGuid: true,
        },
        refetch: async () => ({}),
      }),
    },
  },
  bootstrap: {
    ...(offline
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
  bootstrap: {
    qqDebugCopyPermission: { mutate: async () => true },
    qqDebugCopyAction: {
      mutate: async ({ action }: { action: QqDebugCopyAction }) => {
        if (action === 'prepare')
          setFixture({
            state: 'ready',
            version: data.sourceVersion,
            message: '副本签名与调试权限已就绪；启动并登录后检查在线凭据。',
          });
        if (action === 'launch') setFixture({ runningPids: [42] });
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
