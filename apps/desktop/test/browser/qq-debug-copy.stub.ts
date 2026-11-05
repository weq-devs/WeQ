import { useSyncExternalStore } from 'react';
import type { QqDebugCopyAction, QqDebugCopyStatus } from '../../src/shared/qq_debug_copy';
import { trpc as baseTrpc, client as baseClient } from './qq-data-access-trpc.stub';

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
  bootstrap: {
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

function withDebugBootstrap(base: object, debug: { bootstrap: object }) {
  return new Proxy(base, {
    get(target, key) {
      if (key !== 'bootstrap') return Reflect.get(target, key);
      return new Proxy(Reflect.get(target, key), {
        get(bootstrap, key) {
          return Reflect.get(debug.bootstrap, key) ?? Reflect.get(bootstrap, key);
        },
      });
    },
  });
}
export const trpc = withDebugBootstrap(baseTrpc as object, debugTrpc);
export const client = withDebugBootstrap(baseClient as object, debugClient);
